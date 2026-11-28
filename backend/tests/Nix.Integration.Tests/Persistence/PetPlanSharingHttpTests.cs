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

[Collection(PostgresSecondaryCollectionDefinition.Name)]
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
    public async Task A_saved_key_is_the_only_consent_a_turn_needs_and_no_key_sends_nothing()
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
        using (var denied = await Runtime(host, browser, pet))
        {
            Assert.False(denied.IsSuccessStatusCode);
            Assert.Equal("pets.no_provider_key", await SiteHttpHost.ProblemCodeAsync(denied));
        }
        Assert.Equal(0, worker.Calls);
        Assert.Empty(worker.Body);
        using (var key = await host.SendAsync(HttpMethod.Put, "/api/v1/me/pets/providers/anthropic/key", browser,
            new { key = "fixture-provider-key-abcdefghijklmnopqrstuvwxyz" }))
        {
            key.EnsureSuccessStatusCode();
        }
        using (var sent = await Runtime(host, browser, pet))
        {
            sent.EnsureSuccessStatusCode();
        }
        Assert.Equal(1, worker.Calls);
    }

    [Fact]
    public async Task Private_turn_attestation_checks_every_posted_identity_and_stops_after_the_key_changes()
    {
        using var worker = new RecordingWorker();
        await using var host = CreateHost(worker);
        var browser = await SignIn(host);
        var pet = Guid.NewGuid();
        await Configure(host, browser, pet, "anthropic");
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
        using (var replaced = await host.SendAsync(HttpMethod.Put, "/api/v1/me/pets/providers/anthropic/key", browser,
            new { key = "fixture-replacement-key-abcdefghijklmnopqrstuvwxyz" }))
        {
            replaced.EnsureSuccessStatusCode();
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
    public async Task Key_replacement_and_provider_changes_need_no_new_consent_but_a_missing_provider_key_holds_content()
    {
        using var worker = new RecordingWorker();
        await using var host = CreateHost(worker);
        var browser = await SignIn(host);
        var pet = Guid.NewGuid();
        await Configure(host, browser, pet, "anthropic");
        using (var sent = await Runtime(host, browser, pet))
        {
            sent.EnsureSuccessStatusCode();
        }
        Assert.Contains("fixture private message", worker.Body, StringComparison.Ordinal);
        using (var replaced = await host.SendAsync(HttpMethod.Put, "/api/v1/me/pets/providers/anthropic/key", browser,
            new { key = "fixture-replacement-key-abcdefghijklmnopqrstuvwxyz" }))
        {
            replaced.EnsureSuccessStatusCode();
        }
        using (var sent = await Runtime(host, browser, pet, "tool_result"))
        {
            sent.EnsureSuccessStatusCode();
        }
        using (var sent = await Runtime(host, browser, pet, workspaceAccess: false, itemId: M0SchemaSeed.Alpha.ItemId))
        {
            sent.EnsureSuccessStatusCode();
        }
        Assert.Equal(3, worker.Calls);

        using var settingsResponse = await host.SendAsync(HttpMethod.Get, "/api/v1/me/pets/settings", browser);
        using var settings = await SiteHttpHost.JsonAsync(settingsResponse);
        using (var saved = await host.SendAsync(HttpMethod.Put, "/api/v1/me/pets/settings", browser,
            new SavePetSettingsRequest(settings.RootElement.GetProperty("revision").GetInt64(),
                new PetSettings(true, pet, [new(pet, "Fixture", "owl", "", Provider: "openrouter")]))))
        {
            saved.EnsureSuccessStatusCode();
        }
        using (var held = await Runtime(host, browser, pet))
        {
            Assert.Equal("pets.no_provider_key", await SiteHttpHost.ProblemCodeAsync(held));
        }
        Assert.Equal(3, worker.Calls);
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
