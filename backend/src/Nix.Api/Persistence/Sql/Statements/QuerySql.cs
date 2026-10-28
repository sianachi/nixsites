using System.Collections.Immutable;
using System.Globalization;
using System.Text;
using Nix.Abstractions;
using Nix.Domain.Query;
using Nix.Domain.Views;
using NodaTime;
using Npgsql;
using NpgsqlTypes;

namespace Nix.Persistence.Sql.Statements;

/// <summary>
/// Compiles a query - a saved query view's rules or an ad-hoc workspace query - into one statement:
/// every readable, active item that satisfies the rules, with its parent's title riding along, or
/// the same match folded into an aggregate.
/// </summary>
/// <remarks>
/// <para>
/// <b>One match, two shapes.</b> <see cref="Compile"/> returns rows and <see cref="CompileAggregate"/>
/// folds them; both build their <c>FROM</c>/<c>WHERE</c> through the same private method, so the
/// permission predicate, the lifecycle and lock filters, the scope and every rule arm are the same
/// text in both. An aggregate is never a second rule engine.
/// </para>
/// <para>
/// <b>No user-controlled text ever enters the SQL.</b> The operator and a structural field select
/// fixed fragment templates - an operator outside the closed set throws, because the handler
/// re-validates before calling and an unknown one here is a bug, not an input. Property keys and
/// values are parameters; the only interpolation is the parameter <em>name</em>, generated from
/// the rule's position. A property-based test asserts arbitrary keys and values never appear in
/// the emitted text.
/// </para>
/// <para>
/// <b>The permission filter is a predicate in the statement</b>, the <see cref="GraphSql"/> /
/// <see cref="CalendarSql"/> rule: the readable workspaces arrive as an array parameter resolved
/// by the handler, never sent by a client, so the LIMIT is spent only on rows the caller may see
/// and an aggregate folds only rows the caller may see. The parent join carries the same
/// readable-workspaces predicate as the row itself: the parent's title is projected, and a
/// cross-workspace parent - impossible today, but held only by caller convention, not by any
/// constraint - must surface as a null container title, never as a name from a workspace the
/// caller cannot read.
/// </para>
/// <para>
/// <b>Days compare the first ten characters, and must not cast</b> - <see cref="CalendarSql"/>'s
/// receipt: a stored <c>date</c> is <c>yyyy-MM-dd</c> and a stored <c>timestamp</c> is RFC 9557
/// with a bracketed zone, both beginning with the same ten characters, and a
/// <c>timestamptz</c> cast throws on the bracketed suffix. <c>left(NULL, 10)</c> is null, so an
/// item without the property fails every day comparison - absent is never "on" any day. The two
/// structural timestamps (<c>$created</c>, <c>$modified</c>) are real columns, compared as a
/// half-open range of instants - the caller's days, resolved in the caller's zone
/// (<see cref="QuerySpec.Zone"/>) - which also keeps them sargable.
/// </para>
/// <para>
/// <b>Numbers are JSON numbers, read through <see cref="NumberSql"/>.</b> <c>greater-than</c>,
/// <c>less-than</c> and the numeric folds read a stored JSON number and nothing else - the
/// rollups' rule - so a word, or a string that only looks like a number, is skipped rather than
/// cast, and no stored value can fail the statement.
/// </para>
/// <para>
/// <b>Day rules over the reserved <c>due_date</c> key compile to <c>item.due_day</c></b> - the
/// stored generated column - and everything else stays a bag read with no index claimed. The
/// reason is row security: <c>-&gt;&gt;</c> and <c>left()</c> are not leakproof, so a predicate
/// over them can never be an index condition under RLS - measured on a 100k corpus as the runtime
/// role, the same query against the same expression index ran 0.5 ms with RLS bypassed and
/// 58.5 ms with it enforced. A plain column is leakproof, which is why <c>due_day</c> exists;
/// with it, Overdue runs 4.9 ms / 1,026 buffers against a 99.7 ms / 5,527 seq-scan baseline. The
/// standing CI check is <c>TaskSemanticsPlanEvidenceTests</c>. Any future index over the bag must
/// clear the same bar.
/// </para>
/// <para>
/// <b>This compiler carries no <see cref="QueryOperators.Me"/>-handling branch.</b> <c>Me</c>
/// resolves to the acting principal, which lives in the request's session context, and this is a
/// static class with nothing to read one from. The query handlers resolve it and rewrite the rule
/// before calling the query port, so a value arriving here - even the literal text <c>"me"</c> -
/// is already ordinary data.
/// </para>
/// </remarks>
public static class QuerySql
{
    /// <summary>
    /// The reserved key whose day comparisons compile to the generated column instead of the bag.
    /// </summary>
    /// <remarks>
    /// One key, matched by name: <c>item.due_day</c> is generated from exactly this key, so the
    /// two expressions are equal by construction and only the column form is index-servable under
    /// row security (see the class remarks). The name is interpolated as a fixed literal, never
    /// from input - the rule's key merely selects the branch.
    /// </remarks>
    private const string ReservedDueDateKey = "due_date";

