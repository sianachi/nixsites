using System.IdentityModel.Tokens.Jwt;
using System.Net;
using System.Net.Http.Json;
using System.Text.Json;
using Microsoft.Extensions.DependencyInjection;
using Nix.Abstractions.PetRuns;
using Nix.Authentication;
using Nix.Domain.Identity;
using Nix.Domain.Items;
using Nix.Domain.Tenancy;
using Nix.Features.Pets;
using Nix.Integration.Tests.Harness;

namespace Nix.Integration.Tests.Persistence;

[Collection(PostgresCollectionDefinition.Name)]
public sealed partial class PetPlanSharingHttpTests(NixPostgresFixture fixture) : IAsyncLifetime
{
    private const string Origin = "https://nix.sharing.test";
    private static readonly Guid Workspace = TestTenants.AlphaWorkspace;
    private static CancellationToken Cancellation => TestContext.Current.CancellationToken;
    public async ValueTask InitializeAsync()
    {
        await fixture.ResetAsync();
        await M0SchemaSeed.SeedBothTenantsAsync(fixture);
    }
    public ValueTask DisposeAsync() => ValueTask.CompletedTask;

    [Fact]
    public async Task A_revoked_sharing_decision_cannot_be_replayed_and_retries_do_not_renew_authority()
    {
        using var worker = new RecordingWorker();
        await using var host = CreateHost(worker);
        var browser = await SignIn(host);
        var pet = Guid.NewGuid();
        await Configure(host, browser, pet, "anthropic");
        var route = $"/api/v1/workspaces/{Workspace:D}/pet-sharing";
        var scope = new { kind = "workspace" };
        var first = await Question(host, browser, route, pet, scope);
        Assert.NotEqual(Guid.Empty, first.GetProperty("decisionNonce").GetGuid());
        Assert.Null(await Consent(pet, first));
        using (var held = await Runtime(host, browser, pet))
        {
            Assert.Equal(HttpStatusCode.Conflict, held.StatusCode);
        }
        var requestA = Guid.NewGuid();
        var approval = Decision(pet, scope, first, true, requestA);
        using (var granted = await host.SendAsync(HttpMethod.Post, route + "/decision", browser, approval))
        {
            granted.EnsureSuccessStatusCode();
        }
        var original = await Consent(pet, first);
        Assert.NotNull(original);
        using (var retry = await host.SendAsync(HttpMethod.Post, route + "/decision", browser, approval))
        {
            retry.EnsureSuccessStatusCode();
        }
        Assert.Equal(original, await Consent(pet, first));
        Assert.Equal(JsonValueKind.Null, (await Question(host, browser, route, pet, scope)).ValueKind);
        Assert.Equal(original, await Consent(pet, first));
        var pat = await host.TokenAsync(TestTenants.AlphaContext);
        var inert = await Question(host, pat, route, pet, scope, forDecision: true);
        Assert.Equal(JsonValueKind.Null, inert.GetProperty("decisionNonce").ValueKind);
        Assert.Equal(original, await Consent(pet, first));
        var second = await Question(host, browser, route, pet, scope, forDecision: true);
        Assert.NotEqual(first.GetProperty("decisionNonce").GetGuid(), second.GetProperty("decisionNonce").GetGuid());
        Assert.Equal(original, await Consent(pet, first));
        using (var opposite = await host.SendAsync(HttpMethod.Post, route + "/decision", browser, Decision(pet, scope, first, false, requestA)))
        {
            Assert.False(opposite.IsSuccessStatusCode);
        }
        var refusal = Decision(pet, scope, second, false);
        using (var revoked = await host.SendAsync(HttpMethod.Post, route + "/decision", browser, refusal))
        {
            revoked.EnsureSuccessStatusCode();
        }
        var stopped = await Consent(pet, first);
        Assert.NotNull(stopped);
        Assert.NotNull(stopped.RevokedAt);
        using (var replay = await host.SendAsync(HttpMethod.Post, route + "/decision", browser, approval))
        {
            Assert.False(replay.IsSuccessStatusCode);
            Assert.Equal("pets.sharing_changed", await SiteHttpHost.ProblemCodeAsync(replay));
        }
        using (var retry = await host.SendAsync(HttpMethod.Post, route + "/decision", browser, refusal))
        {
            retry.EnsureSuccessStatusCode();
        }
        Assert.Equal(stopped, await Consent(pet, first));
        using (var held = await Runtime(host, browser, pet))
        {
            Assert.Equal(HttpStatusCode.Conflict, held.StatusCode);
        }
        Assert.Equal(0, worker.Calls);
    }

