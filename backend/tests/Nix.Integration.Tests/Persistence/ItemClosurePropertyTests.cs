using System.Diagnostics.CodeAnalysis;
using Microsoft.EntityFrameworkCore;
using Nix.Abstractions;
using Nix.Domain.Identity;
using Nix.Domain.Items;
using Nix.Domain.Tenancy;
using Nix.Features.Items;
using Nix.Integration.Tests.Harness;
using Nix.Messaging;
using Nix.Persistence.Sql;
using Nix.Persistence.Sql.Statements;
using Npgsql;
using NpgsqlTypes;

namespace Nix.Integration.Tests.Persistence;

/// <summary>
/// The closure table equals a from-scratch recomputation from <c>parent_id</c>, after any sequence
/// of moves.
/// </summary>
/// <remarks>
/// <para>
/// This is the claim that makes <c>item_closure</c> derived data rather than a second source of
/// truth, and it is only worth making if something checks it. Example-based tests cannot: the
/// incremental maintenance is three set operations whose interactions depend on the shape of the
/// tree, and the shapes that break them are exactly the ones nobody thinks to write down - moving
/// a deep subtree under a shallow sibling, moving to the root and back, moving something that has
/// just become someone's only child.
/// </para>
/// <para>
/// So the tree is built and mangled at random, and after every single move the entire closure is
/// compared against one recomputed in memory from the parent pointers alone. A discrepancy of one
/// edge fails the test.
/// </para>
/// <para>
/// <b>Seeded, not arbitrary.</b> Each case runs a fixed seed, so a failure reproduces exactly
/// rather than "sometimes on CI". The seeds are just numbers - add more to widen the search. The
/// authorization goal should bring a proper property-based library with shrinking, where minimising
/// a failing case matters more; here the whole state is dumped on failure and the sequence is
/// short enough to read.
/// </para>
/// </remarks>
[Collection(PostgresCollectionDefinition.Name)]
[SuppressMessage(
    "Security",
    "CA5394:Do not use insecure randomness",
    // Justification: the randomness here chooses tree shapes, not secrets. It is deliberately a
    // seeded System.Random so a failing case reproduces exactly - which a cryptographic generator,
    // being unseedable by design, could not do. Reproducibility is the entire point of the test.
    Justification = "Seeded pseudo-randomness is required for reproducible property tests.")]
public sealed class ItemClosurePropertyTests : IAsyncLifetime
{
    private const int ItemCount = 24;
    private const int MoveCount = 40;

    private readonly NixPostgresFixture _fixture;

    public ItemClosurePropertyTests(NixPostgresFixture fixture) => _fixture = fixture;

    public static TheoryData<int> Seeds => [1, 7, 42, 1337, 20260726];

    private static CancellationToken Cancellation => TestContext.Current.CancellationToken;

    public async ValueTask InitializeAsync()
    {
        await _fixture.ResetAsync();
        await M0SchemaSeed.SeedBothTenantsAsync(_fixture);
    }

    public ValueTask DisposeAsync() => ValueTask.CompletedTask;

