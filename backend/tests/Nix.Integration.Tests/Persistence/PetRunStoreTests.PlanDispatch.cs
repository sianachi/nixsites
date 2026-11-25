using System.Collections.Concurrent;
using System.Net;
using System.Text;
using System.Text.Json;
using Microsoft.Extensions.DependencyInjection;
using Nix.Abstractions;
using Nix.Domain.Items;
using Nix.Features.Pets;
using Nix.Integration.Tests.Harness;
using Nix.Workers;

namespace Nix.Integration.Tests.Persistence;

public sealed partial class PetRunStoreTests
{
    [Theory]
    [Trait("Category", "FrozenPetPlan")]
    [InlineData(false)]
    [InlineData(true)]
    public async Task Changing_the_body_or_target_of_an_unconsumed_signed_request_cannot_write_or_spend_its_exact_permit(bool changeTarget)
    {
        var prepared = await CreatePreparedPairAsync();
        await using var execution = await OpenPreparedExecutionAsync(prepared, holdFirst: true);
        await ApprovePreparedAsync(execution, prepared);
        var issued = await execution.Transport.FirstRequest.WaitAsync(TimeSpan.FromSeconds(15), Cancellation);
        using (var changed = issued.CreateMessage())
        {
            if (changeTarget)
            {
                changed.RequestUri = new Uri(issued.Address, $"/api/v1/items/{prepared.Second.Value:D}");
            }
            else
            {
                changed.Content?.Dispose();
                changed.Content = new StringContent("{\"title\":\"An unreviewed title\"}", Encoding.UTF8, "application/json");
            }
            using var refused = await execution.Host.Client.SendAsync(changed, Cancellation);
            Assert.Equal(HttpStatusCode.Forbidden, refused.StatusCode);
        }
        Assert.Equal("Test target note", await ReadPreparedTitleAsync(prepared.First));
        Assert.Equal("Second prepared note", await ReadPreparedTitleAsync(prepared.Second));
        execution.Transport.Release();
        await WaitForRunAsync(execution.Host, execution.Browser, execution.Route, "completed");
        Assert.Equal("Reviewed project brief", await ReadPreparedTitleAsync(prepared.First));
        Assert.Equal("Reviewed meeting notes", await ReadPreparedTitleAsync(prepared.Second));
        Assert.Equal(2, execution.Transport.Attempts.Count);
        Assert.Equal(0, execution.Provider.Calls);
    }

    [Fact]
    [Trait("Category", "FrozenPetPlan")]
    public async Task Cancelling_after_permit_issuance_before_dispatch_prevents_both_frozen_writes()
    {
        var prepared = await CreatePreparedPairAsync();
        await using var execution = await OpenPreparedExecutionAsync(prepared, holdFirst: true);
        await ApprovePreparedAsync(execution, prepared);
        var issued = await execution.Transport.FirstRequest.WaitAsync(TimeSpan.FromSeconds(15), Cancellation);
        Assert.Equal("Test target note", await ReadPreparedTitleAsync(prepared.First));
        Assert.Equal("Second prepared note", await ReadPreparedTitleAsync(prepared.Second));

        var claimed = await ReadPlanAsync(execution);
        using (var cancelled = await execution.Host.SendAsync(HttpMethod.Post, execution.Route + "/cancel", execution.Browser,
            new { expectedRunRevision = claimed.GetProperty("revision").GetInt64(), requestId = Guid.NewGuid() }))
        {
            cancelled.EnsureSuccessStatusCode();
        }
        await AssertRevokedPlanRequestAsync(execution, issued);
        execution.Transport.Release();
        await execution.Transport.FirstSettled.WaitAsync(TimeSpan.FromSeconds(15), Cancellation);

        var final = await WaitForRunAsync(execution.Host, execution.Browser, execution.Route, "cancelled");
        Assert.Equal("cancelled", final.GetProperty("plan").GetProperty("status").GetString());
        Assert.All(final.GetProperty("plan").GetProperty("steps").EnumerateArray(), step =>
            Assert.Equal("cancelled", step.GetProperty("status").GetString()));
        Assert.Equal("Test target note", await ReadPreparedTitleAsync(prepared.First));
        Assert.Equal("Second prepared note", await ReadPreparedTitleAsync(prepared.Second));
        Assert.Single(execution.Transport.Attempts);
        Assert.Equal(0, execution.Provider.Calls);
    }

