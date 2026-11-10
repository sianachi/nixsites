using System.Net;
using System.Net.Http.Headers;
using System.Net.Http.Json;
using System.Security.Cryptography;
using System.Text.Json;
using Microsoft.AspNetCore.Mvc.Testing;
using Nix.Abstractions;
using Nix.Authentication;
using Nix.Domain.Identity;
using Nix.Domain.Items;
using Nix.Domain.Tenancy;
using Nix.Features.Tokens;
using Nix.Integration.Tests.Harness;
using Nix.Messaging;

namespace Nix.Integration.Tests.Persistence;

/// <summary>
/// Workspace passwords through the real pipeline: the credential the middleware records, the
/// resolver every read asks, the lock routes and the collaboration service's authorization.
/// </summary>
/// <remarks>
/// A workspace with a password is closed to its members until they present it; joining by it adds
/// a same-tenant person as a viewer. Each personal access token is its own credential, so two
/// tokens held by one person are two separate unlocks.
/// </remarks>
[Collection(PostgresSecondaryCollectionDefinition.Name)]
public sealed class WorkspaceLockHttpTests : IAsyncLifetime
{
    private const string InternalSecret = "workspace-lock-http-internal-secret";
    private const string Password = "correct horse";

    private static readonly Guid Owner = new("91919191-1111-4111-8111-919191919191");
    private static readonly Guid Editor = new("92929292-1111-4111-8111-929292929292");
    private static readonly Guid Outsider = new("93939393-1111-4111-8111-939393939393");
    private static readonly Guid Newcomer = new("94949494-1111-4111-8111-949494949494");
    private static readonly Guid BetaPerson = new("95959595-2222-4222-8222-959595959595");

    private static readonly Guid Vault = new("a1a1a1a1-1111-4111-8111-a1a1a1a1a1a1");
    private static readonly Guid Plain = new("a2a2a2a2-1111-4111-8111-a2a2a2a2a2a2");
    private static readonly Guid Closed = new("a3a3a3a3-1111-4111-8111-a3a3a3a3a3a3");
    private static readonly Guid Archived = new("a4a4a4a4-1111-4111-8111-a4a4a4a4a4a4");

    private readonly NixPostgresFixture _fixture;
    private WebApplicationFactory<Program> _factory = null!;
    private HttpClient _client = null!;

