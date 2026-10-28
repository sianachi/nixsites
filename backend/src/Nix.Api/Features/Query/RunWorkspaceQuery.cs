using System.Collections.Immutable;
using System.Globalization;
using Nix.Abstractions;
using Nix.Domain.Items;
using Nix.Domain.Primitives;
using Nix.Domain.Query;
using Nix.Domain.Tenancy;
using Nix.Domain.Views;
using Nix.Features.Items;
using Nix.Messaging;

namespace Nix.Features.Query;

/// <summary>What an ad-hoc query asks, shared by its row and aggregate forms.</summary>
/// <param name="WorkspaceId">The one workspace to look in; the caller must be able to read it.</param>
/// <param name="ScopeParentId">A container to look beneath, or null for the whole workspace.</param>
/// <param name="Descendants">Everything beneath the container (true) or its direct children only.</param>
/// <param name="Preset">A shipped smart list's rules to start from, or null.</param>
/// <param name="Filters">The caller's rules, ANDed with the preset's.</param>
/// <param name="SortProperty">The order's key, or null for the default order.</param>
/// <param name="SortDescending">Which way.</param>
/// <param name="GroupBy">The grouping key, or null.</param>
/// <param name="GroupOrder">The caller's group order.</param>
/// <param name="Today">The caller's own day, <c>yyyy-MM-dd</c>, or null when no rule needs it.</param>
public sealed record WorkspaceQueryInput(
    WorkspaceId WorkspaceId,
    ItemId? ScopeParentId,
    bool Descendants,
    string? Preset,
    ImmutableArray<FilterRule> Filters,
    string? SortProperty,
    bool SortDescending,
    string? GroupBy,
    ImmutableArray<string> GroupOrder,
    string? Today);

/// <summary>Runs an ad-hoc query over one workspace and returns its rows.</summary>
/// <param name="Input">What to match, order and group.</param>
/// <param name="Limit">The most rows wanted; null for the default.</param>
/// <remarks>
/// <b>The rules come from the caller, the reach does not.</b> Unlike <see cref="RunItemQuery"/>,
/// whose rules are stored, these are sent - so the security argument is not that a writer chose
/// them but that they can only narrow: the statement is limited to the one workspace the caller
/// named and may read, every row passes the same permission, lifecycle and lock filters an item
/// read would, and a row projects nothing the caller could not read item by item.
/// </remarks>
public sealed record RunWorkspaceQuery(WorkspaceQueryInput Input, int? Limit)
    : IQuery<Result<WorkspaceQueryResults>>;

/// <summary>Runs the same match as <see cref="RunWorkspaceQuery"/> and folds it.</summary>
/// <param name="Input">What to match and group.</param>
/// <param name="Function">One of <see cref="QueryAggregateFunctions"/>.</param>
/// <param name="Property">The numeric property folded; null for a count.</param>
public sealed record AggregateWorkspaceQuery(WorkspaceQueryInput Input, string Function, string? Property)
    : IQuery<Result<WorkspaceAggregateResults>>;

/// <summary>What an ad-hoc query answered.</summary>
/// <param name="Results">The rows, their groups and the truncation flag.</param>
/// <param name="Today">The day the tokens resolved to, or null when none was sent.</param>
/// <param name="Limit">The ceiling applied.</param>
/// <param name="GroupBy">The grouping applied, or null.</param>
public sealed record WorkspaceQueryResults(QueryResults Results, string? Today, int Limit, string? GroupBy);

/// <summary>What an ad-hoc aggregate answered.</summary>
/// <param name="Results">The groups and totals.</param>
/// <param name="Today">The day the tokens resolved to, or null when none was sent.</param>
/// <param name="Function">The fold.</param>
/// <param name="Property">The property folded, or null.</param>
/// <param name="GroupBy">The grouping applied, or null.</param>
public sealed record WorkspaceAggregateResults(
    QueryAggregateResults Results,
    string? Today,
    string Function,
    string? Property,
    string? GroupBy);

