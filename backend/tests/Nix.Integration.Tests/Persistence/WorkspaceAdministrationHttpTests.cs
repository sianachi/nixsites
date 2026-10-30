using System.Net;
using System.Net.Http.Headers;
using System.Net.Http.Json;
using System.Security.Cryptography;
using System.Text.Json;
using Microsoft.AspNetCore.Mvc.Testing;
using Nix.Abstractions;
using Nix.Authentication;
using Nix.Domain.Identity;
using Nix.Domain.Provisioning;
using Nix.Domain.Tenancy;
using Nix.Features.Tokens;
using Nix.Integration.Tests.Harness;
using Nix.Messaging;

namespace Nix.Integration.Tests.Persistence;

[Collection(PostgresSecondaryCollectionDefinition.Name)]
public sealed class WorkspaceAdministrationHttpTests : IAsyncLifetime
{
    private static readonly Guid Owner = new("81818181-1111-4111-8111-818181818181");
    private static readonly Guid Viewer = new("82828282-2222-4222-8222-828282828282");
    private static readonly Guid Invitee = new("84848484-4444-4444-8444-848484848484");
    private static readonly Guid PersonalWorkspace = new("83838383-3333-4333-8333-838383838383");
    private readonly NixPostgresFixture _fixture;
    private WebApplicationFactory<Program> _factory = null!;
    private HttpClient _client = null!;

    public WorkspaceAdministrationHttpTests(NixPostgresFixture fixture) => _fixture = fixture;

    private static CancellationToken Cancellation => TestContext.Current.CancellationToken;

    public async ValueTask InitializeAsync()
    {
        await _fixture.ResetAsync();
        await M0SchemaSeed.SeedBothTenantsAsync(_fixture);
        await SeedAsync();
        string signingKey;
        using (var key = ECDsa.Create(ECCurve.NamedCurves.nistP256))
        {
            signingKey = key.ExportECPrivateKeyPem();
        }
        _factory = new ConfiguredApplicationFactory(new Dictionary<string, string?>
        {
            ["ConnectionStrings:Nix"] = _fixture.ApplicationConnectionString,
            [SelfIssuedTokenService.IssuerConfigurationKey] = "https://core.workspace-http.test",
            [SelfIssuedTokenService.AudienceConfigurationKey] = "nix",
            [SelfIssuedTokenService.KeyIdConfigurationKey] = "workspace-http-key",
            [SelfIssuedTokenService.SigningKeyConfigurationKey] = signingKey,
        });
        _client = _factory.CreateClient();
    }

    public async ValueTask DisposeAsync()
    {
        _client.Dispose();
        await _factory.DisposeAsync();
    }

    [Fact]
    public async Task Invalid_input_and_cursor_are_422_with_stable_codes()
    {
        var jwt = await JwtAsync(Owner);
        var cursor = await SendAsync(HttpMethod.Get, "/api/v1/workspaces?cursor=not-base64", jwt);
        Assert.Equal(HttpStatusCode.UnprocessableEntity, cursor.StatusCode);
        Assert.Equal("paging.invalid_cursor", await ProblemCodeAsync(cursor));

        var invalidSearch = await SendAsync(HttpMethod.Get,
            $"/api/v1/workspaces/{PersonalWorkspace:D}/invitees?query={new string('a', 129)}", jwt);
        Assert.Equal(HttpStatusCode.UnprocessableEntity, invalidSearch.StatusCode);
        Assert.Equal("workspaces.invitee_search_invalid", await ProblemCodeAsync(invalidSearch));

        var invalidName = await SendAsync(HttpMethod.Post, "/api/v1/workspaces", jwt, new { name = "" });
        Assert.Equal(HttpStatusCode.UnprocessableEntity, invalidName.StatusCode);
        Assert.Equal("workspaces.invalid_name", await ProblemCodeAsync(invalidName));

        var unknownRoleInvitation = await SendAsync(HttpMethod.Post,
            $"/api/v1/workspaces/{PersonalWorkspace:D}/invitations", jwt,
            new { principalId = Invitee, role = "admin" });
        Assert.Equal(HttpStatusCode.UnprocessableEntity, unknownRoleInvitation.StatusCode);
        Assert.Equal("workspaces.invalid_invitation", await ProblemCodeAsync(unknownRoleInvitation));

        var unknownRoleMember = await SendAsync(HttpMethod.Patch,
            $"/api/v1/workspaces/{PersonalWorkspace:D}/members/{Viewer:D}", jwt,
            new { role = "admin" });
        Assert.Equal(HttpStatusCode.UnprocessableEntity, unknownRoleMember.StatusCode);
        Assert.Equal("workspaces.invalid_role", await ProblemCodeAsync(unknownRoleMember));
    }

