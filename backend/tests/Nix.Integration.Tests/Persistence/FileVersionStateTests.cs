using System.Net;
using System.Net.Http.Headers;
using System.Net.Http.Json;
using System.Security.Cryptography;
using System.Text.Json;
using Microsoft.AspNetCore.Mvc.Testing;
using Microsoft.EntityFrameworkCore;
using Nix.Abstractions;
using Nix.Abstractions.Files;
using Nix.Authentication;
using Nix.Domain.Files;
using Nix.Domain.Identity;
using Nix.Domain.Items;
using Nix.Domain.Tenancy;
using Nix.Features.Items;
using Nix.Features.Tokens;
using Nix.Integration.Tests.Harness;
using Nix.Messaging;
using Nix.Persistence.Workspaces;

namespace Nix.Integration.Tests.Persistence;

/// <summary>
/// [SEC] File version lifecycle over the real schema: the allowed transitions, the agent gate for
/// each credential kind, the shown version, rename limited to drafts, and tenant isolation.
/// </summary>
[Collection(PostgresSecondaryCollectionDefinition.Name)]
public sealed class FileVersionStateTests(NixPostgresFixture fixture) : IAsyncLifetime
{
    private static CancellationToken Cancellation => TestContext.Current.CancellationToken;

    private WebApplicationFactory<Program> _factory = null!;
    private HttpClient _client = null!;

    public async ValueTask InitializeAsync()
    {
        await fixture.ResetAsync();
        await M0SchemaSeed.SeedBothTenantsAsync(fixture);
        string signingKey;
        using (var key = ECDsa.Create(ECCurve.NamedCurves.nistP256))
        {
            signingKey = key.ExportECPrivateKeyPem();
        }
        _factory = new ConfiguredApplicationFactory(new Dictionary<string, string?>
        {
            ["ConnectionStrings:Nix"] = fixture.ApplicationConnectionString,
            [SelfIssuedTokenService.IssuerConfigurationKey] = "https://core.version-state.test",
            [SelfIssuedTokenService.AudienceConfigurationKey] = "nix",
            [SelfIssuedTokenService.KeyIdConfigurationKey] = "version-state-key",
            [SelfIssuedTokenService.SigningKeyConfigurationKey] = signingKey,
        });
        _client = _factory.CreateClient();
    }

    public async ValueTask DisposeAsync()
    {
        _client.Dispose();
        await _factory.DisposeAsync();
    }

    [Theory]
    [InlineData("draft", "in_review", true)]
    [InlineData("draft", "approved", true)]
    [InlineData("in_review", "approved", true)]
    [InlineData("in_review", "draft", true)]
    [InlineData("approved", "revoked", true)]
    [InlineData("draft", "draft", false)]
    [InlineData("draft", "revoked", false)]
    [InlineData("in_review", "in_review", false)]
    [InlineData("in_review", "revoked", false)]
    [InlineData("approved", "draft", false)]
    [InlineData("approved", "in_review", false)]
    [InlineData("approved", "approved", false)]
    [InlineData("revoked", "draft", false)]
    [InlineData("revoked", "approved", false)]
    [InlineData("revoked", "in_review", false)]
    public async Task Every_transition_is_allowed_or_refused(string from, string to, bool allowed)
    {
        var file = await UploadAsync("transition-" + from + "-" + to, 1);
        await ForceStateAsync(file.Versions[0], from);

        var result = await ChangeAsync(file, 0, to, interactive: true);

        Assert.Equal(allowed ? FileVersionStateOutcome.Changed : FileVersionStateOutcome.InvalidTransition, result.Outcome);
        Assert.Equal(allowed ? to : from, await StateOfAsync(file.Versions[0]));
        if (allowed)
        {
            Assert.Equal(to, result.Version!.State);
            Assert.Equal(TestTenants.AlphaPrincipal, result.Version.StateChangedBy);
            Assert.NotNull(result.Version.StateChangedAt);
        }
        else
        {
            Assert.Equal(from, result.From);
        }
    }