    /// <summary>
    /// Compiles the rows statement: the match, its order within each group, and the limit.
    /// </summary>
    /// <param name="spec">The re-validated rules, ordering, scope and grouping.</param>
    /// <returns>The statement and its rule parameters.</returns>
    /// <remarks>
    /// The fixed parameters the statement also binds - <c>@tenant_id</c>, <c>@workspace_ids</c>,
    /// <c>@limit</c>, the lock filter's <c>@closed_lock_ids</c>, and <c>@query_item_id</c> /
    /// <c>@scope_parent_id</c> when the spec names them - are the reader's to supply. Rows are
    /// ordered by group first, so grouping happens before the limit and a cut list has whole
    /// groups first.
    /// </remarks>
    public static CompiledQuery Compile(QuerySpec spec)
    {
        ArgumentNullException.ThrowIfNull(spec);

        var parameters = new List<NpgsqlParameter>();
        var grouped = spec.Grouping is not null;
        var sql = new StringBuilder(
            """
            SELECT item.id,
                   item.workspace_id,
                   item.parent_id,
                   parent.properties ->> 'title' AS container_title,
                   item.properties ->> 'title' AS title,
                   item.type,
                   item.properties::text AS properties,
                   item.last_modified_at,
            """);

        // The group rides as a column and its size as a window over the whole match, so the last
        // group of a truncated list can still say how big it is.
        sql.Append(grouped
            ? "\n       grouping.group_key,\n       count(*) OVER (PARTITION BY grouping.group_key) AS group_rows"
            : "\n       NULL::text AS group_key,\n       0::bigint AS group_rows");

        sql.Append(
            """

            FROM item
            LEFT JOIN item AS parent
                   ON parent.id = item.parent_id
                  AND parent.tenant_id = @tenant_id
                  AND parent.workspace_id = ANY(@workspace_ids)
                  AND parent.template_id IS NULL
                  AND parent.lifecycle_state = 'active'
            """);

        if (spec.Grouping is { } grouping)
        {
            AppendGroupingJoin(sql, parameters, grouping);
        }

        AppendMatch(sql, parameters, spec);

        sql.Append("\nORDER BY ");
        if (spec.Grouping is { } order)
        {
            AppendGroupOrder(sql, parameters, order);
            sql.Append(", ");
        }

        AppendOrder(sql, parameters, spec.Order);
        sql.Append("\nLIMIT @limit");

        return new CompiledQuery(sql.ToString(), parameters);
    }