/// <summary>The shipped smart lists' rules, as the ad-hoc query accepts them by name.</summary>
/// <remarks>
/// The same rules <c>SMART_LISTS</c> in <c>@nix/structure-spec</c> stores on a smart list, so a
/// preset asked for here and a smart list applied in the web match the same rows. A test holds
/// the two tables to each other.
/// </remarks>
public static class QueryPresets
{
    /// <summary>Every preset, by name.</summary>
    public static readonly ImmutableDictionary<string, ImmutableArray<FilterRule>> All =
        new Dictionary<string, ImmutableArray<FilterRule>>(StringComparer.Ordinal)
        {
            ["today"] = [new("due_date", QueryOperators.On, QueryOperators.Today)],
            ["next-seven-days"] = [new("due_date", QueryOperators.WithinNext, "7")],
            ["overdue"] =
            [
                new("due_date", QueryOperators.Before, QueryOperators.Today),
                new("completion", QueryOperators.NotEqualTo, "true"),
            ],
            ["assigned-to-me"] = [new("assignee", QueryOperators.EqualTo, QueryOperators.Me)],
        }.ToImmutableDictionary(StringComparer.Ordinal);
}

/// <summary>Handles both forms of the ad-hoc workspace query.</summary>
/// <param name="session">The acting principal, resolving <c>me</c>; never the client.</param>
public sealed class WorkspaceQueryHandler(
    IItemTree tree,
    IPermissionResolver permissions,
    IItemQuery query,
    INixSessionContextAccessor session,
    IItemLocks locks,
    IPrincipalPreferencesStore preferences,
    QueryConcurrencyLimiter concurrency)
    :
    IQueryHandler<RunWorkspaceQuery, Result<WorkspaceQueryResults>>,
    IQueryHandler<AggregateWorkspaceQuery, Result<WorkspaceAggregateResults>>
{
    /// <summary>The rows returned when the caller names no limit.</summary>
    public const int DefaultLimit = 100;

    /// <summary>The most rows one run returns - the saved query's own ceiling.</summary>
    public const int MaximumResults = RunItemQueryHandler.MaximumResults;

    /// <summary>The most groups an aggregate returns - the chart's own bucket ceiling.</summary>
    public const int MaximumGroups = Nix.Features.Charts.RunItemChartHandler.MaximumBuckets;

    /// <summary>The most keys a caller's group order may name.</summary>
    public const int MaximumGroupOrder = 100;

    /// <summary>The longest sort or group key accepted, the rule grammar's own key bound.</summary>
    private const int MaximumKeyLength = QueryOperators.MaximumPropertyLength;

    private readonly IItemQuery _query = query;
    private readonly INixSessionContextAccessor _session = session;

    /// <summary>Runs the query.</summary>
    /// <param name="query">What to run.</param>
    /// <param name="cancellationToken">Cancels the read.</param>
    /// <returns>The rows, or why the query was refused.</returns>
    public async ValueTask<Result<WorkspaceQueryResults>> HandleAsync(
        RunWorkspaceQuery query,
        CancellationToken cancellationToken)
    {
        ArgumentNullException.ThrowIfNull(query);

        var prepared = await PrepareAsync(query.Input, cancellationToken).ConfigureAwait(false);
        if (prepared.IsFailure)
        {
            return Result.Failure<WorkspaceQueryResults>(prepared.Error);
        }

        // A ceiling rather than a rejection, the listing's own rule: a caller asking for more gets
        // a working answer and a truncation flag, not a 400 telling it to ask more politely.
        var limit = Math.Clamp(query.Limit ?? DefaultLimit, 1, MaximumResults);

        using var lease = concurrency.TryEnter(prepared.Value.Caller);
        if (lease is null)
        {
            return Result.Failure<WorkspaceQueryResults>(TooMany());
        }

        QueryResults results;
        try
        {
            results = await _query
                .RunAsync(prepared.Value.Spec, [query.Input.WorkspaceId], limit, cancellationToken)
                .ConfigureAwait(false);
        }
        catch (ItemQueryFailedException failure)
        {
            return Result.Failure<WorkspaceQueryResults>(QueryErrors.From(failure));
        }

        return Result.Success(new WorkspaceQueryResults(
            results,
            prepared.Value.Today,
            limit,
            prepared.Value.Spec.Grouping?.Key));
    }

    /// <summary>Runs the aggregate.</summary>
    /// <param name="query">What to fold.</param>
    /// <param name="cancellationToken">Cancels the read.</param>
    /// <returns>The groups and totals, or why the aggregate was refused.</returns>
    public async ValueTask<Result<WorkspaceAggregateResults>> HandleAsync(
        AggregateWorkspaceQuery query,
        CancellationToken cancellationToken)
    {
        ArgumentNullException.ThrowIfNull(query);

        if (RefuseAggregate(query.Function, query.Property) is { } refusal)
        {
            return Result.Failure<WorkspaceAggregateResults>(QueryErrors.InvalidRequest(refusal));
        }

        var prepared = await PrepareAsync(query.Input, cancellationToken).ConfigureAwait(false);
        if (prepared.IsFailure)
        {
            return Result.Failure<WorkspaceAggregateResults>(prepared.Error);
        }

        var property = string.IsNullOrEmpty(query.Property) ? null : query.Property;

        using var lease = concurrency.TryEnter(prepared.Value.Caller);
        if (lease is null)
        {
            return Result.Failure<WorkspaceAggregateResults>(TooMany());
        }

        QueryAggregateResults results;
        try
        {
            results = await _query
                .AggregateAsync(
                    prepared.Value.Spec,
                    new QueryAggregate(query.Function, property),
                    [query.Input.WorkspaceId],
                    MaximumGroups,
                    cancellationToken)
                .ConfigureAwait(false);
        }
        catch (ItemQueryFailedException failure)
        {
            return Result.Failure<WorkspaceAggregateResults>(QueryErrors.From(failure));
        }

        return Result.Success(new WorkspaceAggregateResults(
            results,
            prepared.Value.Today,
            query.Function,
            property,
            prepared.Value.Spec.Grouping?.Key));
    }

    /// <summary>
    /// The sentence refusing an aggregate's function and property, or null.
    /// </summary>
    private static NixError TooMany() =>
        QueryErrors.TooManyInFlight(
            $"At most {QueryConcurrencyLimiter.MaximumInFlight} queries may run at once for one person; wait for one to finish.");

    private static string? RefuseAggregate(string function, string? property)
    {
        if (!QueryAggregateFunctions.All.Contains(function))
        {
            return $"'{function}' is not an aggregate; use {string.Join(", ", QueryAggregateFunctions.All)}";
        }

        var hasProperty = !string.IsNullOrEmpty(property);
        if (function == QueryAggregateFunctions.Count)
        {
            // A count takes no property: one named would be a second meaning ("count the rows with
            // a value") the fold silently ignores.
            return hasProperty ? $"'{QueryAggregateFunctions.Count}' counts rows and takes no property" : null;
        }

        if (!hasProperty)
        {
            return $"'{function}' folds a numeric property; name one";
        }

        if (property!.Length > MaximumKeyLength)
        {
            return $"a property key may be at most {MaximumKeyLength} characters";
        }

        return QueryFields.IsReserved(property)
            ? $"'{property}' is a structural field, not a numeric property"
            : null;
    }

    /// <summary>
    /// Everything both forms check and resolve before the statement: the request's grammar first
    /// (a pure function of what was sent, so it discloses nothing), then the workspace and the
    /// scope container (each refused exactly as their own reads refuse them), then the caller.
    /// </summary>
    private async ValueTask<Result<Prepared>> PrepareAsync(
        WorkspaceQueryInput input,
        CancellationToken cancellationToken)
    {
        ImmutableArray<FilterRule> presetRules = [];
        if (input.Preset is { } preset)
        {
            if (!QueryPresets.All.TryGetValue(preset, out presetRules))
            {
                return Refused($"'{preset}' is not a preset; use {string.Join(", ", QueryPresets.All.Keys.Order(StringComparer.Ordinal))}");
            }
        }

        var filters = input.Filters.IsDefault ? [] : input.Filters;
        var rules = presetRules.AddRange(filters);

        if (QueryEvaluation.Refuse(rules) is { } reason)
        {
            return Refused(reason);
        }

        DateOnly today = default;
        string? todayText = null;
        if (input.Today is { } sentToday)
        {
            if (!QueryEvaluation.TryParseToday(sentToday, out today))
            {
                return Result.Failure<Prepared>(QueryErrors.InvalidToday(QueryEvaluation.TodayRefusal(sentToday)));
            }

            todayText = today.ToString("yyyy-MM-dd", CultureInfo.InvariantCulture);
        }
        else if (QueryEvaluation.NeedsToday(rules))
        {
            // Never the server's clock: only the caller's zone decides which day "today" is.
            return Result.Failure<Prepared>(
                QueryErrors.InvalidToday("These rules read days relative to today; send today as yyyy-MM-dd."));
        }

        QueryOrder? explicitOrder = null;
        if (input.SortProperty is { } sort)
        {
            if (RefuseKey(sort, QueryFields.Sortable, "sort by") is { } sortReason)
            {
                return Refused(sortReason);
            }

            // Day order only for the reserved due date, whose generated column is a day; any
            // other key is compared as text, which orders yyyy-MM-dd values correctly anyway.
            explicitOrder = new QueryOrder(sort, IsDay: string.Equals(sort, "due_date", StringComparison.Ordinal), input.SortDescending);
        }

        QueryGrouping? grouping = null;
        if (input.GroupBy is { } groupBy)
        {
            if (RefuseKey(groupBy, QueryFields.Groupable, "group by") is { } groupReason)
            {
                return Refused(groupReason);
            }

            var order = input.GroupOrder.IsDefault ? [] : input.GroupOrder;
            if (order.Length > MaximumGroupOrder)
            {
                return Refused($"a group order may name at most {MaximumGroupOrder} groups");
            }

            if (order.Any(key => key.Length > MaximumKeyLength))
            {
                return Refused($"a group key in an order may be at most {MaximumKeyLength} characters");
            }

            grouping = new QueryGrouping(groupBy, order);
        }

        // Loud rather than guessed, for the reason RunItemQueryHandler gives.
        var caller = _session.Current
            ?? throw new InvalidOperationException(
                "No session context has been established for this unit of work. Resolving the "
                + "'me' token needs an acting principal, and there is no anonymous path to this "
                + "query.");

        // Existence and permission answer with the same failure, the listing's rule: a workspace
        // the caller may not read must not be distinguishable from one that does not exist.
        if (!await tree.WorkspaceExistsAsync(input.WorkspaceId, cancellationToken).ConfigureAwait(false)
            || !await permissions.CanReadWorkspaceAsync(input.WorkspaceId, cancellationToken).ConfigureAwait(false))
        {
            return Result.Failure<Prepared>(
                ItemErrors.WorkspaceNotFound($"No workspace {input.WorkspaceId} is visible."));
        }

        QueryScope? scope = null;
        if (input.ScopeParentId is { } parentId)
        {
            // The item read's own refusal, word for word: a container that does not exist, one in
            // a workspace the caller cannot read, and one in another workspace than the one named
            // are all "not visible", so the scope cannot be used to probe for any of them.
            var parent = await tree.FindAsync(parentId, cancellationToken).ConfigureAwait(false);
            if (parent is null || parent.WorkspaceId != input.WorkspaceId)
            {
                return Result.Failure<Prepared>(ItemErrors.NotFound($"No item {parentId} is visible."));
            }

            // A lock covers the subtree, the children list's rule: refused rather than answered
            // empty, because an empty answer would read as "nothing in here".
            if (!await locks.MayReadBodyAsync(parentId, cancellationToken).ConfigureAwait(false))
            {
                return Result.Failure<Prepared>(
                    ItemErrors.Locked($"Item {parentId} is locked. Unlock it to see what is inside."));
            }

            scope = new QueryScope(parentId, input.Descendants);
        }

        var resolved = QueryEvaluation.ResolveCaller(rules, caller.PrincipalId.ToString());
        var spec = new QuerySpec(resolved, QueryEvaluation.ResolveOrder(resolved, explicitOrder, null), today)
        {
            Scope = scope,
            Grouping = grouping,
            Zone = await QueryEvaluation.ZoneAsync(resolved, preferences, caller, cancellationToken).ConfigureAwait(false),
        };

        return Result.Success(new Prepared(spec, todayText, caller.PrincipalId));
    }

    /// <summary>The sentence refusing a sort or group key, or null.</summary>
    private static string? RefuseKey(string key, ImmutableArray<string> structural, string verb)
    {
        if (key.Length == 0)
        {
            return $"name a property to {verb}";
        }

        if (key.Length > MaximumKeyLength)
        {
            return $"a property key may be at most {MaximumKeyLength} characters";
        }

        return QueryFields.IsReserved(key) && !structural.Contains(key)
            ? $"a query can {verb} a property key or {string.Join(", ", structural)}, not '{key}'"
            : null;
    }

    private static Result<Prepared> Refused(string reason) =>
        Result.Failure<Prepared>(QueryErrors.InvalidRequest(reason));

    /// <summary>A checked request, ready to run.</summary>
    private sealed record Prepared(QuerySpec Spec, string? Today, Nix.Domain.Identity.PrincipalId Caller);
}