    [Fact]
    public async Task A_state_change_writes_one_audit_event_and_a_refusal_writes_none()
    {
        var file = await UploadAsync("audit", 1);
        await ChangeAsync(file, 0, "approved", interactive: true);
        await ChangeAsync(file, 0, "draft", interactive: true);

        // The application role can only insert audit rows, so read them as the migrator.
        Assert.Equal(1, await MigratorCountAsync(
            $"SELECT count(*) FROM audit_event WHERE action = 'file_version.state_changed' AND subject_id = '{file.Versions[0]}' AND after->>'state' = 'approved' AND before->>'state' = 'draft'"));
        Assert.Equal(1, await MigratorCountAsync(
            $"SELECT count(*) FROM audit_event WHERE action = 'file_version.state_changed' AND subject_id = '{file.Versions[0]}'"));
    }

    [Fact]
    public async Task An_external_bearer_needs_the_switch_to_approve_or_revoke_but_not_to_review()
    {
        var file = await UploadAsync("bearer", 1);

        // Switch off (the default): in_review and back to draft are ordinary writes.
        Assert.Equal(FileVersionStateOutcome.Changed, (await ChangeAsync(file, 0, "in_review", interactive: false)).Outcome);
        Assert.Equal(FileVersionStateOutcome.Changed, (await ChangeAsync(file, 0, "draft", interactive: false)).Outcome);
        Assert.Equal(FileVersionStateOutcome.NotPermitted, (await ChangeAsync(file, 0, "approved", interactive: false)).Outcome);
        Assert.Equal("draft", await StateOfAsync(file.Versions[0]));

        // A person approves; the bearer still cannot revoke while the switch is off.
        await ChangeAsync(file, 0, "approved", interactive: true);
        Assert.Equal(FileVersionStateOutcome.NotPermitted, (await ChangeAsync(file, 0, "revoked", interactive: false)).Outcome);

        await SetPolicyAsync(approve: true);
        Assert.Equal(FileVersionStateOutcome.Changed, (await ChangeAsync(file, 0, "revoked", interactive: false)).Outcome);
        Assert.Equal("revoked", await StateOfAsync(file.Versions[0]));
    }

    [Fact]
    public async Task A_token_is_held_to_the_same_gate_through_the_api()
    {
        var file = await UploadAsync("token", 1);
        var itemId = file.ItemId;
        var versionId = file.Versions[0];
        var path = $"/api/v1/items/{itemId:D}/file/versions/{versionId:D}/state";
        var write = await TokenAsync(AccessTokenScopes.Read, AccessTokenScopes.Write);
        var readOnly = await TokenAsync(AccessTokenScopes.Read);

        using var review = await SendAsync(HttpMethod.Put, path, write, new { state = "in_review" });
        Assert.Equal(HttpStatusCode.OK, review.StatusCode);
        using var refused = await SendAsync(HttpMethod.Put, path, write, new { state = "approved" });
        Assert.Equal(HttpStatusCode.Forbidden, refused.StatusCode);
        using var scope = await SendAsync(HttpMethod.Put, path, readOnly, new { state = "draft" });
        Assert.Equal(HttpStatusCode.Forbidden, scope.StatusCode);
        using var bogus = await SendAsync(HttpMethod.Put, path, write, new { state = "published" });
        Assert.Equal(HttpStatusCode.UnprocessableEntity, bogus.StatusCode);
        using var missing = await SendAsync(HttpMethod.Put, $"/api/v1/items/{itemId:D}/file/versions/{Guid.NewGuid():D}/state", write, new { state = "draft" });
        Assert.Equal(HttpStatusCode.NotFound, missing.StatusCode);

        await SetPolicyAsync(approve: true);
        using var approved = await SendAsync(HttpMethod.Put, path, write, new { state = "approved" });
        Assert.Equal(HttpStatusCode.OK, approved.StatusCode);
        using (var body = JsonDocument.Parse(await approved.Content.ReadAsStringAsync(Cancellation)))
        {
            Assert.Equal("approved", body.RootElement.GetProperty("state").GetString());
        }
        using var again = await SendAsync(HttpMethod.Put, path, write, new { state = "approved" });
        Assert.Equal(HttpStatusCode.Conflict, again.StatusCode);
    }

