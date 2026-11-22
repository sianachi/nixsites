namespace Nix.Features.Charts;

/// <summary>One bar of a chart.</summary>
/// <param name="Value">
/// The grouping property's value, or <see langword="null"/> for the children that have none.
/// </param>
/// <param name="Children">How many children fall in this bucket.</param>
/// <param name="Total">
/// The measured property's total across them, or <see langword="null"/> when the chart counts
/// rather than totals, or when none of the children in this bucket carried a number.
/// </param>
/// <remarks>
/// <b>Unset is a bucket, not an omission.</b> A container half of whose children have no status is
/// mostly a container of unset things, and a chart that dropped them would draw the other half as
/// though it were the whole - misreporting every proportion on it.
/// </remarks>
/// <param name="Cells">
/// One entry per series, aligned with the response's <c>series</c>; empty when the chart is not
/// split. The cells add up to the bucket.
/// </param>
public sealed record ChartBucketResponse(
    string? Value,
    long Children,
    decimal? Total,
    IReadOnlyList<ChartCellResponse> Cells);

/// <summary>One series' share of one bucket.</summary>
/// <param name="Children">How many of the bucket's children carry the series' value.</param>
/// <param name="Total">Their measured total, or <see langword="null"/>.</param>
public sealed record ChartCellResponse(long Children, decimal? Total);

/// <summary>One series of a split chart.</summary>
/// <param name="Value">
/// The splitting property's value, or <see langword="null"/> for the children with none - and for
/// the "Other" series, which <paramref name="Other"/> tells apart.
/// </param>
/// <param name="Other">Whether this series stands for every value past the sixth.</param>
/// <param name="Children">How many drawn children carry it.</param>
/// <param name="Total">Their measured total, or <see langword="null"/>.</param>
public sealed record ChartSeriesResponse(string? Value, bool Other, long Children, decimal? Total);

/// <summary>
/// A chart's data, and what it could not fit.
/// </summary>
/// <param name="ItemId">The container whose children were summarised.</param>
/// <param name="ViewId">The view whose configuration produced this.</param>
/// <param name="GroupBy">The property the buckets are values of.</param>
/// <param name="Measure">What each bar measures: <c>count</c> or <c>sum</c>.</param>
/// <param name="MeasureProperty">The property being totalled, when the measure is a total.</param>
/// <param name="Buckets">
/// The buckets that fit: largest first for a chart of categories, earliest first - every period of
/// the axis, empty ones as zero - for a chart with a time axis.
/// </param>
/// <param name="Children">
/// How many children were summarised in total, across every bucket including any left out.
/// </param>
/// <param name="DistinctValues">
/// How many distinct values the grouping property takes across those children, whether or not each
/// one fitted.
/// </param>
/// <param name="ChartKind">The type the view draws: <c>bar</c>, <c>column</c>, <c>pie</c>, <c>line</c>, <c>area</c> or <c>year</c>.</param>
/// <param name="Period">The time axis's period, or <see langword="null"/> for a chart of categories.</param>
/// <param name="SplitBy">The property the series are values of, or <see langword="null"/>.</param>
/// <param name="From">The first day a time axis covers, or <see langword="null"/>.</param>
/// <param name="To">The last day a time axis covers, or <see langword="null"/>.</param>
/// <param name="Series">The series, largest first and any "Other" last; empty when not split.</param>
/// <param name="OtherSeries">How many series values were folded into the "Other" series (past the sixth).</param>
/// <param name="Unplaced">
/// Children a time axis could not place because the grouping property holds no date for them.
/// Counted rather than dropped, so a chart never quietly shrinks; always zero for categories.
/// </param>
/// <param name="OutsideWindow">
/// Dated children outside the time axis's window - before it, or after its end - counted so a chart
/// whose items all fall elsewhere says so rather than looking empty. Always zero for categories.
/// </param>
/// <param name="Stacked">Whether split series are stacked, as the view stores it.</param>
/// <param name="Cumulative">Whether lines draw running totals, as the view stores it.</param>
/// <param name="RollingAverage">Whether lines add a trailing seven-period average, as the view stores it.</param>
/// <param name="Truncated">
/// Whether more buckets exist than were returned. Carried rather than left for a client to infer
/// from a count, because inferring it is exactly the sort of arithmetic a client gets wrong once
/// and then draws confidently forever.
/// </param>
/// <remarks>
/// <para>
/// <b>The totals are what make a bounded chart honest.</b> A grouping property that is not a
/// declared list can take a distinct value per child, so the read is bounded - and a bounded read
/// that returned only its buckets would be a picture of the top few presented as a picture of all
/// of them. With <see cref="Children"/> and <see cref="DistinctValues"/>, the view can say how much
/// is missing instead of drawing the rest as though it were everything.
/// </para>
/// <para>
/// <b>Computed over every child, not over the page the client happens to hold.</b> That is the
/// whole reason this is a server read rather than a tally in the browser; ADR-0044 records it.
/// </para>
/// </remarks>
internal sealed record ChartResponse(
    Guid ItemId,
    string ViewId,
    string GroupBy,
    string Measure,
    string? MeasureProperty,
    IReadOnlyList<ChartBucketResponse> Buckets,
    long Children,
    long DistinctValues,
    bool Truncated,
    string ChartKind,
    string? Period,
    string? SplitBy,
    DateOnly? From,
    DateOnly? To,
    IReadOnlyList<ChartSeriesResponse> Series,
    long OtherSeries,
    long Unplaced,
    long OutsideWindow,
    bool Stacked,
    bool Cumulative,
    bool RollingAverage);