    /// <summary>
    /// Compiles the aggregate statement: the same match, folded per group and in total.
    /// </summary>
    /// <param name="spec">The re-validated rules, scope and grouping; the order is not used.</param>
    /// <param name="aggregate">The fold; a numeric fold names its property.</param>
    /// <returns>The statement and its rule parameters.</returns>
    /// <remarks>
    /// One row per returned group, each carrying the totals as well, so an empty or ungrouped
    /// result is still exactly one row: the totals with null group columns. The reader binds
    /// <c>@group_limit</c> besides the fixed parameters <see cref="Compile"/> lists.
    /// </remarks>
    public static CompiledQuery CompileAggregate(QuerySpec spec, QueryAggregate aggregate)
    {
        ArgumentNullException.ThrowIfNull(spec);
        ArgumentNullException.ThrowIfNull(aggregate);

        var parameters = new List<NpgsqlParameter>();
        var numeric = !string.Equals(aggregate.Function, QueryAggregateFunctions.Count, StringComparison.Ordinal);
        if (numeric && string.IsNullOrEmpty(aggregate.Property))
        {
            throw new InvalidOperationException(
                $"'{aggregate.Function}' folds a property, and none was named. The handler checks "
                + "this before calling, so reaching here is a bug rather than an input.");
        }

        var fold = aggregate.Function switch
        {
            QueryAggregateFunctions.Count => "count(*)::numeric",
            // Rounded to six places, every one: a stored number may carry more fractional digits
            // than a decimal holds, and a total of them would fail to read rather than round.
            // A total past NumberSql.TotalBound answers null rather than overflowing the reader.
            QueryAggregateFunctions.Sum => $"round({NumberSql.CappedSum("measure")}, 6)",
            QueryAggregateFunctions.Average => "round(avg(measure), 6)",
            QueryAggregateFunctions.Minimum => "round(min(measure), 6)",
            QueryAggregateFunctions.Maximum => "round(max(measure), 6)",
            _ => throw new InvalidOperationException(
                $"'{aggregate.Function}' is not a fold this build compiles. The handler validates "
                + "the function before calling, so reaching here is a bug rather than an input."),
        };

        var sql = new StringBuilder("WITH matched AS MATERIALIZED (\n    SELECT ");
        sql.Append(spec.Grouping is null ? "NULL::text" : "grouping.group_key");
        sql.Append(" AS group_key,\n           ");

        if (numeric)
        {
            var key = Text("measure_key", aggregate.Property!, parameters);
            sql.Append(CultureInfo.InvariantCulture, $"{NumberSql.Bounded("item.properties", "@" + key)} AS measure,\n           ");
            sql.Append(CultureInfo.InvariantCulture, $"{Present(key)} AS present");
        }
        else
        {
            sql.Append("NULL::numeric AS measure,\n           FALSE AS present");
        }

        sql.Append("\n    FROM item");
        if (spec.Grouping is { } grouping)
        {
            AppendGroupingJoin(sql, parameters, grouping);
        }

        AppendMatch(sql, parameters, spec);

        sql.Append(CultureInfo.InvariantCulture, $"""

            ),
            totals AS (
                SELECT count(*) AS row_count,
                       {fold} AS value,
                       count(*) FILTER (WHERE present AND measure IS NULL) AS skipped,
                       count(DISTINCT group_key)
                           + COALESCE(max(CASE WHEN group_key IS NULL THEN 1 ELSE 0 END), 0) AS group_count
                FROM matched
            )
            """);

        if (spec.Grouping is { } grouped)
        {
            sql.Append(CultureInfo.InvariantCulture, $"""

                SELECT totals.row_count, totals.value, totals.skipped, totals.group_count,
                       groups.group_key, groups.row_count, groups.value, groups.skipped
                FROM totals
                LEFT JOIN (
                    SELECT matched.group_key,
                           count(*) AS row_count,
                           {fold} AS value,
                           count(*) FILTER (WHERE present AND measure IS NULL) AS skipped
                    FROM matched
                    GROUP BY matched.group_key
                    ORDER BY
                """);
            sql.Append(' ');
            AppendGroupRank(sql, parameters, grouped, "matched.group_key");
            sql.Append(
                """

                    LIMIT @group_limit
                ) AS groups ON TRUE
                ORDER BY
                """);
            sql.Append(' ');
            AppendGroupRank(sql, parameters, grouped, "groups.group_key");
        }
        else
        {
            sql.Append(
                """

                SELECT totals.row_count, totals.value, totals.skipped, totals.group_count,
                       NULL::text, NULL::bigint, NULL::numeric, NULL::bigint
                FROM totals
                """);
        }

        return new CompiledQuery(sql.ToString(), parameters);
    }

