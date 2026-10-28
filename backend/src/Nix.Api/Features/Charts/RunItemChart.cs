using Microsoft.AspNetCore.Http.HttpResults;
using Microsoft.AspNetCore.Mvc;
using Nix.Abstractions;
using Nix.Domain.Items;
using Nix.Domain.Primitives;
using Nix.Domain.Time;
using Nix.Domain.Views;
using Nix.Features.Items;
using Nix.Messaging;
using NodaTime;

namespace Nix.Features.Charts;

/// <summary>Summarises a container's children the way one of its chart views says to.</summary>
/// <param name="ItemId">The container.</param>
/// <param name="ViewId">Which of its views to draw.</param>
/// <remarks>
/// <para>
/// <b>The client names the view and never sends the grouping.</b> The stored view is the whole
/// configuration, exactly as it is for a query view (ADR-0039) and for the same reason: what a
/// chart summarises is a property of the container's configuration rather than of the request, and
/// a request that could choose would be a request that could group by anything.
/// </para>
/// <para>
/// <b>Over every child, not over the page the client holds.</b> A chart tallied in the browser from
/// the first two hundred children of three thousand would be a picture of the first page presented
/// as a picture of the whole - the dishonest state the interface rules exist to forbid. ADR-0044
/// records why the aggregate is computed where the rows are.
/// </para>
/// </remarks>
public sealed record RunItemChart(ItemId ItemId, string ViewId) : IQuery<Result<ItemChart>>;

