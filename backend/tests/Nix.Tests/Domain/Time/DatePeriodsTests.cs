using Nix.Domain.Time;

namespace Nix.Tests.Domain.Time;

/// <summary>
/// The period arithmetic every time axis shares: where a period starts, how many lie between two
/// dates, and a rolling window.
/// </summary>
/// <remarks>
/// The edges are the whole point. A week that starts on Sunday for one reader and Monday for another,
/// or a quarter that slips at a year boundary, puts the same item in two different buckets in two
/// views of the same container.
/// </remarks>
public sealed class DatePeriodsTests
{
    [Theory]
    [InlineData("2026-10-05", "2026-10-05")] // Monday is its own week's start.
    [InlineData("2026-10-11", "2026-10-05")] // Sunday belongs to the week that began the Monday before.
    [InlineData("2026-10-12", "2026-10-12")] // The next Monday starts the next week.
    [InlineData("2026-01-01", "2025-12-29")] // A Thursday New Year's Day: the week began in December.
    [InlineData("2024-03-03", "2024-02-26")] // Across a leap day.
    public void A_week_starts_on_the_Monday_on_or_before_the_date(string date, string expected)
    {
        Assert.Equal(
            DateOnly.Parse(expected, System.Globalization.CultureInfo.InvariantCulture),
            DatePeriods.Start(Day(date), DatePeriod.Week));
    }

    [Theory]
    [InlineData("2026-10-09", DatePeriod.Day, "2026-10-09")]
    [InlineData("2026-10-09", DatePeriod.Month, "2026-10-01")]
    [InlineData("2026-10-09", DatePeriod.Quarter, "2026-10-01")]
    [InlineData("2026-09-30", DatePeriod.Quarter, "2026-07-01")]
    [InlineData("2026-01-01", DatePeriod.Quarter, "2026-01-01")]
    [InlineData("2026-03-31", DatePeriod.Quarter, "2026-01-01")]
    [InlineData("2026-10-09", DatePeriod.Year, "2026-01-01")]
    public void A_period_starts_on_its_first_day(string date, DatePeriod period, string expected)
    {
        Assert.Equal(Day(expected), DatePeriods.Start(Day(date), period));
    }

    [Theory]
    [InlineData("2026-02-01", DatePeriod.Month, "2026-02-28")]
    [InlineData("2024-02-01", DatePeriod.Month, "2024-02-29")]
    [InlineData("2026-10-05", DatePeriod.Week, "2026-10-11")]
    [InlineData("2026-10-01", DatePeriod.Quarter, "2026-12-31")]
    [InlineData("2026-01-01", DatePeriod.Year, "2026-12-31")]
    public void A_period_ends_the_day_before_the_next_one_starts(string start, DatePeriod period, string expected)
    {
        Assert.Equal(Day(expected), DatePeriods.End(Day(start), period));
    }

    [Theory]
    [InlineData("2026-01-05", "2026-03-30", DatePeriod.Week, 12)]
    [InlineData("2025-11-01", "2026-02-01", DatePeriod.Month, 3)]
    [InlineData("2025-10-01", "2026-07-01", DatePeriod.Quarter, 3)]
    [InlineData("2020-01-01", "2026-01-01", DatePeriod.Year, 6)]
    [InlineData("2026-02-27", "2026-03-02", DatePeriod.Day, 3)]
    public void Between_counts_whole_periods(string first, string last, DatePeriod period, int expected)
    {
        Assert.Equal(expected, DatePeriods.Between(Day(first), Day(last), period));
    }

    [Fact]
    public void The_last_twelve_months_end_with_the_current_one()
    {
        var range = DatePeriods.Last(Day("2026-10-09"), DatePeriod.Month, 12);

        Assert.Equal(Day("2025-11-01"), range.First);
        Assert.Equal(Day("2026-10-01"), range.Last);
        Assert.Equal(Day("2026-10-31"), range.End);
        Assert.Equal(12, range.Count);
    }

    [Fact]
    public void Enumerating_a_range_yields_every_period_in_order_including_empty_ones()
    {
        var range = new PeriodRange(Day("2025-12-31"), Day("2026-01-13"), DatePeriod.Week);

        Assert.Equal(
            [Day("2025-12-29"), Day("2026-01-05"), Day("2026-01-12")],
            DatePeriods.Enumerate(range).ToArray());
    }

    [Fact]
    public void Keeping_the_latest_periods_cuts_the_earliest_end()
    {
        var range = new PeriodRange(Day("2020-01-01"), Day("2026-01-01"), DatePeriod.Year);

        var kept = DatePeriods.KeepLatest(range, 3);

        Assert.Equal(Day("2024-01-01"), kept.First);
        Assert.Equal(Day("2026-01-01"), kept.Last);
        Assert.Equal(range, DatePeriods.KeepLatest(range, 10));
    }

    [Theory]
    [InlineData("2026-03-17", true)]
    [InlineData("2026-03-17T09:00:00+00:00[Europe/London]", true)]
    [InlineData("2026-13-01", false)]
    [InlineData("soon", false)]
    [InlineData("0001-01-01", false)]
    [InlineData(null, false)]
    public void A_stored_value_reads_as_its_date_part_or_not_at_all(string? text, bool expected)
    {
        Assert.Equal(expected, DatePeriods.TryReadDate(text, out _));
    }

    [Fact]
    public void Every_period_round_trips_through_its_text()
    {
        foreach (var text in DatePeriods.All)
        {
            Assert.True(DatePeriods.TryParse(text, out var period));
            Assert.Equal(text, DatePeriods.ToText(period));
        }

        Assert.False(DatePeriods.TryParse("fortnight", out _));
    }

    private static DateOnly Day(string text) =>
        DateOnly.Parse(text, System.Globalization.CultureInfo.InvariantCulture);

    [Fact]
    public void A_range_snaps_its_ends_to_period_starts_and_refuses_to_run_backwards()
    {
        var range = new PeriodRange(Day("2026-10-09"), Day("2026-12-25"), DatePeriod.Month);

        Assert.Equal(Day("2026-10-01"), range.First);
        Assert.Equal(Day("2026-12-01"), range.Last);
        Assert.Equal(3, range.Count);
        Assert.Throws<ArgumentOutOfRangeException>(
            () => new PeriodRange(Day("2026-12-01"), Day("2026-10-01"), DatePeriod.Month));
    }
}
