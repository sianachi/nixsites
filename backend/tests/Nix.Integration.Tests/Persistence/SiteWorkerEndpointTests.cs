using System.Net;
using System.Security.Cryptography;
using System.Text;
using System.Text.Json;
using Microsoft.Extensions.DependencyInjection;
using Nix.Domain.Items;
using Nix.Domain.Sites;
using Nix.Integration.Tests.Harness;
using Nix.Persistence.Workers;

namespace Nix.Integration.Tests.Persistence;

/// <summary>
/// The sites worker's routes end to end: what the lease proves, what the manifest and uploads
/// enforce, and that the host manifest the worker writes is the exact bytes Core planned.
/// </summary>
[Collection(PostgresSecondaryCollectionDefinition.Name)]
public sealed class SiteWorkerEndpointTests(NixPostgresFixture fixture) : IAsyncLifetime
{
    private const string Execution = "sites-worker:019946d1-fbc1-7d99-9ce7-1c721b406ff0";
    private SiteHttpHost _host = null!;
    private SiteScenario _scenario = null!;
    private string _manager = null!;
    private Guid _siteId;
    private ItemId _guide;

    private static CancellationToken Cancellation => TestContext.Current.CancellationToken;

    private static ItemId Root => ItemId.From(M0SchemaSeed.Alpha.ItemId);

    public async ValueTask InitializeAsync()
    {
        await fixture.ResetAsync();
        await M0SchemaSeed.SeedBothTenantsAsync(fixture);
        _scenario = await SiteScenario.CreateAsync(fixture);
        _host = SiteHttpHost.Create(fixture, new Dictionary<string, string?> { ["Nix:Sites:BuildsRetained"] = "2" });
        _manager = await _host.TokenAsync(SiteScenario.Manager);
        _guide = await _scenario.CreateItemAsync("Guide", Root);
        using var created = await _host.SendAsync(
            HttpMethod.Post, "/api/v1/sites", _manager, new { rootItemId = Root.Value, slug = "flow", layout = "docs" });
        Assert.Equal(HttpStatusCode.Created, created.StatusCode);
        using var site = await SiteHttpHost.JsonAsync(created);
        _siteId = site.RootElement.GetProperty("id").GetGuid();
    }

    public async ValueTask DisposeAsync()
    {
        await _host.DisposeAsync();
        await _scenario.DisposeAsync();
    }