    [Theory]
    [MemberData(nameof(Seeds))]
    public async Task The_closure_equals_a_recomputation_after_every_move(int seed)
    {
        var random = new Random(seed);
        var workspace = WorkspaceId.From(M0SchemaSeed.Alpha.WorkspaceId);
        var actor = PrincipalId.From(M0SchemaSeed.Alpha.PrincipalId);

        // Parent pointers, mirrored in memory: the authority the closure is checked against.
        // Seeded with the row M0SchemaSeed already placed in this workspace - it is a real item
        // with a real self-edge, and a recomputation that ignored it would report a surplus.
        var parents = new Dictionary<ItemId, ItemId?>
        {
            [ItemId.From(M0SchemaSeed.Alpha.ItemId)] = null,
        };

        var work = await _fixture.Application.BeginUnitOfWorkAsync(TestTenants.AlphaContext, Cancellation);
        await using (work.ConfigureAwait(false))
        {
            var tree = work.Resolve<IItemTree>();
            var dispatcher = work.Resolve<NixDispatcher>();

            for (var index = 0; index < ItemCount; index++)
            {
                var candidates = parents.Keys.ToList();
                var parent = candidates.Count == 0 || random.Next(4) == 0
                    ? (ItemId?)null
                    : candidates[random.Next(candidates.Count)];

                var id = ItemId.Create();
                await tree.InsertAsync(
                    NewItem(id, workspace, parent, actor, await NextSeqAsync(tree, workspace, parent)),
                    Cancellation);

                parents[id] = parent;
            }

            await AssertClosureMatchesAsync(work, parents, "after building the tree");

            for (var move = 0; move < MoveCount; move++)
            {
                var ids = parents.Keys.ToList();
                var subject = ids[random.Next(ids.Count)];

                // Include null so items get moved to the root as well as between parents.
                var destinations = ids.Where(candidate => candidate != subject).ToList();
                var destination = destinations.Count == 0 || random.Next(5) == 0
                    ? (ItemId?)null
                    : destinations[random.Next(destinations.Count)];

                var descendants = DescendantsOf(parents, subject);
                var wouldCycle = destination is { } target && descendants.Contains(target);

                if (destination is { } proposed)
                {
                    // The database's own answer must agree with the in-memory one, every time.
                    var reported = await tree.WouldCreateCycleAsync(subject, proposed, Cancellation);
                    Assert.Equal(wouldCycle, reported);
                }

                // Driven through the use case rather than the port, so what is being checked is
                // the operation a request performs - permission check, cycle refusal, sibling
                // placement and closure rewrite together - and not just the store method underneath
                // it. A closure that stayed correct while the use case skipped a step would pass
                // the port-level version of this test and ship the bug.
                var outcome = await dispatcher.SendAsync<MoveItem, Item>(
                    new MoveItem(subject, destination, null),
                    Cancellation);

                if (wouldCycle)
                {
                    Assert.True(outcome.IsFailure);
                    Assert.Equal("items.move_would_create_cycle", outcome.Error.Code);
                    continue;
                }

                Assert.True(outcome.IsSuccess);
                parents[subject] = destination;

                await AssertClosureMatchesAsync(
                    work,
                    parents,
                    $"after move {move} of {subject} to {destination?.ToString() ?? "(root)"}");
            }
        }
    }

    [Fact]
    public async Task A_move_into_the_items_own_subtree_is_reported_as_a_cycle()
    {
        var workspace = WorkspaceId.From(M0SchemaSeed.Alpha.WorkspaceId);
        var actor = PrincipalId.From(M0SchemaSeed.Alpha.PrincipalId);

        var work = await _fixture.Application.BeginUnitOfWorkAsync(TestTenants.AlphaContext, Cancellation);
        await using (work.ConfigureAwait(false))
        {
            var tree = work.Resolve<IItemTree>();

            // grandparent -> parent -> child
            var grandparent = ItemId.Create();
            var parent = ItemId.Create();
            var child = ItemId.Create();

            await tree.InsertAsync(NewItem(grandparent, workspace, null, actor, 1000), Cancellation);
            await tree.InsertAsync(NewItem(parent, workspace, grandparent, actor, 1000), Cancellation);
            await tree.InsertAsync(NewItem(child, workspace, parent, actor, 1000), Cancellation);

            // Every destination inside the subtree, including the item itself, which the
            // zero-depth self-edge covers without a special case.
            Assert.True(await tree.WouldCreateCycleAsync(grandparent, grandparent, Cancellation));
            Assert.True(await tree.WouldCreateCycleAsync(grandparent, parent, Cancellation));
            Assert.True(await tree.WouldCreateCycleAsync(grandparent, child, Cancellation));

            // ...and the legitimate direction, so the check is not simply answering yes.
            Assert.False(await tree.WouldCreateCycleAsync(child, grandparent, Cancellation));
            Assert.False(await tree.WouldCreateCycleAsync(parent, grandparent, Cancellation));
        }
    }

