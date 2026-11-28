using System.Collections.Immutable;
using System.Diagnostics.CodeAnalysis;
using Nix.Abstractions;
using Nix.Domain.Identity;
using Nix.Domain.Items;
using Nix.Domain.Properties;
using Nix.Domain.Tenancy;
using Nix.Features.Items;
using Nix.Features.Properties;
using Nix.Integration.Tests.Harness;
using Nix.Messaging;

namespace Nix.Integration.Tests.Persistence;

/// <summary>
/// The effective schema equals a from-scratch recomputation from the parent pointers, after any
/// sequence of moves and any placement of <c>inherit: false</c>.
/// </summary>
/// <remarks>
/// <para>
/// This is the claim ADR-0007 rests on, and it is only worth making if something checks it. The
/// resolver walks <c>item_closure</c> and merges nearest-first, stopping where a declaration
/// refuses to inherit; the in-memory authority walks <c>parent_id</c> and does the same thing by a
/// different route. They must not be able to disagree.
/// </para>
/// <para>
/// Example-based tests cannot cover this. The interesting cases are shapes nobody thinks to write
/// down: a schema declared on an item that is later moved out from under the one it was
/// overriding; an <c>inherit: false</c> that stops a chain halfway and is then reparented above
/// the thing it was hiding; two ancestors declaring the same key at different depths. So the tree
/// is built and mangled at random, and after every move the effective schema of every item is
/// compared against a recomputation.
/// </para>
/// <para>
/// <b>Seeded, not arbitrary.</b> Each case runs a fixed seed, so a failure reproduces exactly
/// rather than "sometimes on CI". This mirrors the closure property test, which makes the same
/// argument about the same table.
/// </para>
/// </remarks>
[Collection(PostgresCollectionDefinition.Name)]
[SuppressMessage(
    "Security",
    "CA5394:Do not use insecure randomness",
    // Justification: the randomness chooses tree shapes and schema placements, not secrets. It is
    // deliberately a seeded System.Random so a failing case reproduces exactly - which a
    // cryptographic generator, being unseedable by design, could not do.
    Justification = "Seeded pseudo-randomness is required for reproducible property tests.")]
public sealed class SchemaCascadePropertyTests : IAsyncLifetime
{
    private const int ItemCount = 18;
    private const int MoveCount = 25;

    private readonly NixPostgresFixture _fixture;

    public SchemaCascadePropertyTests(NixPostgresFixture fixture) => _fixture = fixture;

    public static TheoryData<int> Seeds => [3, 11, 97, 2026, 20260727];

    private static CancellationToken Cancellation => TestContext.Current.CancellationToken;

    public async ValueTask InitializeAsync()
    {
        await _fixture.ResetAsync();
        await M0SchemaSeed.SeedBothTenantsAsync(_fixture);
    }

    public ValueTask DisposeAsync() => ValueTask.CompletedTask;

    [Theory]
    [MemberData(nameof(Seeds))]
    public async Task The_effective_schema_equals_a_recomputation_after_every_move(int seed)
    {
        var random = new Random(seed);
        var workspace = WorkspaceId.From(M0SchemaSeed.Alpha.WorkspaceId);
        var actor = PrincipalId.From(M0SchemaSeed.Alpha.PrincipalId);

        // The two authorities the resolver is checked against: who each item's parent is, and what
        // each item declares. Both mirrored in memory, both the input to the recomputation.
        var parents = new Dictionary<ItemId, ItemId?>
        {
            [ItemId.From(M0SchemaSeed.Alpha.ItemId)] = null,
        };
        var declared = new Dictionary<ItemId, PropertySchema>();

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

                // Roughly half the items declare something, which is what makes chains where some
                // links contribute and some do not - the shape the merge actually has to handle.
                if (random.Next(2) == 0)
                {
                    var schema = RandomSchema(random);
                    var stored = await dispatcher.SendAsync<SetItemSchema, PropertySchema>(
                        new SetItemSchema(id, schema),
                        Cancellation);

                    Assert.True(stored.IsSuccess, stored.IsSuccess ? "" : stored.Error.Message);
                    declared[id] = schema;
                }
            }

            await AssertResolutionMatchesAsync(work, parents, declared, "after building the tree");