    [Fact]
    public async Task A_build_is_read_uploaded_sealed_and_activated_and_the_host_manifest_is_bound_to_its_digest()
    {
        var (buildId, jobId) = await PublishAsync("one");
        await Sql($"UPDATE site_build SET loss = '[\"draft: A post has no date.\"]'::jsonb WHERE id = '{buildId}'");
        await ClaimAsync(jobId);

        using (var manifest = await Internal(HttpMethod.Get, $"/builds/{jobId}", jobId))
        {
            Assert.Equal(HttpStatusCode.OK, manifest.StatusCode);
            using var json = await SiteHttpHost.JsonAsync(manifest);
            Assert.Equal(1, json.RootElement.GetProperty("formatVersion").GetInt32());
            Assert.Equal(buildId, json.RootElement.GetProperty("buildId").GetGuid());
            Assert.Equal(2, json.RootElement.GetProperty("pageCount").GetInt32());
            Assert.Equal("https://flow.sites.example.net", json.RootElement.GetProperty("canonicalOrigin").GetString());
            Assert.Equal("docs", json.RootElement.GetProperty("layout").GetString());
        }

        using (var first = await Internal(HttpMethod.Get, $"/builds/{jobId}/pages?limit=1", jobId))
        {
            using var json = await SiteHttpHost.JsonAsync(first);
            var page = Assert.Single(json.RootElement.GetProperty("pages").EnumerateArray());
            Assert.Equal("/", page.GetProperty("path").GetString());
            Assert.Equal(0, json.RootElement.GetProperty("next").GetInt32());
            Assert.Equal(1, page.GetProperty("content").GetProperty("seq").GetInt64());
        }

        using (var rest = await Internal(HttpMethod.Get, $"/builds/{jobId}/pages?after=0", jobId))
        {
            using var json = await SiteHttpHost.JsonAsync(rest);
            var page = Assert.Single(json.RootElement.GetProperty("pages").EnumerateArray());
            Assert.Equal("/guide/", page.GetProperty("path").GetString());
            Assert.Equal(JsonValueKind.Null, json.RootElement.GetProperty("next").ValueKind);
            Assert.Equal(JsonValueKind.Null, page.GetProperty("content").ValueKind);
        }

        using (var body = await Internal(HttpMethod.Get, $"/builds/{jobId}/bodies/{Root.Value}", jobId))
        {
            Assert.Equal(HttpStatusCode.OK, body.StatusCode);
            using var json = await SiteHttpHost.JsonAsync(body);
            Assert.Equal(
                $"http://127.0.0.1:8100/documents/{Root.Value}/bundles?scope=item&atSeq=1",
                json.RootElement.GetProperty("sourceUrl").GetString());
            Assert.False(string.IsNullOrWhiteSpace(json.RootElement.GetProperty("bearerToken").GetString()));
        }

        using (var none = await Internal(HttpMethod.Get, $"/builds/{jobId}/bodies/{_guide.Value}", jobId))
        {
            Assert.Equal(HttpStatusCode.NotFound, none.StatusCode);
            Assert.Equal("sites.body_unavailable", await SiteHttpHost.ProblemCodeAsync(none));
        }

        var indexSha = Sha('1');
        var buildSha = Sha('2');
        var assetSha = Sha('3');
        var diagramSha = Sha('d');
        using (var uploads = await Internal(HttpMethod.Post, $"/builds/{jobId}/uploads", jobId, new
        {
            entries = new[]
            {
                Entry("index.html", "build", 10, indexSha, "text/html"),
                Entry("_nix/build.json", "build", 20, buildSha, "application/json"),
                Entry($"{assetSha}.png", "asset", 30, assetSha, "image/png"),
                Entry($"{diagramSha}.svg", "asset", 40, diagramSha, "image/svg+xml"),
            },
        }))
        {
            Assert.Equal(HttpStatusCode.OK, uploads.StatusCode);
            using var json = await SiteHttpHost.JsonAsync(uploads);
            var targets = json.RootElement.GetProperty("targets").EnumerateArray().ToArray();
            Assert.Equal($"sites/{_siteId:D}/builds/{buildId:D}/index.html", targets[0].GetProperty("key").GetString());
            Assert.Equal($"sites/{_siteId:D}/assets/{assetSha}.png", targets[2].GetProperty("key").GetString());
            Assert.Equal($"sites/{_siteId:D}/assets/{diagramSha}.svg", targets[3].GetProperty("key").GetString());
            var url = targets[0].GetProperty("uploadUrl").GetString()!;
            Assert.Contains("nix-sites", url, StringComparison.Ordinal);
            Assert.Contains("if-none-match", url, StringComparison.Ordinal);
            Assert.Contains("x-amz-checksum-sha256", url, StringComparison.Ordinal);
        }

        using (var mismatch = await Internal(HttpMethod.Post, $"/builds/{jobId}/seal", jobId, new { fileCount = 99, totalBytes = 60, buildIndexSha256 = buildSha, loss = Array.Empty<string>() }))
        {
            Assert.Equal((HttpStatusCode)422, mismatch.StatusCode);
            Assert.Equal("sites.seal_mismatch", await SiteHttpHost.ProblemCodeAsync(mismatch));
        }

        string body1;
        string putUrl;
        using (var seal = await Internal(HttpMethod.Post, $"/builds/{jobId}/seal", jobId, new { fileCount = 4, totalBytes = 100, buildIndexSha256 = buildSha, loss = new List<string> { "unsupported embed" } }))
        {
            Assert.Equal(HttpStatusCode.OK, seal.StatusCode);
            using var json = await SiteHttpHost.JsonAsync(seal);
            var write = Assert.Single(json.RootElement.GetProperty("writes").EnumerateArray());
            Assert.Equal("flow.sites.example.net", write.GetProperty("hostname").GetString());
            Assert.Equal("sites/_hosts/flow.sites.example.net.json", write.GetProperty("key").GetString());
            body1 = write.GetProperty("body").GetString()!;
            putUrl = write.GetProperty("uploadUrl").GetString()!;
        }

        using (var manifest = JsonDocument.Parse(body1))
        {
            Assert.Equal(buildId, manifest.RootElement.GetProperty("buildId").GetGuid());
            Assert.Equal(1, manifest.RootElement.GetProperty("generation").GetInt32());
            Assert.Equal($"sites/{_siteId:D}/builds/{buildId:D}/", manifest.RootElement.GetProperty("buildPrefix").GetString());
        }

        var planned = (await QueryAsync($"SELECT ops -> 0 ->> 'sha256' || ':' || (ops -> 0 ->> 'byteLength') FROM site_activation WHERE job_id = '{jobId}'")).Single();
        Assert.Equal($"{Convert.ToHexStringLower(SHA256.HashData(Encoding.UTF8.GetBytes(body1)))}:{Encoding.UTF8.GetByteCount(body1)}", planned);
        Assert.Contains("x-amz-checksum-sha256", putUrl, StringComparison.Ordinal);
        Assert.DoesNotContain("if-none-match", putUrl, StringComparison.Ordinal);

        using (var late = await Internal(HttpMethod.Post, $"/builds/{jobId}/uploads", jobId, new { entries = new[] { Entry("late.html", "build", 1, Sha('4'), "text/html") } }))
        {
            Assert.Equal(HttpStatusCode.Conflict, late.StatusCode);
            Assert.Equal("sites.build_closed", await SiteHttpHost.ProblemCodeAsync(late));
        }

        using (var activated = await Internal(HttpMethod.Post, $"/builds/{jobId}/activated", jobId))
        {
            Assert.Equal(HttpStatusCode.NoContent, activated.StatusCode);
        }

        using (var again = await Internal(HttpMethod.Post, $"/builds/{jobId}/activated", jobId))
        {
            Assert.Equal(HttpStatusCode.NoContent, again.StatusCode);
        }

        using var read = await _host.SendAsync(HttpMethod.Get, $"/api/v1/sites/{_siteId}", _manager);
        using var site = await SiteHttpHost.JsonAsync(read);
        Assert.Equal("published", site.RootElement.GetProperty("status").GetString());
        Assert.Equal(buildId, site.RootElement.GetProperty("liveBuild").GetProperty("id").GetGuid());
        Assert.Equal("live", site.RootElement.GetProperty("liveBuild").GetProperty("status").GetString());
        Assert.Equal(["draft: A post has no date.", "unsupported embed"], site.RootElement.GetProperty("liveBuild").GetProperty("loss").EnumerateArray().Select(entry => entry.GetString()!).ToArray());
        Assert.Equal(["4:100"], await QueryAsync($"SELECT file_count::text || ':' || total_bytes::text FROM site_build WHERE id = '{buildId}'"));
    }

