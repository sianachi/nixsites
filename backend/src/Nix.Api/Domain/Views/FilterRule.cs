using System.Collections.Immutable;
using System.Globalization;

namespace Nix.Domain.Views;

/// <summary>
/// One condition of a query view: a property, an operator, and the value the operator reads.
/// </summary>
/// <param name="Property">The property key the condition tests, matched across containers.</param>
/// <param name="Operator">One of <see cref="QueryOperators"/>' closed set.</param>
/// <param name="Value">
/// What the operator compares against, in the operator's own grammar - a literal for the equality
/// pair (or <c>me</c>, resolved to the calling principal), a day token or <c>yyyy-MM-dd</c> for
/// the date trio, a day count for <c>within-next</c> and <c>within-last</c>.
/// </param>
/// <remarks>
/// <para>
/// <b>Validated per operator, never per property type.</b> A query view spans containers, so
/// there is no single schema to check the key against - the same argument
/// <c>SetContainerViewsHandler.Refuse</c> makes for a board configured before its property is
/// declared. A rule naming a property nothing declares simply matches nothing.
/// </para>
/// <para>
/// <b>Rules combine with AND, with one level of OR.</b> A rule whose <see cref="Any"/> is set is
/// an "any of" group: it matches when at least one of its rules does, and its own property,
/// operator and value are empty. Groups do not nest - "all of, containing any of" is the whole
/// grammar - and the rule ceiling counts the rules inside groups (<see cref="QueryRules"/>).
/// ADR-0060 records the widening from AND-only by exactly this one level.
/// </para>
/// <para>
/// <b>A property starting with <c>$</c> is a structural field, not a property key</b>
/// (<see cref="QueryFields"/>): the item's type, its ancestry, its timestamps, its completion.
/// Property keys may not start with <c>$</c>, which is what keeps the two spaces apart.
/// </para>
/// </remarks>
public sealed record FilterRule(string Property, string Operator, string Value)
{
    /// <summary>
    /// The rules of an "any of" group, or default for an ordinary rule.
    /// </summary>
    /// <remarks>
    /// An init-only member rather than a fourth positional parameter, so every ordinary rule is
    /// still written the way it always was, and a group is spelled through <see cref="Group"/>.
    /// </remarks>
    public ImmutableArray<FilterRule> Any { get; init; }

    /// <summary>Whether this is an "any of" group rather than one condition.</summary>
    public bool IsGroup => !Any.IsDefaultOrEmpty;

    /// <summary>An "any of" group over <paramref name="rules"/>.</summary>
    /// <param name="rules">The alternatives; at least one matches for the group to match.</param>
    /// <returns>The group.</returns>
    public static FilterRule Group(ImmutableArray<FilterRule> rules) =>
        new(string.Empty, string.Empty, string.Empty) { Any = rules };
}

/// <summary>
/// The operators a query view may use, and each one's value grammar.
/// </summary>
/// <remarks>
/// A closed set, policed on write and re-checked before execution: each operator selects a fixed
/// SQL fragment in <c>QuerySql</c>, so an operator outside this set has no fragment to select and
/// a value outside its grammar has no meaning to compile. Sized to the shipped presets plus a
/// select filter, deliberately - every operator added here is also an editor control, a
/// compilation arm and a sentence in the published contract.
/// </remarks>
public static class QueryOperators
{
    /// <summary>The stored value equals the literal.</summary>
    public const string EqualTo = "equals";

    /// <summary>The stored value differs from the literal - including being absent.</summary>
    /// <remarks>
    /// Absence counts as "not equal" on purpose: Overdue asks for <c>done not-equals true</c>,
    /// and an item that never had the property set is exactly as not-done as one set false.
    /// </remarks>
    public const string NotEqualTo = "not-equals";

    /// <summary>The stored date falls on the day.</summary>
    public const string On = "on";

    /// <summary>The stored date falls before the day.</summary>
    public const string Before = "before";

    /// <summary>The stored date falls on or after the day.</summary>
    public const string OnOrAfter = "on-or-after";

    /// <summary>The stored date falls within the next N days, today included.</summary>
    public const string WithinNext = "within-next";