    [Fact]
    public async Task The_agent_policy_is_refused_for_every_token_even_with_the_admin_scope()
    {
        var path = $"/api/v1/workspaces/{TestTenants.AlphaWorkspace:D}/agent-policy";
        var admin = await TokenAsync(AccessTokenScopes.Read, AccessTokenScopes.Write, AccessTokenScopes.Admin);

        using var response = await SendAsync(HttpMethod.Put, path, admin, new { agentsMayApprove = true });
        Assert.Equal(HttpStatusCode.Forbidden, response.StatusCode);

        await using var verify = await fixture.Application.BeginUnitOfWorkAsync(TestTenants.AlphaContext, Cancellation);
        Assert.False(await verify.DbContext.Workspaces.Where(workspace => workspace.Id == WorkspaceId.From(TestTenants.AlphaWorkspace))
            .Select(workspace => workspace.AgentsMayApprove).SingleAsync(Cancellation));
    }

    [Fact]
    public async Task The_workspace_reports_the_bytes_its_file_versions_hold()
    {
        await using var work = await fixture.Application.BeginUnitOfWorkAsync(TestTenants.AlphaContext, Cancellation);
        var workspace = WorkspaceId.From(TestTenants.AlphaWorkspace);
        var held = await work.DbContext.FileVersions.Where(version => version.WorkspaceId == workspace)
            .SumAsync(version => (long?)version.ByteLength, Cancellation) ?? 0;
        var store = work.Resolve<WorkspaceAdministrationStore>();
        Assert.True(held > 0);
        Assert.Equal(held, (await store.FindAsync(workspace, Cancellation))!.StorageUsedBytes);
        Assert.Equal(held, (await store.ListAsync(null, null, 50, Cancellation)).Single(row => row.Id == workspace).StorageUsedBytes);
    }

    [Fact]
    public async Task An_owner_sets_the_policy_audited_and_the_workspace_response_reports_it()
    {
        await using (var work = await fixture.Application.BeginUnitOfWorkAsync(TestTenants.AlphaContext, Cancellation))
        {
            var store = work.Resolve<WorkspaceAdministrationStore>();
            Assert.True(await store.SetAgentPolicyAsync(WorkspaceId.From(TestTenants.AlphaWorkspace), true, null, Cancellation));
            var found = await store.FindAsync(WorkspaceId.From(TestTenants.AlphaWorkspace), Cancellation);
            Assert.True(found!.AgentsMayApprove);
            Assert.False(found.AgentsMayCreatePublicLinks);
            await work.CommitAsync(Cancellation);
        }

        Assert.Equal(1, await MigratorCountAsync(
            "SELECT count(*) FROM audit_event WHERE action = 'workspace.agent_policy_changed' AND after->>'agentsMayApprove' = 'true'"));

        // The other tenant's owner cannot reach it: RLS hides the row, so nothing changes.
        await using var beta = await fixture.Application.BeginUnitOfWorkAsync(TestTenants.BetaContext, Cancellation);
        Assert.False(await beta.Resolve<WorkspaceAdministrationStore>()
            .SetAgentPolicyAsync(WorkspaceId.From(TestTenants.AlphaWorkspace), false, false, Cancellation));
    }