    /// <summary>
    /// The shared match: the readable, active, unlocked, in-scope items the rules admit. Writes the
    /// <c>WHERE</c> clause onward; the caller has written <c>FROM item</c> and any joins.
    /// </summary>
    private static void AppendMatch(StringBuilder sql, List<NpgsqlParameter> parameters, QuerySpec spec)
    {
        sql.Append(
            """

            WHERE item.tenant_id = @tenant_id
              AND item.workspace_id = ANY(@workspace_ids)
              AND item.lifecycle_state = 'active'
              AND item.template_id IS NULL
            """);

        if (spec.ExcludedItemId is not null)
        {
            sql.Append("\n  AND item.id <> @query_item_id");
        }

        // No hidden proper ancestor.
        sql.Append("\n  AND ");
        sql.Append(ItemVisibilitySql.NoHiddenAncestor);
        sql.Append("\n  AND ");
        sql.Append(ItemLockSql.ItemIsNotUnderClosedLock);

        if (spec.Scope is { } scope)
        {
            // The scope container itself is never a row of its own query, in either form: the
            // closure edge requires depth > 0, and parent_id never names the item itself.
            sql.Append(scope.Descendants
                ? """

                    AND EXISTS (
                      SELECT 1
                      FROM item_closure AS scope_edge
                      WHERE scope_edge.tenant_id = @tenant_id
                        AND scope_edge.descendant_id = item.id
                        AND scope_edge.ancestor_id = @scope_parent_id
                        AND scope_edge.depth > 0
                  )
                  """
                : "\n  AND item.parent_id = @scope_parent_id");
        }

        var rules = spec.Rules;
        if (rules.IsDefaultOrEmpty)
        {
            return;
        }

        for (var index = 0; index < rules.Length; index++)
        {
            var rule = rules[index];
            if (!rule.IsGroup)
            {
                sql.Append("\n  AND ");
                AppendCondition(sql, parameters, rule, $"p{index}", spec.Today, spec.Zone);
                continue;
            }

            // One level of OR, parenthesised: "all of, containing any of". Each alternative is
            // itself parenthesised so no arm's own AND/OR can bind across its neighbours.
            sql.Append("\n  AND (");
            for (var inner = 0; inner < rule.Any.Length; inner++)
            {
                if (inner > 0)
                {
                    sql.Append("\n       OR ");
                }

                sql.Append('(');
                AppendCondition(sql, parameters, rule.Any[inner], $"p{index}_{inner}", spec.Today, spec.Zone);
                sql.Append(')');
            }

            sql.Append(')');
        }
    }

    /// <summary>Writes one rule as a boolean expression, never null for an absent property.</summary>
    /// <param name="sql">The statement.</param>
    /// <param name="parameters">The rule parameters.</param>
    /// <param name="rule">A leaf rule.</param>
    /// <param name="name">The rule's parameter prefix, generated from its position - never from input.</param>
    /// <param name="today">The caller's today.</param>
    private static void AppendCondition(
        StringBuilder sql,
        List<NpgsqlParameter> parameters,
        FilterRule rule,
        string name,
        DateOnly today,
        DateTimeZone zone)
    {
        if (QueryFields.IsReserved(rule.Property))
        {
            AppendStructuralCondition(sql, parameters, rule, name, today, zone);
            return;
        }

        // A day expression over the reserved due-date key is the generated column; over any other
        // key it is the bag read. Same value by construction, different plan under RLS.
        var reservedDay = string.Equals(rule.Property, ReservedDueDateKey, StringComparison.Ordinal);

        // The only interpolated text besides fixed fragments: a parameter name generated from the
        // rule's position. The key and every value reach the statement as bound parameters.
        string Key() => Text($"{name}_key", rule.Property, parameters);

        string DayExpression() =>
            reservedDay ? "item.due_day" : $"left(item.properties ->> @{Key()}, 10)";

        switch (rule.Operator)
        {
            case QueryOperators.EqualTo:
                sql.Append(CultureInfo.InvariantCulture, $"item.properties ->> @{Key()} = @{Text($"{name}_value", rule.Value, parameters)}");
                break;

            case QueryOperators.NotEqualTo:
                // IS DISTINCT FROM, so an absent property counts as "not equal" - Overdue's
                // done-not-equals-true must match an item that never had the property at all.
                sql.Append(CultureInfo.InvariantCulture, $"item.properties ->> @{Key()} IS DISTINCT FROM @{Text($"{name}_value", rule.Value, parameters)}");
                break;

            case QueryOperators.On:
            case QueryOperators.Before:
            case QueryOperators.OnOrAfter:
                sql.Append(CultureInfo.InvariantCulture, $"{DayExpression()} {DayComparison(rule.Operator)} @{Day($"{name}_day", rule.Value, today, parameters)}");
                break;

            case QueryOperators.WithinNext:
            case QueryOperators.WithinLast:
                AppendWindow(sql, parameters, DayExpression(), rule, name, today);
                break;

            case QueryOperators.Contains:
                AppendContains(sql, parameters, Key(), rule.Value, name);
                break;

            case QueryOperators.NotContains:
                // The contains expression is never null, so its negation keeps absence: an item
                // without the property does not contain the text, so it is admitted here.
                sql.Append("NOT ");
                AppendContains(sql, parameters, Key(), rule.Value, name);
                break;

            case QueryOperators.GreaterThan:
            case QueryOperators.LessThan:
                // A stored JSON number compared with the literal, cast from text so a literal beyond
                // decimal's range still compares. A non-number is null, and null is not greater.
                var comparison = rule.Operator == QueryOperators.GreaterThan ? ">" : "<";
                sql.Append(CultureInfo.InvariantCulture, $"COALESCE({NumberSql.Number("item.properties", "@" + Key())} {comparison} CAST(@{Text($"{name}_number", rule.Value.Trim(), parameters)} AS numeric), FALSE)");
                break;

            case QueryOperators.IsEmpty:
                sql.Append(Empty(Key()));
                break;

            case QueryOperators.IsNotEmpty:
                sql.Append(CultureInfo.InvariantCulture, $"NOT {Empty(Key())}");
                break;

            default:
                throw new InvalidOperationException(
                    $"'{rule.Operator}' is not an operator this build compiles. The handler "
                    + "re-validates rules before running them, so reaching here is a bug rather "
                    + "than an input.");
        }
    }

