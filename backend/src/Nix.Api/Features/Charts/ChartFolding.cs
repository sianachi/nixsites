using System.Globalization;
using Nix.Abstractions;
using Nix.Domain.Time;
using Nix.Domain.Views;

namespace Nix.Features.Charts;

/// <summary>What a chart view drew, over every child rather than over a loaded page.</summary>
/// <param name="GroupBy">The property the buckets are values (or dates) of.</param>
/// <param name="Measure">What each bucket measures.</param>
/// <param name="MeasureProperty">The property being totalled, when the measure is a total.</param>
/// <param name="Kind">The chart type the view draws.</param>
/// <param name="Period">The time axis's period, or <see langword="null"/> for a chart of categories.</param>
/// <param name="SplitBy">The property the series are values of, or <see langword="null"/>.</param>
/// <param name="From">The first day the time axis covers, or <see langword="null"/>.</param>
/// <param name="To">The last day the time axis covers, or <see langword="null"/>.</param>
/// <param name="Buckets">The buckets drawn: largest first for categories, earliest first for periods.</param>
/// <param name="Series">The series, largest first, any "Other" last; empty when not split.</param>
/// <param name="Children">Every child summarised, including any in buckets left out.</param>
/// <param name="DistinctValues">How many buckets exist - categories, or periods in the axis's range.</param>
/// <param name="Unplaced">Children a time axis could not place because they have no date; zero otherwise.</param>
/// <param name="OtherSeries">How many series values were folded into "Other".</param>
/// <param name="Truncated">Whether buckets exist that were not drawn.</param>
/// <param name="OutsideWindow">Dated children that fall outside the time axis's window.</param>
/// <param name="Stacked">Whether split series are drawn stacked, as the view stores it.</param>
/// <param name="Cumulative">Whether lines draw running totals, as the view stores it.</param>
/// <param name="RollingAverage">Whether lines add a trailing average, as the view stores it.</param>
public sealed record ItemChart(
    string GroupBy,
    string Measure,
    string? MeasureProperty,
    string Kind,
    string? Period,
    string? SplitBy,
    DateOnly? From,
    DateOnly? To,
    IReadOnlyList<ChartBucketResponse> Buckets,
    IReadOnlyList<ChartSeriesResponse> Series,
    long Children,
    long DistinctValues,
    long Unplaced,
    long OtherSeries,
    bool Truncated,
    long OutsideWindow,
    bool Stacked,
    bool Cumulative,
    bool RollingAverage);

/// <summary>What a chart's buckets, series and axis came out as, before the view's labels are attached.</summary>
/// <param name="Buckets">The buckets drawn.</param>
/// <param name="Series">The series, empty when not split.</param>
/// <param name="Children">Every child summarised.</param>
/// <param name="DistinctValues">How many buckets exist.</param>
/// <param name="Unplaced">Children a time axis could not place.</param>
/// <param name="OtherSeries">How many series values were folded into "Other".</param>
/// <param name="Truncated">Whether buckets exist that were not drawn.</param>
/// <param name="From">The first day a time axis covers.</param>
/// <param name="To">The last day a time axis covers.</param>
/// <param name="OutsideWindow">Dated children outside the time axis's window.</param>
public sealed record FoldedChart(
    IReadOnlyList<ChartBucketResponse> Buckets,
    IReadOnlyList<ChartSeriesResponse> Series,
    long Children,
    long DistinctValues,
    long Unplaced,
    long OtherSeries,
    bool Truncated,
    DateOnly? From = null,
    DateOnly? To = null,
    long OutsideWindow = 0);

/// <summary>
/// Turns the rows a chart read returns into the buckets and series a chart draws.
/// </summary>
/// <remarks>
/// <para>
/// <b>Pure, so every rule about honesty is a unit test.</b> The reads return cells; what a chart may
/// claim from them - which series fit, which periods are empty rather than unknown, which bucket the
/// ceiling cut short - is decided here, with no database in the way of testing it.
/// </para>
/// <para>
/// <b>Series are capped at <see cref="MaximumSeries"/>; the rest become one "Other".</b> Six is what
/// the design tokens can tell apart (six series colour roles, each 3:1 on its ground). The reads
/// already fold every series past the cap into Other cells; this ranks what they return, folds
/// again defensively, and reports how many values the "Other" series stands for, so it is never
/// mistaken for a value somebody chose.
/// </para>
/// </remarks>
public static class ChartFolding
{
    /// <summary>The most series a split chart draws before folding the rest into "Other".</summary>
    public const int MaximumSeries = 6;