    [Fact]
    public async Task A_worker_without_the_exact_live_lease_is_refused_on_every_route()
    {
        var (_, jobId) = await PublishAsync("stale");
        await ClaimAsync(jobId);
        var other = Guid.NewGuid();

        foreach (var (method, path, body) in new (HttpMethod, string, object?)[]
        {
            (HttpMethod.Get, $"/builds/{jobId}", null),
            (HttpMethod.Get, $"/builds/{jobId}/pages", null),
            (HttpMethod.Get, $"/builds/{jobId}/bodies/{Root.Value}", null),
            (HttpMethod.Post, $"/builds/{jobId}/uploads", new { entries = new[] { Entry("index.html", "build", 1, Sha('1'), "text/html") } }),
            (HttpMethod.Post, $"/builds/{jobId}/seal", new { fileCount = 1, totalBytes = 1, buildIndexSha256 = Sha('1'), loss = Array.Empty<string>() }),
            (HttpMethod.Post, $"/builds/{jobId}/activated", null),
        })
        {
            using var stale = await _host.InternalAsync(method, "/internal/worker-executions/sites" + path, jobId, "stale-execution", body);
            Assert.Equal(HttpStatusCode.Conflict, stale.StatusCode);

            using var wrongJob = await _host.InternalAsync(method, "/internal/worker-executions/sites" + path, other, Execution, body);
            Assert.Equal(HttpStatusCode.Conflict, wrongJob.StatusCode);
        }

        // A lease on a build job proves nothing about the activation or purge routes.
        using var activation = await Internal(HttpMethod.Get, $"/activations/{jobId}", jobId);
        Assert.Equal(HttpStatusCode.Conflict, activation.StatusCode);
        using var purge = await Internal(HttpMethod.Get, $"/purges/{jobId}/objects", jobId);
        Assert.Equal(HttpStatusCode.Conflict, purge.StatusCode);
    }