    [Fact]
    public async Task The_shown_version_is_the_latest_approved_even_with_a_draft_on_top()
    {
        var file = await UploadAsync("shown", 3);
        await ChangeAsync(file, 0, "approved", interactive: true);
        await ChangeAsync(file, 1, "approved", interactive: true);
        // Version 3 is the latest upload and still a draft; version 2 is the latest approved.

        await using var read = await fixture.Application.BeginUnitOfWorkAsync(TestTenants.AlphaContext, Cancellation);
        var files = read.Resolve<IFileStore>();
        var record = Assert.IsType<FileRecord>(await files.GetAsync(ItemId.From(file.ItemId), Cancellation));
        Assert.Equal(file.Versions[2], record.Current.Id);
        Assert.Equal(file.Versions[1], record.ShownVersionId);
        Assert.Equal("approved", record.Versions.Single(version => version.Id == file.Versions[1]).State);

        var item = ItemId.From(file.ItemId);
        Assert.Equal(file.Versions[1], (await files.AuthorizeDownloadAsync(item, null, Cancellation))!.VersionId);
        Assert.Equal(file.Versions[2], (await files.AuthorizeDownloadAsync(item, FileVersionId.From(file.Versions[2]), Cancellation))!.VersionId);
    }

    [Fact]
    public async Task With_nothing_approved_the_current_upload_is_shown_and_a_revoked_version_is_still_found_by_name_for_the_endpoint_to_refuse()
    {
        var file = await UploadAsync("fallback", 2);
        await using (var read = await fixture.Application.BeginUnitOfWorkAsync(TestTenants.AlphaContext, Cancellation))
        {
            var files = read.Resolve<IFileStore>();
            var record = Assert.IsType<FileRecord>(await files.GetAsync(ItemId.From(file.ItemId), Cancellation));
            Assert.Equal(file.Versions[1], record.ShownVersionId);
            Assert.Equal(file.Versions[1], (await files.AuthorizeDownloadAsync(ItemId.From(file.ItemId), null, Cancellation))!.VersionId);
        }

        await ChangeAsync(file, 0, "approved", interactive: true);
        await ChangeAsync(file, 0, "revoked", interactive: true);

        await using var after = await fixture.Application.BeginUnitOfWorkAsync(TestTenants.AlphaContext, Cancellation);
        var afterFiles = after.Resolve<IFileStore>();
        // Revoked is no longer approved, so the default falls back to the current upload ...
        Assert.Equal(file.Versions[1], (await afterFiles.AuthorizeDownloadAsync(ItemId.From(file.ItemId), null, Cancellation))!.VersionId);
        // ... and the store still resolves the named revoked version (state revoked) so the endpoint can answer 410.
        var named = (await afterFiles.AuthorizeDownloadAsync(
            ItemId.From(file.ItemId), FileVersionId.From(file.Versions[0]), Cancellation))!;
        Assert.Equal(file.Versions[0], named.VersionId);
        Assert.Equal("revoked", named.State);
    }

    [Fact]
    public async Task Renaming_the_item_keeps_the_exact_file_name_of_an_approved_or_revoked_version()
    {
        foreach (var state in new[] { "approved", "revoked", "in_review" })
        {
            var file = await UploadAsync("rename-" + state, 1, fileName: "report-" + state + ".pdf");
            await ForceStateAsync(file.Versions[0], state);

            await using (var rename = await fixture.Application.BeginUnitOfWorkAsync(TestTenants.AlphaContext, Cancellation))
            {
                var result = await rename.Resolve<ICommandHandler<RenameItem, Item>>()
                    .HandleAsync(new RenameItem(ItemId.From(file.ItemId), "renamed-" + state), Cancellation);
                Assert.True(result.IsSuccess);
                await rename.CommitAsync(Cancellation);
            }

            await using var verify = await fixture.Application.BeginUnitOfWorkAsync(TestTenants.AlphaContext, Cancellation);
            var name = await verify.DbContext.FileVersions.Where(version => version.ItemId == ItemId.From(file.ItemId))
                .Select(version => version.FileName).SingleAsync(Cancellation);
            // Only a draft follows the title; in_review is not a draft either, so it stays exact too.
            Assert.Equal("report-" + state + ".pdf", name);
        }
    }

