using System.Net.Http.Json;
using System.Text.Json;
using Nix.Authentication;
using Nix.Domain.Items;
using Nix.Domain.Tenancy;
using Nix.Features.Items;
using Nix.Features.Pets;
using Nix.Integration.Tests.Harness;
using Nix.Messaging;

namespace Nix.Integration.Tests.Persistence;

public sealed partial class PetPlanSharingHttpTests
{
    private static readonly JsonSerializerOptions HistoryJson = new(JsonSerializerDefaults.Web);

    [Fact]
    [Trait("Category", "PetPlanHistory")]
    public async Task Plain_owner_text_and_plain_followup_need_no_source_grant_and_send_no_saved_memories()
    {
        using var worker = new RecordingWorker();
        await using var host = CreateHost(worker);
        var browser = await SignIn(host);
        var pet = Guid.NewGuid();
        await Configure(host, browser, pet, "anthropic");
        const string privateMemory = "Saved memory must not enter an owner-text-only request.";
        using (var response = await host.SendAsync(HttpMethod.Get, "/api/v1/me/pets/settings", browser))
        {
            using var current = await SiteHttpHost.JsonAsync(response);
            var settings = current.RootElement.GetProperty("settings").Deserialize<PetSettings>(HistoryJson)!;
            using var saved = await host.SendAsync(HttpMethod.Put, "/api/v1/me/pets/settings", browser,
                new SavePetSettingsRequest(current.RootElement.GetProperty("revision").GetInt64(), settings with
                { Memories = [new PetMemory(Guid.NewGuid(), privateMemory, DateTimeOffset.UtcNow)] }));
            saved.EnsureSuccessStatusCode();
        }
        var first = await CaptureTurnAsync(host, browser, pet, worker, workspaceAccess: false);
        Assert.DoesNotContain(privateMemory, worker.Body, StringComparison.Ordinal);
        using var ownerTextRequest = JsonDocument.Parse(worker.Body);
        Assert.False(ownerTextRequest.RootElement.GetProperty("workspaceAccess").GetBoolean());
        var second = await CaptureTurnAsync(host, browser, pet, worker, workspaceAccess: false);
        Assert.DoesNotContain(privateMemory, worker.Body, StringComparison.Ordinal);
        Assert.True(await Validate(host, Cached(second, first, [])));
        Assert.Equal(2, worker.Calls);
        var route = $"/api/v1/workspaces/{Workspace:D}/pet-sharing";
        using var question = await host.SendAsync(HttpMethod.Post, route + "/question", browser,
            new { petId = pet, sourceScope = new { kind = "selected", itemIds = Array.Empty<Guid>() } });
        question.EnsureSuccessStatusCode();
        using var noGrant = await SiteHttpHost.JsonAsync(question);
        Assert.Equal(JsonValueKind.Object, noGrant.RootElement.GetProperty("question").ValueKind);
    }

    [Theory]
    [Trait("Category", "PetPlanHistory")]
    [InlineData("sources")]
    [InlineData("broad-scope")]
    [InlineData("protected")]
    [InlineData("unbounded")]
    [InlineData("missing-prior")]
    public async Task A_recipient_only_pin_cannot_launder_cached_source_context(string kind)
    {
        using var worker = new RecordingWorker();
        await using var host = CreateHost(worker);
        var browser = await SignIn(host);
        var pet = Guid.NewGuid();
        await Configure(host, browser, pet, "anthropic");
        var turn = await CaptureTurnAsync(host, browser, pet, worker, workspaceAccess: false);
        var cached = Cached(turn, turn, []);
        switch (kind)
        {
            case "sources": cached["contextSourceItemIds"] = new[] { M0SchemaSeed.Alpha.ItemId }; break;
            case "broad-scope": cached["priorSourceScope"] = new { kind = "workspace" }; break;
            case "protected": cached["contextProtected"] = true; break;
            case "unbounded": cached["contextUnbounded"] = true; break;
            case "missing-prior": cached.Remove("priorTurnId"); cached["contextSourceItemIds"] = new[] { M0SchemaSeed.Alpha.ItemId }; break;
        }
        Assert.False(await Validate(host, cached));
        Assert.Equal(1, worker.Calls);
    }

