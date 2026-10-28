using Microsoft.AspNetCore.Http.HttpResults;
using Microsoft.AspNetCore.Mvc;
using Nix.Abstractions;
using Nix.Domain.Graph;
using Nix.Domain.Primitives;
using Nix.Domain.Tenancy;
using Nix.Messaging;

namespace Nix.Features.Graph;

/// <summary>Reads a workspace as a graph.</summary>
/// <param name="WorkspaceId">The workspace to draw.</param>
public sealed record GetWorkspaceGraph(WorkspaceId WorkspaceId) : IQuery<Result<WorkspaceGraphResults>>;

/// <summary>What a graph read found, and the ceilings it was read under.</summary>
/// <param name="Graph">The nodes and the edges between them.</param>
/// <param name="NodeLimit">The node ceiling that was applied.</param>
/// <param name="LinkLimit">The link ceiling that was applied.</param>
public sealed record WorkspaceGraphResults(WorkspaceGraph Graph, int NodeLimit, int LinkLimit)
{
    /// <summary>Whether the node ceiling was reached.</summary>
    public bool NodesTruncated => Graph.Nodes.Count >= NodeLimit;

    /// <summary>Whether the link ceiling was reached.</summary>
    public bool LinksTruncated => Graph.Links.Count >= LinkLimit;
}

/// <summary>
/// Reads the items of one workspace and the reference edges between them.
/// </summary>
/// <remarks>
/// <para>
/// <b>One permission answer, used twice, and the second use is the one that matters.</b> The caller
/// must be able to read the workspace they named - otherwise this answers "an empty graph", which
/// for a workspace identifier they guessed is still a statement about a workspace they may not see.
/// And the readable set goes on into the query, so the rows are filtered while they are being
/// chosen rather than after they have been read. Both come from one call, so the gate and the
/// filter cannot drift apart.
/// </para>
/// <para>
/// A workspace the caller may not read is reported as not found, matching every other read in the
/// product. "You may not see this" confirms the thing exists.
/// </para>
/// <para>
/// <b>The ceilings are the server's, not the client's.</b> There is no <c>limit</c> parameter, and
/// that is deliberate: a graph is drawn whole or it misleads, so the useful thing to publish is one
/// bound everybody gets and a flag saying whether it was hit - not a knob a caller can turn up
/// until the response is a denial of service they served themselves.
/// </para>
/// </remarks>
public sealed class GetWorkspaceGraphHandler(
    IWorkspaceGraph graph,
    IPermissionResolver permissions)
    : IQueryHandler<GetWorkspaceGraph, Result<WorkspaceGraphResults>>
{
    /// <summary>
    /// The most nodes one graph read may return.
    /// </summary>
    /// <remarks>
    /// Two thousand, chosen against what a graph can honestly show rather than against what the
    /// database can return. A force-directed drawing stops being readable somewhere in the low
    /// thousands - past that the labels overlap into a grey mat and the layout costs more than the
    /// fetch - so a higher ceiling would buy a slower response nobody can read. It also bounds the
    /// payload: two thousand nodes of identifier, parent, type and title is a couple of hundred
    /// kilobytes of JSON, and the lists behind them stay inside the per-request allocation budget.
    /// </remarks>
    public const int MaximumNodes = 2_000;

    /// <summary>
    /// The most links one graph read may return.
    /// </summary>
    /// <remarks>
    /// Twice the node ceiling. A workspace of documents that reference each other averages well
    /// under two outbound references per document, so this is slack rather than a limit in ordinary
    /// use - and a read that reaches it is telling the client the graph is denser than it can draw,
    /// which is exactly what the truncation flag is for.
    /// </remarks>
    public const int MaximumLinks = 4_000;

    private readonly IWorkspaceGraph _graph = graph;

    /// <summary>Reads the graph.</summary>
    /// <param name="query">The workspace to draw.</param>
    /// <param name="cancellationToken">Cancels the read.</param>
    /// <returns>The graph, or why it could not be read.</returns>
    public async ValueTask<Result<WorkspaceGraphResults>> HandleAsync(
        GetWorkspaceGraph query,
        CancellationToken cancellationToken)
    {
        ArgumentNullException.ThrowIfNull(query);

        var workspaces = await permissions
            .ReadableWorkspacesAsync(cancellationToken)
            .ConfigureAwait(false);

        if (!workspaces.Contains(query.WorkspaceId))
        {
            return Result.Failure<WorkspaceGraphResults>(
                GraphErrors.WorkspaceNotFound($"No workspace {query.WorkspaceId} is visible."));
        }

        var graph = await _graph
            .ReadAsync(query.WorkspaceId, workspaces, MaximumNodes, MaximumLinks, cancellationToken)
            .ConfigureAwait(false);

        return Result.Success(new WorkspaceGraphResults(graph, MaximumNodes, MaximumLinks));
    }
}

/// <summary>
/// Route handler for reading a workspace's graph.
/// </summary>
internal static class GetWorkspaceGraphEndpoint
{
    /// <summary>Handles a graph request.</summary>
    /// <param name="workspaceId">The workspace to draw.</param>
    /// <param name="httpContext">The current request.</param>
    /// <param name="dispatcher">Sends the query to its handler.</param>
    /// <returns>The graph.</returns>
    internal static async Task<Results<Ok<WorkspaceGraphResponse>, ProblemHttpResult>> Handle(
        Guid workspaceId,
        HttpContext httpContext,
        [FromServices] NixDispatcher dispatcher)
    {
        var result = await dispatcher
            .QueryAsync<GetWorkspaceGraph, Result<WorkspaceGraphResults>>(
                new GetWorkspaceGraph(WorkspaceId.From(workspaceId)),
                httpContext.RequestAborted)
            .ConfigureAwait(false);

        if (result.IsFailure)
        {
            return TypedResults.Problem(GraphEndpoints.Problem(httpContext, result.Error));
        }

        var found = result.Value;
        return TypedResults.Ok(new WorkspaceGraphResponse(
            workspaceId,
            GraphMapping.ToNodeResponses(found.Graph.Nodes),
            GraphMapping.ToLinkResponses(found.Graph.Links),
            found.NodeLimit,
            found.LinkLimit,
            found.NodesTruncated,
            found.LinksTruncated));
    }
}