    /// <summary>A chart of categories with one series: the shape every chart had before series existed.</summary>
    /// <param name="read">What the bucket read returned.</param>
    /// <returns>The folded chart.</returns>
    public static FoldedChart Categories(ChildBuckets read)
    {
        ArgumentNullException.ThrowIfNull(read);

        var buckets = new List<ChartBucketResponse>(read.Buckets.Count);
        foreach (var bucket in read.Buckets)
        {
            buckets.Add(new ChartBucketResponse(bucket.Value, bucket.Children, bucket.Total, []));
        }

        return new FoldedChart(
            buckets,
            [],
            read.Children,
            read.DistinctValues,
            Unplaced: 0,
            OtherSeries: 0,
            read.DistinctValues > buckets.Count);
    }

    /// <summary>A chart of categories split into series.</summary>
    /// <param name="read">
    /// What the series read returned: cells ordered by bucket size, each bucket's cells together.
    /// </param>
    /// <returns>The folded chart.</returns>
    public static FoldedChart CategoriesBySeries(ChildCells read)
    {
        ArgumentNullException.ThrowIfNull(read);

        // Cells arrive bucket by bucket. When the cell ceiling cut the read, the last bucket may be
        // missing some of its series, and a bar drawn from part of its cells is a shorter bar than
        // the truth - so it is left out and counted as truncated rather than drawn short.
        var groups = new List<(string? Value, List<ChildCell> Cells)>();
        foreach (var cell in read.Cells)
        {
            if (groups.Count == 0 || !string.Equals(groups[^1].Value, cell.Bucket, StringComparison.Ordinal))
            {
                groups.Add((cell.Bucket, []));
            }

            groups[^1].Cells.Add(cell);
        }

        if (read.CellsCut && groups.Count > 0)
        {
            groups.RemoveAt(groups.Count - 1);
        }

        var drawn = new List<ChildCell>();
        foreach (var group in groups)
        {
            drawn.AddRange(group.Cells);
        }

        var series = PickSeries(drawn, read.SeriesValues);

        var buckets = new List<ChartBucketResponse>(groups.Count);
        foreach (var group in groups)
        {
            buckets.Add(Bucket(group.Value, group.Cells, series));
        }

        var distinct = read.DistinctBuckets ?? buckets.Count;

        return new FoldedChart(
            buckets,
            series.Series,
            read.Children,
            distinct,
            Unplaced: 0,
            series.OtherValues,
            read.CellsCut || distinct > buckets.Count);
    }

