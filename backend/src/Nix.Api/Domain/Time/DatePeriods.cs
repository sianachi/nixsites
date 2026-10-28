using System.Collections.Immutable;
using System.Globalization;

namespace Nix.Domain.Time;

/// <summary>The calendar spans a time axis or a grouping can count by.</summary>
/// <remarks>Stored and published as text (<see cref="DatePeriods"/>), never as the ordinal.</remarks>
public enum DatePeriod
{
    /// <summary>One calendar day.</summary>
    Day = 0,

    /// <summary>An ISO week, Monday to Sunday.</summary>
    Week = 1,

    /// <summary>A calendar month.</summary>
    Month = 2,

    /// <summary>A calendar quarter: January, April, July or October and the two months after.</summary>
    Quarter = 3,

    /// <summary>A calendar year.</summary>
    Year = 4,
}

/// <summary>A run of whole periods, named by the first and last period's start dates.</summary>
/// <remarks>
/// The ends are snapped to the start of the period they fall in when the range is made, so a range
/// can never claim to start mid-week and then be enumerated as though it did not. A range whose
/// last period is before its first is refused rather than read as empty: no caller here means it.
/// </remarks>
public readonly record struct PeriodRange
{
    /// <summary>Initializes a new instance of the <see cref="PeriodRange"/> struct.</summary>
    /// <param name="first">Any day in the earliest period.</param>
    /// <param name="last">Any day in the latest period, on or after <paramref name="first"/>'s period.</param>
    /// <param name="period">What each step is.</param>
    /// <exception cref="ArgumentOutOfRangeException">The last period is before the first.</exception>
    public PeriodRange(DateOnly first, DateOnly last, DatePeriod period)
    {
        First = DatePeriods.Start(first, period);
        Last = DatePeriods.Start(last, period);
        Period = period;

        if (Last < First)
        {
            throw new ArgumentOutOfRangeException(nameof(last), last, "A range must end on or after its first period.");
        }
    }

    /// <summary>The start of the earliest period.</summary>
    public DateOnly First { get; }

    /// <summary>The start of the latest period.</summary>
    public DateOnly Last { get; }

    /// <summary>What each step is.</summary>
    public DatePeriod Period { get; }

    /// <summary>The last day the range covers: the end of its latest period.</summary>
    public DateOnly End => DatePeriods.End(Last, Period);

    /// <summary>How many periods the range holds, both ends included.</summary>
    public int Count => DatePeriods.Between(First, Last, Period) + 1;
}

/// <summary>
/// Period arithmetic for every time axis: which period a date falls in, the periods between two
/// dates, and a window of the last few.
/// </summary>
/// <remarks>
/// <para>
/// <b>One place, because two copies of "which week is this" disagree at the edges.</b> A chart's
/// time axis uses it today and the query engine's period grouping is meant to use the same
/// functions, so a chart and a grouped list over the same items put every item in the same week.
/// Its starts agree with Postgres's <c>date_trunc</c> for week, month, quarter and year, which an
/// integration test holds it to, so a statement that truncates in SQL lands on the same keys.
/// A period is named by its start date, so the bucket key is a plain <c>yyyy-MM-dd</c> that sorts
/// chronologically as text.
/// </para>
/// <para>
/// <b>Weeks are ISO weeks and start on Monday.</b> Fixed rather than read from a locale, because the
/// server has no reader's locale and a week whose boundary moved with whoever asked would make two
/// people's charts of the same container disagree. The web draws the same Monday-first weeks.
/// </para>
/// <para>
/// <b>Dates only, never instants.</b> A stored timestamp carries the local time it was written at, so
/// its date part is the day the person meant; converting it to UTC first would move a late-evening
/// entry to the next day for everybody east of Greenwich.
/// </para>
/// </remarks>
public static class DatePeriods
{
    /// <summary>Stored text for <see cref="DatePeriod.Day"/>.</summary>
    public const string Day = "day";

    /// <summary>Stored text for <see cref="DatePeriod.Week"/>.</summary>
    public const string Week = "week";