    [Fact]
    [Trait("Category", "FrozenPetPlan")]
    public async Task A_new_draft_after_permit_issuance_revokes_the_old_token_before_Core_dispatch()
    {
        var prepared = await CreatePreparedPairAsync();
        await using var execution = await OpenPreparedExecutionAsync(prepared, holdFirst: true);
        await ApprovePreparedAsync(execution, prepared);
        var issued = await execution.Transport.FirstRequest.WaitAsync(TimeSpan.FromSeconds(15), Cancellation);
        var claimed = await ReadPlanAsync(execution);
        var firstStep = claimed.GetProperty("plan").GetProperty("steps")[0];
        JsonElement revised;
        using (var response = await execution.Host.SendAsync(HttpMethod.Post, execution.Route + "/drafts", execution.Browser,
            new
            {
                expectedRunRevision = claimed.GetProperty("revision").GetInt64(),
                planVersion = 1,
                fieldEdits = new[] { new { stepId = firstStep.GetProperty("id").GetGuid(), fieldId = "prepared-title", value = "A revised title awaiting review" } },
                requestId = Guid.NewGuid(),
            }))
        {
            response.EnsureSuccessStatusCode();
            using var document = await SiteHttpHost.JsonAsync(response);
            revised = document.RootElement.Clone();
        }
        Assert.Equal("waiting_for_approval", revised.GetProperty("status").GetString());
        Assert.Equal(2, revised.GetProperty("plan").GetProperty("version").GetInt32());
        Assert.NotEqual(prepared.Digest, revised.GetProperty("plan").GetProperty("reviewDigest").GetString());
        Assert.Contains(revised.GetProperty("plan").GetProperty("steps")[0].GetProperty("fields").EnumerateArray(),
            field => field.GetProperty("value").GetString() == "A revised title awaiting review");
        await AssertRevokedPlanRequestAsync(execution, issued);
        execution.Transport.Release();
        await execution.Transport.FirstSettled.WaitAsync(TimeSpan.FromSeconds(15), Cancellation);

        using var staleDecision = await execution.Host.SendAsync(HttpMethod.Post,
            execution.Route + $"/plans/{prepared.PlanId:D}/decision", execution.Browser,
            new
            {
                expectedRunRevision = revised.GetProperty("revision").GetInt64(),
                planVersion = 1,
                reviewDigest = prepared.Digest,
                approve = true,
                requestId = Guid.NewGuid()
            });
        Assert.Equal(HttpStatusCode.Conflict, staleDecision.StatusCode);
        Assert.Equal("Test target note", await ReadPreparedTitleAsync(prepared.First));
        Assert.Equal("Second prepared note", await ReadPreparedTitleAsync(prepared.Second));
        Assert.Single(execution.Transport.Attempts);
        var current = await ReadPlanAsync(execution);
        Assert.Equal("waiting_for_approval", current.GetProperty("status").GetString());
        Assert.Equal(2, current.GetProperty("plan").GetProperty("version").GetInt32());
        Assert.Equal(revised.GetProperty("plan").GetProperty("reviewDigest").GetString(),
            current.GetProperty("plan").GetProperty("reviewDigest").GetString());
        Assert.Equal(0, execution.Provider.Calls);
    }

    [Fact]
    [Trait("Category", "FrozenPetPlan")]
    public async Task A_consumed_exact_request_cannot_be_replayed_after_both_frozen_writes_complete()
    {
        var prepared = await CreatePreparedPairAsync();
        await using var execution = await OpenPreparedExecutionAsync(prepared);
        await ApprovePreparedAsync(execution, prepared);
        var firstRequest = await execution.Transport.FirstRequest.WaitAsync(TimeSpan.FromSeconds(15), Cancellation);
        await WaitForRunAsync(execution.Host, execution.Browser, execution.Route, "completed");
        var beforeReplay = await ReadPreparedRevisionAsync(prepared.First);

        using var replay = firstRequest.CreateMessage();
        using var refused = await execution.Host.Client.SendAsync(replay, Cancellation);

        Assert.Equal(HttpStatusCode.Conflict, refused.StatusCode);
        Assert.Equal("pet_plans.dispatch_refused", await SiteHttpHost.ProblemCodeAsync(refused));
        Assert.Equal(beforeReplay, await ReadPreparedRevisionAsync(prepared.First));
        Assert.Equal("Reviewed project brief", await ReadPreparedTitleAsync(prepared.First));
        Assert.Equal("Reviewed meeting notes", await ReadPreparedTitleAsync(prepared.Second));
        Assert.Equal(2, execution.Transport.Attempts.Count);
        Assert.Equal(0, execution.Provider.Calls);
    }