/// <summary>Handles <see cref="RunItemChart"/>.</summary>
public sealed class RunItemChartHandler(
    IItemTree tree,
    IPermissionResolver permissions,
    IChildAggregates aggregates,
    IItemLocks locks,
    TimeProvider clock,
    IPrincipalPreferencesStore preferences,
    INixSessionContextAccessor session)
    : IQueryHandler<RunItemChart, Result<ItemChart>>
{
    /// <summary>The most bars this build will draw, whatever the grouping property does.</summary>
    /// <remarks>
    /// A ceiling rather than a refusal, the posture <c>ListItemsHandler</c> takes: a grouping
    /// property that is not a declared list can take a distinct value per child, and a chart of
    /// three thousand bars is a chart nobody can read as well as a response nobody should be sent.
    /// The reader clamps to its own ceiling as well, so a caller cannot ask for more by asking
    /// twice; the response reports how many buckets there really are, so the view says it was
    /// truncated instead of drawing the top few as though they were all of them.
    /// </remarks>
    public const int MaximumBuckets = 100;

    /// <summary>The most cells a split or dated chart reads before saying it was cut short.</summary>
    /// <remarks>The reader clamps to its own ceiling as well; see <c>ChildAggregateReader.MaximumCells</c>.</remarks>
    public const int MaximumCells = 10_000;

    private readonly IPrincipalPreferencesStore _preferences = preferences;

    /// <summary>Draws the chart.</summary>
    /// <param name="query">The container and the view.</param>
    /// <param name="cancellationToken">Cancels the read.</param>
    /// <returns>The buckets, or why they could not be read.</returns>
    public async ValueTask<Result<ItemChart>> HandleAsync(
        RunItemChart query,
        CancellationToken cancellationToken)
    {
        ArgumentNullException.ThrowIfNull(query);

        var itemId = query.ItemId;

        // The same refusal an unreadable item gets everywhere: "you may not see this" would confirm
        // the thing exists, which is how an outsider enumerates a workspace an identifier at a time.
        var item = await tree.FindAsync(itemId, cancellationToken).ConfigureAwait(false);
        if (item is null
            || !await permissions.CanReadWorkspaceAsync(item.WorkspaceId, cancellationToken).ConfigureAwait(false))
        {
            return Result.Failure<ItemChart>(ItemErrors.NotFound($"No item {itemId} is visible."));
        }

        // A chart is a view of the children, and a lock covers them.
        if (!await locks.MayReadBodyAsync(itemId, cancellationToken).ConfigureAwait(false))
        {
            return Result.Failure<ItemChart>(
                ItemErrors.Locked($"Item {itemId} is locked. Unlock it to see its chart."));
        }

        ViewDefinition? found = null;
        foreach (var view in ViewDefinitionsJson.Read(item.Views).Views)
        {
            if (view.Kind == ViewKind.Chart && string.Equals(view.Id, query.ViewId, StringComparison.Ordinal))
            {
                found = view;
                break;
            }
        }

        if (found is not { } chart)
        {
            return Result.Failure<ItemChart>(
                ChartErrors.ViewNotFound($"Item {itemId} has no chart view '{query.ViewId}'."));
        }

        if (string.IsNullOrEmpty(chart.GroupBy))
        {
            // A chart with nothing to group by has no bars. Refused rather than answered with an
            // empty bucket list, which a view would draw as "there is nothing in here".
            return Result.Failure<ItemChart>(
                ChartErrors.NotConfigured($"'{chart.Name}' has no property to group by."));
        }

        // Absent means count, which is what every chart stored before the field existed drew and
        // the only measure that always has an answer.
        var measure = chart.Measure is { } stored && ChartMeasures.IsValid(stored)
            ? stored
            : ChartMeasures.Count;

        var measureProperty = string.Equals(measure, ChartMeasures.Sum, StringComparison.Ordinal)
            ? chart.MeasureProperty
            : null;

        if (measure == ChartMeasures.Sum && string.IsNullOrEmpty(measureProperty))
        {
            // A total with nothing to total draws every bar at zero, which looks like data rather
            // than like a configuration nobody finished.
            return Result.Failure<ItemChart>(
                ChartErrors.NotConfigured($"'{chart.Name}' totals a property, so it needs one to total."));
        }

        var options = chart.Chart ?? ChartOptions.Default;
        var splitBy = options.SplitBy is { Length: > 0 } split ? split : null;
        var kind = options.Kind is { } chosen && ChartKinds.IsValid(chosen) ? chosen : ChartKinds.Bar;

        FoldedChart folded;
        string? period = null;
        if (DatePeriods.TryParse(options.Period, out var axis))
        {
            // A year grid is a grid of days whatever else was stored; the write path insists on it,
            // and this holds the line for any other writer.
            if (kind == ChartKinds.Year)
            {
                axis = DatePeriod.Day;
            }

            period = DatePeriods.ToText(axis);
            var today = await TodayAsync(cancellationToken).ConfigureAwait(false);
            var (first, last, endAtData) = Window(options, axis, kind, today);

            var cells = await aggregates
                .BucketByDayAsync(
                    item.WorkspaceId,
                    itemId,
                    chart.GroupBy,
                    splitBy,
                    measureProperty,
                    first is { } from ? DatePeriods.Start(from, axis) : null,
                    last is { } to ? DatePeriods.End(DatePeriods.Start(to, axis), axis) : null,
                    ChartFolding.MaximumSeries,
                    MaximumCells,
                    cancellationToken)
                .ConfigureAwait(false);

            folded = ChartFolding.Days(cells, axis, first, last, splitBy is not null, endAtData);
        }
        else
        {
            // A chart of categories cannot be a line or a grid of days; the write path refuses the
            // pairing and this draws any such stored view as the bars it would otherwise have been.
            if (ChartKinds.NeedsTimeAxis(kind))
            {
                kind = ChartKinds.Bar;
            }

            if (splitBy is not null)
            {
                var cells = await aggregates
                    .BucketBySeriesAsync(
                        item.WorkspaceId,
                        itemId,
                        chart.GroupBy,
                        splitBy,
                        measureProperty,
                        ChartFolding.MaximumSeries,
                        MaximumBuckets,
                        MaximumCells,
                        cancellationToken)
                    .ConfigureAwait(false);

                folded = ChartFolding.CategoriesBySeries(cells);
            }
            else
            {
                var buckets = await aggregates
                    .BucketAsync(
                        item.WorkspaceId,
                        itemId,
                        chart.GroupBy,
                        measureProperty,
                        MaximumBuckets,
                        cancellationToken)
                    .ConfigureAwait(false);

                folded = ChartFolding.Categories(buckets);
            }
        }

        return Result.Success(new ItemChart(
            chart.GroupBy,
            measure,
            measureProperty,
            kind,
            period,
            splitBy,
            folded.From,
            folded.To,
            folded.Buckets,
            folded.Series,
            folded.Children,
            folded.DistinctValues,
            folded.Unplaced,
            folded.OtherSeries,
            folded.Truncated,
            folded.OutsideWindow,
            options.Stacked,
            options.Cumulative,
            options.RollingAverage));
    }

    /// <summary>Today in the reader's own time zone, or in UTC when they have not set one.</summary>
    /// <remarks>
    /// The current period is the reader's: a week chart opened on Monday morning in Tokyo shows
    /// Monday's week, not the Sunday it still is in UTC. One primary-key read of the reader's
    /// preferences; an unknown zone falls back to UTC rather than failing the chart.
    /// </remarks>
    private async ValueTask<DateOnly> TodayAsync(CancellationToken cancellationToken)
    {
        var now = clock.GetUtcNow();
        var zone = DateTimeZone.Utc;
        if (session.Current is { } context
            && await _preferences.FindAsync(context.TenantId, context.PrincipalId, cancellationToken).ConfigureAwait(false) is { } stored
            && DateTimeZoneProviders.Tzdb.GetZoneOrNull(stored.TimeZone) is { } preferred)
        {
            zone = preferred;
        }

        return Instant.FromDateTimeOffset(now).InZone(zone).Date.ToDateOnly();
    }

    /// <summary>The days a time axis's window runs between.</summary>
    /// <returns>
    /// The first and last day, either open, and whether the last day is only a ceiling. With no
    /// stored end the axis ends today - or at the latest period with data, when that is earlier -
    /// so one entry dated 2099 by mistake is counted outside the window rather than stretching the
    /// axis across seventy years of empty periods.
    /// </returns>
    private static (DateOnly? First, DateOnly? Last, bool EndAtData) Window(
        ChartOptions options,
        DatePeriod axis,
        string kind,
        DateOnly today)
    {
        if (options.LastPeriods is { } count)
        {
            var range = DatePeriods.Last(today, axis, Math.Clamp(count, 1, ChartOptions.MaximumPeriods));
            return (range.First, range.Last, false);
        }

        if (options.To is { } to)
        {
            return (options.From, to, false);
        }

        if (kind == ChartKinds.Year && options.From is null)
        {
            // Fifty-three whole weeks ending with this one: the shape of every contribution grid,
            // and exactly MaximumPeriods days.
            var monday = DatePeriods.Start(today, DatePeriod.Week);
            return (monday.AddDays(-52 * 7), monday.AddDays(6), false);
        }

        return (options.From, today, true);
    }
}