    [Fact]
    public async Task A_body_delegation_reads_only_its_own_page_and_only_while_the_build_job_holds_its_lease()
    {
        var (_, jobId) = await PublishAsync("delegation");
        await ClaimAsync(jobId);
        string bearer;
        using (var body = await Internal(HttpMethod.Get, $"/builds/{jobId}/bodies/{Root.Value}", jobId))
        {
            using var json = await SiteHttpHost.JsonAsync(body);
            bearer = json.RootElement.GetProperty("bearerToken").GetString()!;
        }

        using (var own = await _host.InternalBearerAsync(HttpMethod.Get, $"/internal/authz/items/{Root.Value}", bearer))
        {
            Assert.Equal(HttpStatusCode.OK, own.StatusCode);
        }

        using (var sibling = await _host.InternalBearerAsync(HttpMethod.Get, $"/internal/authz/items/{_guide.Value}", bearer))
        {
            Assert.Equal(HttpStatusCode.Forbidden, sibling.StatusCode);
        }

        using (var write = await _host.InternalBearerAsync(HttpMethod.Post, $"/internal/items/{Root.Value}/touched", bearer))
        {
            Assert.Equal(HttpStatusCode.Forbidden, write.StatusCode);
        }

        await Sql($"UPDATE worker_job SET status = 'failed', lease_owner = NULL, lease_until = NULL WHERE job_id = '{jobId}'");

        using (var ended = await _host.InternalBearerAsync(HttpMethod.Get, $"/internal/authz/items/{Root.Value}", bearer))
        {
            Assert.Equal(HttpStatusCode.Unauthorized, ended.StatusCode);
        }
    }

    [Fact]
    public async Task Uploads_are_validated_before_a_key_is_derived()
    {
        var (_, jobId) = await PublishAsync("validate");
        await ClaimAsync(jobId);
        var sha = Sha('5');

        foreach (var entry in new[]
        {
            Entry("../escape.html", "build", 1, sha, "text/html"),
            Entry("/absolute.html", "build", 1, sha, "text/html"),
            Entry("a//b.html", "build", 1, sha, "text/html"),
            Entry("index.html", "build", 1, sha, "image/png"),
            Entry("index.exe", "build", 1, sha, "application/octet-stream"),
            Entry("index.html", "build", 1, "not-a-digest", "text/html"),
            Entry("index.html", "build", SiteLimits.Over, sha, "text/html"),
            Entry("index.html", "elsewhere", 1, sha, "text/html"),
            Entry($"{Sha('6')}.png", "asset", 1, sha, "image/png"),
            Entry($"{sha}.gif", "asset", 1, sha, "image/gif"),
            Entry($"{sha}.svg", "asset", SiteRules.MaximumDiagramBytes + 1, sha, "image/svg+xml"),
            Entry($"{sha}.pdf", "asset", SiteRules.MaximumDownloadBytes + 1, sha, "application/pdf"),
        })
        {
            using var refused = await Internal(HttpMethod.Post, $"/builds/{jobId}/uploads", jobId, new { entries = new[] { entry } });
            Assert.Equal((HttpStatusCode)422, refused.StatusCode);
        }

        using (var none = await Internal(HttpMethod.Post, $"/builds/{jobId}/uploads", jobId, new { entries = Array.Empty<object>() }))
        {
            Assert.Equal((HttpStatusCode)422, none.StatusCode);
        }

        using (var first = await Internal(HttpMethod.Post, $"/builds/{jobId}/uploads", jobId, new { entries = new[] { Entry("index.html", "build", 5, sha, "text/html") } }))
        {
            Assert.Equal(HttpStatusCode.OK, first.StatusCode);
        }

        using (var same = await Internal(HttpMethod.Post, $"/builds/{jobId}/uploads", jobId, new { entries = new[] { Entry("index.html", "build", 5, sha, "text/html") } }))
        {
            Assert.Equal(HttpStatusCode.OK, same.StatusCode);
        }

        using (var changed = await Internal(HttpMethod.Post, $"/builds/{jobId}/uploads", jobId, new { entries = new[] { Entry("index.html", "build", 6, sha, "text/html") } }))
        {
            Assert.Equal(HttpStatusCode.Conflict, changed.StatusCode);
            Assert.Equal("sites.object_conflict", await SiteHttpHost.ProblemCodeAsync(changed));
        }

        Assert.Equal(["1"], await QueryAsync($"SELECT count(*)::text FROM site_build_object WHERE build_id = (SELECT id FROM site_build WHERE job_id = '{jobId}')"));
    }