    [Theory]
    [Trait("Category", "FrozenPetPlan")]
    [InlineData(false, "refused", "Test target note")]
    [InlineData(true, "unknown", "Reviewed project brief")]
    public async Task A_refused_or_unconfirmed_first_effect_stops_the_remaining_frozen_plan(
        bool loseResponse, string expectedStepStatus, string expectedFirstTitle)
    {
        var prepared = await CreatePreparedPairAsync();
        await using var execution = await OpenPreparedExecutionAsync(prepared,
            behavior: loseResponse ? PlanTransportBehavior.LoseFirstResponse : PlanTransportBehavior.RefuseFirst);
        await ApprovePreparedAsync(execution, prepared);
        var stopped = await WaitForRunAsync(execution.Host, execution.Browser, execution.Route, "review_required");
        var steps = stopped.GetProperty("plan").GetProperty("steps");

        Assert.Equal(expectedStepStatus, steps[0].GetProperty("status").GetString());
        Assert.Equal("cancelled", steps[1].GetProperty("status").GetString());
        Assert.Equal(expectedFirstTitle, await ReadPreparedTitleAsync(prepared.First));
        Assert.Equal("Second prepared note", await ReadPreparedTitleAsync(prepared.Second));
        Assert.Single(execution.Transport.Attempts);
        Assert.Equal(0, execution.Provider.Calls);
    }

    private async Task<PreparedExecution> OpenPreparedExecutionAsync(PreparedPair prepared, bool holdFirst = false,
        PlanTransportBehavior behavior = PlanTransportBehavior.PassThrough)
    {
#pragma warning disable CA2000 // Justification: PreparedExecution owns these resources; failed sign-in disposes them below.
        var provider = new PreparedPlanMustNotCallProvider();
        SiteHttpHost? target = null;
        var transport = new PlanDispatchTransport(holdFirst, behavior);
        var host = SiteHttpHost.Create(fixture, new Dictionary<string, string?>
        {
            ["Nix:Bff:PublicOrigin"] = PetOrigin,
            ["Nix:PetRuns:Enabled"] = "true",
            ["Nix:PetRuns:AllowedWorkspaces:0"] = AlphaWorkspace.Value.ToString("D"),
            ["Nix:Workers:Families:0"] = "pet-plan",
            ["Nix:Workers:LoopbackUrl"] = "http://127.0.0.1",
            ["Nix:Pets:WorkerUrl"] = "https://prepared-plan.invalid/",
        }, services =>
        {
            services.AddHttpClient<PetWorkerClient>().ConfigurePrimaryHttpMessageHandler(() => provider);
            services.AddHttpClient("PetRecipientMetadataClient").ConfigurePrimaryHttpMessageHandler(() => new PreparedRecipientMetadata());
            services.AddHttpClient(WorkerLoopbackClient.HttpClientName).ConfigurePrimaryHttpMessageHandler(() =>
            {
                transport.InnerHandler = target!.CreateLoopbackHandler();
                return transport;
            });
        });
#pragma warning restore CA2000
        target = host;
        try
        {
            return new(host, await SignInAsync(host),
                $"/api/v1/workspaces/{AlphaWorkspace.Value:D}/pet-plans/{prepared.Run.Id:D}", provider, transport);
        }
        catch
        {
            await host.DisposeAsync();
            provider.Dispose();
            transport.Dispose();
            throw;
        }
    }

    private static async Task ApprovePreparedAsync(PreparedExecution execution, PreparedPair prepared)
    {
        var review = await ReadPlanAsync(execution);
        using var response = await execution.Host.SendAsync(HttpMethod.Post,
            execution.Route + $"/plans/{prepared.PlanId:D}/decision", execution.Browser,
            new
            {
                expectedRunRevision = review.GetProperty("revision").GetInt64(),
                planVersion = 1,
                reviewDigest = prepared.Digest,
                approve = true,
                requestId = Guid.NewGuid()
            });
        response.EnsureSuccessStatusCode();
    }

    private static async Task<JsonElement> ReadPlanAsync(PreparedExecution execution)
    {
        using var response = await execution.Host.SendAsync(HttpMethod.Get, execution.Route, execution.Browser);
        response.EnsureSuccessStatusCode();
        using var document = await SiteHttpHost.JsonAsync(response);
        return document.RootElement.Clone();
    }

    private static async Task AssertRevokedPlanRequestAsync(PreparedExecution execution, CapturedPlanRequest issued)
    {
        // A revoked worker may cancel its transport; the issued credential must also fail when presented independently.
        using var request = issued.CreateMessage();
        using var response = await execution.Host.Client.SendAsync(request, Cancellation);
        Assert.Equal(HttpStatusCode.Conflict, response.StatusCode);
        Assert.Equal("pet_plans.dispatch_refused", await SiteHttpHost.ProblemCodeAsync(response));
    }