    /// <summary>Writes a rule over a structural field (<see cref="QueryFields"/>).</summary>
    private static void AppendStructuralCondition(
        StringBuilder sql,
        List<NpgsqlParameter> parameters,
        FilterRule rule,
        string name,
        DateOnly today,
        DateTimeZone zone)
    {
        var negated = rule.Operator == QueryOperators.NotEqualTo;

        switch (rule.Property)
        {
            case QueryFields.Type:
                sql.Append(CultureInfo.InvariantCulture, $"item.type {(negated ? "<>" : "=")} @{Text($"{name}_value", rule.Value, parameters)}");
                return;

            case QueryFields.Inside:
                // Ancestry through the closure, strictly beneath: an item is not inside itself.
                // The id is a typed parameter; the grammar has already proven it parses.
                var ancestor = $"{name}_ancestor";
                parameters.Add(new NpgsqlParameter(ancestor, NpgsqlDbType.Uuid)
                {
                    Value = Guid.ParseExact(rule.Value, "D"),
                });
                sql.Append(CultureInfo.InvariantCulture, $"""
                    {(negated ? "NOT " : string.Empty)}EXISTS (
                          SELECT 1
                          FROM item_closure AS {name}_inside
                          WHERE {name}_inside.tenant_id = @tenant_id
                            AND {name}_inside.descendant_id = item.id
                            AND {name}_inside.ancestor_id = @{ancestor}
                            AND {name}_inside.depth > 0
                      )
                    """);
                return;

            case QueryFields.Done:
                // Done is the reserved completion key set to true, and nothing else; absent and
                // false are both "not done", so "done equals false" admits an item never marked.
                var wantsDone = string.Equals(rule.Value, "true", StringComparison.Ordinal) != negated;
                sql.Append(wantsDone
                    ? "item.properties ->> 'completion' = 'true'"
                    : "item.properties ->> 'completion' IS DISTINCT FROM 'true'");
                return;

            case QueryFields.Created:
            case QueryFields.Modified:
                AppendTimestampRange(sql, parameters, rule, name, today, zone);
                return;

            default:
                throw new InvalidOperationException(
                    $"'{rule.Property}' is not a field this build compiles. The handler re-validates "
                    + "rules before running them, so reaching here is a bug rather than an input.");
        }
    }