    [Fact]
    public async Task A_body_image_is_recorded_only_for_a_page_in_the_manifest_and_only_if_the_publisher_may_copy_it()
    {
        var image = await _scenario.CreateFileAsync("body.png", "image/png", Sha('7'), parent: Root);
        var locked = await _scenario.CreateFileAsync("locked.png", "image/png", Sha('8'), parent: Root);
        var document = await _scenario.CreateFileAsync("Spec Sheet.pdf", "application/pdf", Sha('9'), parent: Root);
        var drawing = await _scenario.CreateFileAsync("plan.svg", "image/svg+xml", Sha('e'), parent: Root);
        var archive = await _scenario.CreateFileAsync("bundle.zip", "application/zip", Sha('6'), parent: Root);
        var outside = await _scenario.CreateFileAsync("outside.png", "image/png", Sha('5'));
        await Sql($"INSERT INTO item_lock (item_id, tenant_id, password_hash, locked_by, locked_at) VALUES ('{locked.Value}', '{TestTenants.Alpha}', 'pbkdf2-sha256$1$AAAAAAAAAAAAAAAAAAAAAA==$AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA=', '{TestTenants.AlphaPrincipal}', now())");
        var (buildId, jobId) = await PublishAsync("images");
        await ClaimAsync(jobId);

        using (var elsewhere = await Internal(HttpMethod.Get, $"/builds/{jobId}/files/{image.Value}?source={Guid.NewGuid()}", jobId))
        {
            Assert.Equal(HttpStatusCode.Conflict, elsewhere.StatusCode);
            Assert.Equal("sites.source_not_in_manifest", await SiteHttpHost.ProblemCodeAsync(elsewhere));
        }

        using (var missingSource = await Internal(HttpMethod.Get, $"/builds/{jobId}/files/{image.Value}", jobId))
        {
            Assert.Equal((HttpStatusCode)422, missingSource.StatusCode);
        }

        foreach (var refused in new[] { locked, archive, outside, ItemId.Create() })
        {
            using var response = await Internal(HttpMethod.Get, $"/builds/{jobId}/files/{refused.Value}?source={_guide.Value}", jobId);
            Assert.Equal(HttpStatusCode.NotFound, response.StatusCode);
            Assert.Equal("sites.file_unavailable", await SiteHttpHost.ProblemCodeAsync(response));
        }

        using (var allowed = await Internal(HttpMethod.Get, $"/builds/{jobId}/files/{image.Value}?source={_guide.Value}", jobId))
        {
            Assert.Equal(HttpStatusCode.OK, allowed.StatusCode);
            using var json = await SiteHttpHost.JsonAsync(allowed);
            Assert.Equal(Sha('7'), json.RootElement.GetProperty("sha256").GetString());
            Assert.Equal("image/png", json.RootElement.GetProperty("mediaType").GetString());
            Assert.DoesNotContain("nix-sites", json.RootElement.GetProperty("url").GetString()!, StringComparison.Ordinal);
        }

        // A PDF is a download: eligible under the same rules, named for the worker, and recorded.
        using (var pdf = await Internal(HttpMethod.Get, $"/builds/{jobId}/files/{document.Value}?source={_guide.Value}", jobId))
        {
            Assert.Equal(HttpStatusCode.OK, pdf.StatusCode);
            using var json = await SiteHttpHost.JsonAsync(pdf);
            Assert.Equal("application/pdf", json.RootElement.GetProperty("mediaType").GetString());
            Assert.Equal("Spec Sheet.pdf", json.RootElement.GetProperty("fileName").GetString());
        }

        // An SVG is eligible as an image; the worker re-sanitises it before it is published.
        using (var svg = await Internal(HttpMethod.Get, $"/builds/{jobId}/files/{drawing.Value}?source={_guide.Value}", jobId))
        {
            Assert.Equal(HttpStatusCode.OK, svg.StatusCode);
            using var json = await SiteHttpHost.JsonAsync(svg);
            Assert.Equal("image/svg+xml", json.RootElement.GetProperty("mediaType").GetString());
            Assert.Equal(Sha('e'), json.RootElement.GetProperty("sha256").GetString());
        }

        Assert.Equal(
            new[] { $"{image.Value}:{_guide.Value}", $"{document.Value}:{_guide.Value}", $"{drawing.Value}:{_guide.Value}" }.Order(StringComparer.Ordinal),
            await QueryAsync($"SELECT file_item_id::text || ':' || source_item_id::text FROM site_build_file WHERE build_id = '{buildId}' ORDER BY file_item_id::text COLLATE \"C\""));
    }