    [Fact]
    [Trait("Category", "PetPlanHistory")]
    public async Task An_existing_source_grant_does_not_let_an_owner_text_only_turn_reuse_source_history()
    {
        using var worker = new RecordingWorker();
        await using var host = CreateHost(worker);
        var browser = await SignIn(host);
        var pet = Guid.NewGuid();
        await Configure(host, browser, pet, "anthropic");
        await GrantHistoryScopeAsync(host, browser, pet, new { kind = "workspace" });
        var sourceTurn = await CaptureTurnAsync(host, browser, pet, worker);
        var ownerTextTurn = await CaptureTurnAsync(host, browser, pet, worker, workspaceAccess: false);
        Assert.False(await Validate(host, Cached(ownerTextTurn, sourceTurn, [M0SchemaSeed.Alpha.ItemId])));
        Assert.Equal(2, worker.Calls);
    }

    [Fact]
    [Trait("Category", "PetPlanHistory")]
    public async Task A_normal_followup_may_reuse_known_current_sources_under_the_same_recipient_and_scope()
    {
        using var worker = new RecordingWorker();
        await using var host = CreateHost(worker);
        var browser = await SignIn(host);
        var pet = Guid.NewGuid();
        await Configure(host, browser, pet, "anthropic");
        await GrantHistoryScopeAsync(host, browser, pet, new { kind = "workspace" });
        var first = await CaptureTurnAsync(host, browser, pet, worker);
        var followup = await CaptureTurnAsync(host, browser, pet, worker);
        Assert.True(await Validate(host, Cached(followup, first, [M0SchemaSeed.Alpha.ItemId])));
        Assert.Equal(2, worker.Calls);
    }

    [Theory]
    [Trait("Category", "PetPlanHistory")]
    [InlineData("narrowed")]
    [InlineData("withheld")]
    [InlineData("locked")]
    [InlineData("recipient")]
    public async Task Cached_sources_stop_after_scope_protection_or_recipient_changes(string changed)
    {
        using var worker = new RecordingWorker();
        await using var host = CreateHost(worker);
        var browser = await SignIn(host);
        var pet = Guid.NewGuid();
        await Configure(host, browser, pet, "anthropic");
        await GrantHistoryScopeAsync(host, browser, pet, new { kind = "workspace" });
        var first = await CaptureTurnAsync(host, browser, pet, worker);
        Guid? selected = null;
        if (changed == "narrowed")
        {
            await using var work = await fixture.Application.BeginUnitOfWorkAsync(TestTenants.AlphaContext, Cancellation);
            var created = await work.Resolve<NixDispatcher>().SendAsync<CreateItem, Item>(
                new(WorkspaceId.From(Workspace), "note", "Different selected source", null, null), Cancellation);
            Assert.True(created.IsSuccess);
            selected = created.Value.Id.Value;
            await work.CommitAsync(Cancellation);
            await GrantHistoryScopeAsync(host, browser, pet, new { kind = "selected", itemIds = new[] { selected.Value } });
        }
        if (changed == "recipient")
        {
            using var replaced = await host.SendAsync(HttpMethod.Put, "/api/v1/me/pets/providers/anthropic/key", browser,
                new { key = "fixture-new-history-key-abcdefghijklmnopqrstuvwxyz" });
            replaced.EnsureSuccessStatusCode();
            await GrantHistoryScopeAsync(host, browser, pet, new { kind = "workspace" });
        }
        var followup = await CaptureTurnAsync(host, browser, pet, worker, workspaceAccess: selected is null, itemId: selected);
        if (changed is "withheld" or "locked")
        {
            var item = $"/api/v1/items/{M0SchemaSeed.Alpha.ItemId:D}";
            using var protectedItem = await host.SendAsync(HttpMethod.Put,
                item + (changed == "withheld" ? "/pet-protection" : "/lock"), browser,
                changed == "withheld" ? new { withholdFromPets = true } : (object)new { password = "fixture-lock-password" });
            protectedItem.EnsureSuccessStatusCode();
        }
        Assert.False(await Validate(host, Cached(followup, first, [M0SchemaSeed.Alpha.ItemId])));
        if (changed == "recipient")
        {
            Assert.False(await Validate(host, first.Validation));
        }
        Assert.Equal(2, worker.Calls);
    }