    /// <summary>Stored text for <see cref="DatePeriod.Month"/>.</summary>
    public const string Month = "month";

    /// <summary>Stored text for <see cref="DatePeriod.Quarter"/>.</summary>
    public const string Quarter = "quarter";

    /// <summary>Stored text for <see cref="DatePeriod.Year"/>.</summary>
    public const string Year = "year";

    /// <summary>Every period, in the order an editor offers them.</summary>
    public static readonly ImmutableArray<string> All = [Day, Week, Month, Quarter, Year];

    /// <summary>The earliest date a period may be computed for.</summary>
    /// <remarks>
    /// One year in from <see cref="DateOnly.MinValue"/>, so flooring to a week or stepping back a
    /// period can never fall off the calendar. Nobody's habit started in the year 1.
    /// </remarks>
    public static readonly DateOnly Earliest = new(2, 1, 1);

    /// <summary>The latest date a period may be computed for, a year short of the calendar's end.</summary>
    public static readonly DateOnly Latest = new(9998, 12, 31);

    /// <summary>Reads stored period text.</summary>
    /// <param name="text">The stored text.</param>
    /// <param name="period">The period, when recognised.</param>
    /// <returns><see langword="true"/> when the text names a period.</returns>
    public static bool TryParse(string? text, out DatePeriod period)
    {
        switch (text)
        {
            case Day:
                period = DatePeriod.Day;
                return true;
            case Week:
                period = DatePeriod.Week;
                return true;
            case Month:
                period = DatePeriod.Month;
                return true;
            case Quarter:
                period = DatePeriod.Quarter;
                return true;
            case Year:
                period = DatePeriod.Year;
                return true;
            default:
                period = default;
                return false;
        }
    }

    /// <summary>Writes a period for storage.</summary>
    /// <param name="period">The period.</param>
    /// <returns>Its stored text.</returns>
    public static string ToText(DatePeriod period) => period switch
    {
        DatePeriod.Day => Day,
        DatePeriod.Week => Week,
        DatePeriod.Month => Month,
        DatePeriod.Quarter => Quarter,
        DatePeriod.Year => Year,
        _ => throw new ArgumentOutOfRangeException(nameof(period), period, "Unknown period."),
    };

    /// <summary>Whether a date is inside the range period arithmetic is defined over.</summary>
    /// <param name="date">The date.</param>
    /// <returns><see langword="true"/> between <see cref="Earliest"/> and <see cref="Latest"/>.</returns>
    public static bool IsInRange(DateOnly date) => date >= Earliest && date <= Latest;

    /// <summary>Reads a stored <c>yyyy-MM-dd</c> date, or the date part of a stored timestamp.</summary>
    /// <param name="text">The stored value's first ten characters, or more.</param>
    /// <param name="date">The date, when the text starts with one inside the supported range.</param>
    /// <returns><see langword="true"/> when a date was read.</returns>
    public static bool TryReadDate(string? text, out DateOnly date)
    {
        if (text is { Length: >= 10 }
            && DateOnly.TryParseExact(
                text.AsSpan(0, 10),
                "yyyy-MM-dd",
                CultureInfo.InvariantCulture,
                DateTimeStyles.None,
                out date)
            && IsInRange(date))
        {
            return true;
        }

        date = default;
        return false;
    }

    /// <summary>The first day of the period <paramref name="date"/> falls in.</summary>
    /// <param name="date">Any date in the supported range.</param>
    /// <param name="period">The period.</param>
    /// <returns>The period's start: the day itself, its Monday, or the first of its month, quarter or year.</returns>
    public static DateOnly Start(DateOnly date, DatePeriod period) => period switch
    {
        DatePeriod.Day => date,

        // DayOfWeek counts from Sunday; shifting by six and wrapping makes Monday zero.
        DatePeriod.Week => date.AddDays(-(((int)date.DayOfWeek + 6) % 7)),
        DatePeriod.Month => new DateOnly(date.Year, date.Month, 1),
        DatePeriod.Quarter => new DateOnly(date.Year, (((date.Month - 1) / 3) * 3) + 1, 1),
        DatePeriod.Year => new DateOnly(date.Year, 1, 1),
        _ => throw new ArgumentOutOfRangeException(nameof(period), period, "Unknown period."),
    };