    [Fact]
    public async Task A_build_retired_into_a_purge_refuses_every_route()
    {
        var (buildId, jobId) = await PublishAsync("retired");
        await ClaimAsync(jobId);
        await Sql($"UPDATE site_build SET purge_id = gen_random_uuid() WHERE id = '{buildId}'");

        using var manifest = await Internal(HttpMethod.Get, $"/builds/{jobId}", jobId);

        Assert.Equal(HttpStatusCode.Conflict, manifest.StatusCode);
        Assert.Equal("sites.build_closed", await SiteHttpHost.ProblemCodeAsync(manifest));
    }

    [Fact]
    public async Task An_image_an_open_purge_is_deleting_cannot_be_uploaded_again_until_it_drains()
    {
        var sha = Sha('4');
        var old = Guid.CreateVersion7();
        await Sql($"""
            INSERT INTO site_build
                (tenant_id, id, site_id, status, job_id, publisher_id, origin, idempotency_key, header, page_count,
                 file_count, total_bytes, loss, created_at, purge_id)
            VALUES ('{TestTenants.Alpha}', '{old}', '{_siteId}', 'superseded', gen_random_uuid(),
                    '{TestTenants.AlphaPrincipal}', 'manual', 'old', jsonb_build_object(), 1, 1, 1, '[]'::jsonb, now() - interval '1 day', gen_random_uuid());
            INSERT INTO site_build_object (tenant_id, build_id, key, sha256, byte_length, kind, created_at)
            VALUES ('{TestTenants.Alpha}', '{old}', 'sites/{_siteId:D}/assets/{sha}.png', '{sha}', 1, 'asset', now());
            """);
        var (_, jobId) = await PublishAsync("after-purge");
        await ClaimAsync(jobId);
        var asset = new { entries = new[] { Entry($"{sha}.png", "asset", 1, sha, "image/png") } };

        using (var refused = await Internal(HttpMethod.Post, $"/builds/{jobId}/uploads", jobId, asset))
        {
            Assert.Equal(HttpStatusCode.Conflict, refused.StatusCode);
            Assert.Equal("sites.asset_purging", await SiteHttpHost.ProblemCodeAsync(refused));
        }

        await Sql($"UPDATE site_build SET status = 'purged' WHERE id = '{old}'");
        using var accepted = await Internal(HttpMethod.Post, $"/builds/{jobId}/uploads", jobId, asset);
        Assert.Equal(HttpStatusCode.OK, accepted.StatusCode);
    }