    [Fact]
    public async Task Another_tenant_cannot_see_or_change_a_version()
    {
        var file = await UploadAsync("tenant", 1);

        await using var beta = await fixture.Application.BeginUnitOfWorkAsync(TestTenants.BetaContext, Cancellation);
        beta.Resolve<AccessTokenSessionContext>().SetInteractive();
        var result = await beta.Resolve<IFileStore>().SetVersionStateAsync(
            ItemId.From(file.ItemId), FileVersionId.From(file.Versions[0]), "approved",
            MayChangeApproval(beta.Resolve<AccessTokenSessionContext>()), Cancellation);
        Assert.Equal(FileVersionStateOutcome.NotFound, result.Outcome);
        Assert.Null(await beta.Resolve<IFileStore>().GetAsync(ItemId.From(file.ItemId), Cancellation));
    }

    [Fact]
    public async Task Concurrent_changes_to_one_version_serialize_so_only_one_wins()
    {
        var file = await UploadAsync("race", 1);
        var tasks = Enumerable.Range(0, 6).Select(_ => ChangeAsync(file, 0, "approved", interactive: true)).ToArray();
        var results = await Task.WhenAll(tasks);

        Assert.Equal(1, results.Count(result => result.Outcome == FileVersionStateOutcome.Changed));
        Assert.Equal(5, results.Count(result => result.Outcome == FileVersionStateOutcome.InvalidTransition));
    }

    [Fact]
    public async Task The_sync_snapshot_shows_the_approved_version_and_its_state()
    {
        var file = await UploadAsync("sync", 2);
        await ChangeAsync(file, 0, "approved", interactive: true);

        await using var read = await fixture.Application.BeginUnitOfWorkAsync(TestTenants.AlphaContext, Cancellation);
        var snapshot = await read.Resolve<IWorkspaceSync>().SnapshotAsync(
            WorkspaceId.From(TestTenants.AlphaWorkspace), null, null, 500, Cancellation);
        var item = snapshot!.Items.Single(candidate => candidate.Id == file.ItemId);
        Assert.Equal(file.Versions[0], item.File!.VersionId);
        Assert.Equal("approved", item.File.State);
    }

    // The same gate the endpoint supplies.
    private static Func<Workspace, bool> MayChangeApproval(AccessTokenSessionContext session) =>
        workspace => Nix.Features.Workspaces.AgentPolicyGate.MayChangeVersionState(session, workspace);

    private sealed record Uploaded(Guid ItemId, Guid[] Versions);

    private async Task<Uploaded> UploadAsync(string key, int versions, string fileName = "doc.pdf")
    {
        await using var work = await fixture.Application.BeginUnitOfWorkAsync(TestTenants.AlphaContext, Cancellation);
        var files = work.Resolve<IFileStore>();
        Guid? itemId = null;
        var ids = new List<Guid>();
        for (var index = 0; index < versions; index++)
        {
            var begun = Assert.IsType<FileUploadRecord>(await files.BeginAsync(
                new BeginFileUpload(
                    WorkspaceId.From(TestTenants.AlphaWorkspace),
                    null,
                    itemId is { } target ? ItemId.From(target) : null,
                    fileName,
                    "application/pdf",
                    4,
                    $"version-state-{key}-{index}"),
                Cancellation));
            Assert.NotNull(await files.QueueInspectionAsync(FileUploadId.From(begun.Id), Cancellation));
            var published = Assert.IsType<FileRecord>(await files.CompleteAsync(
                new CompleteFileUpload(FileUploadId.From(begun.Id), "application/pdf", 4, new string('a', 64), Previewable: false, PixelWidth: null, PixelHeight: null),
                Cancellation));
            itemId = published.ItemId;
            ids.Add(published.Current.Id);
        }
        await work.CommitAsync(Cancellation);
        return new Uploaded(itemId!.Value, [.. ids]);
    }

