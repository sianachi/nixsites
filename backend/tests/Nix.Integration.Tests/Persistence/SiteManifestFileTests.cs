using System.Text.Json.Nodes;
using Nix.Abstractions;
using Nix.Domain.Items;
using Nix.Domain.Sites;
using Nix.Features.Sites;
using Nix.Integration.Tests.Harness;
using Npgsql;

namespace Nix.Integration.Tests.Persistence;

/// <summary>
/// [SEC] Only referenced images are copied into a build, and the set cannot grow once the build
/// has left the queue.
/// </summary>
[Collection(PostgresSecondaryCollectionDefinition.Name)]
public sealed class SiteManifestFileTests(NixPostgresFixture fixture) : IAsyncLifetime
{
    private SiteScenario _scenario = null!;
    private Guid _siteId;
    private ItemId _page;
    private ItemId _referenced;
    private ItemId _unreferenced;
    private ItemId _lockedImage;
    private ItemId _document;

    private static CancellationToken Cancellation => TestContext.Current.CancellationToken;

    private static ItemId Root => ItemId.From(M0SchemaSeed.Alpha.ItemId);

    public async ValueTask InitializeAsync()
    {
        await fixture.ResetAsync();
        await M0SchemaSeed.SeedBothTenantsAsync(fixture);
        _scenario = await SiteScenario.CreateAsync(fixture);

        _referenced = await _scenario.CreateFileAsync("referenced.png", "image/png", new string('a', 64), parent: Root);
        _unreferenced = await _scenario.CreateFileAsync("unreferenced.png", "image/png", new string('b', 64), parent: Root);
        _lockedImage = await _scenario.CreateFileAsync("locked.png", "image/png", new string('c', 64), parent: Root);
        _document = await _scenario.CreateFileAsync("bundle.zip", "application/zip", new string('d', 64), parent: Root);
        await Sql($"INSERT INTO item_lock (item_id, tenant_id, password_hash, locked_by, locked_at) VALUES ('{_lockedImage.Value}', '{TestTenants.Alpha}', 'pbkdf2-sha256$1$AAAAAAAAAAAAAAAAAAAAAA==$AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA=', '{TestTenants.AlphaPrincipal}', now())");

        _page = await _scenario.CreateItemAsync(
            "Gallery",
            Root,
            properties: new JsonObject
            {
                ["cover"] = $"nix-file:{_referenced.Value}",
                ["secret"] = $"nix-file:{_lockedImage.Value}",
                ["attachment"] = $"nix-file:{_document.Value}",
                ["elsewhere"] = $"nix-file:{Guid.NewGuid()}",
                ["external"] = "https://example.test/pic.png",
            });
        var created = await _scenario.SendAsync<CreateSite, SiteResponse>(
            SiteScenario.Manager, new CreateSite(new CreateSiteRequest(Root.Value, "gallery", "blog", null)));
        _siteId = created.Value.Id;
    }

    public async ValueTask DisposeAsync() => await _scenario.DisposeAsync();

    [Fact]
    public async Task Only_a_file_a_page_references_and_the_publisher_may_copy_is_recorded()
    {
        var build = await PublishAsync();

        var recorded = await Query($"SELECT file_item_id::text || ':' || source_item_id::text FROM site_build_file WHERE build_id = '{build}'");

        Assert.Equal([$"{_referenced.Value}:{_page.Value}"], recorded);
        var page = await Query($"SELECT property_files::text FROM site_build_page WHERE build_id = '{build}' AND item_id = '{_page.Value}'");
        Assert.Contains(_referenced.Value.ToString(), page.Single(), StringComparison.Ordinal);
        Assert.DoesNotContain(_unreferenced.Value.ToString(), page.Single(), StringComparison.Ordinal);
        Assert.DoesNotContain(_lockedImage.Value.ToString(), page.Single(), StringComparison.Ordinal);
        Assert.DoesNotContain(_document.Value.ToString(), page.Single(), StringComparison.Ordinal);
    }

    [Fact]
    public async Task A_file_recorded_for_a_queued_build_is_idempotent_and_a_sealed_build_refuses_more()
    {
        var build = await PublishAsync();
        var candidate = await _scenario.ReadAsync(SiteScenario.Manager, async unit =>
            await FindFileAsync(unit, _unreferenced));
        Assert.NotNull(candidate);

        var first = await RecordAsync(build, candidate);
        var again = await RecordAsync(build, candidate);
        Assert.Equal(SiteFileRecording.Recorded, first);
        Assert.Equal(SiteFileRecording.Recorded, again);
        Assert.Equal(["1"], await Query($"SELECT count(*)::text FROM site_build_file WHERE build_id = '{build}' AND file_item_id = '{_unreferenced.Value}'"));

        await Sql($"UPDATE site_build SET status = 'sealed' WHERE id = '{build}'");

        Assert.Equal(SiteFileRecording.BuildClosed, await RecordAsync(build, candidate, sourceOverride: Root));
    }