    [Fact]
    public async Task The_commenter_role_can_be_invited_accepted_and_assigned()
    {
        var ownerJwt = await JwtAsync(Owner);
        var invited = await SendAsync(HttpMethod.Post,
            $"/api/v1/workspaces/{PersonalWorkspace:D}/invitations", ownerJwt,
            new { principalId = Invitee, role = "commenter" });
        Assert.Equal(HttpStatusCode.Created, invited.StatusCode);
        using var invitation = JsonDocument.Parse(await invited.Content.ReadAsStringAsync(Cancellation));
        var invitationId = invitation.RootElement.GetProperty("id").GetGuid();
        Assert.Equal("commenter", invitation.RootElement.GetProperty("role").GetString());

        var accepted = await SendAsync(HttpMethod.Post,
            $"/api/v1/workspaces/{PersonalWorkspace:D}/invitations/{invitationId:D}/accept",
            await JwtAsync(Invitee));
        Assert.True(accepted.IsSuccessStatusCode, await accepted.Content.ReadAsStringAsync(Cancellation));

        var changed = await SendAsync(HttpMethod.Patch,
            $"/api/v1/workspaces/{PersonalWorkspace:D}/members/{Viewer:D}", ownerJwt, new { role = "commenter" });
        Assert.Equal(HttpStatusCode.OK, changed.StatusCode);
        using var member = JsonDocument.Parse(await changed.Content.ReadAsStringAsync(Cancellation));
        Assert.Equal("commenter", member.RootElement.GetProperty("role").GetString());

        var members = await SendAsync(HttpMethod.Get, $"/api/v1/workspaces/{PersonalWorkspace:D}/members", ownerJwt);
        var body = await members.Content.ReadAsStringAsync(Cancellation);
        Assert.Contains(Invitee.ToString("D"), body, StringComparison.Ordinal);
    }

    [Fact]
    public async Task Absent_and_inaccessible_workspaces_are_the_same_opaque_404()
    {
        var viewerJwt = await JwtAsync(Viewer);
        var absent = await SendAsync(
            HttpMethod.Get, $"/api/v1/workspaces/{Guid.CreateVersion7():D}", viewerJwt);
        var inaccessible = await SendAsync(
            HttpMethod.Get, $"/api/v1/workspaces/{M0SchemaSeed.Alpha.WorkspaceId:D}", viewerJwt);
        Assert.Equal(HttpStatusCode.NotFound, absent.StatusCode);
        Assert.Equal(HttpStatusCode.NotFound, inaccessible.StatusCode);
        Assert.Equal("workspaces.not_found", await ProblemCodeAsync(absent));
        Assert.Equal("workspaces.not_found", await ProblemCodeAsync(inaccessible));
    }

    [Fact]
    public async Task Nonadministrator_recovery_is_403_and_active_owner_recovery_is_409()
    {
        var ownerJwt = await JwtAsync(Owner);
        var forbidden = await SendAsync(HttpMethod.Post,
            $"/api/v1/workspaces/{PersonalWorkspace:D}/recover", ownerJwt,
            new { newOwnerPrincipalId = Viewer });
        Assert.Equal(HttpStatusCode.Forbidden, forbidden.StatusCode);
        Assert.Equal("workspaces.recovery_forbidden", await ProblemCodeAsync(forbidden));

        var administratorJwt = await JwtAsync(M0SchemaSeed.Alpha.PrincipalId);
        var conflict = await SendAsync(HttpMethod.Post,
            $"/api/v1/workspaces/{PersonalWorkspace:D}/recover", administratorJwt,
            new { newOwnerPrincipalId = Viewer });
        Assert.Equal(HttpStatusCode.Conflict, conflict.StatusCode);
        Assert.Equal("workspaces.recovery_refused", await ProblemCodeAsync(conflict));
    }

    [Fact]
    public async Task Revoking_a_nonpending_invitation_is_409_and_viewer_daily_open_is_404()
    {
        var ownerJwt = await JwtAsync(Owner);
        var invited = await SendAsync(HttpMethod.Post,
            $"/api/v1/workspaces/{PersonalWorkspace:D}/invitations", ownerJwt,
            new { principalId = Invitee, role = "viewer" });
        Assert.Equal(HttpStatusCode.Created, invited.StatusCode);
        using var invitation = JsonDocument.Parse(await invited.Content.ReadAsStringAsync(Cancellation));
        var invitationId = invitation.RootElement.GetProperty("id").GetGuid();
        var revoked = await SendAsync(HttpMethod.Delete,
            $"/api/v1/workspaces/{PersonalWorkspace:D}/invitations/{invitationId:D}", ownerJwt);
        Assert.Equal(HttpStatusCode.NoContent, revoked.StatusCode);
        var repeated = await SendAsync(HttpMethod.Delete,
            $"/api/v1/workspaces/{PersonalWorkspace:D}/invitations/{invitationId:D}", ownerJwt);
        Assert.Equal(HttpStatusCode.Conflict, repeated.StatusCode);
        Assert.Equal("workspaces.invitation_not_pending", await ProblemCodeAsync(repeated));

        var viewerJwt = await JwtAsync(Viewer);
        var daily = await SendAsync(HttpMethod.Put,
            $"/api/v1/workspaces/{PersonalWorkspace:D}/daily-notes/2026-08-30", viewerJwt);
        Assert.Equal(HttpStatusCode.NotFound, daily.StatusCode);
        Assert.Equal("workspaces.not_found", await ProblemCodeAsync(daily));
    }