    private async Task<PetPlanConsentRecord?> Consent(Guid pet, JsonElement question)
    {
        var owner = Nix.Abstractions.NixSessionContext.ForTenant(TenantId.From(TestTenants.Alpha), PrincipalId.From(TestTenants.AlphaPrincipal));
        await using var work = await fixture.Application.BeginUnitOfWorkAsync(owner, Cancellation);
        return await work.Resolve<IPetPlanConsentStore>().FindAsync(WorkspaceId.From(Workspace), pet,
            question.GetProperty("scopeDigest").GetString()!, question.GetProperty("recipientRevision").GetString()!, Cancellation);
    }

    [Fact]
    public async Task Unknown_recipient_cannot_be_granted_or_disclose_content()
    {
        using var worker = new RecordingWorker();
        await using var host = CreateHost(worker);
        var browser = await SignIn(host);
        var pet = Guid.NewGuid();
        using var settingsResponse = await host.SendAsync(HttpMethod.Get, "/api/v1/me/pets/settings", browser);
        settingsResponse.EnsureSuccessStatusCode();
        using var settings = await SiteHttpHost.JsonAsync(settingsResponse);
        using (var saved = await host.SendAsync(HttpMethod.Put, "/api/v1/me/pets/settings", browser,
            new SavePetSettingsRequest(settings.RootElement.GetProperty("revision").GetInt64(),
                new PetSettings(true, pet, [new(pet, "Fixture", "owl", "", Provider: "anthropic")]))))
        {
            saved.EnsureSuccessStatusCode();
        }
        var route = $"/api/v1/workspaces/{Workspace:D}/pet-sharing";
        var scope = new { kind = "workspace", itemIds = Array.Empty<Guid>() };
        var question = await Question(host, browser, route, pet, scope);
        Assert.Equal("unknown", question.GetProperty("recipient").GetProperty("connectionRevision").GetString());
        using (var denied = await host.SendAsync(HttpMethod.Post, route + "/decision", browser, Decision(pet, scope, question, true)))
        {
            Assert.False(denied.IsSuccessStatusCode);
        }
        using (var denied = await Runtime(host, browser, pet))
        {
            Assert.Equal(HttpStatusCode.Conflict, denied.StatusCode);
        }
        Assert.Equal(0, worker.Calls);
        Assert.Empty(worker.Body);
    }

    [Fact]
    public async Task Private_turn_attestation_checks_every_posted_identity_and_stops_after_revocation()
    {
        using var worker = new RecordingWorker();
        await using var host = CreateHost(worker);
        var browser = await SignIn(host);
        var pet = Guid.NewGuid();
        await Configure(host, browser, pet, "anthropic");
        var route = $"/api/v1/workspaces/{Workspace:D}/pet-sharing";
        var scope = new { kind = "workspace", itemIds = Array.Empty<Guid>() };
        var question = await Question(host, browser, route, pet, scope);
        using (var granted = await host.SendAsync(HttpMethod.Post, route + "/decision", browser, Decision(pet, scope, question, true)))
        {
            granted.EnsureSuccessStatusCode();
        }
        using (var sent = await Runtime(host, browser, pet))
        {
            sent.EnsureSuccessStatusCode();
        }
        using var forwarded = JsonDocument.Parse(worker.Body);
        var proof = forwarded.RootElement.GetProperty("sharingAttestation").GetString();
        var turnId = Guid.Parse(forwarded.RootElement.GetProperty("requestId").GetString()!);
        var values = new Dictionary<string, object?>
        {
            ["attestation"] = proof,
            ["tenantId"] = TestTenants.Alpha,
            ["principalId"] = TestTenants.AlphaPrincipal,
            ["workspaceId"] = Workspace,
            ["petId"] = pet,
            ["provider"] = "anthropic",
            ["turnId"] = turnId,
        };
        Assert.True(await Validate(host, values));
        foreach (var field in new[] { "tenantId", "principalId", "workspaceId", "petId", "provider", "turnId" })
        {
            var changed = new Dictionary<string, object?>(values) { [field] = field == "provider" ? "openrouter" : Guid.NewGuid() };
            Assert.False(await Validate(host, changed));
        }
        var forged = new Dictionary<string, object?>(values) { ["attestation"] = "forged" };
        Assert.False(await Validate(host, forged));
        question = await Question(host, browser, route, pet, scope, forDecision: true);
        using (var revoked = await host.SendAsync(HttpMethod.Post, route + "/decision", browser, Decision(pet, scope, question, false)))
        {
            revoked.EnsureSuccessStatusCode();
        }
        Assert.False(await Validate(host, values));
        Assert.Equal(1, worker.Calls);
    }

