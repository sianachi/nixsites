using System.Globalization;
using System.Text.Json.Nodes;
using System.Web;
using Nix.Abstractions;
using Nix.Domain.Items;
using Nix.Domain.Tenancy;
using Nix.Features.Charts;
using Nix.Integration.Tests.Harness;
using Nix.Messaging;

namespace Nix.Integration.Tests.ViewCompute;

/// <summary>
/// Replays <c>packages/view-compute/fixtures/chart/*.json</c> through Core's own chart handler, so
/// the offline TypeScript port of <c>GET /items/{id}/chart</c> and Core cannot drift. The answer is
/// built the way <c>ChartMapping</c> builds the HTTP body and compared with the fixture's expected
/// JSON after the minted ids are written back as <c>{key}</c>.
/// </summary>
[Collection(PostgresSecondaryCollectionDefinition.Name)]
public sealed class ChartFixtureReplayTests : IAsyncLifetime
{
    private readonly NixPostgresFixture _fixture;

    public ChartFixtureReplayTests(NixPostgresFixture fixture) => _fixture = fixture;

    private static CancellationToken Cancellation => TestContext.Current.CancellationToken;

    public async ValueTask InitializeAsync()
    {
        await _fixture.ResetAsync();
        await M0SchemaSeed.SeedBothTenantsAsync(_fixture);
    }

    public ValueTask DisposeAsync() => ValueTask.CompletedTask;

    [Fact]
    public async Task Every_chart_fixture_matches_what_core_answers()
    {
        var fixtures = ViewComputeFixtures.Load("chart");
        Assert.NotEmpty(fixtures);

        foreach (var fixture in fixtures)
        {
            var work = await _fixture.Application.BeginUnitOfWorkAsync(TestTenants.AlphaContext, Cancellation);
            await using (work.ConfigureAwait(false))
            {
                var workspace = WorkspaceId.From(TestTenants.AlphaWorkspace);
                var ids = await ViewComputeFixtures.SeedAsync(
                    work.Resolve<NixDispatcher>(), workspace, fixture, Cancellation);

                var path = ViewComputeFixtures.ToIds(fixture.Request["path"]!.GetValue<string>(), ids);
                var answer = await AnswerAsync(work, path, fixture.Now);
                var actual = ViewComputeFixtures.ToKeys(answer, ids);

                Assert.True(
                    JsonNode.DeepEquals(fixture.Expected, actual),
                    $"{fixture.Name}: Core answered {actual?.ToJsonString()} but the fixture expects {fixture.Expected.ToJsonString()}");
            }
        }
    }

    private static async Task<JsonObject> AnswerAsync(NixUnitOfWork work, string path, DateTimeOffset now)
    {
        var uri = new Uri(new Uri("https://nix.test"), path);
        var itemId = Guid.Parse(uri.AbsolutePath.Split('/')[4]);
        var view = HttpUtility.ParseQueryString(uri.Query)["view"];

        if (string.IsNullOrEmpty(view))
        {
            return Refused(ChartErrors.ViewNotFound(string.Empty).Code, "Name the view to draw: ?view=<view id>.");
        }

        var handler = new RunItemChartHandler(
            work.Resolve<IItemTree>(),
            work.Resolve<IPermissionResolver>(),
            work.Resolve<IChildAggregates>(),
            work.Resolve<IItemLocks>(),
            new FixedClock(now),
            work.Resolve<IPrincipalPreferencesStore>(),
            work.Resolve<INixSessionContextAccessor>());

        var result = await handler.HandleAsync(new RunItemChart(ItemId.From(itemId), view), Cancellation);
        return result.IsSuccess
            ? new JsonObject { ["status"] = 200, ["body"] = Body(itemId, view, result.Value) }
            : Refused(result.Error.Code, result.Error.Message);
    }

    // The statuses ChartEndpoints.Problem (internal) maps these codes to; anything else is items.locked.
    private static JsonObject Refused(string code, string detail) => new()
    {
        ["status"] = code switch
        {
            "items.not_found" or "chart.view_not_found" => 404,
            "chart.not_configured" => 422,
            _ => 423,
        },
        ["code"] = code,
        ["detail"] = detail,
    };

    private static JsonObject Body(Guid itemId, string view, ItemChart chart) => new()
    {
        ["itemId"] = itemId.ToString(),
        ["viewId"] = view,
        ["groupBy"] = chart.GroupBy,
        ["measure"] = chart.Measure,
        ["measureProperty"] = chart.MeasureProperty,
        ["buckets"] = new JsonArray([.. chart.Buckets.Select(bucket => (JsonNode)new JsonObject
        {
            ["value"] = bucket.Value,
            ["children"] = bucket.Children,
            ["total"] = Number(bucket.Total),
            ["cells"] = new JsonArray([.. bucket.Cells.Select(cell => (JsonNode)new JsonObject
            {
                ["children"] = cell.Children,
                ["total"] = Number(cell.Total),
            })]),
        })]),
        ["children"] = chart.Children,
        ["distinctValues"] = chart.DistinctValues,
        ["truncated"] = chart.Truncated,
        ["chartKind"] = chart.Kind,
        ["period"] = chart.Period,
        ["splitBy"] = chart.SplitBy,
        ["from"] = Day(chart.From),
        ["to"] = Day(chart.To),
        ["series"] = new JsonArray([.. chart.Series.Select(series => (JsonNode)new JsonObject
        {
            ["value"] = series.Value,
            ["other"] = series.Other,
            ["children"] = series.Children,
            ["total"] = Number(series.Total),
        })]),
        ["otherSeries"] = chart.OtherSeries,
        ["unplaced"] = chart.Unplaced,
        ["outsideWindow"] = chart.OutsideWindow,
        ["stacked"] = chart.Stacked,
        ["cumulative"] = chart.Cumulative,
        ["rollingAverage"] = chart.RollingAverage,
    };

    // As a double so 4.000000 and 4 compare as the same number.
    private static JsonValue? Number(decimal? value) =>
        value is { } number ? JsonValue.Create((double)number) : null;

    private static string? Day(DateOnly? day) =>
        day?.ToString("yyyy-MM-dd", CultureInfo.InvariantCulture);

    private sealed class FixedClock(DateTimeOffset now) : TimeProvider
    {
        public override DateTimeOffset GetUtcNow() => now;
    }
}