    /// <summary>A chart along a time axis, its days folded into periods and its empty periods filled.</summary>
    /// <param name="read">What the day read returned: undated cells first, then latest day first.</param>
    /// <param name="period">The period each bucket spans.</param>
    /// <param name="first">The window's first day, or <see langword="null"/> to start at the earliest data.</param>
    /// <param name="last">The window's last day, or <see langword="null"/> to end at the latest data.</param>
    /// <param name="split">Whether the read was split into series.</param>
    /// <param name="endAtData">
    /// Whether <paramref name="last"/> is only a ceiling - today, for a chart with no stored end -
    /// so the axis ends at the latest period with data when that is earlier.
    /// </param>
    /// <returns>The folded chart.</returns>
    /// <remarks>
    /// <para>
    /// <b>Zero only where zero is known.</b> A period inside the window with no children is a real
    /// zero and is drawn as one, so a line has no gaps. A period the cell ceiling stopped the read
    /// before reaching is not a zero - nothing is known about it - so the axis starts after it and
    /// the chart says it was truncated.
    /// </para>
    /// <para>
    /// <b>No dated children, no axis.</b> A window with nothing in it returns no buckets rather than a
    /// run of zeros, and still names its days, so the view can say "nothing between these dates"
    /// and how many items fall outside them.
    /// </para>
    /// </remarks>
    public static FoldedChart Days(
        ChildCells read,
        DatePeriod period,
        DateOnly? first,
        DateOnly? last,
        bool split,
        bool endAtData = false)
    {
        ArgumentNullException.ThrowIfNull(read);

        long unplaced = 0;
        var dated = new List<(DateOnly Start, ChildCell Cell)>(read.Cells.Count);
        foreach (var cell in read.Cells)
        {
            if (DatePeriods.TryReadDate(cell.Bucket, out var day))
            {
                dated.Add((DatePeriods.Start(day, period), cell));
            }
            else
            {
                unplaced += cell.Children;
            }
        }

        // A cut read may have stopped anywhere - even inside the undated rows - so it is always
        // reported, whatever is left to draw.
        var truncated = read.CellsCut;
        DateOnly? earliestKnown = null;
        if (read.CellsCut && dated.Count > 0)
        {
            // Latest day first, so the earliest period read is the one the ceiling may have cut.
            var cut = dated[^1].Start;
            dated.RemoveAll(entry => entry.Start == cut);
            earliestKnown = DatePeriods.Add(cut, period, 1);
        }

        var children = read.Children - unplaced;
        var windowFrom = first is { } from ? DatePeriods.Start(from, period) : (DateOnly?)null;
        var windowTo = last is { } to && !endAtData ? DatePeriods.End(DatePeriods.Start(to, period), period) : (DateOnly?)null;

        if (dated.Count == 0)
        {
            return new FoldedChart([], [], children, 0, unplaced, 0, truncated, windowFrom, windowTo, read.OutsideWindow);
        }

        DateOnly dataFirst = dated[0].Start;
        DateOnly dataLast = dated[0].Start;
        foreach (var (start, _) in dated)
        {
            dataFirst = start < dataFirst ? start : dataFirst;
            dataLast = start > dataLast ? start : dataLast;
        }

        var rangeFirst = first is { } low ? DatePeriods.Start(low, period) : dataFirst;
        var rangeLast = last is { } high ? DatePeriods.Start(high, period) : dataLast;
        if (endAtData && dataLast < rangeLast)
        {
            rangeLast = dataLast;
        }

        if (earliestKnown is { } known && rangeFirst < known)
        {
            rangeFirst = known;
        }

        if (rangeLast < rangeFirst)
        {
            return new FoldedChart([], [], children, 0, unplaced, 0, truncated, windowFrom, windowTo, read.OutsideWindow);
        }

        var whole = new PeriodRange(rangeFirst, rangeLast, period);
        var range = DatePeriods.KeepLatest(whole, ChartOptions.MaximumPeriods);
        truncated |= range.Count < whole.Count;

        var byPeriod = new Dictionary<DateOnly, List<ChildCell>>();
        var drawn = new List<ChildCell>(dated.Count);
        foreach (var (start, cell) in dated)
        {
            if (start < range.First || start > range.Last)
            {
                continue;
            }

            if (!byPeriod.TryGetValue(start, out var cells))
            {
                cells = [];
                byPeriod[start] = cells;
            }

            cells.Add(cell);
            drawn.Add(cell);
        }

        var series = split ? PickSeries(drawn, read.SeriesValues) : SeriesPick.None;

        var buckets = new List<ChartBucketResponse>(range.Count);
        foreach (var start in DatePeriods.Enumerate(range))
        {
            var value = start.ToString("yyyy-MM-dd", CultureInfo.InvariantCulture);
            buckets.Add(Bucket(value, byPeriod.TryGetValue(start, out var cells) ? cells : [], series));
        }

        return new FoldedChart(
            buckets,
            series.Series,
            children,
            whole.Count,
            unplaced,
            series.OtherValues,
            truncated,
            range.First,
            range.End,
            read.OutsideWindow);
    }

    private static ChartBucketResponse Bucket(string? value, IReadOnlyList<ChildCell> cells, SeriesPick series)
    {
        long children = 0;
        var total = default(TotalAccumulator);
        var columns = series.Series.Count == 0 ? null : new (long Children, TotalAccumulator Total)[series.Series.Count];

        foreach (var cell in cells)
        {
            children += cell.Children;
            total.Add(cell.Total);

            if (columns is not null)
            {
                var column = cell.Other ? series.OtherColumn : series.ColumnOf(cell.Series);
                columns[column].Children += cell.Children;
                columns[column].Total.Add(cell.Total);
            }
        }

        IReadOnlyList<ChartCellResponse> split = columns is null
            ? []
            : [.. columns.Select(column => new ChartCellResponse(column.Children, column.Total.Value))];

        return new ChartBucketResponse(value, children, total.Value, split);
    }

