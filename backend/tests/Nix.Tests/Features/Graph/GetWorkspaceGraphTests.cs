using Nix.Abstractions;
using Nix.Domain.Graph;
using Nix.Domain.Items;
using Nix.Domain.Primitives;
using Nix.Domain.Tenancy;
using Nix.Features.Graph;

namespace Nix.Tests.Features.Graph;

/// <summary>
/// What the workspace graph use case does before, during and after it asks for rows.
/// </summary>
/// <remarks>
/// <para>
/// A graph read is bulk disclosure - the title and the parent of everything at once - so the
/// assertions worth writing here are the ones about the handler's relationship with the permission
/// resolver, not about the shape of the payload. The two that matter: a workspace the caller may
/// not read never reaches the reader at all, and the readable set the resolver produced is the
/// exact set handed into the query, so the filter cannot be a pass over the results.
/// </para>
/// <para>
/// Rows are proven against real Postgres in <c>Nix.Integration.Tests</c>, with two tenants and a
/// workspace the caller is not a member of. This suite stays free of Testcontainers, so the reader
/// is a fake that records what it was asked.
/// </para>
/// </remarks>
public sealed class GetWorkspaceGraphTests
{
    private static readonly WorkspaceId Readable = WorkspaceId.From(new Guid("11111111-1111-4111-8111-111111111111"));
    private static readonly WorkspaceId AlsoReadable = WorkspaceId.From(new Guid("22222222-2222-4222-8222-222222222222"));
    private static readonly WorkspaceId Refused = WorkspaceId.From(new Guid("33333333-3333-4333-8333-333333333333"));

    private static CancellationToken Cancellation => TestContext.Current.CancellationToken;

    [Fact]
    public async Task A_workspace_the_caller_may_not_read_is_reported_as_not_found()
    {
        var reader = new RecordingGraphReader(WorkspaceGraph.Empty);
        var handler = new GetWorkspaceGraphHandler(reader, new StubPermissions([Readable]));

        var result = await handler.HandleAsync(new GetWorkspaceGraph(Refused), Cancellation);

        // Not an empty graph, which for a workspace identifier somebody guessed is still a
        // statement about a workspace they may not see.
        Assert.True(result.IsFailure);
        Assert.Equal("workspaces.not_found", result.Error.Code);
    }

    [Fact]
    public async Task A_refused_workspace_is_never_queried_for_rows()
    {
        var reader = new RecordingGraphReader(WorkspaceGraph.Empty);
        var handler = new GetWorkspaceGraphHandler(reader, new StubPermissions([Readable]));

        await handler.HandleAsync(new GetWorkspaceGraph(Refused), Cancellation);

        // The refusal has to happen before the read, not after it. A handler that queried and then
        // discarded would pass every assertion a caller can make and would still have read the
        // titles of a workspace it had no entitlement to.
        Assert.Equal(0, reader.Calls);
    }

    [Fact]
    public async Task The_readable_workspaces_the_resolver_returned_are_handed_into_the_query()
    {
        var reader = new RecordingGraphReader(WorkspaceGraph.Empty);
        var handler = new GetWorkspaceGraphHandler(reader, new StubPermissions([Readable, AlsoReadable]));

        var result = await handler.HandleAsync(new GetWorkspaceGraph(Readable), Cancellation);

        Assert.True(result.IsSuccess);

        // This is the whole security property, expressed at the seam a unit test can see it: the
        // set the single authorization code path produced is the set the query filters with. A
        // handler that passed only the requested workspace would look identical today and would be
        // resolving permissions for itself the moment entitlement stops being per workspace.
        Assert.Equal(Readable, reader.LastWorkspaceId);
        Assert.Equal<IReadOnlyList<WorkspaceId>>([Readable, AlsoReadable], reader.LastReadableWorkspaces);
    }

    [Fact]
    public async Task The_query_is_bounded_by_the_ceilings_the_contract_publishes()
    {
        var reader = new RecordingGraphReader(WorkspaceGraph.Empty);
        var handler = new GetWorkspaceGraphHandler(reader, new StubPermissions([Readable]));

        await handler.HandleAsync(new GetWorkspaceGraph(Readable), Cancellation);

        Assert.Equal(GetWorkspaceGraphHandler.MaximumNodes, reader.LastNodeLimit);
        Assert.Equal(GetWorkspaceGraphHandler.MaximumLinks, reader.LastLinkLimit);
    }

    [Fact]
    public async Task A_graph_that_fits_under_both_ceilings_reports_itself_whole()
    {
        var graph = new WorkspaceGraph([Node("a"), Node("b")], [Link("a", "b")]);
        var handler = new GetWorkspaceGraphHandler(
            new RecordingGraphReader(graph),
            new StubPermissions([Readable]));

        var result = await handler.HandleAsync(new GetWorkspaceGraph(Readable), Cancellation);

        Assert.True(result.IsSuccess);
        Assert.False(result.Value.NodesTruncated);
        Assert.False(result.Value.LinksTruncated);
    }

    [Fact]
    public async Task A_graph_that_fills_the_node_ceiling_says_so()
    {
        // A truncated list looks short. A truncated graph looks like a graph, and a reader would
        // conclude two clusters are unconnected - a wrong answer rather than a missing one. The
        // flag is the only thing standing between the drawing and that conclusion.
        var nodes = new List<GraphNode>(GetWorkspaceGraphHandler.MaximumNodes);
        for (var index = 0; index < GetWorkspaceGraphHandler.MaximumNodes; index++)
        {
            nodes.Add(Node(index.ToString(System.Globalization.CultureInfo.InvariantCulture)));
        }

        var handler = new GetWorkspaceGraphHandler(
            new RecordingGraphReader(new WorkspaceGraph(nodes, [])),
            new StubPermissions([Readable]));

        var result = await handler.HandleAsync(new GetWorkspaceGraph(Readable), Cancellation);

        Assert.True(result.IsSuccess);
        Assert.True(result.Value.NodesTruncated);
        Assert.False(result.Value.LinksTruncated);
    }

