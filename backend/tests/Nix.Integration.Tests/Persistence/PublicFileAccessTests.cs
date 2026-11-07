using Microsoft.Extensions.Configuration;
using Nix.Abstractions;
using Nix.Abstractions.Files;
using Nix.Domain.Tenancy;
using Nix.Features.PublicLinks.Notes;
using Nix.Integration.Tests.Harness;
using Nix.Persistence;

namespace Nix.Integration.Tests.Persistence;

/// <summary>
/// [SEC] The draft exposure rule for public note links, proved against real Postgres: which file
/// a note may hand out, which version, and what stays hidden. The seeded Alpha file has one draft
/// version.
/// </summary>
[Collection(PostgresSecondaryCollectionDefinition.Name)]
public sealed class PublicFileAccessTests(NixPostgresFixture fixture) : IAsyncLifetime
{
    private static readonly M0TenantRows Alpha = M0SchemaSeed.Alpha;
    private static readonly Guid FirstVersion = Alpha.TemplateSourceId;
    private static readonly Guid SecondVersion = new("27272727-2727-4727-8727-272727272727");

    private static CancellationToken Cancellation => TestContext.Current.CancellationToken;

    public async ValueTask InitializeAsync()
    {
        await fixture.ResetAsync();
        await M0SchemaSeed.SeedBothTenantsAsync(fixture);
    }

    public ValueTask DisposeAsync() => ValueTask.CompletedTask;

    private async Task ExecAsync(string sql)
    {
        var connection = await fixture.OpenMigratorConnectionAsync();
        await using (connection.ConfigureAwait(false))
        {
            await RawSql.ExecuteAsync(connection, null, sql);
        }
    }

    private Task SetStateAsync(Guid version, string state) =>
        ExecAsync($"UPDATE file_version SET state = '{state}' WHERE file_version_id = '{version}'");

    private Task AddCurrentVersionAsync(string mediaType, string state = "draft") => ExecAsync($"""
        INSERT INTO file_version
            (file_version_id, tenant_id, workspace_id, item_id, version, object_key, file_name, media_type,
             byte_length, sha256, previewable, created_by, created_at, state)
        VALUES ('{SecondVersion}', '{Alpha.TenantId}', '{Alpha.WorkspaceId}', '{Alpha.ItemId}', 2,
                'files/seed/alpha-v2', 'alpha-v2.bin', '{mediaType}', 4, repeat('c', 64), false,
                '{Alpha.PrincipalId}', now(), '{state}');
        UPDATE file_body SET current_version_id = '{SecondVersion}' WHERE item_id = '{Alpha.ItemId}';
        """);

    private async Task<PublicFileVerdict> ResolveAsync(
        Guid fileId,
        bool asImage,
        NixSessionContext? context = null,
        Guid? workspace = null)
    {
        await using var work = await fixture.Application.BeginUnitOfWorkAsync(
            context ?? TestTenants.AlphaContext, Cancellation);
        return await PublicFileAccess.ResolveAsync(
            work.Resolve<IItemTree>(),
            work.Resolve<IFileStore>(),
            work.Resolve<IPublicFileVersions>(),
            new TenantId(Alpha.TenantId),
            new WorkspaceId(workspace ?? Alpha.WorkspaceId),
            fileId,
            asImage,
            Cancellation);
    }

    [Fact]
    public async Task A_draft_file_is_withheld_by_name_and_serves_no_object()
    {
        var verdict = await ResolveAsync(Alpha.ItemId, asImage: false);
        Assert.Equal(PublicFileDisposition.Withheld, verdict.Disposition);
        Assert.Equal("alpha.bin", verdict.Name);
        Assert.Null(verdict.Choice);
    }

    [Fact]
    public async Task An_approved_file_serves_the_latest_approved_version_not_a_newer_draft()
    {
        await SetStateAsync(FirstVersion, "approved");
        await AddCurrentVersionAsync("application/pdf");

        var verdict = await ResolveAsync(Alpha.ItemId, asImage: false);

        Assert.Equal(PublicFileDisposition.Servable, verdict.Disposition);
        Assert.Equal("files/seed/alpha", verdict.Choice?.ObjectKey);
    }

    [Fact]
    public async Task A_newer_approved_version_wins_over_an_older_one()
    {
        await SetStateAsync(FirstVersion, "approved");
        await AddCurrentVersionAsync("application/pdf", "approved");

        var verdict = await ResolveAsync(Alpha.ItemId, asImage: false);

        Assert.Equal("files/seed/alpha-v2", verdict.Choice?.ObjectKey);
    }

    [Fact]
    public async Task A_revoked_only_file_is_withheld()
    {
        await SetStateAsync(FirstVersion, "revoked");

        var verdict = await ResolveAsync(Alpha.ItemId, asImage: false);

        Assert.Equal(PublicFileDisposition.Withheld, verdict.Disposition);
        Assert.Null(verdict.Choice);
    }

