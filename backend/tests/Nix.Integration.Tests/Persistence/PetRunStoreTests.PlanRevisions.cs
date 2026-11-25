using System.Net;
using Nix.Domain.Items;
using Nix.Features.Items;
using Nix.Integration.Tests.Harness;
using Nix.Messaging;

namespace Nix.Integration.Tests.Persistence;

public sealed partial class PetRunStoreTests
{
    [Theory]
    [Trait("Category", "PetPlanRevision")]
    [InlineData(1, "completed")]
    [InlineData(3, "completed")]
    [InlineData(3, "partial")]
    [InlineData(3, "unknown")]
    public async Task A_changed_step_count_rebinds_both_original_calls_and_retains_truthful_observed_outcomes(int revisedCount, string outcome)
    {
        var prepared = await CreatePreparedPairAsync();
        ItemId third;
        await using (var work = await fixture.Application.BeginUnitOfWorkAsync(TestTenants.AlphaContext, Cancellation))
        {
            var created = await work.Resolve<NixDispatcher>().SendAsync<CreateItem, Item>(
                new(AlphaWorkspace, "note", "Third revision target", null, null), Cancellation);
            Assert.True(created.IsSuccess);
            third = created.Value.Id;
            await work.CommitAsync(Cancellation);
        }
        var targets = revisedCount == 1 ? new[] { prepared.Second } : new[] { prepared.First, prepared.Second, third };
        using var adapter = new ReadBatchAdapter(prepared.First.Value, prepared.Second.Value, readWithoutAsking: false, readOnly: false, mixed: true)
        { RevisedWriteTargets = targets.Select(target => target.Value).ToArray(), WriteOutcome = outcome };
        await using var host = CreateReadPlanHost(adapter);
        adapter.Host = host;
        var browser = await SignInAsync(host);
        var route = await StartReadBatchAsync(host, browser, adapter, prepared.Run.State.GetProperty("petId").GetGuid());
        var original = await WaitForRunAsync(host, browser, route, "waiting_for_approval");
        var originalPlan = original.GetProperty("plan");
        Assert.Equal(2, originalPlan.GetProperty("steps").GetArrayLength());
        using (var feedback = await host.SendAsync(HttpMethod.Post, route + "/drafts", browser,
            new
            {
                expectedRunRevision = original.GetProperty("revision").GetInt64(),
                planVersion = originalPlan.GetProperty("version").GetInt32(),
                feedback = "Replace the original proposal with the reviewed independent title changes.",
                requestId = Guid.NewGuid()
            }))
        {
            feedback.EnsureSuccessStatusCode();
        }
        var revised = await WaitForRunAsync(host, browser, route, "waiting_for_approval");
        var plan = revised.GetProperty("plan");
        Assert.Equal(2, plan.GetProperty("version").GetInt32());
        Assert.Equal(revisedCount, plan.GetProperty("steps").GetArrayLength());
        Assert.NotEqual(originalPlan.GetProperty("reviewDigest").GetString(), plan.GetProperty("reviewDigest").GetString());
        Assert.Equal(0, adapter.ReadCalls);
        Assert.Equal(0, adapter.WriteDispatches);
        var supersession = Assert.Single(adapter.Supersessions);
        var bindings = supersession.GetProperty("bindings").EnumerateArray().ToArray();
        Assert.Equal(2, bindings.Length);
        Assert.Equal(2, bindings.Select(binding => binding.GetProperty("next").GetProperty("toolId").GetString()).Distinct().Count());
        Assert.All(bindings, binding =>
        {
            var previous = binding.GetProperty("previous");
            var next = binding.GetProperty("next");
            Assert.Equal(previous.GetProperty("toolId").GetString(), next.GetProperty("toolId").GetString());
            Assert.Equal(1, previous.GetProperty("planVersion").GetInt32());
            Assert.Equal(2, next.GetProperty("planVersion").GetInt32());
            Assert.Equal(plan.GetProperty("steps")[0].GetProperty("id").GetGuid(), next.GetProperty("stepId").GetGuid());
            Assert.Equal(plan.GetProperty("reviewDigest").GetString(), next.GetProperty("reviewDigest").GetString());
        });
        using (var stale = await host.SendAsync(HttpMethod.Post, route + $"/plans/{plan.GetProperty("id").GetGuid():D}/decision", browser,
            new
            {
                expectedRunRevision = revised.GetProperty("revision").GetInt64(),
                planVersion = 1,
                reviewDigest = originalPlan.GetProperty("reviewDigest").GetString(),
                approve = true,
                requestId = Guid.NewGuid()
            }))
        {
            Assert.Equal(HttpStatusCode.Conflict, stale.StatusCode);
        }
        Assert.Equal(0, adapter.WriteDispatches);
        using (var accepted = await host.SendAsync(HttpMethod.Post, route + $"/plans/{plan.GetProperty("id").GetGuid():D}/decision", browser,
            new
            {
                expectedRunRevision = revised.GetProperty("revision").GetInt64(),
                planVersion = 2,
                reviewDigest = plan.GetProperty("reviewDigest").GetString(),
                approve = true,
                requestId = Guid.NewGuid()
            }))
        {
            accepted.EnsureSuccessStatusCode();
        }
        var final = await WaitForRunAsync(host, browser, route, outcome == "completed" ? "completed" : "review_required");
        var steps = final.GetProperty("plan").GetProperty("steps").EnumerateArray().ToArray();
        var dispatched = outcome == "completed" ? revisedCount : 1;
        Assert.Equal(dispatched, adapter.WriteDispatches);
        Assert.Equal(dispatched, adapter.WrittenReceipts.Count);
        Assert.Equal(1, adapter.ModelCalls);
        Assert.Equal(0, adapter.ReadCalls);
        for (var index = 0; index < revisedCount; index++)
        {
            Assert.Equal(index < dispatched ? outcome == "completed" ? "applied" : outcome : "cancelled", steps[index].GetProperty("status").GetString());
            if (index < dispatched)
            {
                Assert.Equal($"Reviewed revision {index + 1}", await ReadPreparedTitleAsync(targets[index]));
                Assert.Equal(adapter.WrittenReceipts.ElementAt(index), steps[index].GetProperty("receipt").GetString());
            }
        }
        if (outcome != "completed")
        {
            Assert.Equal("Second prepared note", await ReadPreparedTitleAsync(prepared.Second));
            Assert.Equal("Third revision target", await ReadPreparedTitleAsync(third));
        }
        Assert.Equal(2, adapter.Resolutions.Count);
        Assert.All(adapter.Resolutions, resolution =>
        {
            Assert.False(resolution.GetProperty("success").GetBoolean());
            var receipt = resolution.GetProperty("result").GetString()!;
            Assert.Contains("Original proposal superseded by reviewed plan version 2.", receipt, StringComparison.Ordinal);
            for (var index = 0; index < revisedCount; index++)
            {
                Assert.Contains(steps[index].GetProperty("status").GetString()! + ":", receipt, StringComparison.Ordinal);
                Assert.Contains(steps[index].GetProperty("effect").GetProperty("description").GetString()!, receipt, StringComparison.Ordinal);
            }
            foreach (var written in adapter.WrittenReceipts)
            {
                Assert.Contains(written, receipt, StringComparison.Ordinal);
            }
        });
    }
}