    [Fact]
    public async Task A_graph_that_fills_the_link_ceiling_says_so_independently_of_its_nodes()
    {
        var links = new List<GraphLink>(GetWorkspaceGraphHandler.MaximumLinks);
        for (var index = 0; index < GetWorkspaceGraphHandler.MaximumLinks; index++)
        {
            links.Add(Link("a", index.ToString(System.Globalization.CultureInfo.InvariantCulture)));
        }

        var handler = new GetWorkspaceGraphHandler(
            new RecordingGraphReader(new WorkspaceGraph([Node("a")], links)),
            new StubPermissions([Readable]));

        var result = await handler.HandleAsync(new GetWorkspaceGraph(Readable), Cancellation);

        Assert.True(result.IsSuccess);
        Assert.False(result.Value.NodesTruncated);
        Assert.True(result.Value.LinksTruncated);
    }

    [Fact]
    public async Task A_principal_who_may_read_nothing_reaches_no_workspace_at_all()
    {
        var reader = new RecordingGraphReader(WorkspaceGraph.Empty);
        var handler = new GetWorkspaceGraphHandler(reader, new StubPermissions([]));

        var result = await handler.HandleAsync(new GetWorkspaceGraph(Readable), Cancellation);

        Assert.True(result.IsFailure);
        Assert.Equal(0, reader.Calls);
    }

    [Fact]
    public void A_workspace_refused_here_carries_the_code_the_workspaces_feature_publishes()
    {
        // Asking for a workspace's graph is asking for a workspace. A client that already handles
        // "that workspace is not visible" must not need a second branch because the fact arrived
        // through a different route.
        Assert.Equal("workspaces.not_found", GraphErrors.WorkspaceNotFound("why").Code);
    }

    private static GraphNode Node(string seed) =>
        new(ItemId.From(Deterministic(seed)), null, "note", seed, DateTimeOffset.UnixEpoch, DateTimeOffset.UnixEpoch);

    private static GraphLink Link(string source, string target) =>
        new(ItemId.From(Deterministic(source)), ItemId.From(Deterministic(target)), 1);

    /// <summary>An identifier that is the same every run, so a failure is reproducible.</summary>
    private static Guid Deterministic(string seed)
    {
        var bytes = new byte[16];
        var hash = seed.GetHashCode(StringComparison.Ordinal);
        BitConverter.TryWriteBytes(bytes, hash);
        return new Guid(bytes);
    }

    /// <summary>Answers with a fixed readable set, the way the resolver does for one principal.</summary>
    private sealed class StubPermissions : IPermissionResolver
    {
        private readonly IReadOnlyList<WorkspaceId> _readable;

        internal StubPermissions(IReadOnlyList<WorkspaceId> readable) => _readable = readable;

        public ValueTask<bool> CanReadWorkspaceAsync(WorkspaceId workspaceId, CancellationToken cancellationToken) =>
            ValueTask.FromResult(_readable.Contains(workspaceId));

        public ValueTask<bool> CanWriteWorkspaceAsync(WorkspaceId workspaceId, CancellationToken cancellationToken) =>
            ValueTask.FromResult(_readable.Contains(workspaceId));

        public ValueTask<bool> CanCommentWorkspaceAsync(WorkspaceId workspaceId, CancellationToken cancellationToken) => ValueTask.FromResult(false);


        public ValueTask<bool> CanManageWorkspaceAsync(WorkspaceId workspaceId, CancellationToken cancellationToken) =>
            ValueTask.FromResult(false);

        public ValueTask<IReadOnlyList<WorkspaceId>> ReadableWorkspacesAsync(CancellationToken cancellationToken) =>
            ValueTask.FromResult(_readable);

        public ValueTask<bool> IsTenantAdministratorAsync(CancellationToken cancellationToken) =>
            ValueTask.FromResult(false);
    }

    /// <summary>
    /// A reader that returns a prepared graph and remembers what it was asked for.
    /// </summary>
    /// <remarks>
    /// A fake for an I/O port, which is the sanctioned reason to write one. It asserts nothing by
    /// itself: the tests read what it recorded, so a failure names the argument that was wrong
    /// rather than the fake.
    /// </remarks>
    private sealed class RecordingGraphReader : IWorkspaceGraph
    {
        private readonly WorkspaceGraph _graph;

        internal RecordingGraphReader(WorkspaceGraph graph) => _graph = graph;

        internal int Calls { get; private set; }

        internal WorkspaceId LastWorkspaceId { get; private set; }

        internal IReadOnlyList<WorkspaceId> LastReadableWorkspaces { get; private set; } = [];

        internal int LastNodeLimit { get; private set; }

        internal int LastLinkLimit { get; private set; }

        public ValueTask<WorkspaceGraph> ReadAsync(
            WorkspaceId workspaceId,
            IReadOnlyList<WorkspaceId> readableWorkspaces,
            int nodeLimit,
            int linkLimit,
            CancellationToken cancellationToken)
        {
            Calls++;
            LastWorkspaceId = workspaceId;
            LastReadableWorkspaces = readableWorkspaces;
            LastNodeLimit = nodeLimit;
            LastLinkLimit = linkLimit;

            return ValueTask.FromResult(_graph);
        }
    }
}