    [Theory]
    [InlineData(true)]
    [InlineData(false)]
    public async Task Moving_all_children_at_once_matches_moving_them_one_by_one(bool underParent)
    {
        var workspace = WorkspaceId.From(M0SchemaSeed.Alpha.WorkspaceId);
        var actor = PrincipalId.From(M0SchemaSeed.Alpha.PrincipalId);
        var at = DateTimeOffset.UtcNow;
        var parents = new Dictionary<ItemId, ItemId?> { [ItemId.From(M0SchemaSeed.Alpha.ItemId)] = null };
        var container = ItemId.Create();
        ItemId? destination = null;
        var children = new List<ItemId>();

        var build = await _fixture.Application.BeginUnitOfWorkAsync(TestTenants.AlphaContext, Cancellation);
        await using (build.ConfigureAwait(false))
        {
            var tree = build.Resolve<IItemTree>();
            async Task<ItemId> AddAsync(ItemId? parent, long seq)
            {
                var id = ItemId.Create();
                await tree.InsertAsync(NewItem(id, workspace, parent, actor, seq), Cancellation);
                parents[id] = parent;
                return id;
            }

            if (underParent)
            {
                destination = await AddAsync(null, 1000);
                await AddAsync(destination, 5000);
                await AddAsync(destination, 9000);
            }

            parents[container] = destination;
            await tree.InsertAsync(NewItem(container, workspace, destination, actor, 2000), Cancellation);
            for (var index = 0; index < 6; index++)
            {
                children.Add(await AddAsync(container, 1000 + index * 1000));
            }

            await AddAsync(children[0], 1000);
            await AddAsync(children[2], 1000);
            foreach (var trashed in new[] { children[1], children[4] })
            {
                await tree.SetLifecycleAsync(trashed, ItemLifecycleState.Deleted, actor, at, Cancellation);
            }

            await build.CommitAsync(Cancellation);
        }

        async Task<List<string>> RunAsync(bool batch)
        {
            var work = await _fixture.Application.BeginUnitOfWorkAsync(TestTenants.AlphaContext, Cancellation);
            await using (work.ConfigureAwait(false))
            {
                var tree = work.Resolve<IItemTree>();
                if (batch)
                {
                    await tree.ReparentChildrenAsync(workspace, container, destination, actor, at, Cancellation);
                }
                else
                {
                    foreach (var child in await tree.ListChildrenAsync(workspace, container, true, null, 200, Cancellation))
                    {
                        var seq = await tree.NextSiblingSequenceAsync(workspace, destination, Cancellation);
                        await tree.ReparentAsync(child.Id, destination, seq, actor, at, Cancellation);
                    }
                }

                foreach (var child in children)
                {
                    parents[child] = destination;
                }

                await AssertClosureMatchesAsync(work, parents, batch ? "after the batch" : "after one by one");
                var siblings = (await tree.ListChildrenAsync(workspace, destination, true, null, 200, Cancellation))
                    .Select(item => $"{item.Id}|{item.ParentId}|{item.Seq}|{item.LifecycleState}|{item.LastModifiedAt.UtcTicks}")
                    .ToList();
                return siblings;
            }
        }

        var oneByOne = await RunAsync(batch: false);
        var all = await RunAsync(batch: true);
        Assert.Equal(oneByOne.Order(StringComparer.Ordinal), all.Order(StringComparer.Ordinal));
        Assert.Contains(all, line => line.StartsWith(children[0].ToString(), StringComparison.Ordinal));
    }