    [Fact]
    public async Task A_trashed_daily_note_is_409_and_a_locked_one_is_423_never_a_missing_workspace()
    {
        var ownerJwt = await JwtAsync(Owner);
        var path = $"/api/v1/workspaces/{PersonalWorkspace:D}/daily-notes/2026-08-30";
        var opened = await SendAsync(HttpMethod.Put, path, ownerJwt);
        Assert.Equal(HttpStatusCode.OK, opened.StatusCode);
        Guid itemId;
        using (var document = JsonDocument.Parse(await opened.Content.ReadAsStringAsync(Cancellation)))
        {
            itemId = document.RootElement.GetProperty("itemId").GetGuid();
        }

        await ExecuteAsMigratorAsync($"UPDATE item SET lifecycle_state = 'deleted' WHERE id = '{itemId:D}'");
        var trashed = await SendAsync(HttpMethod.Put, path, ownerJwt);
        Assert.Equal(HttpStatusCode.Conflict, trashed.StatusCode);
        Assert.Equal("workspaces.daily_note_in_trash", await ProblemCodeAsync(trashed));

        await ExecuteAsMigratorAsync($"""
            UPDATE item SET lifecycle_state = 'active' WHERE id = '{itemId:D}';
            INSERT INTO item_lock (item_id, tenant_id, password_hash, locked_by, locked_at)
            VALUES ('{DeterministicProvisioningId.DailyNotesRoot(WorkspaceId.From(PersonalWorkspace)):D}',
                    '{M0SchemaSeed.Alpha.TenantId:D}', '{new string('a', 64)}', '{Owner:D}', now());
            """);
        var locked = await SendAsync(HttpMethod.Put, path, ownerJwt);
        Assert.Equal(HttpStatusCode.Locked, locked.StatusCode);
        Assert.Equal("workspaces.daily_note_locked", await ProblemCodeAsync(locked));
    }

    [Fact]
    public async Task Workspace_lifecycle_requires_archive_before_scheduling_permanent_deletion()
    {
        var ownerJwt = await JwtAsync(Owner);

        var refused = await SendAsync(HttpMethod.Delete, $"/api/v1/workspaces/{PersonalWorkspace:D}", ownerJwt);
        Assert.Equal(HttpStatusCode.Conflict, refused.StatusCode);
        Assert.Equal("workspaces.purge_refused", await ProblemCodeAsync(refused));

        var archived = await SendAsync(
            HttpMethod.Post, $"/api/v1/workspaces/{PersonalWorkspace:D}/archive", ownerJwt);
        Assert.Equal(HttpStatusCode.OK, archived.StatusCode);
        using (var document = JsonDocument.Parse(await archived.Content.ReadAsStringAsync(Cancellation)))
        {
            Assert.Equal("archived", document.RootElement.GetProperty("lifecycleState").GetString());
            Assert.False(document.RootElement.GetProperty("archivedAt").ValueKind == JsonValueKind.Null);
        }

        var restored = await SendAsync(
            HttpMethod.Post, $"/api/v1/workspaces/{PersonalWorkspace:D}/restore", ownerJwt);
        Assert.Equal(HttpStatusCode.OK, restored.StatusCode);
        using (var document = JsonDocument.Parse(await restored.Content.ReadAsStringAsync(Cancellation)))
        {
            Assert.Equal("active", document.RootElement.GetProperty("lifecycleState").GetString());
            Assert.Equal(JsonValueKind.Null, document.RootElement.GetProperty("archivedAt").ValueKind);
        }

        var archivedAgain = await SendAsync(
            HttpMethod.Post, $"/api/v1/workspaces/{PersonalWorkspace:D}/archive", ownerJwt);
        Assert.Equal(HttpStatusCode.OK, archivedAgain.StatusCode);

        var purging = await SendAsync(HttpMethod.Delete, $"/api/v1/workspaces/{PersonalWorkspace:D}", ownerJwt);
        Assert.Equal(HttpStatusCode.Accepted, purging.StatusCode);
    }