    /// <summary>Steps a period start forwards or backwards by whole periods.</summary>
    /// <param name="start">A period start, as <see cref="Start"/> returns.</param>
    /// <param name="period">The period.</param>
    /// <param name="count">How many periods to step; negative steps back.</param>
    /// <returns>The start of the period <paramref name="count"/> steps away.</returns>
    public static DateOnly Add(DateOnly start, DatePeriod period, int count) => period switch
    {
        DatePeriod.Day => start.AddDays(count),
        DatePeriod.Week => start.AddDays(7 * count),
        DatePeriod.Month => start.AddMonths(count),
        DatePeriod.Quarter => start.AddMonths(3 * count),
        DatePeriod.Year => start.AddYears(count),
        _ => throw new ArgumentOutOfRangeException(nameof(period), period, "Unknown period."),
    };

    /// <summary>The last day of the period that starts on <paramref name="start"/>.</summary>
    /// <param name="start">A period start.</param>
    /// <param name="period">The period.</param>
    /// <returns>The day before the next period starts.</returns>
    public static DateOnly End(DateOnly start, DatePeriod period) =>
        Add(start, period, 1).AddDays(-1);

    /// <summary>How many whole periods lie from one period start to a later one.</summary>
    /// <param name="first">The earlier period start.</param>
    /// <param name="last">The later period start.</param>
    /// <param name="period">The period.</param>
    /// <returns>Zero when they are the same period; negative when <paramref name="last"/> is earlier.</returns>
    public static int Between(DateOnly first, DateOnly last, DatePeriod period)
    {
        var months = ((last.Year - first.Year) * 12) + (last.Month - first.Month);

        return period switch
        {
            DatePeriod.Day => last.DayNumber - first.DayNumber,
            DatePeriod.Week => (last.DayNumber - first.DayNumber) / 7,
            DatePeriod.Month => months,
            DatePeriod.Quarter => months / 3,
            DatePeriod.Year => last.Year - first.Year,
            _ => throw new ArgumentOutOfRangeException(nameof(period), period, "Unknown period."),
        };
    }

    /// <summary>The last <paramref name="count"/> periods, ending with the one <paramref name="today"/> is in.</summary>
    /// <param name="today">The reader's current date.</param>
    /// <param name="period">The period.</param>
    /// <param name="count">How many periods, at least one.</param>
    /// <returns>The range, current period included.</returns>
    public static PeriodRange Last(DateOnly today, DatePeriod period, int count)
    {
        ArgumentOutOfRangeException.ThrowIfLessThan(count, 1);

        var last = Start(today, period);
        return new PeriodRange(Add(last, period, -(count - 1)), last, period);
    }

    /// <summary>
    /// Keeps the most recent <paramref name="maximum"/> periods of a range.
    /// </summary>
    /// <param name="range">The range.</param>
    /// <param name="maximum">The most periods to keep.</param>
    /// <returns>The range, shortened at its earliest end when it held more.</returns>
    public static PeriodRange KeepLatest(PeriodRange range, int maximum)
    {
        ArgumentOutOfRangeException.ThrowIfLessThan(maximum, 1);

        return range.Count <= maximum
            ? range
            : new PeriodRange(Add(range.Last, range.Period, -(maximum - 1)), range.Last, range.Period);
    }

    /// <summary>Every period start in a range, earliest first.</summary>
    /// <param name="range">The range.</param>
    /// <returns>One start per period; empty periods included, which is the point.</returns>
    public static IEnumerable<DateOnly> Enumerate(PeriodRange range)
    {
        for (var start = range.First; start <= range.Last; start = Add(start, range.Period, 1))
        {
            yield return start;
        }
    }
}
