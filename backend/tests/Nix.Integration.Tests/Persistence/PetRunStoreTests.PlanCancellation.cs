using Nix.Integration.Tests.Harness;

namespace Nix.Integration.Tests.Persistence;

public sealed partial class PetRunStoreTests
{
    [Fact]
    [Trait("Category", "PetPlanCancellation")]
    public async Task Cancelling_before_source_adoption_resolves_the_original_planned_calls_without_dispatch()
    {
        var prepared = await CreatePreparedPairAsync();
        using var adapter = new ReadBatchAdapter(prepared.First.Value, prepared.Second.Value, readWithoutAsking: false, readOnly: false, mixed: true)
        { HoldInspection = true };
        await using var host = CreateReadPlanHost(adapter);
        adapter.Host = host;
        var browser = await SignInAsync(host);
        var route = await StartReadBatchAsync(host, browser, adapter, prepared.Run.State.GetProperty("petId").GetGuid());
        try
        {
            await adapter.InspectionEntered.WaitAsync(TimeSpan.FromSeconds(15), Cancellation);
            using var response = await host.SendAsync(HttpMethod.Get, route, browser);
            response.EnsureSuccessStatusCode();
            using var current = await SiteHttpHost.JsonAsync(response);
            using var cancelled = await host.SendAsync(HttpMethod.Post, route + "/cancel", browser,
                new { expectedRunRevision = current.RootElement.GetProperty("revision").GetInt64(), requestId = Guid.NewGuid() });
            cancelled.EnsureSuccessStatusCode();
        }
        finally
        {
            adapter.ReleaseInspection();
        }
        await WaitForRunAsync(host, browser, route, "cancelled");
        var cancellation = Assert.Single(adapter.Cancellations);
        Assert.EndsWith(cancellation.GetProperty("runId").GetGuid().ToString("D"), route, StringComparison.Ordinal);
        Assert.Equal(adapter.ToolIds, cancellation.GetProperty("toolIds").EnumerateArray().Select(tool => tool.GetString()));
        Assert.Empty(adapter.Resolutions);
        Assert.Empty(adapter.Supersessions);
        Assert.Equal(0, adapter.ReadCalls);
        Assert.Equal(0, adapter.WriteDispatches);
        Assert.Equal(0, adapter.ModelCalls);
        Assert.Equal("Test target note", await ReadPreparedTitleAsync(prepared.First));
        Assert.Equal("Second prepared note", await ReadPreparedTitleAsync(prepared.Second));
    }

    [Fact]
    [Trait("Category", "PetPlanCancellation")]
    public async Task Declining_source_sharing_resolves_original_calls_without_inspection_or_dispatch()
    {
        var prepared = await CreatePreparedPairAsync();
        using var adapter = new ReadBatchAdapter(prepared.First.Value, prepared.Second.Value, readWithoutAsking: false, readOnly: false, mixed: true);
        await using var host = CreateReadPlanHost(adapter);
        adapter.Host = host;
        var browser = await SignInAsync(host);
        var route = await StartReadBatchAsync(host, browser, adapter, prepared.Run.State.GetProperty("petId").GetGuid(), approveSharing: false);
        await WaitForRunAsync(host, browser, route, "cancelled");
        var cancellation = Assert.Single(adapter.Cancellations);
        Assert.EndsWith(cancellation.GetProperty("runId").GetGuid().ToString("D"), route, StringComparison.Ordinal);
        Assert.Equal(adapter.ToolIds, cancellation.GetProperty("toolIds").EnumerateArray().Select(tool => tool.GetString()));
        Assert.Equal(0, adapter.InspectionCalls);
        Assert.Equal(0, adapter.ReadCalls);
        Assert.Equal(0, adapter.WriteDispatches);
        Assert.Equal(0, adapter.ModelCalls);
        Assert.Empty(adapter.Resolutions);
        Assert.Empty(adapter.Supersessions);
        Assert.Equal("Test target note", await ReadPreparedTitleAsync(prepared.First));
        Assert.Equal("Second prepared note", await ReadPreparedTitleAsync(prepared.Second));
    }
}
