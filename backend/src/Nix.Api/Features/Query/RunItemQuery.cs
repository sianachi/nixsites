using System.Collections.Immutable;
using System.Globalization;
using Microsoft.AspNetCore.Http.HttpResults;
using Microsoft.AspNetCore.Mvc;
using Nix.Abstractions;
using Nix.Domain.Items;
using Nix.Domain.Primitives;
using Nix.Domain.Query;
using Nix.Domain.Views;
using Nix.Features.Items;
using Nix.Messaging;

namespace Nix.Features.Query;

/// <summary>Runs the saved query one of an item's views stores.</summary>
/// <param name="ItemId">The smart list - the item whose view holds the rules.</param>
/// <param name="ViewId">Which of its views to run.</param>
/// <param name="Today">
/// The caller's own today, <c>yyyy-MM-dd</c>. Sent on every read because only the caller's zone
/// decides which day it is, and a saved query stores the rule (<c>today</c>) rather than a date.
/// </param>
/// <remarks>
/// <b>The client names the view; it never sends rules here.</b> The stored view is the whole
/// query. Sending rules is the ad-hoc workspace query's job (<c>RunWorkspaceQuery</c>),
/// which runs the same rules through the same evaluator and statement but over one workspace the
/// caller names; it projects nothing the caller could not read item by item, which is the
/// argument ADR-0060 records for accepting rules from any reader.
/// </remarks>
public sealed record RunItemQuery(ItemId ItemId, string ViewId, string Today)
    : IQuery<Result<ItemQueryResults>>;

/// <summary>What a run answered, with what it was asked echoed for the response.</summary>
/// <param name="Results">The matches and the truncation flag.</param>
/// <param name="ViewId">The view that ran.</param>
/// <param name="Today">The day the <c>today</c> token resolved to.</param>
/// <param name="Limit">The ceiling the run applied.</param>
public sealed record ItemQueryResults(QueryResults Results, string ViewId, string Today, int Limit);

/// <summary>Handles <see cref="RunItemQuery"/>.</summary>
/// <param name="session">
/// The acting principal, used to resolve the <see cref="QueryOperators.Me"/> token. Never the
/// client - see <see cref="QueryOperators.Me"/> for why that would defeat the check.
/// </param>
public sealed class RunItemQueryHandler(
    IItemTree tree,
    IPermissionResolver permissions,
    IItemQuery query,
    INixSessionContextAccessor session,
    IItemLocks locks,
    IPrincipalPreferencesStore preferences)
    : IQueryHandler<RunItemQuery, Result<ItemQueryResults>>
{
    /// <summary>The most rows one run returns.</summary>
    /// <remarks>
    /// A fixed ceiling with a truncation flag rather than a cursor: a cross-container result set
    /// has no stable global order for a cursor to page over, and a smart list past this size is
    /// not a list anyone reads. Goal 3.9 owns 10k-scale and can add keyset paging if measurement
    /// demands it.
    /// </remarks>
    public const int MaximumResults = 500;

    private readonly IItemQuery _query = query;
    private readonly INixSessionContextAccessor _session = session;

    /// <summary>Runs the query.</summary>
    /// <param name="query">The item, the view, and the caller's today.</param>
    /// <param name="cancellationToken">Cancels the read.</param>
    /// <returns>The matches, or why the run was refused.</returns>
    public async ValueTask<Result<ItemQueryResults>> HandleAsync(
        RunItemQuery query,
        CancellationToken cancellationToken)
    {
        ArgumentNullException.ThrowIfNull(query);

        if (!QueryEvaluation.TryParseToday(query.Today, out var today))
        {
            return Result.Failure<ItemQueryResults>(QueryErrors.InvalidToday(QueryEvaluation.TodayRefusal(query.Today)));
        }

        // Loud rather than guessed: there is no anonymous path to this query (every route under
        // /api/v1 is authenticated, Program.cs), so a missing context here is a bug in the
        // pipeline that established the unit of work, not an input this handler can refuse
        // gracefully. Silently skipping the "me" resolution would either match nobody's items or,
        // worse, everybody's - both are the wrong kind of quiet.
        var caller = _session.Current
            ?? throw new InvalidOperationException(
                "No session context has been established for this unit of work. Resolving the "
                + "'me' token needs an acting principal, and there is no anonymous path to this "
                + "query.");

        var item = await tree.FindAsync(query.ItemId, cancellationToken).ConfigureAwait(false);
        if (item is null
            || !await permissions.CanReadWorkspaceAsync(item.WorkspaceId, cancellationToken).ConfigureAwait(false))
        {
            return Result.Failure<ItemQueryResults>(ItemErrors.NotFound($"No item {query.ItemId} is visible."));
        }

        // A lock withholds an item's views along with its body, a saved query among them.
        if (!await locks.MayReadBodyAsync(query.ItemId, cancellationToken).ConfigureAwait(false))
        {
            return Result.Failure<ItemQueryResults>(
                ItemErrors.Locked($"Item {query.ItemId} is locked. Unlock it to run its views."));
        }

        var stored = ViewDefinitionsJson.Read(item.Views);
        ViewDefinition? view = null;
        foreach (var candidate in stored.Views)
        {
            if (string.Equals(candidate.Id, query.ViewId, StringComparison.Ordinal))
            {
                view = candidate;
                break;
            }
        }

        if (view is null)
        {
            return Result.Failure<ItemQueryResults>(
                QueryErrors.ViewNotFound($"This item has no view '{query.ViewId}'."));
        }

        if (view.Kind != ViewKind.Query)
        {
            return Result.Failure<ItemQueryResults>(
                QueryErrors.ViewNotFound($"'{query.ViewId}' is not a query view, so it has nothing to run."));
        }

        // Re-validated at execution, fail-closed: the stored JSON reader is fail-soft per rule,
        // and a dropped rule can only ever WIDEN a query. Refusing to run a set that no longer
        // passes is what keeps that widening from silently disclosing rows the saved query never
        // asked for. The same check the ad-hoc query runs (QueryEvaluation), so a stored rule and
        // a sent one are refused for the same reasons.
        var rules = view.Filters.IsDefaultOrEmpty ? [] : view.Filters;
        if (QueryEvaluation.Refuse(rules) is { } reason)
        {
            return Result.Failure<ItemQueryResults>(
                QueryErrors.InvalidRules(
                    $"A stored filter no longer validates ({reason}), so the query was not "
                    + "run. Edit the view's filters and save them again."));
        }

        // Resolved here, not in the compiler: QuerySql is a static class with no session to read
        // a principal from, and the same argument that keeps "today" client-supplied keeps "me"
        // the opposite - never client-supplied.
        var resolvedRules = QueryEvaluation.ResolveCaller(rules, caller.PrincipalId.ToString());

        // A view's own sort is outranked by a date rule (soonest first), as it always was; it is
        // lexical over the property text, which the published description states.
        var fallback = view.SortBy is { Length: > 0 } sortBy
            ? new QueryOrder(sortBy, IsDay: false, view.SortDescending)
            : null;

        var workspaces = await permissions.ReadableWorkspacesAsync(cancellationToken).ConfigureAwait(false);

        var spec = new QuerySpec(resolvedRules, QueryEvaluation.ResolveOrder(resolvedRules, null, fallback), today)
        {
            ExcludedItemId = query.ItemId,
            Zone = await QueryEvaluation.ZoneAsync(resolvedRules, preferences, caller, cancellationToken).ConfigureAwait(false),
        };

        QueryResults results;
        try
        {
            results = await _query
                .RunAsync(spec, workspaces, MaximumResults, cancellationToken)
                .ConfigureAwait(false);
        }
        catch (ItemQueryFailedException failure)
        {
            return Result.Failure<ItemQueryResults>(QueryErrors.From(failure));
        }

        return Result.Success(new ItemQueryResults(results, view.Id, ToIso(today), MaximumResults));
    }

    private static string ToIso(DateOnly day) => day.ToString("yyyy-MM-dd", CultureInfo.InvariantCulture);
}