    private static async Task<bool> Validate(SiteHttpHost host, object body)
    {
        using var request = new HttpRequestMessage(HttpMethod.Post, "/internal/pets/sharing/validate");
        request.Headers.Add(InternalBoundaryMiddleware.SecretHeaderName, SiteHttpHost.InternalSecret);
        request.Content = JsonContent.Create(body);
        using var response = await host.Client.SendAsync(request, Cancellation);
        response.EnsureSuccessStatusCode();
        using var result = await SiteHttpHost.JsonAsync(response);
        return result.RootElement.GetProperty("allowed").GetBoolean();
    }

    [Fact]
    public async Task Only_the_named_PAT_can_consume_an_exact_context_after_BFF_authorization()
    {
        using var worker = new RecordingWorker();
        await using var host = CreateHost(worker);
        var browser = await SignIn(host);
        var pat = await host.TokenAsync(TestTenants.AlphaContext);
        var otherPat = await host.TokenAsync(TestTenants.AlphaContext);
        var (runId, planId) = await ReviewableRun();
        var route = $"/api/v1/workspaces/{Workspace:D}/pet-plans/{runId:D}";
        var handoff = new { planId, planVersion = 1, reviewDigest = "fixture-review", clientName = "Named fixture CLI", approve = false };
        using (var denied = await host.SendAsync(HttpMethod.Post, route + "/decision-handoffs", browser, handoff))
        {
            Assert.Equal(HttpStatusCode.Forbidden, denied.StatusCode);
        }
        using var pendingResponse = await host.SendAsync(HttpMethod.Post, route + "/decision-handoffs", pat, handoff);
        pendingResponse.EnsureSuccessStatusCode();
        using var pending = await SiteHttpHost.JsonAsync(pendingResponse);
        var handoffId = pending.RootElement.GetProperty("handoffId").GetGuid();
        var secret = pending.RootElement.GetProperty("decisionContext").GetString();
        var requestId = Guid.NewGuid();
        object Decision(string? context = null, string digest = "fixture-review") => new
        {
            expectedRunRevision = 2,
            planVersion = 1,
            reviewDigest = digest,
            approve = false,
            requestId,
            decisionContext = context,
        };
        foreach (var bearer in new[] { pat, browser, host.PetTurnToken(TestTenants.AlphaContext) })
        {
            using var denied = await host.SendAsync(HttpMethod.Post, $"{route}/plans/{planId:D}/decision", bearer, Decision(secret));
            Assert.False(denied.IsSuccessStatusCode);
        }
        using (var denied = await host.SendAsync(HttpMethod.Post, $"{route}/plans/{planId:D}/decision", pat, Decision()))
        {
            Assert.False(denied.IsSuccessStatusCode);
        }
        using var statusResponse = await host.SendAsync(HttpMethod.Get, $"{route}/decision-handoffs/{handoffId:D}", browser);
        statusResponse.EnsureSuccessStatusCode();
        using var status = await SiteHttpHost.JsonAsync(statusResponse);
        Assert.False(status.RootElement.TryGetProperty("decisionContext", out _));
        var credentialId = status.RootElement.GetProperty("granteeCredentialId").GetGuid();
        object Authorize(Guid grantee) => new { handoffId, planId, planVersion = 1, reviewDigest = "fixture-review", granteeCredentialId = grantee, clientName = "Named fixture CLI", approve = false };
        using (var denied = await host.SendAsync(HttpMethod.Post, route + "/decision-contexts", pat, Authorize(credentialId)))
        {
            Assert.Equal(HttpStatusCode.Forbidden, denied.StatusCode);
        }
        using (var denied = await host.SendAsync(HttpMethod.Post, route + "/decision-contexts", browser, Authorize(Guid.NewGuid())))
        {
            Assert.Equal(HttpStatusCode.Forbidden, denied.StatusCode);
        }
        using (var authorized = await host.SendAsync(HttpMethod.Post, route + "/decision-contexts", browser, Authorize(credentialId)))
        {
            authorized.EnsureSuccessStatusCode();
            using var body = await SiteHttpHost.JsonAsync(authorized);
            Assert.False(body.RootElement.TryGetProperty("decisionContext", out _));
            Assert.Equal("authorized", body.RootElement.GetProperty("status").GetString());
        }
        foreach (var bearer in new[] { otherPat, browser })
        {
            using var denied = await host.SendAsync(HttpMethod.Post, $"{route}/plans/{planId:D}/decision", bearer, Decision(secret));
            Assert.False(denied.IsSuccessStatusCode);
        }
        using (var denied = await host.SendAsync(HttpMethod.Post, $"{route}/plans/{planId:D}/decision", pat, Decision(secret, "stale-review")))
        {
            Assert.False(denied.IsSuccessStatusCode);
        }
        using (var decided = await host.SendAsync(HttpMethod.Post, $"{route}/plans/{planId:D}/decision", pat, Decision(secret)))
        {
            decided.EnsureSuccessStatusCode();
            using var result = await SiteHttpHost.JsonAsync(decided);
            Assert.Equal("delegated", result.RootElement.GetProperty("plan").GetProperty("decision").GetProperty("credentialClass").GetString());
        }
        using (var duplicate = await host.SendAsync(HttpMethod.Post, $"{route}/plans/{planId:D}/decision", pat, Decision(secret)))
        {
            duplicate.EnsureSuccessStatusCode();
        }
        Assert.Equal(0, worker.Calls);
    }