    /// <summary>The stored date falls within the last N days, today included - the mirror of <see cref="WithinNext"/>.</summary>
    public const string WithinLast = "within-last";

    /// <summary>
    /// For text, the stored value contains the literal as a substring, ignoring case. For a
    /// multi-select, the literal is one of the stored options exactly, case included - an option
    /// is a declared name, not text to search.
    /// </summary>
    /// <remarks>
    /// The web evaluates it over a container's own children
    /// (<c>packages/web-collections/src/core/filter-rules.ts</c>) and <c>QuerySql</c> compiles it with the
    /// same meaning: an escaped <c>ILIKE</c> for text, element containment for a list.
    /// </remarks>
    public const string Contains = "contains";

    /// <summary>The negation of <see cref="Contains"/>, absence included.</summary>
    public const string NotContains = "not-contains";

    /// <summary>The stored number is greater than the literal.</summary>
    /// <remarks>
    /// A stored JSON number, the rollups' rule (<c>NumberSql</c>). Anything else - absent, a word, a
    /// list, a string that only looks like a number - is not greater than anything, never an error.
    /// </remarks>
    public const string GreaterThan = "greater-than";

    /// <summary>The stored number is less than the literal. Same reading as <see cref="GreaterThan"/>.</summary>
    public const string LessThan = "less-than";

    /// <summary>The property is absent, null, empty text or an empty list. Takes no value.</summary>
    public const string IsEmpty = "is-empty";

    /// <summary>The negation of <see cref="IsEmpty"/>. Takes no value.</summary>
    public const string IsNotEmpty = "is-not-empty";

    /// <summary>The token a stored rule keeps where a concrete day would go.</summary>
    /// <remarks>
    /// Resolved at read time from the caller's own <c>today</c> parameter, never from the server
    /// clock: only the reader's zone decides which day "today" is, and a saved query has to stay
    /// saved as the rule rather than as whichever day it was written on.
    /// </remarks>
    public const string Today = "today";

    /// <summary>The Monday on or before the caller's today (weeks start on Monday, as the calendar draws them).</summary>
    public const string StartOfWeek = "start-of-week";

    /// <summary>The first day of the caller's month.</summary>
    public const string StartOfMonth = "start-of-month";

    /// <summary>Seven days before the caller's today.</summary>
    public const string SameDayLastWeek = "same-day-last-week";

    /// <summary>
    /// The same day of the previous month, clamped to that month's last day (31 March reads 28 or
    /// 29 February).
    /// </summary>
    public const string SameDayLastMonth = "same-day-last-month";

    /// <summary>Every token a day operator accepts where a date would go.</summary>
    /// <remarks>Each is resolved from the caller's own today, never the server clock - see <see cref="Today"/>.</remarks>
    public static readonly ImmutableArray<string> DayTokens =
        [Today, StartOfWeek, StartOfMonth, SameDayLastWeek, SameDayLastMonth];

    /// <summary>The token a stored rule keeps where the calling principal's identifier would go.</summary>
    /// <remarks>
    /// <para>
    /// <b>Valid only as the value of <see cref="EqualTo"/> or <see cref="NotEqualTo"/>.</b> None
    /// of the day operators or <see cref="WithinNext"/> read an identity, so a rule that names
    /// <c>me</c> there is refused by the same grammar that refuses any other malformed day or
    /// count - it is neither <see cref="Today"/> nor a calendar day, and it does not parse as a
    /// number, so no separate check is needed to keep it out of those arms.
    /// </para>
    /// <para>
    /// <b>Resolved from the session context the request pipeline established, never from
    /// anything a client sends.</b> This is the one place the parallel with <see cref="Today"/>
    /// breaks: <c>today</c>'s caller is the reader's own clock, sent because only the reader's
    /// zone knows the day, but letting a client assert <em>its own identity</em> inside a filter
    /// value would make "assigned to me" mean whatever the request claimed rather than who
    /// actually asked. <c>RunItemQueryHandler</c> resolves it from the acting principal and
    /// rewrites the rule before the compiled statement ever sees it, so by the time a value
    /// reaches <c>QuerySql</c> it is already a literal - the same reason <c>QuerySql</c> carries
    /// no <c>me</c>-handling branch of its own; it is a static compiler with no session to read
    /// one from.
    /// </para>
    /// </remarks>
    public const string Me = "me";