    private async Task<long?> ReadPreparedRevisionAsync(ItemId item)
    {
        await using var work = await fixture.Application.BeginUnitOfWorkAsync(TestTenants.AlphaContext, Cancellation);
        return await work.Resolve<IItemTree>().ReadPetRevisionAsync(AlphaWorkspace, item, false, Cancellation);
    }

    private sealed record PreparedExecution(SiteHttpHost Host, string Browser, string Route,
        PreparedPlanMustNotCallProvider Provider, PlanDispatchTransport Transport) : IAsyncDisposable
    {
        public async ValueTask DisposeAsync()
        {
            Transport.Release();
            await Host.DisposeAsync();
            Provider.Dispose();
            Transport.Dispose();
        }
    }

    private enum PlanTransportBehavior { PassThrough, RefuseFirst, LoseFirstResponse }

    private sealed record CapturedPlanRequest(Uri Address, string Body, IReadOnlyDictionary<string, string[]> Headers,
        IReadOnlyDictionary<string, string[]> ContentHeaders)
    {
        internal HttpRequestMessage CreateMessage()
        {
            var request = new HttpRequestMessage(HttpMethod.Patch, Address) { Content = new StringContent(Body) };
            request.Content.Headers.Clear();
            foreach (var header in Headers)
            {
                request.Headers.TryAddWithoutValidation(header.Key, header.Value);
            }
            foreach (var header in ContentHeaders)
            {
                request.Content.Headers.TryAddWithoutValidation(header.Key, header.Value);
            }
            return request;
        }
    }

    private sealed class PlanDispatchTransport(bool holdFirst, PlanTransportBehavior behavior) : DelegatingHandler
    {
        private readonly TaskCompletionSource<CapturedPlanRequest> _firstRequest = new(TaskCreationOptions.RunContinuationsAsynchronously);
        private readonly TaskCompletionSource _firstSettled = new(TaskCreationOptions.RunContinuationsAsynchronously);
        private readonly TaskCompletionSource _release = new(TaskCreationOptions.RunContinuationsAsynchronously);
        private int _attempts;
        internal ConcurrentQueue<string> Attempts { get; } = new();
        internal Task<CapturedPlanRequest> FirstRequest => _firstRequest.Task;
        internal Task FirstSettled => _firstSettled.Task;
        internal void Release() => _release.TrySetResult();

        protected override async Task<HttpResponseMessage> SendAsync(HttpRequestMessage request, CancellationToken cancellationToken)
        {
            if (request.Method != HttpMethod.Patch)
            {
                return await base.SendAsync(request, cancellationToken);
            }
            var first = Interlocked.Increment(ref _attempts) == 1;
            Attempts.Enqueue(request.RequestUri!.PathAndQuery);
            try
            {
                if (first)
                {
                    var body = await request.Content!.ReadAsStringAsync(cancellationToken);
                    _firstRequest.TrySetResult(new(request.RequestUri, body,
                        request.Headers.ToDictionary(header => header.Key, header => header.Value.ToArray()),
                        request.Content.Headers.ToDictionary(header => header.Key, header => header.Value.ToArray())));
                    if (holdFirst)
                    {
                        await _release.Task.WaitAsync(cancellationToken);
                    }
                }
                if (first && behavior == PlanTransportBehavior.RefuseFirst)
                {
                    return new HttpResponseMessage(HttpStatusCode.Forbidden)
                    {
                        Content = new StringContent("{\"code\":\"test.refused\"}", Encoding.UTF8, "application/problem+json"),
                    };
                }
                var response = await base.SendAsync(request, cancellationToken);
                if (first && behavior == PlanTransportBehavior.LoseFirstResponse)
                {
                    response.Dispose();
                    throw new HttpRequestException("The local response was lost after Core applied the effect.");
                }
                return response;
            }
            finally
            {
                if (first)
                {
                    _firstSettled.TrySetResult();
                }
            }
        }
    }

    private sealed class PreparedRecipientMetadata : HttpMessageHandler
    {
        protected override Task<HttpResponseMessage> SendAsync(HttpRequestMessage request, CancellationToken cancellationToken) =>
            Task.FromResult(new HttpResponseMessage(HttpStatusCode.OK)
            {
                Content = new StringContent("{\"provider\":\"chatgpt\",\"connectionRevision\":\"prepared-local-connection\"}", Encoding.UTF8, "application/json"),
            });
    }
}
