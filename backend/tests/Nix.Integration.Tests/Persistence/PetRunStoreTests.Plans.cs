using System.Collections.Concurrent;
using System.Globalization;
using System.Net;
using System.Text.Json;
using Microsoft.Extensions.DependencyInjection;
using Nix.Abstractions;
using Nix.Abstractions.PetRuns;
using Nix.Domain.Items;
using Nix.Features.Items;
using Nix.Features.Pets;
using Nix.Integration.Tests.Harness;
using Nix.Messaging;
using Nix.Workers;

namespace Nix.Integration.Tests.Persistence;

public sealed partial class PetRunStoreTests
{
    [Fact]
    [Trait("Category", "FrozenPetPlan")]
    public async Task One_owner_decision_executes_two_prepared_effects_and_retries_cannot_repeat_them()
    {
        var prepared = await CreatePreparedPairAsync();
        var (run, planId, digest, first, second) = prepared;
        var observed = new ConcurrentQueue<(string Target, string Body, HttpStatusCode Status)>();
        using var forbiddenProvider = new PreparedPlanMustNotCallProvider();
        SiteHttpHost? target = null;
        await using var host = SiteHttpHost.Create(fixture, new Dictionary<string, string?>
        {
            ["Nix:Bff:PublicOrigin"] = PetOrigin,
            ["Nix:PetRuns:Enabled"] = "true",
            ["Nix:PetRuns:AllowedWorkspaces:0"] = AlphaWorkspace.Value.ToString("D"),
            ["Nix:Workers:Families:0"] = "pet-plan",
            ["Nix:Workers:LoopbackUrl"] = "http://127.0.0.1",
            ["Nix:Pets:WorkerUrl"] = "https://prepared-plan.invalid/",
        }, services =>
        {
            services.AddHttpClient<PetWorkerClient>().ConfigurePrimaryHttpMessageHandler(() => forbiddenProvider);
            services.AddHttpClient(WorkerLoopbackClient.HttpClientName).ConfigurePrimaryHttpMessageHandler(() =>
                new ObservedPlanLoopback(target!.CreateLoopbackHandler(), observed));
        });
        target = host;
        var browser = await SignInAsync(host);
        var route = $"/api/v1/workspaces/{AlphaWorkspace.Value:D}/pet-plans/{run.Id:D}";
        using var reviewResponse = await host.SendAsync(HttpMethod.Get, route, browser);
        reviewResponse.EnsureSuccessStatusCode();
        using var review = await SiteHttpHost.JsonAsync(reviewResponse);
        var revision = review.RootElement.GetProperty("revision").GetInt64();
        Assert.Equal(2, review.RootElement.GetProperty("plan").GetProperty("steps").GetArrayLength());
        Assert.Empty(observed);
        Assert.Equal("Test target note", await ReadPreparedTitleAsync(first));
        Assert.Equal("Second prepared note", await ReadPreparedTitleAsync(second));

        var decisionId = Guid.NewGuid();
        var decision = new
        {
            expectedRunRevision = revision,
            planVersion = 1,
            reviewDigest = digest,
            approve = true,
            requestId = decisionId
        };
        using (var stale = await host.SendAsync(HttpMethod.Post, route + $"/plans/{planId:D}/decision", browser,
            new { expectedRunRevision = revision, planVersion = 1, reviewDigest = "changed-review", approve = true, requestId = Guid.NewGuid() }))
        {
            Assert.Equal(HttpStatusCode.Conflict, stale.StatusCode);
        }
        Assert.Empty(observed);
        Assert.Equal("Test target note", await ReadPreparedTitleAsync(first));
        Assert.Equal("Second prepared note", await ReadPreparedTitleAsync(second));
        using (var continued = await host.SendAsync(HttpMethod.Post, route + $"/plans/{planId:D}/decision", browser, decision))
        {
            continued.EnsureSuccessStatusCode();
        }
        var completed = await WaitForRunAsync(host, browser, route, "completed");
        var steps = completed.GetProperty("plan").GetProperty("steps").EnumerateArray().ToArray();
        Assert.Equal(2, steps.Length);
        Assert.All(steps, step =>
        {
            Assert.Equal("applied", step.GetProperty("status").GetString());
            Assert.False(string.IsNullOrWhiteSpace(step.GetProperty("receipt").GetString()));
        });
        Assert.Equal("Reviewed project brief", await ReadPreparedTitleAsync(first));
        Assert.Equal("Reviewed meeting notes", await ReadPreparedTitleAsync(second));
        Assert.Equal(decisionId, completed.GetProperty("plan").GetProperty("decision").GetProperty("requestId").GetGuid());
        Assert.Equal(2, observed.Count);
        Assert.All(observed, request => Assert.Equal(HttpStatusCode.OK, request.Status));
        Assert.Contains(observed, request => request.Target == $"/api/v1/items/{first.Value:D}"
            && JsonSerializer.Deserialize<Dictionary<string, string>>(request.Body)!["title"] == "Reviewed project brief");
        Assert.Contains(observed, request => request.Target == $"/api/v1/items/{second.Value:D}"
            && JsonSerializer.Deserialize<Dictionary<string, string>>(request.Body)!["title"] == "Reviewed meeting notes");

        using var repeated = await host.SendAsync(HttpMethod.Post, route + $"/plans/{planId:D}/decision", browser, decision);
        repeated.EnsureSuccessStatusCode();
        Assert.Equal(2, observed.Count);
        Assert.Equal(0, forbiddenProvider.Calls);
    }