    [Fact]
    public async Task Old_boolean_cannot_disclose_and_scope_key_provider_and_revocation_changes_hold_later_content()
    {
        using var worker = new RecordingWorker();
        await using var host = CreateHost(worker);
        var browser = await SignIn(host);
        var pet = Guid.NewGuid();
        await Configure(host, browser, pet, "anthropic");
        var route = $"/api/v1/workspaces/{Workspace:D}/pet-sharing";
        var scope = new { kind = "workspace", itemIds = Array.Empty<Guid>() };
        var question = await Question(host, browser, route, pet, scope);
        Assert.NotEqual("unknown", question.GetProperty("recipient").GetProperty("connectionRevision").GetString());
        using (var refused = await Runtime(host, browser, pet))
        {
            Assert.Equal(HttpStatusCode.Conflict, refused.StatusCode);
        }
        Assert.Equal(0, worker.Calls);
        var pat = await host.TokenAsync(TestTenants.AlphaContext);
        var approval = Decision(pet, scope, question, approve: true);
        using (var refused = await host.SendAsync(HttpMethod.Post, route + "/decision", pat, approval))
        {
            Assert.Equal(HttpStatusCode.Forbidden, refused.StatusCode);
        }
        host.Client.DefaultRequestHeaders.Remove("Origin");
        host.Client.DefaultRequestHeaders.Add("Origin", "https://cross-origin.test");
        using (var refused = await host.SendAsync(HttpMethod.Post, route + "/decision", browser, approval))
        {
            Assert.Equal(HttpStatusCode.Forbidden, refused.StatusCode);
        }
        host.Client.DefaultRequestHeaders.Remove("Origin");
        host.Client.DefaultRequestHeaders.Add("Origin", Origin);
        using (var granted = await host.SendAsync(HttpMethod.Post, route + "/decision", browser, approval))
        {
            granted.EnsureSuccessStatusCode();
        }
        using (var sent = await Runtime(host, browser, pet))
        {
            sent.EnsureSuccessStatusCode();
        }

        Assert.Equal(1, worker.Calls);
        Assert.Contains("fixture private message", worker.Body, StringComparison.Ordinal);
        var oldQuestion = question;
        using (var replaced = await host.SendAsync(HttpMethod.Put, "/api/v1/me/pets/providers/anthropic/key", browser,
            new { key = "fixture-replacement-key-abcdefghijklmnopqrstuvwxyz" }))
        {
            replaced.EnsureSuccessStatusCode();
        }

        question = await Question(host, browser, route, pet, scope);
        Assert.NotEqual(oldQuestion.GetProperty("recipientRevision").GetString(), question.GetProperty("recipientRevision").GetString());
        using (var held = await Runtime(host, browser, pet, "tool_result"))
        {
            Assert.Equal(HttpStatusCode.Conflict, held.StatusCode);
        }

        Assert.Equal(1, worker.Calls);
        using (var granted = await host.SendAsync(HttpMethod.Post, route + "/decision", browser, Decision(pet, scope, question, true)))
        {
            granted.EnsureSuccessStatusCode();
        }

        var selectedScope = new { kind = "selected", itemIds = new[] { M0SchemaSeed.Alpha.ItemId } };
        var selected = await Question(host, browser, route, pet, selectedScope);
        Assert.NotEqual(question.GetProperty("scopeDigest").GetString(), selected.GetProperty("scopeDigest").GetString());
        using (var held = await Runtime(host, browser, pet, workspaceAccess: false, itemId: M0SchemaSeed.Alpha.ItemId))
        {
            Assert.Equal(HttpStatusCode.Conflict, held.StatusCode);
        }

        question = await Question(host, browser, route, pet, scope, forDecision: true);
        using (var revoked = await host.SendAsync(HttpMethod.Post, route + "/decision", browser, Decision(pet, scope, question, false)))
        {
            revoked.EnsureSuccessStatusCode();
        }

        using (var held = await Runtime(host, browser, pet))
        {
            Assert.Equal(HttpStatusCode.Conflict, held.StatusCode);
        }

        await Configure(host, browser, pet, "openrouter");
        var changedProvider = await Question(host, browser, route, pet, scope);
        Assert.NotEqual(question.GetProperty("recipientRevision").GetString(), changedProvider.GetProperty("recipientRevision").GetString());
        using (var held = await Runtime(host, browser, pet))
        {
            Assert.Equal(HttpStatusCode.Conflict, held.StatusCode);
        }

        Assert.Equal(1, worker.Calls);
    }