    public WorkspaceLockHttpTests(NixPostgresFixture fixture) => _fixture = fixture;

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
            [InternalBoundaryMiddleware.SecretConfigurationKey] = InternalSecret,
            [SelfIssuedTokenService.IssuerConfigurationKey] = "https://core.workspace-lock.test",
            [SelfIssuedTokenService.AudienceConfigurationKey] = "nix",
            [SelfIssuedTokenService.KeyIdConfigurationKey] = "workspace-lock-key",
            [SelfIssuedTokenService.SigningKeyConfigurationKey] = signingKey,
            ["Nix:RateLimits:LockPasswordAttemptsPerMinute"] = "1000",
            ["Nix:RateLimits:WritesPerMinute"] = "1000",
            ["Nix:Collaboration:BaseUrl"] = "http://127.0.0.1:8100",
            ["Nix:ObjectStorage:Endpoint"] = "http://127.0.0.1:7070",
            ["Nix:ObjectStorage:Region"] = "us-east-1",
            ["Nix:ObjectStorage:Bucket"] = "nix-objects",
            ["Nix:ObjectStorage:AccessKey"] = "lock-access",
            ["Nix:ObjectStorage:SecretKey"] = "lock-secret",
        });
        _client = _factory.CreateClient();
    }

    public async ValueTask DisposeAsync()
    {
        _client.Dispose();
        await _factory.DisposeAsync();
    }

    [Fact]
    public async Task A_member_without_a_grant_sees_nothing_and_a_grant_opens_it_until_it_ends()
    {
        var owner = await TokenAsync(Owner);
        var itemId = await CreateNoteAsync(owner, "Secret title");
        await SetPasswordAsync(owner, Vault);

        var first = await TokenAsync(Editor);
        var second = await TokenAsync(Editor);

        await AssertClosedAsync(first, itemId);
        await AssertClosedAsync(second, itemId);

        // The list shows the name and that it is locked, and nothing else.
        using (var list = await SendAsync(HttpMethod.Get, "/api/v1/workspaces", first))
        {
            using var body = JsonDocument.Parse(await list.Content.ReadAsStringAsync(Cancellation));
            var row = body.RootElement.GetProperty("items").EnumerateArray()
                .Single(item => item.GetProperty("id").GetGuid() == Vault);
            Assert.Equal("Vault", row.GetProperty("name").GetString());
            Assert.True(row.GetProperty("passwordProtected").GetBoolean());
            Assert.Equal(JsonValueKind.Null, row.GetProperty("unlockedUntil").ValueKind);
            Assert.False(row.GetProperty("canManageMembers").GetBoolean());
            Assert.Equal(0, row.GetProperty("storageQuotaBytes").GetInt64());
        }

        // Member management reads its own SQL; the workspace group refuses it while closed.
        using (var members = await SendAsync(HttpMethod.Get, $"/api/v1/workspaces/{Vault:D}/members", first))
        {
            Assert.Equal(HttpStatusCode.NotFound, members.StatusCode);
        }

        // A wrong password opens nothing; the right one opens this credential and no other.
        using (var wrong = await SendAsync(HttpMethod.Post, $"/api/v1/workspaces/{Vault:D}/unlock", first, new { password = "nope nope" }))
        {
            Assert.Equal(HttpStatusCode.Forbidden, wrong.StatusCode);
            Assert.Equal("workspaces.wrong_password", await ProblemCodeAsync(wrong));
        }

        using (var unlocked = await SendAsync(HttpMethod.Post, $"/api/v1/workspaces/{Vault:D}/unlock", first, new { password = Password }))
        {
            Assert.Equal(HttpStatusCode.OK, unlocked.StatusCode);
        }

        await AssertOpenAsync(first, itemId);
        await AssertClosedAsync(second, itemId);

        // Expiry: the grant stops counting the moment it passes, with no sweep needed.
        await ExecuteAsMigratorAsync("UPDATE workspace_unlock SET expires_at = now() - interval '1 second' WHERE credential_id IS NOT NULL");
        await AssertClosedAsync(first, itemId);

        // Relock drops this credential's grant only.
        using (await SendAsync(HttpMethod.Post, $"/api/v1/workspaces/{Vault:D}/unlock", first, new { password = Password }))
        {
        }

        using (await SendAsync(HttpMethod.Post, $"/api/v1/workspaces/{Vault:D}/unlock", second, new { password = Password }))
        {
        }

        await AssertOpenAsync(first, itemId);
        using (var relock = await SendAsync(HttpMethod.Delete, $"/api/v1/workspaces/{Vault:D}/unlock", first))
        {
            Assert.Equal(HttpStatusCode.NoContent, relock.StatusCode);
        }

        await AssertClosedAsync(first, itemId);
        await AssertOpenAsync(second, itemId);

        // Changing the password ends every grant.
        using (var changed = await SendAsync(
            HttpMethod.Put, $"/api/v1/workspaces/{Vault:D}/password", owner,
            new { password = "a different one", currentPassword = Password }))
        {
            Assert.Equal(HttpStatusCode.NoContent, changed.StatusCode);
        }

        await AssertClosedAsync(second, itemId);

        // Removing the password opens the workspace to everybody who is a member.
        using (var removed = await SendAsync(
            HttpMethod.Post, $"/api/v1/workspaces/{Vault:D}/password/remove", owner, new { password = "a different one" }))
        {
            Assert.Equal(HttpStatusCode.NoContent, removed.StatusCode);
        }

        await AssertOpenAsync(first, itemId);
    }

    [Fact]
    public async Task Only_an_owner_sets_the_password_and_changing_or_removing_it_needs_the_current_one()
    {
        var owner = await TokenAsync(Owner);
        var editor = await TokenAsync(Editor);
        var outsider = await TokenAsync(Outsider);

        foreach (var token in new[] { editor, outsider })
        {
            using var refused = await SendAsync(
                HttpMethod.Put, $"/api/v1/workspaces/{Vault:D}/password", token, new { password = Password });
            Assert.Equal(HttpStatusCode.NotFound, refused.StatusCode);
        }

        using (var tooShort = await SendAsync(HttpMethod.Put, $"/api/v1/workspaces/{Vault:D}/password", owner, new { password = "abc" }))
        {
            Assert.Equal(HttpStatusCode.BadRequest, tooShort.StatusCode);
            Assert.Equal("workspaces.password_invalid", await ProblemCodeAsync(tooShort));
        }

        await SetPasswordAsync(owner, Vault);

        using (var noCurrent = await SendAsync(HttpMethod.Put, $"/api/v1/workspaces/{Vault:D}/password", owner, new { password = "something else" }))
        {
            Assert.Equal(HttpStatusCode.Conflict, noCurrent.StatusCode);
            Assert.Equal("workspaces.password_exists", await ProblemCodeAsync(noCurrent));
        }

        using (var wrongCurrent = await SendAsync(
            HttpMethod.Put, $"/api/v1/workspaces/{Vault:D}/password", owner, new { password = "something else", currentPassword = "wrong one" }))
        {
            Assert.Equal(HttpStatusCode.Forbidden, wrongCurrent.StatusCode);
        }

        using (var wrongRemove = await SendAsync(
            HttpMethod.Post, $"/api/v1/workspaces/{Vault:D}/password/remove", owner, new { password = "wrong one" }))
        {
            Assert.Equal(HttpStatusCode.Forbidden, wrongRemove.StatusCode);
        }

        using (var notSet = await SendAsync(
            HttpMethod.Post, $"/api/v1/workspaces/{Plain:D}/password/remove", owner, new { password = Password }))
        {
            Assert.Equal(HttpStatusCode.Conflict, notSet.StatusCode);
            Assert.Equal("workspaces.password_not_set", await ProblemCodeAsync(notSet));
        }
    }

    [Fact]
    public async Task Joining_by_password_adds_a_viewer_and_unlocks_this_session()
    {
        var owner = await TokenAsync(Owner);
        var itemId = await CreateNoteAsync(owner, "Joined title");
        await SetPasswordAsync(owner, Vault);

        var newcomer = await TokenAsync(Newcomer);
        await AssertClosedAsync(newcomer, itemId, member: false);

        using (var joined = await SendAsync(HttpMethod.Post, $"/api/v1/workspaces/{Vault:D}/join", newcomer, new { password = Password }))
        {
            Assert.Equal(HttpStatusCode.OK, joined.StatusCode);
        }

        await AssertOpenAsync(newcomer, itemId);

        // A viewer: reads, but the write is refused.
        using (var write = await SendAsync(
            HttpMethod.Post, $"/api/v1/workspaces/{Vault:D}/items", newcomer, new { type = "note", title = "Not allowed" }))
        {
            Assert.Equal(HttpStatusCode.NotFound, write.StatusCode);
        }

        Assert.Equal("viewer", await RoleOfAsync(Newcomer));

        // Another session of the same person is a member who has not unlocked.
        var elsewhere = await TokenAsync(Newcomer);
        await AssertClosedAsync(elsewhere, itemId);

        // An existing member who joins only unlocks; their role does not move.
        var editor = await TokenAsync(Editor);
        using (var again = await SendAsync(HttpMethod.Post, $"/api/v1/workspaces/{Vault:D}/join", editor, new { password = Password }))
        {
            Assert.Equal(HttpStatusCode.OK, again.StatusCode);
        }

        Assert.Equal("editor", await RoleOfAsync(Editor));
        await AssertOpenAsync(editor, itemId);

        Assert.Equal(1, await CountAsync($"SELECT count(*) FROM audit_event WHERE action = 'workspace.member_joined' AND subject_id = '{Newcomer:D}'"));
    }

    [Fact]
    public async Task Every_way_a_join_can_fail_answers_the_same_and_nothing_is_disclosed()
    {
        var owner = await TokenAsync(Owner);
        await SetPasswordAsync(owner, Vault);
        await SetPasswordAsync(owner, Closed);
        await SetPasswordAsync(owner, Archived);
        await ExecuteAsMigratorAsync($"UPDATE workspace SET membership_locked = true WHERE workspace_id = '{Closed:D}'");
        await ExecuteAsMigratorAsync($"UPDATE workspace SET lifecycle_state = 'archived', archived_at = now() WHERE workspace_id = '{Archived:D}'");

        var outsider = await TokenAsync(Outsider);
        var betaPerson = await TokenAsync(BetaPerson, M0SchemaSeed.Beta.TenantId);
        var attempts = new List<(string Name, string Token, Guid Workspace, string Password)>
        {
            ("wrong password", outsider, Vault, "not the password"),
            ("unknown workspace", outsider, Guid.CreateVersion7(), Password),
            ("no password set", outsider, Plain, Password),
            ("membership closed", outsider, Closed, Password),
            ("archived", outsider, Archived, Password),
            ("another tenant", betaPerson, Vault, Password),
        };

        var shapes = new List<(HttpStatusCode Status, string? Code, string? Title, string? Detail)>();
        foreach (var (_, token, workspace, password) in attempts)
        {
            using var response = await SendAsync(HttpMethod.Post, $"/api/v1/workspaces/{workspace:D}/join", token, new { password });
            var text = await response.Content.ReadAsStringAsync(Cancellation);
            Assert.DoesNotContain("Vault", text, StringComparison.Ordinal);
            using var document = JsonDocument.Parse(text);
            shapes.Add((
                response.StatusCode,
                document.RootElement.GetProperty("code").GetString(),
                document.RootElement.GetProperty("title").GetString(),
                document.RootElement.GetProperty("detail").GetString()));
        }

        Assert.Equal(HttpStatusCode.Forbidden, shapes[0].Status);
        Assert.Equal("workspaces.join_refused", shapes[0].Code);
        Assert.All(shapes, shape => Assert.Equal(shapes[0], shape));
        Assert.Equal(0, await CountAsync("SELECT count(*) FROM workspace_member WHERE subject_id IN ("
            + $"'{Outsider:D}', '{BetaPerson:D}')"));

        // A non-member cannot unlock or relock either: the standard not found.
        using var unlock = await SendAsync(HttpMethod.Post, $"/api/v1/workspaces/{Vault:D}/unlock", outsider, new { password = Password });
        Assert.Equal(HttpStatusCode.NotFound, unlock.StatusCode);
    }

    [Fact]
    public async Task Repeated_wrong_passwords_are_throttled_whether_or_not_the_workspace_exists()
    {
        var owner = await TokenAsync(Owner);
        await SetPasswordAsync(owner, Vault);
        var outsider = await TokenAsync(Outsider);

        foreach (var workspace in new[] { Vault, Guid.CreateVersion7() })
        {
            HttpStatusCode last = default;
            for (var attempt = 0; attempt < 8; attempt++)
            {
                using var response = await SendAsync(
                    HttpMethod.Post, $"/api/v1/workspaces/{workspace:D}/join", outsider, new { password = $"guess number {attempt}" });
                last = response.StatusCode;
                if (last == HttpStatusCode.TooManyRequests)
                {
                    Assert.Equal("workspaces.too_many_attempts", await ProblemCodeAsync(response));
                    break;
                }
            }

            Assert.Equal(HttpStatusCode.TooManyRequests, last);
        }
    }

    [Fact]
    public async Task Notifications_and_operations_about_a_closed_workspace_are_withheld()
    {
        var owner = await TokenAsync(Owner);
        await SetPasswordAsync(owner, Vault);
        var editor = await TokenAsync(Editor);
        await ExecuteAsMigratorAsync($"""
            INSERT INTO notification (tenant_id, id, principal_id, kind, title, body, workspace_id, created_at, dedupe_key)
            VALUES ('{M0SchemaSeed.Alpha.TenantId:D}', gen_random_uuid(), '{Editor:D}', 'reminder', 'Secret reminder', 'Due today',
                    '{Vault:D}', now(), 'workspace-lock-test');
            """);

        Assert.DoesNotContain("Secret reminder", await NotificationsAsync(editor), StringComparison.Ordinal);
        using (await SendAsync(HttpMethod.Post, $"/api/v1/workspaces/{Vault:D}/unlock", editor, new { password = Password }))
        {
        }

        Assert.Contains("Secret reminder", await NotificationsAsync(editor), StringComparison.Ordinal);
    }

    [Fact]
    public async Task One_members_wrong_guesses_do_not_throttle_another_member_or_the_owner()
    {
        var owner = await TokenAsync(Owner);
        await SetPasswordAsync(owner, Vault);
        var editor = await TokenAsync(Editor);
        var ownerElsewhere = await TokenAsync(Owner);

        HttpStatusCode last = default;
        for (var attempt = 0; attempt < 8 && last != HttpStatusCode.TooManyRequests; attempt++)
        {
            using var response = await SendAsync(
                HttpMethod.Post, $"/api/v1/workspaces/{Vault:D}/unlock", editor, new { password = $"guess number {attempt}" });
            last = response.StatusCode;
        }

        Assert.Equal(HttpStatusCode.TooManyRequests, last);
        using var unlocked = await SendAsync(
            HttpMethod.Post, $"/api/v1/workspaces/{Vault:D}/unlock", ownerElsewhere, new { password = Password });
        Assert.Equal(HttpStatusCode.OK, unlocked.StatusCode);
    }

    [Fact]
    public async Task A_short_password_is_refused_and_outsiders_share_one_failure_count_that_members_do_not()
    {
        var owner = await TokenAsync(Owner);
        using (var seven = await SendAsync(HttpMethod.Put, $"/api/v1/workspaces/{Vault:D}/password", owner, new { password = "1234567" }))
        {
            Assert.Equal(HttpStatusCode.BadRequest, seven.StatusCode);
            Assert.Equal("workspaces.password_invalid", await ProblemCodeAsync(seven));
        }

        await SetPasswordAsync(owner, Vault);
        HttpStatusCode last = default;
        for (var person = 0; person < 8 && last != HttpStatusCode.TooManyRequests; person++)
        {
            var stranger = Guid.CreateVersion7();
            await ExecuteAsMigratorAsync($"""
                INSERT INTO principal
                    (principal_id, tenant_id, external_issuer, external_subject, kind, display_name,
                     email, email_normalized, email_verified, status)
                VALUES ('{stranger:D}', '{M0SchemaSeed.Alpha.TenantId:D}', 'https://wl.test', 'stranger-{stranger:N}',
                        'user', 'Stranger', '{stranger:N}@wl.test', '{stranger:N}@wl.test', true, 'active');
                """);
            var token = await TokenAsync(stranger);
            using var response = await SendAsync(
                HttpMethod.Post, $"/api/v1/workspaces/{Vault:D}/join", token, new { password = "not the password" });
            last = response.StatusCode;
        }

        // Each stranger made one guess, yet the workspace stopped taking strangers' guesses.
        Assert.Equal(HttpStatusCode.TooManyRequests, last);

        // A member is not part of that count.
        var editor = await TokenAsync(Editor);
        using var member = await SendAsync(HttpMethod.Post, $"/api/v1/workspaces/{Vault:D}/unlock", editor, new { password = Password });
        Assert.Equal(HttpStatusCode.OK, member.StatusCode);
    }

    [Fact]
    public async Task An_archived_protected_workspace_is_unlocked_before_it_can_be_restored()
    {
        var owner = await TokenAsync(Owner);
        await SetPasswordAsync(owner, Archived);
        await ExecuteAsMigratorAsync($"UPDATE workspace SET lifecycle_state = 'archived', archived_at = now() WHERE workspace_id = '{Archived:D}'");

        var fresh = await TokenAsync(Owner);
        using (var refused = await SendAsync(HttpMethod.Post, $"/api/v1/workspaces/{Archived:D}/restore", fresh))
        {
            Assert.Equal(HttpStatusCode.NotFound, refused.StatusCode);
        }

        using (var unlock = await SendAsync(HttpMethod.Post, $"/api/v1/workspaces/{Archived:D}/unlock", fresh, new { password = Password }))
        {
            Assert.Equal(HttpStatusCode.OK, unlock.StatusCode);
        }

        using var restored = await SendAsync(HttpMethod.Post, $"/api/v1/workspaces/{Archived:D}/restore", fresh);
        Assert.Equal(HttpStatusCode.OK, restored.StatusCode);
    }

    [Fact]
    public async Task Removing_a_member_ends_their_unlocks_so_adding_them_back_does_not_reopen_the_workspace()
    {
        var owner = await TokenAsync(Owner);
        await SetPasswordAsync(owner, Vault);
        var editor = await TokenAsync(Editor);
        using (await SendAsync(HttpMethod.Post, $"/api/v1/workspaces/{Vault:D}/unlock", editor, new { password = Password }))
        {
        }

        Assert.Equal(1, await CountAsync($"SELECT count(*) FROM workspace_unlock WHERE principal_id = '{Editor:D}'"));
        using (var removed = await SendAsync(HttpMethod.Delete, $"/api/v1/workspaces/{Vault:D}/members/{Editor:D}", owner))
        {
            Assert.True(removed.IsSuccessStatusCode, $"Remove answered {removed.StatusCode}.");
        }

        Assert.Equal(0, await CountAsync($"SELECT count(*) FROM workspace_unlock WHERE principal_id = '{Editor:D}'"));
        await ExecuteAsMigratorAsync($"""
            INSERT INTO workspace_member (workspace_id, subject_type, subject_id, tenant_id, role, granted_by, granted_at)
            VALUES ('{Vault:D}', 'principal', '{Editor:D}', '{M0SchemaSeed.Alpha.TenantId:D}', 'editor', '{Owner:D}', now());
            """);
        using var again = await SendAsync(HttpMethod.Get, $"/api/v1/workspaces/{Vault:D}/graph", editor);
        Assert.Equal(HttpStatusCode.NotFound, again.StatusCode);
    }

    [Fact]
    public async Task A_public_forms_submission_identity_and_published_note_reads_are_not_closed_by_the_password()
    {
        var owner = await TokenAsync(Owner);
        var itemId = await CreateNoteAsync(owner, "Published title");
        await SetPasswordAsync(owner, Vault);
        var form = Guid.CreateVersion7();
        var other = Guid.CreateVersion7();
        await ExecuteAsMigratorAsync($"""
            INSERT INTO principal
                (principal_id, tenant_id, external_issuer, external_subject, kind, display_name, email, email_normalized, email_verified, status)
            VALUES
                ('{form:D}', '{M0SchemaSeed.Alpha.TenantId:D}', 'https://wl.test', 'nix:public-form:{form:D}', 'service', 'Public form', NULL, NULL, false, 'active'),
                ('{other:D}', '{M0SchemaSeed.Alpha.TenantId:D}', 'https://wl.test', 'some-agent-{other:D}', 'service', 'Agent', NULL, NULL, false, 'active');
            INSERT INTO workspace_member (workspace_id, subject_type, subject_id, tenant_id, role, granted_by, granted_at)
            VALUES ('{Vault:D}', 'principal', '{form:D}', '{M0SchemaSeed.Alpha.TenantId:D}', 'editor', '{Owner:D}', now()),
                   ('{Vault:D}', 'principal', '{other:D}', '{M0SchemaSeed.Alpha.TenantId:D}', 'editor', '{Owner:D}', now());
            """);

        async Task<bool> CanWriteAsync(Guid principal)
        {
            var work = await _fixture.Application.BeginUnitOfWorkAsync(
                NixSessionContext.ForTenant(TenantId.From(M0SchemaSeed.Alpha.TenantId), PrincipalId.From(principal)),
                Cancellation);
            await using (work.ConfigureAwait(false))
            {
                return await work.Resolve<IPermissionResolver>().CanWriteWorkspaceAsync(WorkspaceId.From(Vault), Cancellation);
            }
        }

        Assert.True(await CanWriteAsync(form));
        Assert.False(await CanWriteAsync(other));

        // A published note is served under a service identity: the password does not apply, an item lock does.
        var work = await _fixture.Application.BeginUnitOfWorkAsync(
            NixSessionContext.ForTenant(TenantId.From(M0SchemaSeed.Alpha.TenantId), PrincipalId.From(Owner)),
            Cancellation);
        await using (work.ConfigureAwait(false))
        {
            var locks = work.Resolve<IItemLocks>();
            Assert.False(await locks.MayReadBodyAsync(ItemId.From(itemId), Cancellation));
            Assert.True(await locks.MayReadBodyIgnoringWorkspaceLockAsync(ItemId.From(itemId), Cancellation));
        }
    }

    private async Task<string> NotificationsAsync(string token)
    {
        using var response = await SendAsync(HttpMethod.Get, "/api/v1/me/notifications", token);
        response.EnsureSuccessStatusCode();
        return await response.Content.ReadAsStringAsync(Cancellation);
    }

    private async Task AssertClosedAsync(string token, Guid itemId, bool member = true)
    {
        foreach (var path in new[]
        {
            $"/api/v1/items/{itemId:D}",
            $"/api/v1/items/{itemId:D}/body",
            $"/api/v1/items/{itemId:D}/comments",
            $"/api/v1/items/{itemId:D}/file",
            $"/api/v1/items/{itemId:D}/query",
            $"/api/v1/workspaces/{Vault:D}/items",
            $"/api/v1/workspaces/{Vault:D}/graph",
        })
        {
            using var response = await SendAsync(HttpMethod.Get, path, token);
            Assert.True(response.StatusCode == HttpStatusCode.NotFound, $"{path} answered {response.StatusCode}.");
        }

        // A device mirror must be able to tell "locked" (keep everything, wait) from "no access"
        // (wipe): a member gets 423, a stranger the 404.
        using (var sync = await SendAsync(HttpMethod.Get, $"/api/v1/workspaces/{Vault:D}/sync/snapshot", token))
        {
            Assert.Equal(member ? (HttpStatusCode)423 : HttpStatusCode.NotFound, sync.StatusCode);
        }

        using (var query = await SendAsync(HttpMethod.Post, $"/api/v1/workspaces/{Vault:D}/query", token, new { }))
        {
            Assert.Equal(HttpStatusCode.NotFound, query.StatusCode);
        }

        // Bulk reads exclude the workspace rather than failing.
        using (var search = await SendAsync(HttpMethod.Get, "/api/v1/search?q=title", token))
        {
            Assert.Equal(HttpStatusCode.OK, search.StatusCode);
            Assert.DoesNotContain(itemId.ToString("D"), await search.Content.ReadAsStringAsync(Cancellation), StringComparison.Ordinal);
        }

        // A member's collaboration session is told the body is locked; a stranger is told nothing exists.
        using var authorize = await InternalAuthzAsync(token, itemId);
        if (member)
        {
            Assert.Equal(HttpStatusCode.Forbidden, authorize.StatusCode);
            Assert.Equal("internal.workspace_locked", await ProblemCodeAsync(authorize));
        }
        else
        {
            Assert.Equal(HttpStatusCode.NotFound, authorize.StatusCode);
        }
    }

    private async Task AssertOpenAsync(string token, Guid itemId)
    {
        foreach (var path in new[]
        {
            $"/api/v1/items/{itemId:D}",
            $"/api/v1/workspaces/{Vault:D}/graph",
            $"/api/v1/workspaces/{Vault:D}/sync/snapshot",
        })
        {
            using var response = await SendAsync(HttpMethod.Get, path, token);
            Assert.True(response.StatusCode == HttpStatusCode.OK, $"{path} answered {response.StatusCode}.");
        }

        using (var search = await SendAsync(HttpMethod.Get, "/api/v1/search?q=title", token))
        {
            Assert.Contains(itemId.ToString("D"), await search.Content.ReadAsStringAsync(Cancellation), StringComparison.Ordinal);
        }

        using var authorize = await InternalAuthzAsync(token, itemId);
        Assert.Equal(HttpStatusCode.OK, authorize.StatusCode);
    }

    private async Task<Guid> CreateNoteAsync(string token, string title)
    {
        using var created = await SendAsync(
            HttpMethod.Post, $"/api/v1/workspaces/{Vault:D}/items", token, new { type = "note", title });
        Assert.Equal(HttpStatusCode.Created, created.StatusCode);
        using var body = JsonDocument.Parse(await created.Content.ReadAsStringAsync(Cancellation));
        return body.RootElement.GetProperty("id").GetGuid();
    }

    private async Task SetPasswordAsync(string token, Guid workspace)
    {
        using var response = await SendAsync(HttpMethod.Put, $"/api/v1/workspaces/{workspace:D}/password", token, new { password = Password });
        Assert.Equal(HttpStatusCode.NoContent, response.StatusCode);
    }

    private async Task<HttpResponseMessage> InternalAuthzAsync(string bearer, Guid itemId)
    {
        using var request = new HttpRequestMessage(HttpMethod.Get, $"/internal/authz/items/{itemId:D}");
        request.Headers.Authorization = new AuthenticationHeaderValue("Bearer", bearer);
        request.Headers.TryAddWithoutValidation(InternalBoundaryMiddleware.SecretHeaderName, InternalSecret);
        return await _client.SendAsync(request, Cancellation);
    }

    private async Task<string> TokenAsync(Guid principalId, Guid? tenant = null)
    {
        var context = NixSessionContext.ForTenant(
            TenantId.From(tenant ?? M0SchemaSeed.Alpha.TenantId), PrincipalId.From(principalId));
        var work = await _fixture.Application.BeginUnitOfWorkAsync(context, Cancellation);
        IssuedAccessToken issued;
        await using (work.ConfigureAwait(false))
        {
            var result = await work.Resolve<NixDispatcher>().SendAsync<CreateAccessToken, IssuedAccessToken>(
                new CreateAccessToken(
                    "workspace-lock",
                    [AccessTokenScopes.Read, AccessTokenScopes.Write, AccessTokenScopes.Admin],
                    1),
                Cancellation);
            Assert.True(result.IsSuccess, result.IsFailure ? result.Error.Message : string.Empty);
            issued = result.Value;
            await work.CommitAsync(Cancellation);
        }

        using var exchange = await _client.PostAsJsonAsync("/public/v1/auth/token", new { token = issued.Secret }, Cancellation);
        exchange.EnsureSuccessStatusCode();
        using var document = JsonDocument.Parse(await exchange.Content.ReadAsStringAsync(Cancellation));
        return document.RootElement.GetProperty("accessToken").GetString()!;
    }

    private async Task<HttpResponseMessage> SendAsync(HttpMethod method, string path, string bearer, object? body = null)
    {
        using var request = new HttpRequestMessage(method, path);
        request.Headers.Authorization = new AuthenticationHeaderValue("Bearer", bearer);
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

    private async Task<string?> RoleOfAsync(Guid principal)
    {
        var connection = await _fixture.OpenMigratorConnectionAsync();
        await using (connection.ConfigureAwait(false))
        {
            var roles = await RawSql.TextListAsync(
                connection,
                $"SELECT role FROM workspace_member WHERE workspace_id = '{Vault:D}' AND subject_id = '{principal:D}'");
            return roles.SingleOrDefault();
        }
    }

    private async Task<long> CountAsync(string sql)
    {
        var connection = await _fixture.OpenMigratorConnectionAsync();
        await using (connection.ConfigureAwait(false))
        {
            return await RawSql.CountAsync(connection, transaction: null, sql);
        }
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
        var alpha = M0SchemaSeed.Alpha.TenantId;
        var beta = M0SchemaSeed.Beta.TenantId;
        await ExecuteAsMigratorAsync($"""
            INSERT INTO principal
                (principal_id, tenant_id, external_issuer, external_subject, kind, display_name,
                 email, email_normalized, email_verified, status)
            VALUES
                ('{Owner:D}', '{alpha:D}', 'https://wl.test', 'owner', 'user', 'Owner', 'owner@wl.test', 'owner@wl.test', true, 'active'),
                ('{Editor:D}', '{alpha:D}', 'https://wl.test', 'editor', 'user', 'Editor', 'editor@wl.test', 'editor@wl.test', true, 'active'),
                ('{Outsider:D}', '{alpha:D}', 'https://wl.test', 'outsider', 'user', 'Outsider', 'outsider@wl.test', 'outsider@wl.test', true, 'active'),
                ('{Newcomer:D}', '{alpha:D}', 'https://wl.test', 'newcomer', 'user', 'Newcomer', 'newcomer@wl.test', 'newcomer@wl.test', true, 'active'),
                ('{BetaPerson:D}', '{beta:D}', 'https://wl.test', 'beta', 'user', 'Beta', 'beta@wl.test', 'beta@wl.test', true, 'active');
            INSERT INTO workspace
                (workspace_id, tenant_id, name, version_retention_days, coalesce_window_min, storage_quota_bytes, created_at)
            VALUES
                ('{Vault:D}', '{alpha:D}', 'Vault', 90, 10, 10737418240, now()),
                ('{Plain:D}', '{alpha:D}', 'Plain', 90, 10, 10737418240, now()),
                ('{Closed:D}', '{alpha:D}', 'Closed', 90, 10, 10737418240, now()),
                ('{Archived:D}', '{alpha:D}', 'Archived', 90, 10, 10737418240, now());
            INSERT INTO workspace_member
                (workspace_id, subject_type, subject_id, tenant_id, role, granted_by, granted_at)
            SELECT w.workspace_id, 'principal', '{Owner:D}'::uuid, '{alpha:D}'::uuid, 'owner', '{Owner:D}'::uuid, now()
            FROM (VALUES ('{Vault:D}'::uuid), ('{Plain:D}'::uuid), ('{Closed:D}'::uuid), ('{Archived:D}'::uuid)) AS w(workspace_id);
            INSERT INTO workspace_member
                (workspace_id, subject_type, subject_id, tenant_id, role, granted_by, granted_at)
            VALUES ('{Vault:D}', 'principal', '{Editor:D}', '{alpha:D}', 'editor', '{Owner:D}', now());
            """);
    }

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