    private static string DayComparison(string @operator) => @operator switch
    {
        QueryOperators.On => "=",
        QueryOperators.Before => "<",
        QueryOperators.OnOrAfter => ">=",
        _ => throw new InvalidOperationException($"'{@operator}' does not compare days."),
    };

    /// <summary>
    /// A structural timestamp rule as a half-open range of instants: the caller's days, each
    /// starting at midnight in the caller's zone. <c>on</c> is <c>[start(d), start(d+1))</c>,
    /// <c>before</c> is <c>&lt; start(d)</c>, <c>on-or-after</c> is <c>&gt;= start(d)</c>, and the
    /// windows cover their days inclusively. A bare column compared with a parameter, so the
    /// predicate is leakproof and index-servable under RLS.
    /// </summary>
    private static void AppendTimestampRange(
        StringBuilder sql,
        List<NpgsqlParameter> parameters,
        FilterRule rule,
        string name,
        DateOnly today,
        DateTimeZone zone)
    {
        var column = rule.Property == QueryFields.Created ? "item.created_at" : "item.last_modified_at";

        (DateOnly? From, DateOnly? Through) days = rule.Operator switch
        {
            QueryOperators.On => (Resolve(rule.Value, today), Resolve(rule.Value, today)),
            QueryOperators.Before => (null, Previous(Resolve(rule.Value, today))),
            QueryOperators.OnOrAfter => (Resolve(rule.Value, today), null),
            QueryOperators.WithinNext => (today, Plus(today, Count(rule.Value))),
            QueryOperators.WithinLast => (Plus(today, -Count(rule.Value)), today),
            _ => throw new InvalidOperationException($"'{rule.Operator}' does not compare days."),
        };

        var terms = new List<string>(2);
        if (days.From is { } from)
        {
            terms.Add($"{column} >= @{Instant($"{name}_from", StartOf(from, zone), parameters)}");
        }

        // The end is exclusive: the start of the day after the last one included. The calendar's
        // last day has no day after it, so the range is simply left open there.
        if (days.Through is { } through && through < DateOnly.MaxValue)
        {
            terms.Add($"{column} < @{Instant($"{name}_to", StartOf(through.AddDays(1), zone), parameters)}");
        }

        // "Before the first day there is" holds for nothing, and an unbounded range for everything.
        sql.Append(terms.Count > 0
            ? "(" + string.Join(" AND ", terms) + ")"
            : rule.Operator == QueryOperators.Before ? "FALSE" : "TRUE");

        static DateOnly Resolve(string value, DateOnly today) =>
            QueryOperators.ResolveDay(value, today)
            ?? throw new InvalidOperationException($"'{value}' is not a day; the handler validates rules first.");

        static int Count(string value) => int.Parse(value, NumberStyles.None, CultureInfo.InvariantCulture);

        static DateOnly? Previous(DateOnly day) => day == DateOnly.MinValue ? null : day.AddDays(-1);

        static DateOnly Plus(DateOnly day, int days) =>
            day.DayNumber + days < DateOnly.MinValue.DayNumber ? DateOnly.MinValue
            : day.DayNumber + days > DateOnly.MaxValue.DayNumber ? DateOnly.MaxValue
            : day.AddDays(days);
    }

    /// <summary>
    /// The instant a day starts in a zone, clamped to what a <see cref="DateTimeOffset"/> can hold
    /// (a zone east of UTC starts 0001-01-01 before the representable range).
    /// </summary>
    private static DateTimeOffset StartOf(DateOnly day, DateTimeZone zone)
    {
        var instant = zone.AtStartOfDay(LocalDate.FromDateOnly(day)).ToInstant();
        var earliest = NodaTime.Instant.FromDateTimeOffset(DateTimeOffset.MinValue);
        var latest = NodaTime.Instant.FromDateTimeOffset(DateTimeOffset.MaxValue);
        var clamped = instant < earliest ? earliest : instant > latest ? latest : instant;
        return clamped.ToDateTimeOffset();
    }

    private static string Instant(string name, DateTimeOffset value, List<NpgsqlParameter> parameters)
    {
        parameters.Add(new NpgsqlParameter(name, NpgsqlDbType.TimestampTz) { Value = value });
        return name;
    }