    private static Item NewItem(
        ItemId id,
        WorkspaceId workspace,
        ItemId? parent,
        PrincipalId actor,
        long seq) =>
        new()
        {
            Id = id,
            TenantId = TenantId.From(TestTenants.Alpha),
            WorkspaceId = workspace,
            Type = "folder",
            ParentId = parent,
            Seq = seq,
            Properties = ItemProperties.WithTitle(null, $"item-{id}"),
            LifecycleState = ItemLifecycleState.Active,
            CreatedBy = actor,
            LastModifiedBy = actor,
            CreatedAt = DateTimeOffset.UtcNow,
            LastModifiedAt = DateTimeOffset.UtcNow,
        };

    private static async ValueTask<long> NextSeqAsync(IItemTree tree, WorkspaceId workspace, ItemId? parent) =>
        await tree.NextSiblingSequenceAsync(workspace, parent, Cancellation);

    /// <summary>Every item reachable downwards from <paramref name="root"/>, including itself.</summary>
    private static HashSet<ItemId> DescendantsOf(Dictionary<ItemId, ItemId?> parents, ItemId root)
    {
        var found = new HashSet<ItemId> { root };
        var changed = true;

        while (changed)
        {
            changed = false;
            foreach (var (id, parent) in parents)
            {
                if (parent is { } value && found.Contains(value) && found.Add(id))
                {
                    changed = true;
                }
            }
        }

        return found;
    }

    /// <summary>
    /// The closure as it should be, computed from parent pointers alone: for each item, itself at
    /// depth zero and each ancestor at its distance.
    /// </summary>
    private static SortedSet<string> ExpectedEdges(Dictionary<ItemId, ItemId?> parents)
    {
        var edges = new SortedSet<string>(StringComparer.Ordinal);

        foreach (var id in parents.Keys)
        {
            var ancestor = id;
            var depth = 0;

            while (true)
            {
                edges.Add($"{id}|{ancestor}|{depth}");

                if (parents[ancestor] is not { } next)
                {
                    break;
                }

                ancestor = next;
                depth++;
            }
        }

        return edges;
    }

    /// <summary>Reads one closure edge as a comparable key.</summary>
    /// <remarks>
    /// A struct mapper so the executor devirtualises the call and allocates nothing per row - the
    /// same shape production code uses, which is the point of reading through the executor rather
    /// than around it.
    /// </remarks>
    private readonly struct EdgeMapper : INixRowMapper<string>
    {
        public string Map(NpgsqlDataReader reader)
        {
            ArgumentNullException.ThrowIfNull(reader);
            return $"{reader.GetGuid(0)}|{reader.GetGuid(1)}|{reader.GetInt32(2)}";
        }
    }

    private static async Task AssertClosureMatchesAsync(
        NixUnitOfWork work,
        Dictionary<ItemId, ItemId?> parents,
        string because)
    {
        var stored = new SortedSet<string>(StringComparer.Ordinal);

        var edges = work.Sql.QueryAsync<string, EdgeMapper>(
            ClosureSql.SelectAllEdgesInWorkspace,
            default,
            [
                new NpgsqlParameter("tenant_id", NpgsqlDbType.Uuid) { Value = TestTenants.Alpha },
                new NpgsqlParameter("workspace_id", NpgsqlDbType.Uuid)
                {
                    Value = M0SchemaSeed.Alpha.WorkspaceId,
                },
            ],
            Cancellation);

        await foreach (var edge in edges.ConfigureAwait(false))
        {
            stored.Add(edge);
        }

        var expected = ExpectedEdges(parents);

        // Both directions named separately: "missing" and "surplus" are different bugs. A missing
        // edge hides a descendant from a permission check; a surplus one grants access through an
        // ancestor that is no longer there.
        var missing = expected.Except(stored, StringComparer.Ordinal).ToArray();
        var surplus = stored.Except(expected, StringComparer.Ordinal).ToArray();

        Assert.True(
            missing.Length == 0 && surplus.Length == 0,
            $"Closure disagrees with a recomputation {because}.\n"
            + $"  missing {missing.Length}: {string.Join(", ", missing.Take(10))}\n"
            + $"  surplus {surplus.Length}: {string.Join(", ", surplus.Take(10))}");
    }
}