            for (var move = 0; move < MoveCount; move++)
            {
                var ids = parents.Keys.ToList();
                var subject = ids[random.Next(ids.Count)];

                var destinations = ids.Where(candidate => candidate != subject).ToList();
                var destination = destinations.Count == 0 || random.Next(4) == 0
                    ? (ItemId?)null
                    : destinations[random.Next(destinations.Count)];

                var descendants = DescendantsOf(parents, subject);
                if (destination is { } target && descendants.Contains(target))
                {
                    continue;
                }

                var outcome = await dispatcher.SendAsync<MoveItem, Item>(
                    new MoveItem(subject, destination, null),
                    Cancellation);
                Assert.True(outcome.IsSuccess, outcome.IsSuccess ? "" : outcome.Error.Message);

                parents[subject] = destination;

                // Moving a subtree changes the effective schema of every item in it, which is the
                // case a materialised resolution would have to invalidate and a computed one gets
                // right for free. Checking after every move is what proves that.
                await AssertResolutionMatchesAsync(
                    work,
                    parents,
                    declared,
                    $"after move {move} of {subject} to {destination?.ToString() ?? "(root)"}");
            }
        }
    }

    [Fact]
    public async Task A_declaration_that_refuses_to_inherit_hides_everything_above_it()
    {
        var workspace = WorkspaceId.From(M0SchemaSeed.Alpha.WorkspaceId);
        var actor = PrincipalId.From(M0SchemaSeed.Alpha.PrincipalId);

        var work = await _fixture.Application.BeginUnitOfWorkAsync(TestTenants.AlphaContext, Cancellation);
        await using (work.ConfigureAwait(false))
        {
            var tree = work.Resolve<IItemTree>();
            var dispatcher = work.Resolve<NixDispatcher>();
            var resolver = work.Resolve<ISchemaResolver>();

            // workspace -> scratch -> note
            var top = ItemId.Create();
            var scratch = ItemId.Create();
            var note = ItemId.Create();

            await tree.InsertAsync(NewItem(top, workspace, null, actor, 1000), Cancellation);
            await tree.InsertAsync(NewItem(scratch, workspace, top, actor, 1000), Cancellation);
            await tree.InsertAsync(NewItem(note, workspace, scratch, actor, 1000), Cancellation);

            await dispatcher.SendAsync<SetItemSchema, PropertySchema>(
                new SetItemSchema(top, Schema(true, ("owner", "Owner"))),
                Cancellation);
            await dispatcher.SendAsync<SetItemSchema, PropertySchema>(
                new SetItemSchema(scratch, Schema(false, ("note", "Note"))),
                Cancellation);

            var effective = await resolver.ResolveForItemAsync(note, Cancellation);

            // The case this exists for: a scratch area under a heavily-schema'd workspace, where
            // inheriting a dozen required properties would make every note in it invalid on
            // arrival.
            Assert.NotNull(effective.Find("note"));
            Assert.Null(effective.Find("owner"));
        }
    }

    [Fact]
    public async Task A_nearer_declaration_of_a_key_replaces_a_farther_one()
    {
        var workspace = WorkspaceId.From(M0SchemaSeed.Alpha.WorkspaceId);
        var actor = PrincipalId.From(M0SchemaSeed.Alpha.PrincipalId);

        var work = await _fixture.Application.BeginUnitOfWorkAsync(TestTenants.AlphaContext, Cancellation);
        await using (work.ConfigureAwait(false))
        {
            var tree = work.Resolve<IItemTree>();
            var dispatcher = work.Resolve<NixDispatcher>();
            var resolver = work.Resolve<ISchemaResolver>();

            var top = ItemId.Create();
            var project = ItemId.Create();
            var note = ItemId.Create();

            await tree.InsertAsync(NewItem(top, workspace, null, actor, 1000), Cancellation);
            await tree.InsertAsync(NewItem(project, workspace, top, actor, 1000), Cancellation);
            await tree.InsertAsync(NewItem(note, workspace, project, actor, 1000), Cancellation);

            await dispatcher.SendAsync<SetItemSchema, PropertySchema>(
                new SetItemSchema(
                    top,
                    new PropertySchema
                    {
                        Inherit = true,
                        Properties =
                        [
                            new PropertyDefinition("status", "Status", PropertyType.Text, [], false),
                        ],
                    }),
                Cancellation);

            await dispatcher.SendAsync<SetItemSchema, PropertySchema>(
                new SetItemSchema(
                    project,
                    new PropertySchema
                    {
                        Inherit = true,
                        Properties =
                        [
                            new PropertyDefinition(
                                "status",
                                "Stage",
                                PropertyType.Select,
                                ["Todo", "Done"],
                                true),
                        ],
                    }),
                Cancellation);

            var effective = await resolver.ResolveForItemAsync(note, Cancellation);
            var status = effective.Find("status");

            // A workspace-wide property a single project folder can narrow for its own subtree is
            // the case people actually have. Root-wins would make the outermost declaration
            // unoverridable and turn any shared schema into a commitment nobody could walk back.
            Assert.NotNull(status);
            Assert.Equal(PropertyType.Select, status.Type);
            Assert.Equal("Stage", status.Label);
            Assert.True(status.Required);

            // And the sibling above still sees its own.
            var atTop = await resolver.ResolveForItemAsync(top, Cancellation);
            Assert.Equal(PropertyType.Text, atTop.Find("status")?.Type);
        }
    }

    [Fact]
    public async Task A_schema_is_never_visible_across_tenants()
    {
        var work = await _fixture.Application.BeginUnitOfWorkAsync(TestTenants.BetaContext, Cancellation);
        await using (work.ConfigureAwait(false))
        {
            var resolver = work.Resolve<ISchemaResolver>();

            // Alpha's item, resolved inside Beta's session. The closure rows are invisible, so the
            // walk finds nothing - which is the correct answer and not a special case anybody had
            // to write.
            var effective = await resolver.ResolveForItemAsync(
                ItemId.From(M0SchemaSeed.Alpha.ItemId),
                Cancellation);

            Assert.True(effective.IsEmpty);
        }
    }

    /// <summary>
    /// Recomputes every item's effective schema from the parent pointers and compares.
    /// </summary>
    private static async Task AssertResolutionMatchesAsync(
        NixUnitOfWork work,
        Dictionary<ItemId, ItemId?> parents,
        Dictionary<ItemId, PropertySchema> declared,
        string stage)
    {
        var resolver = work.Resolve<ISchemaResolver>();

        foreach (var id in parents.Keys)
        {
            var expected = Recompute(id, parents, declared);
            var actual = await resolver.ResolveForItemAsync(id, Cancellation);

            Assert.Equal(
                Describe(expected),
                Describe(actual));
        }

        Assert.True(true, stage);
    }

    /// <summary>
    /// The authority: walk parent pointers upwards, merging nearest-first, stopping at the first
    /// declaration that refuses to inherit.
    /// </summary>
    private static PropertySchema Recompute(
        ItemId id,
        Dictionary<ItemId, ItemId?> parents,
        Dictionary<ItemId, PropertySchema> declared)
    {
        var chain = new List<PropertySchema>();

        ItemId? cursor = id;
        while (cursor is { } current)
        {
            if (declared.TryGetValue(current, out var schema))
            {
                chain.Add(schema);
                if (!schema.Inherit)
                {
                    break;
                }
            }

            cursor = parents.TryGetValue(current, out var parent) ? parent : null;
        }

        if (chain.Count == 0)
        {
            return PropertySchema.Empty;
        }

        var effective = chain[0];
        for (var index = 1; index < chain.Count; index++)
        {
            effective = PropertySchema.Merge(chain[index], effective);
        }

        return effective;
    }

    /// <summary>
    /// A schema as a comparable string, so a mismatch names the properties rather than the objects.
    /// </summary>
    private static string Describe(PropertySchema schema) =>
        string.Join(
            " | ",
            schema.Properties.Select(
                property =>
                    $"{property.Key}:{PropertyTypes.ToText(property.Type)}:{property.Label}:"
                    + $"{property.Required}:{string.Join(",", property.Options)}"));

    private static PropertySchema RandomSchema(Random random)
    {
        var count = random.Next(1, 4);
        var properties = ImmutableArray.CreateBuilder<PropertyDefinition>(count);
        var keys = new HashSet<string>(StringComparer.Ordinal);

        for (var index = 0; index < count; index++)
        {
            // A small key pool on purpose: collisions between ancestors are the whole point, and a
            // wide pool would make them vanishingly rare.
            var key = $"p{random.Next(4)}";
            if (!keys.Add(key))
            {
                continue;
            }

            var type = random.Next(3) switch
            {
                0 => PropertyType.Text,
                1 => PropertyType.Number,
                _ => PropertyType.Date,
            };

            properties.Add(
                new PropertyDefinition(key, $"{key}-{random.Next(100)}", type, [], random.Next(2) == 0));
        }

        return new PropertySchema
        {
            Properties = properties.ToImmutable(),

            // One in four refuses to inherit, so chains that stop halfway are common enough to be
            // exercised and rare enough that long chains still happen.
            Inherit = random.Next(4) != 0,
        };
    }

    private static PropertySchema Schema(bool inherit, params (string Key, string Label)[] properties) =>
        new()
        {
            Inherit = inherit,
            Properties =
            [
                .. properties.Select(
                    property => new PropertyDefinition(
                        property.Key,
                        property.Label,
                        PropertyType.Text,
                        [],
                        false)),
            ],
        };

    private static HashSet<ItemId> DescendantsOf(Dictionary<ItemId, ItemId?> parents, ItemId root)
    {
        var descendants = new HashSet<ItemId> { root };
        bool grew;

        do
        {
            grew = false;
            foreach (var (id, parent) in parents)
            {
                if (parent is { } value && descendants.Contains(value) && descendants.Add(id))
                {
                    grew = true;
                }
            }
        }
        while (grew);

        return descendants;
    }

    private static async Task<long> NextSeqAsync(IItemTree tree, WorkspaceId workspace, ItemId? parent) =>
        await tree.NextSiblingSequenceAsync(workspace, parent, Cancellation);

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
}