/// <summary>
/// Route handler for drawing one of an item's chart views.
/// </summary>
/// <remarks>
/// Named apart from <see cref="RunItemChart"/> itself, the same disambiguation every feature's
/// endpoint class makes.
/// </remarks>
internal static class RunItemChartEndpoint
{
    /// <summary>Handles a request to draw one of an item's chart views.</summary>
    /// <param name="itemId">The container.</param>
    /// <param name="view">Which of its views to draw.</param>
    /// <param name="httpContext">The current request.</param>
    /// <param name="dispatcher">Sends the query to its handler.</param>
    /// <returns>The buckets, or a problem describing the refusal.</returns>
    internal static async Task<Results<Ok<ChartResponse>, ProblemHttpResult>> Handle(
        Guid itemId,
        [FromQuery] string? view,
        HttpContext httpContext,
        [FromServices] NixDispatcher dispatcher)
    {
        if (string.IsNullOrEmpty(view))
        {
            return TypedResults.Problem(
                ChartEndpoints.Problem(
                    httpContext,
                    ChartErrors.ViewNotFound("Name the view to draw: ?view=<view id>.")));
        }

        var result = await dispatcher
            .QueryAsync<RunItemChart, Result<ItemChart>>(
                new RunItemChart(ItemId.From(itemId), view),
                httpContext.RequestAborted)
            .ConfigureAwait(false);

        return result.Match<Results<Ok<ChartResponse>, ProblemHttpResult>>(
            chart => TypedResults.Ok(ChartMapping.ToResponse(itemId, view, chart)),
            error => TypedResults.Problem(ChartEndpoints.Problem(httpContext, error)));
    }
}

/// <summary>Maps a drawn chart onto its published shape; shared by the endpoint and by site builds.</summary>
internal static class ChartMapping
{
    /// <summary>Maps one chart.</summary>
    /// <param name="itemId">The container the chart was drawn for.</param>
    /// <param name="view">The chart view's identifier.</param>
    /// <param name="chart">The drawn chart.</param>
    /// <returns>The published shape.</returns>
    internal static ChartResponse ToResponse(Guid itemId, string view, ItemChart chart)
    {
        ArgumentNullException.ThrowIfNull(chart);
        return new ChartResponse(
            itemId,
            view,
            chart.GroupBy,
            chart.Measure,
            chart.MeasureProperty,
            [
                .. chart.Buckets.Select(bucket =>
                    new ChartBucketResponse(
                        bucket.Value,
                        bucket.Children,
                        bucket.Total,
                        [.. bucket.Cells.Select(cell => new ChartCellResponse(cell.Children, cell.Total))])),
            ],
            chart.Children,
            chart.DistinctValues,
            chart.Truncated,
            chart.Kind,
            chart.Period,
            chart.SplitBy,
            chart.From,
            chart.To,
            [
                .. chart.Series.Select(series =>
                    new ChartSeriesResponse(series.Value, series.Other, series.Children, series.Total)),
            ],
            chart.OtherSeries,
            chart.Unplaced,
            chart.OutsideWindow,
            chart.Stacked,
            chart.Cumulative,
            chart.RollingAverage);
    }
}
