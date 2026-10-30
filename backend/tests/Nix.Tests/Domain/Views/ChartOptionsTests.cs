using System.Collections.Immutable;
using System.Text.Json.Nodes;
using Nix.Domain.Time;
using Nix.Domain.Views;

namespace Nix.Tests.Domain.Views;

/// <summary>
/// A chart view's type, time axis, series and window: what may be stored, and how it is read back.
/// </summary>
public sealed class ChartOptionsTests
{
    private static ViewDefinition Chart(ChartOptions? options) =>
        new("chart", "Spend", ViewKind.Chart, [], "category", [], null, null, false, Chart: options);

    [Fact]
    public void A_chart_with_no_options_stores_exactly_as_before_the_field_existed()
    {
        var json = ViewDefinitionsJson.Write([Chart(null)]);

        Assert.DoesNotContain("\"chart\":", json, StringComparison.Ordinal);
        Assert.Null(ViewDefinitionsJson.Read(json).Views.Single().Chart);

        // An all-default object is no options at all, so it stores nothing either.
        Assert.DoesNotContain("\"chart\":", ViewDefinitionsJson.Write([Chart(ChartOptions.Default)]), StringComparison.Ordinal);
    }

    [Fact]
    public void Every_option_round_trips_through_storage()
    {
        var options = new ChartOptions(
            ChartKinds.Line,
            DatePeriods.Week,
            "project",
            From: new DateOnly(2026, 1, 1),
            To: new DateOnly(2026, 6, 30),
            Cumulative: true,
            RollingAverage: true,
            Stacked: true);

        var read = ViewDefinitionsJson.Read(ViewDefinitionsJson.Write([Chart(options)])).Views.Single();

        Assert.Equal(options, read.Chart);

        var rolling = new ChartOptions(ChartKinds.Area, DatePeriods.Month, LastPeriods: 12);
        Assert.Equal(
            rolling,
            ViewDefinitionsJson.Read(ViewDefinitionsJson.Write([Chart(rolling)])).Views.Single().Chart);
    }

    [Fact]
    public void A_type_or_period_this_build_does_not_know_reads_as_absent_rather_than_costing_the_view()
    {
        var json = """
            {"views":[{"id":"c","name":"C","kind":"chart","groupBy":"status","sortDescending":false,
              "chart":{"kind":"radar","period":"fortnight","splitBy":"owner","lastPeriods":9000}}]}
            """;

        var view = Assert.Single(ViewDefinitionsJson.Read(json).Views);

        Assert.Equal(new ChartOptions(SplitBy: "owner"), view.Chart);
    }

    [Fact]
    public void A_line_stored_without_a_period_reads_as_bars()
    {
        var json = """
            {"views":[{"id":"c","name":"C","kind":"chart","groupBy":"status","sortDescending":false,
              "chart":{"kind":"line"}}]}
            """;

        Assert.Null(Assert.Single(ViewDefinitionsJson.Read(json).Views).Chart);
    }

    [Theory]
    [InlineData("radar", null, "not a chart type")]
    [InlineData(null, "fortnight", "not a period")]
    [InlineData("line", null, "needs a date to group by and a period")]
    [InlineData("area", null, "needs a date to group by and a period")]
    [InlineData("year", "week", "counts by day")]
    public void A_type_or_period_that_cannot_be_drawn_is_refused(string? kind, string? period, string reason)
    {
        var refusal = ViewDefinitionRules.Refuse([Chart(new ChartOptions(kind, period))], null);

        Assert.NotNull(refusal);
        Assert.Contains(reason, refusal, StringComparison.Ordinal);
    }

    [Theory]
    [InlineData(null, "week", "needs a date property to group by")]
    [InlineData("line", null, "needs a date property to group by")]
    [InlineData(null, null, "needs a property to group by")]
    public void A_period_chart_with_nothing_to_group_by_names_the_date_it_needs(
        string? kind,
        string? period,
        string reason)
    {
        var view = new ViewDefinition(
            "chart", "Spend", ViewKind.Chart, [], null, [], null, null, false,
            Chart: kind is null && period is null ? null : new ChartOptions(kind, period));

        var refusal = ViewDefinitionRules.Refuse([view], null);

        Assert.NotNull(refusal);
        Assert.Contains(reason, refusal, StringComparison.Ordinal);
    }

    [Fact]
    public void Windows_need_a_period_one_shape_and_an_order()
    {
        Assert.Contains(
            "needs a period",
            new ChartOptions(LastPeriods: 6).Refuse(),
            StringComparison.Ordinal);
        Assert.Contains(
            "not both",
            new ChartOptions(Period: "month", LastPeriods: 6, From: new DateOnly(2026, 1, 1)).Refuse(),
            StringComparison.Ordinal);
        Assert.Contains(
            "from 1 to 371",
            new ChartOptions(Period: "day", LastPeriods: 372).Refuse(),
            StringComparison.Ordinal);
        Assert.Contains(
            "on or after",
            new ChartOptions(Period: "day", From: new DateOnly(2026, 2, 1), To: new DateOnly(2026, 1, 1)).Refuse(),
            StringComparison.Ordinal);

        Assert.Null(new ChartOptions(ChartKinds.Year, DatePeriods.Day).Refuse());
        Assert.Null(new ChartOptions(ChartKinds.Column, DatePeriods.Month, "status", LastPeriods: 12).Refuse());
        Assert.Null(new ChartOptions(ChartKinds.Pie, SplitBy: "done").Refuse());
    }

    [Fact]
    public void Every_type_is_valid_and_only_ordered_ones_need_a_time_axis()
    {
        Assert.Equal(["bar", "column", "pie", "line", "area", "year"], ChartKinds.All.ToArray());
        Assert.All(ChartKinds.All, kind => Assert.True(ChartKinds.IsValid(kind)));
        Assert.Equal(
            ["line", "area", "year"],
            ChartKinds.All.Where(ChartKinds.NeedsTimeAxis).ToArray());
    }

    [Fact]
    public void The_stored_shape_is_sparse()
    {
        var json = ViewDefinitionsJson.Write([Chart(new ChartOptions(ChartKinds.Pie))]);
        var stored = JsonNode.Parse(json!)!["views"]![0]!["chart"]!.AsObject();

        Assert.Equal(["kind"], stored.Select(pair => pair.Key).ToImmutableArray());
    }
}