    /// <summary>
    /// A window of days from today: forward for <c>within-next</c>, back for <c>within-last</c>,
    /// both inclusive at each end.
    /// </summary>
    private static void AppendWindow(
        StringBuilder sql,
        List<NpgsqlParameter> parameters,
        string dayExpression,
        FilterRule rule,
        string name,
        DateOnly today)
    {
        var days = int.Parse(rule.Value, NumberStyles.None, CultureInfo.InvariantCulture);
        var (start, end) = rule.Operator == QueryOperators.WithinNext
            ? (today, today.AddDays(days))
            : (today.AddDays(-days), today);

        var from = Text($"{name}_from", Iso(start), parameters);
        var to = Text($"{name}_to", Iso(end), parameters);
        sql.Append(CultureInfo.InvariantCulture, $"{dayExpression} BETWEEN @{from} AND @{to}");
    }

    /// <summary>
    /// The meaning <see cref="QueryOperators.Contains"/> documents: a case-insensitive substring of
    /// stored text, escaped so the literal's own <c>%</c> and <c>_</c> mean themselves; exact
    /// option membership for a list. Anything else - absent, a number, an object - contains
    /// nothing. Never null.
    /// </summary>
    private static void AppendContains(
        StringBuilder sql,
        List<NpgsqlParameter> parameters,
        string key,
        string value,
        string name)
    {
        var pattern = Text($"{name}_pattern", "%" + EscapeLike(value) + "%", parameters);
        var option = Text($"{name}_option", value, parameters);
        sql.Append(CultureInfo.InvariantCulture, $"""
            (CASE jsonb_typeof(item.properties -> @{key})
                       WHEN 'string' THEN (item.properties ->> @{key}) ILIKE @{pattern} ESCAPE '\'
                       WHEN 'array' THEN (item.properties -> @{key}) @> jsonb_build_array(@{option}::text)
                       ELSE FALSE
                   END)
            """);
    }