    /// <summary>
    /// Every operator a rule's <c>Operator</c> may hold - not <see cref="Today"/> or
    /// <see cref="Me"/>, which are value tokens, never an operator.
    /// </summary>
    public static readonly ImmutableArray<string> All =
        [EqualTo, NotEqualTo, On, Before, OnOrAfter, WithinNext, WithinLast,
            Contains, NotContains, GreaterThan, LessThan, IsEmpty, IsNotEmpty];

    /// <summary>
    /// The operators a query's SQL compiles - since the queries plan (1.2), every one of
    /// <see cref="All"/>.
    /// </summary>
    /// <remarks>
    /// Kept as its own name rather than folded into <see cref="All"/>, because it is the set the
    /// statement and the pet catalog must agree on, and the two sets were apart once (ADR-0054). A
    /// rule naming an operator outside it is refused on write and again before it runs, rather
    /// than reaching the compiler's "unknown operator" throw.
    /// </remarks>
    public static readonly ImmutableArray<string> CompiledByQuery = All;

    /// <summary>Whether an operator takes no value at all.</summary>
    /// <param name="operator">The operator text.</param>
    /// <returns><see langword="true"/> for the emptiness pair.</returns>
    public static bool TakesNoValue(string @operator) => @operator is IsEmpty or IsNotEmpty;

    /// <summary>Whether an operator reads its value as a number.</summary>
    /// <param name="operator">The operator text.</param>
    /// <returns><see langword="true"/> for the numeric comparisons.</returns>
    public static bool ReadsNumber(string @operator) => @operator is GreaterThan or LessThan;

    /// <summary>Whether an operator reads its value as a count of days around today.</summary>
    /// <param name="operator">The operator text.</param>
    /// <returns><see langword="true"/> for <see cref="WithinNext"/> and <see cref="WithinLast"/>.</returns>
    public static bool ReadsDayCount(string @operator) => @operator is WithinNext or WithinLast;

    /// <summary>Whether an operator compares days at all - the date trio or a window.</summary>
    /// <param name="operator">The operator text.</param>
    /// <returns><see langword="true"/> when the rule is date-shaped.</returns>
    public static bool IsDateShaped(string @operator) => ReadsDay(@operator) || ReadsDayCount(@operator);

    /// <summary>The most days <see cref="WithinNext"/> or <see cref="WithinLast"/> may reach.</summary>
    public const int MaximumWithinDays = 365;

    /// <summary>The longest value a rule may carry, in characters.</summary>
    public const int MaximumValueLength = 512;

    /// <summary>The longest property key a rule may name, in characters.</summary>
    public const int MaximumPropertyLength = 128;

    /// <summary>Whether the operator is one this build defines.</summary>
    /// <param name="operator">The operator text.</param>
    /// <returns><see langword="true"/> when it selects a compilation arm.</returns>
    public static bool IsKnown(string @operator) => All.Contains(@operator);

    /// <summary>Whether the operator reads its value as a day.</summary>
    /// <param name="operator">The operator text.</param>
    /// <returns><see langword="true"/> for the date trio; the windows read a count.</returns>
    public static bool ReadsDay(string @operator) => @operator is On or Before or OnOrAfter;

    /// <summary>Whether a value is one of the <see cref="DayTokens"/>.</summary>
    /// <param name="value">The rule's value.</param>
    /// <returns><see langword="true"/> for a token the caller's today resolves.</returns>
    public static bool IsDayToken(string value) => DayTokens.Contains(value);