    [Theory]
    [InlineData("image/png", true)]
    [InlineData("image/jpeg", true)]
    [InlineData("image/webp", true)]
    [InlineData("image/avif", true)]
    [InlineData("image/svg+xml", false)]
    [InlineData("image/gif", false)]
    [InlineData("application/pdf", false)]
    public async Task An_unapproved_file_serves_on_an_image_node_only_as_a_safe_raster_type(string mediaType, bool served)
    {
        await AddCurrentVersionAsync(mediaType);

        var asImage = await ResolveAsync(Alpha.ItemId, asImage: true);
        var asBlock = await ResolveAsync(Alpha.ItemId, asImage: false);

        Assert.Equal(served ? PublicFileDisposition.Servable : PublicFileDisposition.Withheld, asImage.Disposition);
        Assert.Equal(PublicFileDisposition.Withheld, asBlock.Disposition);
    }

    [Fact]
    public async Task A_file_in_another_workspace_or_tenant_is_hidden_with_no_name()
    {
        var otherWorkspace = await ResolveAsync(Alpha.ItemId, asImage: false, workspace: Guid.NewGuid());
        var otherTenant = await ResolveAsync(M0SchemaSeed.Beta.ItemId, asImage: false);

        Assert.Equal(PublicFileDisposition.Hidden, otherWorkspace.Disposition);
        Assert.Null(otherWorkspace.Name);
        Assert.Equal(PublicFileDisposition.Hidden, otherTenant.Disposition);
        Assert.Null(otherTenant.Name);
    }

    [Fact]
    public async Task A_locked_file_is_hidden_with_no_name()
    {
        await SetStateAsync(FirstVersion, "approved");
        await ExecAsync($"""
            INSERT INTO item_lock (item_id, tenant_id, password_hash, locked_by, locked_at)
            VALUES ('{Alpha.ItemId}', '{Alpha.TenantId}', '{new string('a', 64)}', '{Alpha.PrincipalId}', now());
            """);

        var verdict = await ResolveAsync(Alpha.ItemId, asImage: false);

        Assert.Equal(PublicFileDisposition.Hidden, verdict.Disposition);
        Assert.Null(verdict.Name);
    }

    [Fact]
    public async Task A_trashed_file_is_hidden_with_no_name()
    {
        await SetStateAsync(FirstVersion, "approved");
        await ExecAsync($"UPDATE item SET lifecycle_state = 'deleted' WHERE id = '{Alpha.ItemId}'");

        var verdict = await ResolveAsync(Alpha.ItemId, asImage: false);

        Assert.Equal(PublicFileDisposition.Hidden, verdict.Disposition);
        Assert.Null(verdict.Name);
    }

    private async Task<PublicNoteGrant?> GrantAsync(bool enabled, Guid? principal = null, bool revoke = false)
    {
        var linkId = await LinkIdAsync();
        if (revoke)
        {
            await ExecAsync($"UPDATE public_link SET revoked_at = now() WHERE id = '{linkId}'");
        }

        var configuration = new ConfigurationBuilder()
            .AddInMemoryCollection(new Dictionary<string, string?> { ["Nix:PublicLinks:Enabled"] = enabled ? "true" : "false" })
            .Build();
        await using var host = NixPersistenceHost.Create(fixture.ApplicationConnectionString, null, configuration);
        await using var work = await host.BeginUnitOfWorkAsync(TestTenants.AlphaContext, Cancellation);
        return await PublicNoteInternalEndpoints.GrantAsync(
            work.Resolve<IServiceProvider>(),
            linkId,
            new PublicNoteScope(Alpha.TenantId, principal ?? Alpha.PrincipalId, Alpha.WorkspaceId, Alpha.ItemId),
            Cancellation);
    }

    [Fact]
    public async Task The_grant_is_a_read_for_a_live_link()
    {
        var grant = await GrantAsync(enabled: true);

        Assert.NotNull(grant);
        Assert.Equal("read", grant.Permission);
        Assert.Equal(Alpha.ItemId, grant.ItemId);
    }

    [Fact]
    public async Task The_grant_is_refused_when_the_install_switch_is_off() =>
        Assert.Null(await GrantAsync(enabled: false));

    [Fact]
    public async Task The_grant_is_refused_for_a_revoked_link() =>
        Assert.Null(await GrantAsync(enabled: true, revoke: true));

    [Fact]
    public async Task The_grant_is_refused_for_another_principal_than_the_links() =>
        Assert.Null(await GrantAsync(enabled: true, principal: Guid.NewGuid()));

    [Fact]
    public async Task The_grant_is_refused_for_a_trashed_item()
    {
        await ExecAsync($"UPDATE item SET lifecycle_state = 'deleted' WHERE id = '{Alpha.ItemId}'");

        Assert.Null(await GrantAsync(enabled: true));
    }

    [Fact]
    public async Task The_grant_is_refused_for_a_locked_item()
    {
        await ExecAsync($"""
            INSERT INTO item_lock (item_id, tenant_id, password_hash, locked_by, locked_at)
            VALUES ('{Alpha.ItemId}', '{Alpha.TenantId}', '{new string('a', 64)}', '{Alpha.PrincipalId}', now());
            """);

        Assert.Null(await GrantAsync(enabled: true));
    }

    private async Task<Guid> LinkIdAsync()
    {
        var connection = await fixture.OpenMigratorConnectionAsync();
        await using (connection.ConfigureAwait(false))
        {
            var text = await RawSql.TextAsync(connection, null, $"SELECT id::text FROM public_link WHERE item_id = '{Alpha.ItemId}'");
            return Guid.Parse(text!);
        }
    }
}