    /// <summary>Escapes a LIKE literal: the escape character first, then the two wildcards.</summary>
    /// <param name="value">The literal as typed.</param>
    /// <returns>The literal, with every wildcard matching only itself.</returns>
    public static string EscapeLike(string value)
    {
        ArgumentNullException.ThrowIfNull(value);
        return value
            .Replace(@"\", @"\\", StringComparison.Ordinal)
            .Replace("%", @"\%", StringComparison.Ordinal)
            .Replace("_", @"\_", StringComparison.Ordinal);
    }

    /// <summary>
    /// Absent, JSON null, empty text and an empty list are all one bucket - the "Unset" the views
    /// draw. Never null: a missing key reads as empty.
    /// </summary>
    private static string Empty(string key) =>
        $"COALESCE((item.properties -> @{key}) IN ('null'::jsonb, '\"\"'::jsonb, '[]'::jsonb), TRUE)";

    /// <summary>Whether a row holds a value for the key at all: not absent, not null, not empty text.</summary>
    private static string Present(string key) =>
        $"(COALESCE(jsonb_typeof(item.properties -> @{key}) <> 'null', FALSE) AND (item.properties ->> @{key}) <> '')";

    /// <summary>
    /// Joins each row to its group key as a column, so the select list, the window and the order
    /// all read one expression.
    /// </summary>
    private static void AppendGroupingJoin(StringBuilder sql, List<NpgsqlParameter> parameters, QueryGrouping grouping)
    {
        string expression;
        if (string.Equals(grouping.Key, QueryFields.Type, StringComparison.Ordinal))
        {
            expression = "item.type";
        }
        else
        {
            // A string, a true/false or a numeric value names its group; an empty string and every other shape (a
            // list, an object, absence) are the "no value" group.
            var key = Text("group_key", grouping.Key, parameters);
            expression = $"""
                CASE jsonb_typeof(item.properties -> @{key})
                                     WHEN 'string' THEN NULLIF(item.properties ->> @{key}, '')
                                     WHEN 'boolean' THEN item.properties ->> @{key}
                                     WHEN 'number' THEN item.properties ->> @{key}
                                 END
                """;
        }

        sql.Append(CultureInfo.InvariantCulture, $"\nCROSS JOIN LATERAL (SELECT {expression} AS group_key) AS grouping");
    }

    private static void AppendGroupOrder(StringBuilder sql, List<NpgsqlParameter> parameters, QueryGrouping grouping) =>
        AppendGroupRank(sql, parameters, grouping, "grouping.group_key");

    /// <summary>
    /// The groups' order: the caller's named keys first, in its order, then the rest by text, with
    /// "no value" last.
    /// </summary>
    private static void AppendGroupRank(
        StringBuilder sql,
        List<NpgsqlParameter> parameters,
        QueryGrouping grouping,
        string column)
    {
        if (!grouping.Order.IsDefaultOrEmpty)
        {
            if (!parameters.Exists(parameter => parameter.ParameterName == "group_order"))
            {
                parameters.Add(new NpgsqlParameter("group_order", NpgsqlDbType.Array | NpgsqlDbType.Text)
                {
                    Value = grouping.Order.ToArray(),
                });
            }

            sql.Append(CultureInfo.InvariantCulture, $"array_position(@group_order, {column}) ASC NULLS LAST, ");
        }

        sql.Append(CultureInfo.InvariantCulture, $"{column} ASC NULLS LAST");
    }

    private static void AppendOrder(StringBuilder sql, List<NpgsqlParameter> parameters, QueryOrder order)
    {
        if (order.Key is null)
        {
            // Recency: what an unconfigured query view shows. Newest change first, because a
            // smart list with no date rule is a "what moved" list.
            sql.Append("item.last_modified_at DESC, item.id");
            return;
        }

        var direction = order.Descending ? "DESC" : "ASC";

        switch (order.Key)
        {
            case QueryFields.Created:
                sql.Append(CultureInfo.InvariantCulture, $"item.created_at {direction}, item.id");
                return;

            case QueryFields.Modified:
                sql.Append(CultureInfo.InvariantCulture, $"item.last_modified_at {direction}, item.id");
                return;

            case QueryFields.Type:
                sql.Append(CultureInfo.InvariantCulture, $"item.type {direction}, item.id");
                return;
        }

        // NULLS LAST in both directions: a column of blanks at the top tells nobody anything,
        // the same rule the client's own sort applies. Ordering by a property is lexical - a
        // number property sorts as text, which the contract states rather than hides.
        if (order.IsDay && string.Equals(order.Key, ReservedDueDateKey, StringComparison.Ordinal))
        {
            // The generated column. Ascending is the order the starters want and the one the
            // index serves (the sort node disappears only that way); a descending day order is
            // still correct, it simply sorts.
            sql.Append(CultureInfo.InvariantCulture, $"item.due_day {direction} NULLS LAST, item.id");
        }
        else if (order.IsDay)
        {
            sql.Append(CultureInfo.InvariantCulture, $"left(item.properties ->> @{Text("order_key", order.Key, parameters)}, 10) {direction} NULLS LAST, item.id");
        }
        else
        {
            sql.Append(CultureInfo.InvariantCulture, $"item.properties ->> @{Text("order_key", order.Key, parameters)} {direction} NULLS LAST, item.id");
        }
    }

    private static string Text(string name, string value, List<NpgsqlParameter> parameters)
    {
        // A key read by several fragments of one rule is bound once; the same name always carries
        // the same value, because names are generated from the rule's position.
        if (!parameters.Exists(parameter => parameter.ParameterName == name))
        {
            parameters.Add(new NpgsqlParameter(name, NpgsqlDbType.Text) { Value = value });
        }

        return name;
    }

    private static string Day(string name, string value, DateOnly today, List<NpgsqlParameter> parameters)
    {
        var day = QueryOperators.ResolveDay(value, today)
            ?? throw new InvalidOperationException(
                $"'{value}' is not a day. The handler re-validates rules before running them, so "
                + "reaching here is a bug rather than an input.");
        return Text(name, Iso(day), parameters);
    }

    private static string Iso(DateOnly day) =>
        day.ToString("yyyy-MM-dd", CultureInfo.InvariantCulture);
}

/// <summary>A compiled statement and the rule parameters it binds.</summary>
/// <param name="Sql">The statement text.</param>
/// <param name="Parameters">The rule and ordering parameters; the caller adds the fixed ones.</param>
public sealed record CompiledQuery(string Sql, IReadOnlyList<NpgsqlParameter> Parameters);