/// <summary>
/// Route handler for running a saved query.
/// </summary>
/// <remarks>
/// Named apart from <see cref="RunItemQuery"/> itself, the same disambiguation every feature's
/// endpoint class makes.
/// </remarks>
internal static class RunItemQueryEndpoint
{
    /// <summary>Handles a request to run one of an item's query views.</summary>
    /// <param name="itemId">The smart list.</param>
    /// <param name="view">Which of its views to run.</param>
    /// <param name="today">The caller's own today, yyyy-MM-dd.</param>
    /// <param name="httpContext">The current request.</param>
    /// <param name="dispatcher">Sends the query to its handler.</param>
    /// <returns>The matches, or a problem describing the refusal.</returns>
    internal static async Task<Results<Ok<QueryResultsResponse>, ProblemHttpResult>> Handle(
        Guid itemId,
        [FromQuery] string? view,
        [FromQuery] string? today,
        HttpContext httpContext,
        [FromServices] NixDispatcher dispatcher)
    {
        if (string.IsNullOrEmpty(view))
        {
            return TypedResults.Problem(
                QueryEndpoints.Problem(
                    httpContext,
                    QueryErrors.ViewNotFound("Name the view to run: ?view=<view id>.")));
        }

        if (string.IsNullOrEmpty(today))
        {
            return TypedResults.Problem(
                QueryEndpoints.Problem(
                    httpContext,
                    QueryErrors.InvalidToday("Send the caller's day: ?today=yyyy-MM-dd.")));
        }

        var result = await dispatcher
            .QueryAsync<RunItemQuery, Result<ItemQueryResults>>(
                new RunItemQuery(ItemId.From(itemId), view, today),
                httpContext.RequestAborted)
            .ConfigureAwait(false);

        return result.Match<Results<Ok<QueryResultsResponse>, ProblemHttpResult>>(
            run => TypedResults.Ok(QueryMapping.ToResponse(itemId, run)),
            error => TypedResults.Problem(QueryEndpoints.Problem(httpContext, error)));
    }
}