    [Fact]
    public async Task Rollback_unpublish_and_retention_move_hostnames_and_queue_the_purge_of_retired_builds()
    {
        var first = await RunBuildAsync("v1");
        var second = await RunBuildAsync("v2");
        var third = await RunBuildAsync("v3");

        // Retention keeps two: the live build and one previous. The first is retired; the image all
        // three share stays because the others still hold it.
        Assert.Equal(
            ["live", "superseded", "superseded"],
            await QueryAsync($"SELECT status FROM site_build WHERE site_id = '{_siteId}' ORDER BY created_at DESC"));
        var purgeJob = (await QueryAsync("SELECT job_id::text FROM worker_job WHERE kind = 'site.purge'")).Single();
        await ClaimAsync(Guid.Parse(purgeJob));
        using (var objects = await Internal(HttpMethod.Get, $"/purges/{purgeJob}/objects", Guid.Parse(purgeJob)))
        {
            Assert.Equal(HttpStatusCode.OK, objects.StatusCode);
            using var json = await SiteHttpHost.JsonAsync(objects);
            var keys = json.RootElement.GetProperty("objects").EnumerateArray().Select(entry => entry.GetProperty("key").GetString()!).ToArray();
            Assert.All(keys, key => Assert.StartsWith($"sites/{_siteId:D}/builds/{first:D}/", key, StringComparison.Ordinal));
            Assert.Equal(2, keys.Length);
            using var deleted = await Internal(HttpMethod.Post, $"/purges/{purgeJob}/objects/deleted", Guid.Parse(purgeJob), new { keys });
            Assert.Equal(HttpStatusCode.OK, deleted.StatusCode);
        }

        Assert.Equal(["purged"], await QueryAsync($"SELECT status FROM site_build WHERE id = '{first}'"));
        Assert.Equal(["0"], await QueryAsync($"SELECT count(*)::text FROM site_build_object WHERE build_id = '{first}'"));
        Assert.Equal(["1"], await QueryAsync($"SELECT count(*)::text FROM site_build_object WHERE build_id = '{second}' AND kind = 'asset'"));

        // A retired build cannot be served again; the previous one can.
        using (var gone = await _host.SendAsync(HttpMethod.Post, $"/api/v1/sites/{_siteId}/rollback", _manager, new { buildId = first }))
        {
            Assert.Equal(HttpStatusCode.Conflict, gone.StatusCode);
            Assert.Equal("sites.build_unavailable", await SiteHttpHost.ProblemCodeAsync(gone));
        }

        using (var rollback = await _host.SendAsync(HttpMethod.Post, $"/api/v1/sites/{_siteId}/rollback", _manager, new { buildId = second }))
        {
            Assert.Equal(HttpStatusCode.Accepted, rollback.StatusCode);
        }

        var rollbackJob = Guid.Parse((await QueryAsync("SELECT job_id::text FROM site_activation WHERE reason = 'rollback'")).Single());
        await ClaimAsync(rollbackJob);
        using (var ops = await Internal(HttpMethod.Get, $"/activations/{rollbackJob}", rollbackJob))
        {
            using var json = await SiteHttpHost.JsonAsync(ops);
            var op = Assert.Single(json.RootElement.GetProperty("ops").EnumerateArray());
            Assert.Equal("put", op.GetProperty("op").GetString());
            using var planned = JsonDocument.Parse(op.GetProperty("body").GetString()!);
            Assert.Equal(second, planned.RootElement.GetProperty("buildId").GetGuid());
            Assert.Equal(4, planned.RootElement.GetProperty("generation").GetInt32());
        }

        using (var applied = await Internal(HttpMethod.Post, $"/activations/{rollbackJob}/applied", rollbackJob))
        {
            Assert.Equal(HttpStatusCode.NoContent, applied.StatusCode);
        }

        Assert.Equal([second.ToString("D")], await QueryAsync($"SELECT live_build_id::text FROM site WHERE id = '{_siteId}'"));
        Assert.Equal(["live", "superseded"], await QueryAsync($"SELECT status FROM site_build WHERE id IN ('{second}', '{third}') ORDER BY created_at"));

        using (var unpublish = await _host.SendAsync(HttpMethod.Post, $"/api/v1/sites/{_siteId}/unpublish", _manager))
        {
            Assert.Equal(HttpStatusCode.Accepted, unpublish.StatusCode);
        }

        var unpublishJob = Guid.Parse((await QueryAsync("SELECT job_id::text FROM site_activation WHERE reason = 'unpublish'")).Single());
        await ClaimAsync(unpublishJob);
        using (var ops = await Internal(HttpMethod.Get, $"/activations/{unpublishJob}", unpublishJob))
        {
            using var json = await SiteHttpHost.JsonAsync(ops);
            var op = Assert.Single(json.RootElement.GetProperty("ops").EnumerateArray());
            Assert.Equal("delete", op.GetProperty("op").GetString());
            Assert.Equal("sites/_hosts/flow.sites.example.net.json", op.GetProperty("key").GetString());
        }

        using (var applied = await Internal(HttpMethod.Post, $"/activations/{unpublishJob}/applied", unpublishJob))
        {
            Assert.Equal(HttpStatusCode.NoContent, applied.StatusCode);
        }

        Assert.Equal(["unpublished:"], await QueryAsync($"SELECT status || ':' || coalesce(live_build_id::text, '') FROM site WHERE id = '{_siteId}'"));
        Assert.Equal(2, (await QueryAsync("SELECT job_id::text FROM worker_job WHERE kind = 'site.purge'")).Count);
        Assert.Equal(
            ["site.published", "site.published", "site.published", "site.rolled_back", "site.unpublished"],
            await QueryAsync($"SELECT action FROM audit_event WHERE subject_id = '{_siteId}' AND action <> 'site.created' ORDER BY action, occurred_at"));
    }