    private async Task<string> JwtAsync(Guid principalId)
    {
        var work = await _fixture.Application.BeginUnitOfWorkAsync(Context(principalId), Cancellation);
        IssuedAccessToken issued;
        await using (work.ConfigureAwait(false))
        {
            var result = await work.Resolve<NixDispatcher>().SendAsync<CreateAccessToken, IssuedAccessToken>(
                new CreateAccessToken("workspace-http", [AccessTokenScopes.Read, AccessTokenScopes.Write,
                    AccessTokenScopes.Admin], 1), Cancellation);
            Assert.True(result.IsSuccess, result.IsFailure ? result.Error.Message : string.Empty);
            issued = result.Value;
            await work.CommitAsync(Cancellation);
        }
        var exchange = await _client.PostAsJsonAsync(
            "/public/v1/auth/token", new { token = issued.Secret }, Cancellation);
        exchange.EnsureSuccessStatusCode();
        using var document = JsonDocument.Parse(await exchange.Content.ReadAsStringAsync(Cancellation));
        return document.RootElement.GetProperty("accessToken").GetString()!;
    }

    private async Task<HttpResponseMessage> SendAsync(HttpMethod method, string path, string jwt, object? body = null)
    {
        using var request = new HttpRequestMessage(method, path);
        request.Headers.Authorization = new AuthenticationHeaderValue("Bearer", jwt);
        if (body is not null)
        {
            request.Content = JsonContent.Create(body);
        }

        return await _client.SendAsync(request, Cancellation);
    }

    private static async Task<string?> ProblemCodeAsync(HttpResponseMessage response)
    {
        using var document = JsonDocument.Parse(await response.Content.ReadAsStringAsync(Cancellation));
        return document.RootElement.GetProperty("code").GetString();
    }

    private async Task ExecuteAsMigratorAsync(string sql)
    {
        var connection = await _fixture.OpenMigratorConnectionAsync();
        await using (connection.ConfigureAwait(false))
        {
            await RawSql.ExecuteAsync(connection, null, sql);
        }
    }

    private async Task SeedAsync()
    {
        var connection = await _fixture.OpenMigratorConnectionAsync();
        await using (connection.ConfigureAwait(false))
        {
            await RawSql.ExecuteAsync(connection, null, $"""
                INSERT INTO principal
                    (principal_id, tenant_id, external_issuer, external_subject, kind, display_name,
                     email, email_normalized, email_verified, status)
                VALUES
                    ('{Owner:D}', '{M0SchemaSeed.Alpha.TenantId:D}', 'https://http.test', 'owner',
                     'user', 'Owner', 'owner@http.test', 'owner@http.test', true, 'active'),
                    ('{Viewer:D}', '{M0SchemaSeed.Alpha.TenantId:D}', 'https://http.test', 'viewer',
                     'user', 'Viewer', 'viewer@http.test', 'viewer@http.test', true, 'active'),
                    ('{Invitee:D}', '{M0SchemaSeed.Alpha.TenantId:D}', 'https://http.test', 'invitee',
                     'user', 'Invitee', 'invitee@http.test', 'invitee@http.test', true, 'active');
                INSERT INTO workspace
                    (workspace_id, tenant_id, name, version_retention_days, coalesce_window_min,
                     storage_quota_bytes, created_at, personal_owner_principal_id)
                VALUES ('{PersonalWorkspace:D}', '{M0SchemaSeed.Alpha.TenantId:D}', 'Personal',
                        90, 10, 10737418240, now(), '{Owner:D}');
                INSERT INTO workspace_member
                    (workspace_id, subject_type, subject_id, tenant_id, role, granted_by, granted_at)
                VALUES
                    ('{PersonalWorkspace:D}', 'principal', '{Owner:D}', '{M0SchemaSeed.Alpha.TenantId:D}',
                     'owner', '{Owner:D}', now()),
                    ('{PersonalWorkspace:D}', 'principal', '{Viewer:D}', '{M0SchemaSeed.Alpha.TenantId:D}',
                     'viewer', '{Owner:D}', now());
                """);
        }
    }

    private static NixSessionContext Context(Guid principalId) => NixSessionContext.ForTenant(
        TenantId.From(M0SchemaSeed.Alpha.TenantId), PrincipalId.From(principalId));

    private sealed class ConfiguredApplicationFactory(Dictionary<string, string?> settings)
        : WebApplicationFactory<Program>
    {
        protected override void ConfigureWebHost(Microsoft.AspNetCore.Hosting.IWebHostBuilder builder)
        {
            foreach (var (key, value) in settings)
            {
                builder.UseSetting(key, value);
            }
        }
    }
}