    /// <summary>The day a day operator's value names, resolved against the caller's today.</summary>
    /// <param name="value">A token from <see cref="DayTokens"/> or a <c>yyyy-MM-dd</c> date.</param>
    /// <param name="today">The caller's own today.</param>
    /// <returns>The day, or <see langword="null"/> when the value is neither.</returns>
    public static DateOnly? ResolveDay(string value, DateOnly today) => value switch
    {
        Today => today,
        StartOfWeek => today.AddDays(-(((int)today.DayOfWeek + 6) % 7)),
        StartOfMonth => new DateOnly(today.Year, today.Month, 1),
        SameDayLastWeek => today.AddDays(-7),
        SameDayLastMonth => today.AddMonths(-1),
        _ => DateOnly.TryParseExact(value, "yyyy-MM-dd", CultureInfo.InvariantCulture, DateTimeStyles.None, out var day)
            ? day
            : null,
    };

    /// <summary>Whether a rule can only be compiled once the caller's today is known.</summary>
    /// <param name="rule">A leaf rule.</param>
    /// <returns><see langword="true"/> for a window, or a day operator holding a token.</returns>
    public static bool NeedsToday(FilterRule rule)
    {
        ArgumentNullException.ThrowIfNull(rule);
        return ReadsDayCount(rule.Operator) || (ReadsDay(rule.Operator) && IsDayToken(rule.Value));
    }

    /// <summary>
    /// The sentence refusing one rule, or null when the rule is storable.
    /// </summary>
    /// <param name="rule">The rule.</param>
    /// <returns>How to finish "'&lt;view name&gt;': ...", or <see langword="null"/>.</returns>
    /// <remarks>
    /// Grammar only - key length, operator membership, value shape. Whether the property exists
    /// is deliberately not asked; see <see cref="FilterRule"/>.
    /// </remarks>
    public static string? Refuse(FilterRule rule)
    {
        ArgumentNullException.ThrowIfNull(rule);

        if (rule.IsGroup)
        {
            // A group is a container of rules, checked by QueryRules where the nesting and the
            // ceiling are known; asking this method about one is asking the wrong question.
            return "an \"any of\" group is not a single filter";
        }

        if (rule.Property.Length == 0)
        {
            return "a filter needs a property to test";
        }

        if (rule.Property.Length > MaximumPropertyLength)
        {
            return $"a filter's property key may be at most {MaximumPropertyLength} characters";
        }

        if (!IsKnown(rule.Operator))
        {
            return $"'{rule.Operator}' is not a filter operator";
        }

        if (TakesNoValue(rule.Operator))
        {
            // Nothing to compare against, and a value here would be a second, ignored meaning.
            return rule.Value.Length == 0 ? null : $"'{rule.Operator}' takes no value";
        }

        if (rule.Value.Length == 0)
        {
            return "a filter needs a value to compare against";
        }

        if (rule.Value.Length > MaximumValueLength)
        {
            return $"a filter's value may be at most {MaximumValueLength} characters";
        }

        if (ReadsDay(rule.Operator)
            && !IsDayToken(rule.Value)
            && !IsCalendarDay(rule.Value))
        {
            return $"'{rule.Operator}' reads a day: '{Today}', '{StartOfWeek}', '{StartOfMonth}', "
                + $"'{SameDayLastWeek}', '{SameDayLastMonth}' or a date written yyyy-MM-dd";
        }

        if (ReadsNumber(rule.Operator) && !IsFiniteNumber(rule.Value))
        {
            return $"'{rule.Operator}' reads a number, written like 12 or -3.5";
        }

        if (ReadsDayCount(rule.Operator)
            && (!int.TryParse(rule.Value, NumberStyles.None, CultureInfo.InvariantCulture, out var days)
                || days < 1
                || days > MaximumWithinDays))
        {
            return $"'{rule.Operator}' reads a number of days from 1 to {MaximumWithinDays}";
        }

        // Last, so a structural field still meets the grammar every operator has; the field then
        // narrows which operators and values mean anything for it.
        return QueryFields.IsReserved(rule.Property) ? QueryFields.Refuse(rule) : null;
    }

    private static bool IsFiniteNumber(string value) =>
        double.TryParse(value, NumberStyles.Float, CultureInfo.InvariantCulture, out var number)
        && double.IsFinite(number);

    private static bool IsCalendarDay(string value) =>
        DateOnly.TryParseExact(value, "yyyy-MM-dd", CultureInfo.InvariantCulture, DateTimeStyles.None, out _);
}