    /// <summary>Ranks the series values across the drawn cells and keeps the largest.</summary>
    /// <param name="cells">The drawn cells; those flagged Other were folded by the read.</param>
    /// <param name="seriesValues">How many distinct series values the read saw, or zero if it did not say.</param>
    private static SeriesPick PickSeries(IReadOnlyList<ChildCell> cells, long seriesValues)
    {
        var totals = new Dictionary<SeriesKey, (long Children, TotalAccumulator Total)>();
        long otherChildren = 0;
        var otherTotal = default(TotalAccumulator);
        var foldedByRead = false;
        foreach (var cell in cells)
        {
            if (cell.Other)
            {
                foldedByRead = true;
                otherChildren += cell.Children;
                otherTotal.Add(cell.Total);
                continue;
            }

            var key = new SeriesKey(cell.Series);
            totals.TryGetValue(key, out var entry);
            entry.Children += cell.Children;
            entry.Total.Add(cell.Total);
            totals[key] = entry;
        }

        // Largest first, then by value so equal series always come out in the same order; the
        // children with no value sort after every named series of their size.
        var ranked = totals
            .OrderByDescending(pair => pair.Value.Children)
            .ThenBy(pair => pair.Key.Value is null ? 1 : 0)
            .ThenBy(pair => pair.Key.Value, StringComparer.Ordinal)
            .ToList();

        var series = new List<ChartSeriesResponse>(Math.Min(ranked.Count, MaximumSeries) + 1);
        var columns = new Dictionary<SeriesKey, int>(ranked.Count);
        var foldedHere = 0;

        foreach (var (key, entry) in ranked)
        {
            if (series.Count < MaximumSeries)
            {
                columns[key] = series.Count;
                series.Add(new ChartSeriesResponse(key.Value, Other: false, entry.Children, entry.Total.Value));
                continue;
            }

            foldedHere++;
            otherChildren += entry.Children;
            otherTotal.Add(entry.Total.Value);
        }

        if (!foldedByRead && foldedHere == 0)
        {
            return new SeriesPick(series, columns, -1, 0);
        }

        // The read knows how many values exist across the whole container; what this pass folded
        // is the floor when it does not say.
        var otherValues = (int)Math.Max(foldedHere, Math.Min(int.MaxValue, seriesValues - series.Count));
        var otherColumn = series.Count;
        series.Add(new ChartSeriesResponse(null, Other: true, otherChildren, otherTotal.Value));

        return new SeriesPick(series, columns, otherColumn, Math.Max(1, otherValues));
    }

    /// <summary>A series value as a dictionary key, the children with no value included.</summary>
    private readonly record struct SeriesKey(string? Value);

    /// <summary>The series chosen for a chart, and which column each value is drawn in.</summary>
    private sealed record SeriesPick(
        IReadOnlyList<ChartSeriesResponse> Series,
        IReadOnlyDictionary<SeriesKey, int> Columns,
        int OtherColumn,
        int OtherValues)
    {
        public static SeriesPick None { get; } = new([], new Dictionary<SeriesKey, int>(), -1, 0);

        public int ColumnOf(string? value) =>
            Columns.TryGetValue(new SeriesKey(value), out var column) ? column : OtherColumn;
    }

    /// <summary>
    /// A running total that knows the difference between nothing to add, a sum, and a sum too large
    /// to represent.
    /// </summary>
    /// <remarks>
    /// Each cell's total is bounded by the statement, but thousands of them added together are not,
    /// and <see cref="decimal"/> throws where Postgres's numeric would not. A total that overflows is
    /// reported as unknown - the posture the statement already takes for one value too large - rather
    /// than failing the whole chart over one figure.
    /// </remarks>
    private struct TotalAccumulator
    {
        private decimal _sum;
        private bool _any;
        private bool _overflowed;

        public readonly decimal? Value => _any && !_overflowed ? _sum : null;

        public void Add(decimal? value)
        {
            if (value is not { } number || _overflowed)
            {
                return;
            }

            try
            {
                _sum = checked(_sum + number);
                _any = true;
            }
            catch (OverflowException)
            {
                _overflowed = true;
            }
        }
    }
}