    [Fact]
    public async Task An_image_outside_the_site_under_an_excluded_item_or_under_a_withheld_post_is_refused()
    {
        var outside = await _scenario.CreateFileAsync("outside.png", "image/png", new string('e', 64));
        var excluded = await _scenario.CreateItemAsync("Private", Root, "folder");
        var underExclusion = await _scenario.CreateFileAsync("private.png", "image/png", new string('f', 64), parent: excluded);
        var blog = await _scenario.CreateItemAsync("Blog", Root, "folder");
        var future = await _scenario.CreateItemAsync("Future", blog, properties: new JsonObject { ["published"] = "2999-01-01T00:00:00Z[Europe/London]" });
        var underFuture = await _scenario.CreateFileAsync("future.png", "image/png", new string('9', 64), parent: future);
        var past = await _scenario.CreateItemAsync("Past", blog, properties: new JsonObject { ["published"] = "2026-01-01T09:00:00+01:00[Europe/Paris]" });
        var underPast = await _scenario.CreateFileAsync("past.png", "image/png", new string('8', 64), parent: past);
        var updated = await _scenario.SendAsync<UpdateSite, SiteResponse>(
            SiteScenario.Manager,
            new UpdateSite(_siteId, new UpdateSiteRequest(null, null, null, null, [excluded.Value], [new SiteDatedCollectionDto(blog.Value, "published", null, null, null)])));
        Assert.True(updated.IsSuccess, updated.IsFailure ? updated.Error.Message : string.Empty);

        var found = await _scenario.ReadAsync(SiteScenario.Manager, async unit => new[]
        {
            await FindFileAsync(unit, outside),
            await FindFileAsync(unit, underExclusion),
            await FindFileAsync(unit, underFuture),
            await FindFileAsync(unit, underPast),
            await FindFileAsync(unit, _referenced),
        });

        Assert.Null(found[0]);
        Assert.Null(found[1]);
        Assert.Null(found[2]);
        Assert.NotNull(found[3]);
        Assert.NotNull(found[4]);
    }

    [Fact]
    public async Task The_trigger_refuses_a_manifest_page_for_a_sealed_build()
    {
        var build = await PublishAsync();
        await Sql($"UPDATE site_build SET status = 'sealed' WHERE id = '{build}'");

        var refused = await Assert.ThrowsAsync<PostgresException>(() => Sql($"""
            INSERT INTO site_build_page (tenant_id, build_id, ordinal, item_id, path, title, type, seq, item_created_at, item_updated_at, properties, property_files)
            SELECT tenant_id, build_id, 999, '{_unreferenced.Value}', '/smuggled/', 'smuggled', type, seq, item_created_at, item_updated_at, properties, property_files
            FROM site_build_page WHERE build_id = '{build}' AND ordinal = 0
            """));

        Assert.Equal(PostgresErrorCodes.CheckViolation, refused.SqlState);
    }

    [Fact]
    public async Task The_trigger_refuses_a_file_row_for_a_sealed_build_whoever_inserts_it()
    {
        var build = await PublishAsync();
        await Sql($"UPDATE site_build SET status = 'sealed' WHERE id = '{build}'");

        var connection = await fixture.OpenApplicationConnectionAsync();
        await using (connection.ConfigureAwait(false))
        {
            var transaction = await connection.BeginTransactionAsync(Cancellation);
            await using (transaction.ConfigureAwait(false))
            {
                await RawSql.ExecuteAsync(connection, transaction, $"SELECT set_config('nix.tenant_id', '{TestTenants.Alpha}', true)");
                var refused = await Assert.ThrowsAsync<PostgresException>(() => RawSql.ExecuteAsync(
                    connection,
                    transaction,
                    $"""
                    INSERT INTO site_build_file
                        (tenant_id, build_id, source_item_id, file_item_id, file_version_id, sha256, media_type, byte_length, created_at)
                    VALUES ('{TestTenants.Alpha}', '{build}', '{_page.Value}', '{_unreferenced.Value}', gen_random_uuid(),
                            '{new string('b', 64)}', 'image/png', 10, now())
                    """));

                Assert.Equal(PostgresErrorCodes.CheckViolation, refused.SqlState);
            }
        }
    }

    private async Task<Guid> PublishAsync()
    {
        var published = await _scenario.SendAsync<PublishSite, SiteBuildResponse>(
            SiteScenario.Manager, new PublishSite(_siteId, Guid.NewGuid().ToString("D"), false, true, "manual"));
        Assert.True(published.IsSuccess, published.IsFailure ? published.Error.Message : string.Empty);
        return published.Value.Id;
    }

    private async Task<SiteFileRecording> RecordAsync(Guid buildId, SiteFileCandidate? candidate, ItemId? sourceOverride = null) =>
        await _scenario.RunAsync(SiteScenario.Manager, async unit =>
        {
            var store = unit.Resolve<ISiteStore>();
            var build = await store.FindBuildForUpdateAsync(buildId, Cancellation);
            return await store.RecordFileAsync(build!, sourceOverride ?? _page, candidate!, DateTimeOffset.UtcNow, Cancellation);
        });

    private async Task<SiteFileCandidate?> FindFileAsync(NixUnitOfWork unit, ItemId file)
    {
        var store = unit.Resolve<ISiteStore>();
        var site = await store.FindAsync(_siteId, Cancellation);
        return await store.FindFileAsync(site!, file, DateTimeOffset.UtcNow, Cancellation);
    }

    private async Task<List<string>> Query(string sql)
    {
        var connection = await fixture.OpenMigratorConnectionAsync();
        await using (connection.ConfigureAwait(false))
        {
            return [.. await RawSql.TextListAsync(connection, sql)];
        }
    }

    private async Task Sql(string statement)
    {
        var connection = await fixture.OpenMigratorConnectionAsync();
        await using (connection.ConfigureAwait(false))
        {
            await RawSql.ExecuteAsync(connection, transaction: null, statement);
        }
    }
}