    [Fact]
    [Trait("Category", "PetPlanHistory")]
    public async Task An_unbounded_result_is_revalidated_within_its_turn_and_cannot_be_replayed_in_a_fresh_turn()
    {
        using var worker = new RecordingWorker();
        await using var host = CreateHost(worker);
        var browser = await SignIn(host);
        var pet = Guid.NewGuid();
        await Configure(host, browser, pet, "anthropic");
        await GrantHistoryScopeAsync(host, browser, pet, new { kind = "workspace" });
        var first = await CaptureTurnAsync(host, browser, pet, worker);
        var aggregate = Cached(first, first, []);
        aggregate["contextUnbounded"] = true;
        Assert.True(await Validate(host, aggregate));
        var followup = await CaptureTurnAsync(host, browser, pet, worker);
        var replayed = Cached(followup, first, []);
        replayed["contextUnbounded"] = true;
        Assert.False(await Validate(host, replayed));
        using var withheld = await host.SendAsync(HttpMethod.Put, $"/api/v1/items/{M0SchemaSeed.Alpha.ItemId:D}/pet-protection", browser,
            new { withholdFromPets = true });
        withheld.EnsureSuccessStatusCode();
        Assert.False(await Validate(host, aggregate));
    }

    private static async Task GrantHistoryScopeAsync(SiteHttpHost host, string browser, Guid pet, object scope)
    {
        var route = $"/api/v1/workspaces/{Workspace:D}/pet-sharing";
        var question = await Question(host, browser, route, pet, scope, forDecision: true);
        using var granted = await host.SendAsync(HttpMethod.Post, route + "/decision", browser, Decision(pet, scope, question, true));
        granted.EnsureSuccessStatusCode();
    }

    private static async Task<HistoryTurn> CaptureTurnAsync(SiteHttpHost host, string browser, Guid pet,
        RecordingWorker worker, bool workspaceAccess = true, Guid? itemId = null)
    {
        using var sent = await host.SendAsync(HttpMethod.Post, "/api/v1/me/pets/runtime", browser,
            new PetRuntimeRequest("send", Workspace, pet, Guid.NewGuid(), "A synthetic owner follow-up.", ItemId: itemId, WorkspaceAccess: workspaceAccess));
        sent.EnsureSuccessStatusCode();
        using var forwarded = JsonDocument.Parse(worker.Body);
        var posted = forwarded.RootElement;
        var validation = new Dictionary<string, object?>
        {
            ["attestation"] = posted.GetProperty("sharingAttestation").GetString(),
            ["tenantId"] = TestTenants.Alpha,
            ["principalId"] = TestTenants.AlphaPrincipal,
            ["workspaceId"] = Workspace,
            ["petId"] = pet,
            ["provider"] = "anthropic",
            ["turnId"] = Guid.Parse(posted.GetProperty("requestId").GetString()!),
        };
        using var request = new HttpRequestMessage(HttpMethod.Post, "/internal/pets/sharing/validate") { Content = JsonContent.Create(validation) };
        request.Headers.Add(InternalBoundaryMiddleware.SecretHeaderName, SiteHttpHost.InternalSecret);
        using var response = await host.Client.SendAsync(request, Cancellation);
        response.EnsureSuccessStatusCode();
        using var answer = await SiteHttpHost.JsonAsync(response);
        Assert.True(answer.RootElement.GetProperty("allowed").GetBoolean());
        return new(validation, answer.RootElement.GetProperty("recipientRevision").GetString()!, answer.RootElement.GetProperty("sourceScope").Clone());
    }

    private static Dictionary<string, object?> Cached(HistoryTurn current, HistoryTurn previous, Guid[] sources) =>
        new(current.Validation)
        {
            ["priorTurnId"] = previous.Validation["turnId"],
            ["priorRecipientRevision"] = previous.RecipientRevision,
            ["priorSourceScope"] = previous.SourceScope,
            ["contextSourceItemIds"] = sources,
            ["contextProtected"] = false,
            ["contextUnbounded"] = false,
        };

    private sealed record HistoryTurn(Dictionary<string, object?> Validation, string RecipientRevision, JsonElement SourceScope);
}