    // This fixture starts at authoritative prepared state; it does not prove planner preparation.
    private async Task<PreparedPair> CreatePreparedPairAsync()
    {
        var (first, petId) = await CreateNoteWithPetAsync();
        ItemId second;
        long firstRevision;
        long secondRevision;
        await using (var work = await fixture.Application.BeginUnitOfWorkAsync(TestTenants.AlphaContext, Cancellation))
        {
            var created = await work.Resolve<NixDispatcher>().SendAsync<CreateItem, Item>(
                new(AlphaWorkspace, "note", "Second prepared note", null, null), Cancellation);
            Assert.True(created.IsSuccess);
            second = created.Value.Id;
            var tree = work.Resolve<IItemTree>();
            firstRevision = (await tree.ReadPetRevisionAsync(AlphaWorkspace, first, false, Cancellation))!.Value;
            secondRevision = (await tree.ReadPetRevisionAsync(AlphaWorkspace, second, false, Cancellation))!.Value;
            await work.CommitAsync(Cancellation);
        }

        var planId = Guid.NewGuid();
        var startRequestId = Guid.NewGuid();
        const string digest = "prepared-two-note-review";
        using var checkpoint = JsonDocument.Parse(JsonSerializer.Serialize(new
        {
            petId,
            provider = "anthropic",
            proposals = Array.Empty<object>(),
            results = Array.Empty<object>(),
            answers = Array.Empty<string>(),
            turns = 1,
            planRequest = new { requestId = startRequestId, sourceScope = new { kind = "workspace" } },
            plan = new
            {
                id = planId,
                version = 1,
                summary = "Rename both prepared notes.",
                reviewDigest = digest,
                scopeDigest = "prepared-fixture-scope",
                recipientRevision = "prepared-fixture-recipient",
                status = "awaiting_review",
                steps = new[]
                {
                    PreparedRename(first, firstRevision, "Reviewed project brief"),
                    PreparedRename(second, secondRevision, "Reviewed meeting notes"),
                },
            },
        }));
        var run = NewRun(first, checkpoint.RootElement.Clone()) with
        {
            ItemId = null,
            Brief = "Rename two independent notes with one reviewed plan.",
            SourceItemIds = [first.Value, second.Value],
            WorkspaceScope = true,
            Abilities = ["nix.action"],
            RequestId = startRequestId,
        };
        await SaveWaitingAsync(run, "waiting_for_approval");

        return new(run, planId, digest, first, second);
    }

    private sealed record PreparedPair(PetRunRecord Run, Guid PlanId, string Digest, ItemId First, ItemId Second);

    private static object PreparedRename(ItemId item, long revision, string title)
    {
        var arguments = new { operationId = "UpdateItem", path = new { itemId = item.Value }, body = new { title } };
        return new
        {
            id = Guid.NewGuid(),
            capability = "nix.action",
            arguments,
            effect = new
            {
                description = $"Rename the prepared note to {title}.",
                parameters = new
                {
                    operationId = "UpdateItem",
                    method = "PATCH",
                    target = $"/api/v1/items/{item.Value:D}",
                    inputs = arguments,
                    revisions = string.Create(CultureInfo.InvariantCulture, $"{AlphaWorkspace.Value:D}|{item.Value:D}:{revision}"),
                },
            },
            executor = "server",
            status = "pending",
            fields = new[] { new { id = "prepared-title", label = "Title", kind = "text", value = title,
                argumentPath = new[] { "body", "title" } } },
        };
    }

    private async Task<string?> ReadPreparedTitleAsync(ItemId item)
    {
        await using var work = await fixture.Application.BeginUnitOfWorkAsync(TestTenants.AlphaContext, Cancellation);
        var found = await work.Resolve<IItemTree>().FindAsync(item, Cancellation);
        return found is null ? null : ItemProperties.ReadTitle(found.Properties);
    }

    private sealed class PreparedPlanMustNotCallProvider : HttpMessageHandler
    {
        public int Calls { get; private set; }
        protected override Task<HttpResponseMessage> SendAsync(HttpRequestMessage request, CancellationToken cancellationToken)
        {
            Calls++;
            throw new InvalidOperationException("Executing prepared effects must not call a provider.");
        }
    }

    private sealed class ObservedPlanLoopback(HttpMessageHandler inner,
        ConcurrentQueue<(string Target, string Body, HttpStatusCode Status)> observed) : DelegatingHandler(inner)
    {
        protected override async Task<HttpResponseMessage> SendAsync(HttpRequestMessage request, CancellationToken cancellationToken)
        {
            var body = request.Content is null ? "" : await request.Content.ReadAsStringAsync(cancellationToken);
            var response = await base.SendAsync(request, cancellationToken);
            if (request.Method == HttpMethod.Patch)
            {
                observed.Enqueue((request.RequestUri!.PathAndQuery, body, response.StatusCode));
            }
            return response;
        }
    }
}