    private SiteHttpHost CreateHost(RecordingWorker worker) => SiteHttpHost.Create(fixture,
        new Dictionary<string, string?>
        {
            ["Nix:Bff:PublicOrigin"] = Origin,
            ["Nix:Pets:WorkerUrl"] = "https://fixture-companion.test/",
            ["Nix:PetRuns:Enabled"] = "true",
            ["Nix:PetRuns:AllowedWorkspaces:0"] = Workspace.ToString("D"),
            ["Nix:Workers:Families:0"] = "notify"
        },
        services => services.AddHttpClient<PetWorkerClient>().ConfigurePrimaryHttpMessageHandler(() => worker));

    private async Task<(Guid RunId, Guid PlanId)> ReviewableRun()
    {
        var planId = Guid.NewGuid();
        var now = DateTimeOffset.UtcNow;
        using var state = JsonDocument.Parse(JsonSerializer.Serialize(new
        {
            petId = Guid.NewGuid(),
            activeJobId = (Guid?)null,
            question = (object?)null,
            proposals = Array.Empty<object>(),
            results = Array.Empty<object>(),
            answers = Array.Empty<string>(),
            turns = 0,
            planRequest = new { requestId = Guid.NewGuid(), sourceScope = new { kind = "selected", itemIds = Array.Empty<Guid>() } },
            plan = new
            {
                id = planId,
                version = 1,
                summary = "Fixture exact plan",
                reviewDigest = "fixture-review",
                scopeDigest = "scope",
                recipientRevision = "recipient",
                status = "awaiting_review",
                steps = new[] { new { id = Guid.NewGuid(), capability = "task.rename", arguments = new { title = "Reviewed title" }, effect = new { description = "Rename fixture", parameters = new { } }, executor = "client", status = "pending", fields = Array.Empty<object>() } }
            },
        }));
        var run = new PetRunRecord(Guid.NewGuid(), ItemId.From(M0SchemaSeed.Alpha.ItemId), WorkspaceId.From(Workspace),
            TenantId.From(TestTenants.Alpha), PrincipalId.From(TestTenants.AlphaPrincipal), "Fixture review", [], false, [], "queued", 1, state.RootElement, now, now);
        await using var work = await fixture.Application.BeginUnitOfWorkAsync(TestTenants.AlphaContext, Cancellation);
        var store = work.Resolve<IPetRunStore>();
        Assert.True(await store.CreateAsync(run, Cancellation));
        Assert.True(await store.UpdateAsync(run with { Status = "waiting_for_approval", Revision = 2 }, 1, Cancellation));
        await work.CommitAsync(Cancellation);
        return (run.Id, planId);
    }