    private async Task<FileVersionStateResult> ChangeAsync(Uploaded file, int index, string state, bool interactive)
    {
        await using var work = await fixture.Application.BeginUnitOfWorkAsync(TestTenants.AlphaContext, Cancellation);
        if (interactive)
        {
            work.Resolve<AccessTokenSessionContext>().SetInteractive();
        }
        else
        {
            // The non-interactive caller here is an external bearer, as the middleware would mark it.
            work.Resolve<AccessTokenSessionContext>().SetExternalBearer();
        }

        var result = await work.Resolve<IFileStore>().SetVersionStateAsync(
            ItemId.From(file.ItemId), FileVersionId.From(file.Versions[index]), state,
            MayChangeApproval(work.Resolve<AccessTokenSessionContext>()), Cancellation);
        await work.CommitAsync(Cancellation);
        return result;
    }

    private Task ForceStateAsync(Guid versionId, string state) =>
        MigratorAsync($"UPDATE file_version SET state = '{state}' WHERE file_version_id = '{versionId}'");

    private Task SetPolicyAsync(bool approve) =>
        MigratorAsync($"UPDATE workspace SET agents_may_approve = {(approve ? "true" : "false")} WHERE workspace_id = '{TestTenants.AlphaWorkspace}'");

    private async Task<long> MigratorCountAsync(string sql)
    {
        await using var connection = await fixture.OpenMigratorConnectionAsync();
#pragma warning disable CA2100 // Static test text with test-owned ids.
        await using var command = new Npgsql.NpgsqlCommand(sql, connection);
#pragma warning restore CA2100
        return (long)(await command.ExecuteScalarAsync(Cancellation))!;
    }

    private async Task MigratorAsync(string sql)
    {
        await using var connection = await fixture.OpenMigratorConnectionAsync();
#pragma warning disable CA2100 // Static test text with test-owned ids.
        await using var command = new Npgsql.NpgsqlCommand(sql, connection);
#pragma warning restore CA2100
        await command.ExecuteNonQueryAsync(Cancellation);
    }

    private async Task<string> StateOfAsync(Guid versionId)
    {
        await using var read = await fixture.Application.BeginUnitOfWorkAsync(TestTenants.AlphaContext, Cancellation);
        return await read.DbContext.FileVersions.Where(version => version.Id == FileVersionId.From(versionId))
            .Select(version => version.State).SingleAsync(Cancellation);
    }

    private async Task<string> TokenAsync(params string[] scopes)
    {
        await using var work = await fixture.Application.BeginUnitOfWorkAsync(TestTenants.AlphaContext, Cancellation);
        var result = await work.Resolve<NixDispatcher>().SendAsync<CreateAccessToken, IssuedAccessToken>(
            new CreateAccessToken("version-state", scopes, 1), Cancellation);
        Assert.True(result.IsSuccess, result.IsFailure ? result.Error.Message : string.Empty);
        await work.CommitAsync(Cancellation);
        using var exchange = await _client.PostAsJsonAsync("/public/v1/auth/token", new { token = result.Value.Secret }, Cancellation);
        exchange.EnsureSuccessStatusCode();
        using var body = JsonDocument.Parse(await exchange.Content.ReadAsStringAsync(Cancellation));
        return body.RootElement.GetProperty("accessToken").GetString()!;
    }

    private async Task<HttpResponseMessage> SendAsync(HttpMethod method, string path, string bearer, object? body)
    {
        using var request = new HttpRequestMessage(method, path);
        request.Headers.Authorization = new AuthenticationHeaderValue("Bearer", bearer);
        if (body is not null)
        {
            request.Content = JsonContent.Create(body);
        }
        return await _client.SendAsync(request, Cancellation);
    }
}