    private async Task<Guid> RunBuildAsync(string key)
    {
        var (buildId, jobId) = await PublishAsync(key);
        await ClaimAsync(jobId);
        var assetSha = Sha('a');
        var buildSha = Sha('b');
        using (var uploads = await Internal(HttpMethod.Post, $"/builds/{jobId}/uploads", jobId, new
        {
            entries = new[]
            {
                Entry("index.html", "build", 10, Sha('c'), "text/html"),
                Entry("_nix/build.json", "build", 20, buildSha, "application/json"),
                Entry($"{assetSha}.png", "asset", 30, assetSha, "image/png"),
            },
        }))
        {
            Assert.Equal(HttpStatusCode.OK, uploads.StatusCode);
        }

        using (var seal = await Internal(HttpMethod.Post, $"/builds/{jobId}/seal", jobId, new { fileCount = 3, totalBytes = 60, buildIndexSha256 = buildSha, loss = Array.Empty<string>() }))
        {
            Assert.Equal(HttpStatusCode.OK, seal.StatusCode);
        }

        using var activated = await Internal(HttpMethod.Post, $"/builds/{jobId}/activated", jobId);
        Assert.Equal(HttpStatusCode.NoContent, activated.StatusCode);
        return buildId;
    }

    private async Task<(Guid BuildId, Guid JobId)> PublishAsync(string key)
    {
        using var response = await _host.SendAsync(
            HttpMethod.Post, $"/api/v1/sites/{_siteId}/publish", _manager, new { idempotencyKey = key, refreshPaths = false, acknowledgeDisclosure = true });
        Assert.Equal(HttpStatusCode.Accepted, response.StatusCode);
        using var build = await SiteHttpHost.JsonAsync(response);
        var buildId = build.RootElement.GetProperty("id").GetGuid();
        var job = (await QueryAsync($"SELECT job_id::text FROM site_build WHERE id = '{buildId}'")).Single();
        return (buildId, Guid.Parse(job));
    }

    private async Task ClaimAsync(Guid jobId)
    {
        await using var scope = fixture.Application.CreateUnscopedScope();
        var dispatch = scope.ServiceProvider.GetRequiredService<WorkerDispatchStore>();
        Assert.NotNull(await dispatch.ClaimJobAsync(jobId, Execution, 60, Cancellation));
    }

    private Task<HttpResponseMessage> Internal(HttpMethod method, string path, Guid jobId, object? body = null) =>
        _host.InternalAsync(method, "/internal/worker-executions/sites" + path, jobId, Execution, body);

    private static object Entry(string path, string kind, long byteLength, string sha256, string mediaType) =>
        new { path, kind, byteLength, sha256, mediaType };

    private static string Sha(char digit) => new(digit, 64);

    private async Task<List<string>> QueryAsync(string sql)
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

    private static class SiteLimits
    {
        public const long Over = 50L * 1024 * 1024 + 1;
    }
}