    private async Task<string> SignIn(SiteHttpHost host)
    {
        var bearer = await host.InteractiveTokenAsync(TestTenants.AlphaContext);
        var session = Guid.Parse(new JwtSecurityTokenHandler().ReadJwtToken(bearer).Claims.Single(claim => claim.Type == SelfIssuedTokenService.BrowserSessionClaim).Value);
        var secret = BrowserSessionSecret.Mint();
        await using var connection = await fixture.OpenMigratorConnectionAsync();
        await RawSql.ExecuteAsync(connection, null, $"UPDATE browser_session SET token_hash = '{secret.Hash}' WHERE session_id = '{session:D}'");
        host.Client.DefaultRequestHeaders.Add("Cookie", "__Host-nix_session=" + secret.Token);
        host.Client.DefaultRequestHeaders.Add("Origin", Origin);
        return bearer;
    }

    private static async Task Configure(SiteHttpHost host, string browser, Guid pet, string provider)
    {
        using var settingsResponse = await host.SendAsync(HttpMethod.Get, "/api/v1/me/pets/settings", browser);
        settingsResponse.EnsureSuccessStatusCode();
        using var settings = await SiteHttpHost.JsonAsync(settingsResponse);
        using var saved = await host.SendAsync(HttpMethod.Put, "/api/v1/me/pets/settings", browser,
            new SavePetSettingsRequest(settings.RootElement.GetProperty("revision").GetInt64(),
                new PetSettings(true, pet, [new(pet, "Fixture", "owl", "", Provider: provider)])));
        saved.EnsureSuccessStatusCode();
        using var key = await host.SendAsync(HttpMethod.Put, $"/api/v1/me/pets/providers/{provider}/key", browser,
            new { key = "fixture-provider-key-abcdefghijklmnopqrstuvwxyz" });
        key.EnsureSuccessStatusCode();
    }

    private static async Task<JsonElement> Question(SiteHttpHost host, string bearer, string route, Guid pet, object scope, bool forDecision = false)
    {
        using var response = await host.SendAsync(HttpMethod.Post, route + "/question", bearer, new { petId = pet, sourceScope = scope, forDecision });
        response.EnsureSuccessStatusCode();
        using var json = await SiteHttpHost.JsonAsync(response);
        return json.RootElement.GetProperty("question").Clone();
    }
    private static object Decision(Guid pet, object scope, JsonElement question, bool approve, Guid? requestId = null) => new
    {
        petId = pet,
        sourceScope = scope,
        recipientRevision = question.GetProperty("recipientRevision").GetString(),
        scopeDigest = question.GetProperty("scopeDigest").GetString(),
        approve,
        requestId = requestId ?? Guid.NewGuid(),
        decisionNonce = question.GetProperty("decisionNonce"),
    };
    private static Task<HttpResponseMessage> Runtime(SiteHttpHost host, string bearer, Guid pet,
        string operation = "send", bool workspaceAccess = true, Guid? itemId = null) => host.SendAsync(HttpMethod.Post,
        "/api/v1/me/pets/runtime", bearer, new PetRuntimeRequest(operation, Workspace, pet, Guid.NewGuid(),
            "fixture private message", ItemId: itemId, WorkspaceAccess: workspaceAccess, ToolId: operation == "tool_result" ? "tool" : "",
            ToolResult: operation == "tool_result" ? "fixture private tool result" : ""));

    private sealed class RecordingWorker : HttpMessageHandler
    {
        internal int Calls { get; private set; }
        internal string Body { get; private set; } = "";
        protected override async Task<HttpResponseMessage> SendAsync(HttpRequestMessage request, CancellationToken cancellationToken)
        {
            Calls++;
            Body = await request.Content!.ReadAsStringAsync(cancellationToken);
            return new(HttpStatusCode.OK) { Content = JsonContent.Create(new PetConnectionResponse("anthropic", "connected", "", false)) };
        }
    }
}
