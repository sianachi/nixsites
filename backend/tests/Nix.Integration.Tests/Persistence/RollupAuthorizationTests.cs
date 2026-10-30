using System.Globalization;
using Nix.Abstractions;
using Nix.Domain.Items;
using Nix.Domain.Tenancy;
using Nix.Integration.Tests.Harness;

namespace Nix.Integration.Tests.Persistence;

/// <summary>
/// The two folds honour derived item visibility and tenancy inside their bulk read.
/// </summary>
/// <remarks>
/// <para>
/// <b>The disclosure this exists to prevent, found in the security review of goal 2.2.</b> A
/// listing may ask for deleted items (<c>?includeDeleted=true</c> is an ordinary read), so a page
/// can carry a deleted container. Its children are themselves active, so a fold filtering only the
/// child's own lifecycle would answer count, sum, minimum, maximum and average over rows every
/// other endpoint refuses - a point read of one is a 404 and listing them is a refused parent. A
/// minimum and a maximum are not counts; they are exact stored values of particular hidden rows.
/// </para>
/// <para>
/// <b>The tenant cases are constructed so they can fail.</b> Beta's container has children of its
/// own and Alpha asks for Beta's parent by id, so the assertion rests on the tenant predicate and
/// the row-security policy rather than on the corpus making a match impossible - which is the
/// defect the review found in the first version of the plan-evidence test.
/// </para>
/// </remarks>
[Collection(PostgresCollectionDefinition.Name)]
public sealed class RollupAuthorizationTests : IAsyncLifetime
{
    private static readonly Guid DeletedAncestor = new("201100f0-1111-4111-8111-201100f00001");
    private static readonly Guid HiddenContainer = new("201100f0-1111-4111-8111-201100f00002");
    private static readonly Guid HiddenChild = new("201100f0-1111-4111-8111-201100f00003");
    private static readonly Guid VisibleContainer = new("201100f0-1111-4111-8111-201100f00004");
    private static readonly Guid VisibleChild = new("201100f0-1111-4111-8111-201100f00005");
    private static readonly Guid BetaContainer = new("201100f0-2222-4222-8222-201100f00006");
    private static readonly Guid BetaChild = new("201100f0-2222-4222-8222-201100f00007");

    private readonly NixPostgresFixture _fixture;

    public RollupAuthorizationTests(NixPostgresFixture fixture) => _fixture = fixture;

    private static CancellationToken Cancellation => TestContext.Current.CancellationToken;

    public async ValueTask InitializeAsync()
    {
        await _fixture.ResetAsync();
        await M0SchemaSeed.SeedBothTenantsAsync(_fixture);
        await SeedAsync();
    }

    public ValueTask DisposeAsync() => ValueTask.CompletedTask;

    [Theory]
    [InlineData("deleted", false)]
    [InlineData("purged", false)]
    [InlineData("provisioning", false)]
    [InlineData("active", true)]
    public async Task A_container_below_a_non_visible_ancestor_folds_to_nothing(
        string ancestorLifecycle,
        bool templateOwned)
    {
        await SetAncestorBoundaryAsync(ancestorLifecycle, templateOwned);

        var work = await _fixture.Application.BeginUnitOfWorkAsync(TestTenants.AlphaContext, Cancellation);
        await using (work.ConfigureAwait(false))
        {
            var folds = await work.Resolve<IChildAggregates>().FoldAsync(
                WorkspaceId.From(M0SchemaSeed.Alpha.WorkspaceId),
                [ItemId.From(HiddenContainer), ItemId.From(VisibleContainer)],
                ["estimate"],
                Cancellation);

            // The visible container answers, so the read is working and the absence below is a
            // refusal rather than an empty result.
            var visible = Assert.Contains(
                new ChildAggregateKey(ItemId.From(VisibleContainer), "estimate"),
                folds);
            Assert.Equal(1, visible.Children);
            Assert.Equal(7m, visible.Total);

            Assert.DoesNotContain(
                new ChildAggregateKey(ItemId.From(HiddenContainer), "estimate"),
                folds);
        }
    }

    [Fact]
    public async Task A_container_whose_own_lifecycle_is_not_active_folds_to_nothing()
    {
        // The direct case, not the inherited one: the parent itself is what a page carrying
        // ?includeDeleted=true hands the fold.
        await SetLifecycleAsync(VisibleContainer, "deleted");

        var work = await _fixture.Application.BeginUnitOfWorkAsync(TestTenants.AlphaContext, Cancellation);
        await using (work.ConfigureAwait(false))
        {
            var folds = await work.Resolve<IChildAggregates>().FoldAsync(
                WorkspaceId.From(M0SchemaSeed.Alpha.WorkspaceId),
                [ItemId.From(VisibleContainer)],
                ["estimate"],
                Cancellation);

            Assert.Empty(folds);
        }
    }

    [Fact]
    public async Task Another_tenant_cannot_fold_a_container_it_names_by_id()
    {
        // Beta's container really does have a child carrying the folded property, so a match is
        // possible and only the tenant predicate and the policy prevent it.
        var work = await _fixture.Application.BeginUnitOfWorkAsync(TestTenants.AlphaContext, Cancellation);
        await using (work.ConfigureAwait(false))
        {
            var folds = await work.Resolve<IChildAggregates>().FoldAsync(
                WorkspaceId.From(M0SchemaSeed.Beta.WorkspaceId),
                [ItemId.From(BetaContainer)],
                ["estimate"],
                Cancellation);

            Assert.Empty(folds);
        }
    }

    [Fact]
    public async Task Another_tenant_cannot_bucket_a_container_it_names_by_id()
    {
        var work = await _fixture.Application.BeginUnitOfWorkAsync(TestTenants.AlphaContext, Cancellation);
        await using (work.ConfigureAwait(false))
        {
            var buckets = await work.Resolve<IChildAggregates>().BucketAsync(
                WorkspaceId.From(M0SchemaSeed.Beta.WorkspaceId),
                ItemId.From(BetaContainer),
                "status",
                measureKey: "estimate",
                limit: 10,
                Cancellation);

            Assert.Empty(buckets.Buckets);
            Assert.Equal(0, buckets.Children);
        }
    }

    [Fact]
    public async Task A_container_below_a_non_visible_ancestor_buckets_to_nothing()
    {
        var work = await _fixture.Application.BeginUnitOfWorkAsync(TestTenants.AlphaContext, Cancellation);
        await using (work.ConfigureAwait(false))
        {
            var hidden = await work.Resolve<IChildAggregates>().BucketAsync(
                WorkspaceId.From(M0SchemaSeed.Alpha.WorkspaceId),
                ItemId.From(HiddenContainer),
                "status",
                measureKey: null,
                limit: 10,
                Cancellation);

            Assert.Empty(hidden.Buckets);

            // The visible one answers, so the emptiness above is a refusal rather than a read that
            // does not work.
            var visible = await work.Resolve<IChildAggregates>().BucketAsync(
                WorkspaceId.From(M0SchemaSeed.Alpha.WorkspaceId),
                ItemId.From(VisibleContainer),
                "status",
                measureKey: null,
                limit: 10,
                Cancellation);

            Assert.Equal(1, visible.Children);
        }
    }

    [Fact]
    public async Task A_number_too_large_to_represent_is_not_counted_rather_than_fatal()
    {
        // Measured in the review of goal 2.2: `PropertyValidator` accepts anything that reads as a
        // double, so 1e308 is a legal write - and Postgres numeric is arbitrary precision where
        // System.Decimal is not. Unbounded, this read threw OverflowException, and the blast radius
        // was the whole listing of the container as an opaque 500. One person, one number.
        await SetPropertiesAsync(VisibleChild, "{\"title\":\"Visible child\",\"estimate\":1e308}");

        var work = await _fixture.Application.BeginUnitOfWorkAsync(TestTenants.AlphaContext, Cancellation);
        await using (work.ConfigureAwait(false))
        {
            var folds = await work.Resolve<IChildAggregates>().FoldAsync(
                WorkspaceId.From(M0SchemaSeed.Alpha.WorkspaceId),
                [ItemId.From(VisibleContainer)],
                ["estimate"],
                Cancellation);

            var fold = Assert.Contains(
                new ChildAggregateKey(ItemId.From(VisibleContainer), "estimate"),
                folds);

            // The child is still a child and still carries a value; the value is simply not one
            // the fold can reduce, which is the posture a value of the wrong kind already gets.
            Assert.Equal(1, fold.Children);
            Assert.Equal(1, fold.Present);
            Assert.Equal(0, fold.Numbers);
            Assert.Null(fold.Total);
            Assert.Null(fold.Smallest);
        }
    }

    [Theory]
    [InlineData("\"123\"")]
    [InlineData("\"soon\"")]
    [InlineData("\"\\u2003123\"")]
    [InlineData("1e308")]
    [InlineData("1e-1000")]
    public async Task Every_chart_read_skips_unusable_measures_without_losing_children(string estimate)
    {
        await SetPropertiesAsync(VisibleChild,
            $$"""{"title":"Unusable","status":"Todo","owner":"Ada","done":"2026-03-04","estimate":{{estimate}}}""");
        await AddChildAsync(new Guid("201100f0-1111-4111-8111-201100f00030"),
            """{"title":"Valid","status":"Todo","owner":"Ada","done":"2026-03-04","estimate":7}""");

        await using var work = await _fixture.Application.BeginUnitOfWorkAsync(TestTenants.AlphaContext, Cancellation);
        var reader = work.Resolve<IChildAggregates>();
        var workspace = WorkspaceId.From(M0SchemaSeed.Alpha.WorkspaceId);
        var parent = ItemId.From(VisibleContainer);
        var buckets = await reader.BucketAsync(workspace, parent, "status", "estimate", 10, Cancellation);
        var series = await reader.BucketBySeriesAsync(workspace, parent, "status", "owner", "estimate", 6, 10, 100, Cancellation);
        var days = await reader.BucketByDayAsync(workspace, parent, "done", "owner", "estimate",
            new DateOnly(2026, 1, 1), new DateOnly(2026, 12, 31), 6, 100, Cancellation);

        Assert.Equal(2, buckets.Children);
        Assert.Equal(7m, Assert.Single(buckets.Buckets).Total);
        Assert.Equal(2, series.Children);
        Assert.Equal(7m, Assert.Single(series.Cells).Total);
        Assert.Equal(2, days.Children);
        Assert.Equal(7m, Assert.Single(days.Cells).Total);
    }

    [Fact]
    public async Task A_chart_buckets_by_a_priority_and_a_checkbox_with_an_unset_value_apart()
    {
        // JSON numbers and booleans read as text through `->>`: "2", "true". A child with no value
        // lands in the null bucket, so unchecked-by-omission stays distinct from a stored false.
        await SetPropertiesAsync(VisibleChild, """{"title":"A","severity":1,"resolved":true}""");
        await AddChildAsync(new Guid("201100f0-1111-4111-8111-201100f00040"),
            """{"title":"B","severity":1,"resolved":false}""");
        await AddChildAsync(new Guid("201100f0-1111-4111-8111-201100f00041"),
            """{"title":"C","severity":3}""");

        await using var work = await _fixture.Application.BeginUnitOfWorkAsync(TestTenants.AlphaContext, Cancellation);
        var reader = work.Resolve<IChildAggregates>();
        var workspace = WorkspaceId.From(M0SchemaSeed.Alpha.WorkspaceId);
        var parent = ItemId.From(VisibleContainer);

        var severity = await reader.BucketAsync(workspace, parent, "severity", null, 10, Cancellation);
        var resolved = await reader.BucketAsync(workspace, parent, "resolved", null, 10, Cancellation);

        Assert.Equal(2L, severity.Buckets.Single(bucket => bucket.Value == "1").Children);
        Assert.Equal(1L, severity.Buckets.Single(bucket => bucket.Value == "3").Children);
        Assert.Equal(1L, resolved.Buckets.Single(bucket => bucket.Value == "true").Children);
        Assert.Equal(1L, resolved.Buckets.Single(bucket => bucket.Value == "false").Children);
        Assert.Equal(1L, resolved.Buckets.Single(bucket => bucket.Value is null).Children);
    }

    [Fact]
    public async Task An_ordinary_large_total_is_still_answered()
    {
        // The other half of the bound: it has to admit a total a real workspace could reach. Two
        // hundred and one children at 1e15 each total 2.01e17, well inside what a decimal holds.
        await SetPropertiesAsync(VisibleChild, "{\"title\":\"a\",\"estimate\":1000000000000000}");
        await AddChildrenWithEstimateAsync(VisibleContainer, 200);

        var work = await _fixture.Application.BeginUnitOfWorkAsync(TestTenants.AlphaContext, Cancellation);
        await using (work.ConfigureAwait(false))
        {
            var folds = await work.Resolve<IChildAggregates>().FoldAsync(
                WorkspaceId.From(M0SchemaSeed.Alpha.WorkspaceId),
                [ItemId.From(VisibleContainer)],
                ["estimate"],
                Cancellation);

            var fold = Assert.Contains(
                new ChildAggregateKey(ItemId.From(VisibleContainer), "estimate"),
                folds);

            Assert.Equal(201, fold.Numbers);
            Assert.Equal(201_000_000_000_000_000m, fold.Total);
        }
    }

    [Fact]
    public async Task Another_tenant_cannot_split_or_date_bucket_a_container_it_names_by_id()
    {
        var work = await _fixture.Application.BeginUnitOfWorkAsync(TestTenants.AlphaContext, Cancellation);
        await using (work.ConfigureAwait(false))
        {
            var aggregates = work.Resolve<IChildAggregates>();

            var series = await aggregates.BucketBySeriesAsync(
                WorkspaceId.From(M0SchemaSeed.Beta.WorkspaceId),
                ItemId.From(BetaContainer),
                "status",
                "title",
                measureKey: "estimate",
                seriesLimit: 6,
                bucketLimit: 10,
                cellLimit: 100,
                Cancellation);
            var days = await aggregates.BucketByDayAsync(
                WorkspaceId.From(M0SchemaSeed.Beta.WorkspaceId),
                ItemId.From(BetaContainer),
                "status",
                splitKey: null,
                measureKey: null,
                firstDay: null,
                lastDay: null,
                seriesLimit: 6,
                cellLimit: 100,
                Cancellation);

            Assert.Empty(series.Cells);
            Assert.Equal(0, series.Children);
            Assert.Empty(days.Cells);
            Assert.Equal(0, days.Children);
        }
    }

    [Theory]
    [InlineData("deleted", false)]
    [InlineData("active", true)]
    public async Task A_container_below_a_non_visible_ancestor_splits_and_dates_to_nothing(
        string ancestorLifecycle,
        bool templateOwned)
    {
        await SetAncestorBoundaryAsync(ancestorLifecycle, templateOwned);

        var work = await _fixture.Application.BeginUnitOfWorkAsync(TestTenants.AlphaContext, Cancellation);
        await using (work.ConfigureAwait(false))
        {
            var aggregates = work.Resolve<IChildAggregates>();
            var workspace = WorkspaceId.From(M0SchemaSeed.Alpha.WorkspaceId);

            var hiddenSeries = await aggregates.BucketBySeriesAsync(
                workspace, ItemId.From(HiddenContainer), "status", "title", null, 6, 10, 100, Cancellation);
            var hiddenDays = await aggregates.BucketByDayAsync(
                workspace, ItemId.From(HiddenContainer), "status", null, null, null, null, 6, 100, Cancellation);

            Assert.Empty(hiddenSeries.Cells);
            Assert.Empty(hiddenDays.Cells);

            // The visible container answers both, so the emptiness above is a refusal.
            var visibleSeries = await aggregates.BucketBySeriesAsync(
                workspace, ItemId.From(VisibleContainer), "status", "title", null, 6, 10, 100, Cancellation);
            var visibleDays = await aggregates.BucketByDayAsync(
                workspace, ItemId.From(VisibleContainer), "status", null, null, null, null, 6, 100, Cancellation);

            Assert.Equal(1, visibleSeries.Children);
            Assert.Equal(1, visibleDays.Children);
        }
    }

    [Fact]
    public async Task The_day_read_counts_only_visible_children_and_places_each_on_its_own_day()
    {
        // A dated child, a timestamp written late in the evening in its own zone, an undated one,
        // one outside the window, and two that must never be counted: deleted, and template-owned.
        await SetPropertiesAsync(
            VisibleChild,
            "{\"title\":\"a\",\"estimate\":7,\"status\":\"Todo\",\"done\":\"2026-03-04\",\"owner\":\"Ada\"}");
        await AddChildAsync(
            new Guid("201100f0-1111-4111-8111-201100f00010"),
            "{\"title\":\"b\",\"estimate\":2,\"done\":\"2026-03-04T23:30:00+01:00[Europe/Paris]\"}");
        await AddChildAsync(
            new Guid("201100f0-1111-4111-8111-201100f00011"),
            "{\"title\":\"c\",\"done\":\"soon\"}");
        await AddChildAsync(
            new Guid("201100f0-1111-4111-8111-201100f00015"),
            "{\"title\":\"g\",\"done\":\"2026-13-01\"}");
        await AddChildAsync(
            new Guid("201100f0-1111-4111-8111-201100f00012"),
            "{\"title\":\"d\",\"done\":\"2025-12-31\"}");
        await AddChildAsync(
            new Guid("201100f0-1111-4111-8111-201100f00013"),
            "{\"title\":\"e\",\"done\":\"2026-03-04\"}",
            lifecycle: "deleted");
        await AddChildAsync(
            new Guid("201100f0-1111-4111-8111-201100f00014"),
            "{\"title\":\"f\",\"done\":\"2026-03-04\"}",
            templateOwned: true);

        var work = await _fixture.Application.BeginUnitOfWorkAsync(TestTenants.AlphaContext, Cancellation);
        await using (work.ConfigureAwait(false))
        {
            var read = await work.Resolve<IChildAggregates>().BucketByDayAsync(
                WorkspaceId.From(M0SchemaSeed.Alpha.WorkspaceId),
                ItemId.From(VisibleContainer),
                "done",
                splitKey: "owner",
                measureKey: "estimate",
                firstDay: new DateOnly(2026, 1, 1),
                lastDay: new DateOnly(2026, 12, 31),
                seriesLimit: 6,
                cellLimit: 100,
                Cancellation);

            Assert.False(read.CellsCut);

            // Undated first, counted whatever the window; then the one dated day, split by owner.
            Assert.Collection(
                read.Cells,
                undated =>
                {
                    // "soon" and "2026-13-01": neither is a real date, so neither has a day.
                    Assert.Null(undated.Bucket);
                    Assert.Equal(2, undated.Children);
                },
                ada =>
                {
                    Assert.Equal("2026-03-04", ada.Bucket);
                    Assert.Equal("Ada", ada.Series);
                    Assert.Equal(1, ada.Children);
                    Assert.Equal(7m, ada.Total);
                },
                nobody =>
                {
                    Assert.Equal("2026-03-04", nobody.Bucket);
                    Assert.Null(nobody.Series);
                    Assert.Equal(1, nobody.Children);
                    Assert.Equal(2m, nobody.Total);
                });

            // The deleted and template-owned children are nowhere; the one outside the window is
            // counted as outside rather than as a child of any day.
            Assert.Equal(4, read.Children);
            Assert.Equal(1, read.OutsideWindow);
        }
    }

    [Fact]
    public async Task The_series_read_returns_whole_buckets_and_never_counts_a_deleted_child()
    {
        await AddChildAsync(new Guid("201100f0-1111-4111-8111-201100f00020"), "{\"title\":\"b\",\"status\":\"Todo\",\"owner\":\"Ada\"}");
        await AddChildAsync(new Guid("201100f0-1111-4111-8111-201100f00021"), "{\"title\":\"c\",\"status\":\"Done\",\"owner\":\"Ada\"}");
        await AddChildAsync(
            new Guid("201100f0-1111-4111-8111-201100f00022"),
            "{\"title\":\"d\",\"status\":\"Done\",\"owner\":\"Bo\"}",
            lifecycle: "deleted");

        var work = await _fixture.Application.BeginUnitOfWorkAsync(TestTenants.AlphaContext, Cancellation);
        await using (work.ConfigureAwait(false))
        {
            var read = await work.Resolve<IChildAggregates>().BucketBySeriesAsync(
                WorkspaceId.From(M0SchemaSeed.Alpha.WorkspaceId),
                ItemId.From(VisibleContainer),
                "status",
                "owner",
                measureKey: null,
                seriesLimit: 6,
                bucketLimit: 1,
                cellLimit: 100,
                Cancellation);

            // Todo holds two children (the seeded one with no owner, and Ada's), Done holds one, so
            // Todo is the one bucket that fits - with both of its series.
            Assert.Equal(2, read.DistinctBuckets);
            Assert.Equal(3, read.Children);
            Assert.All(read.Cells, cell => Assert.Equal("Todo", cell.Bucket));
            Assert.Collection(
                read.Cells,
                ada => Assert.Equal("Ada", ada.Series),
                nobody => Assert.Null(nobody.Series));
        }
    }

    [Fact]
    public async Task A_split_by_a_value_per_child_returns_at_most_the_cap_plus_one_series_per_day()
    {
        await AddChildrenAsync(VisibleContainer, 40, "jsonb_build_object('title', 'n' || n, 'done', '2026-03-0' || (1 + n % 3), 'note', 'free text ' || n)");

        var work = await _fixture.Application.BeginUnitOfWorkAsync(TestTenants.AlphaContext, Cancellation);
        await using (work.ConfigureAwait(false))
        {
            var aggregates = work.Resolve<IChildAggregates>();
            var days = await aggregates.BucketByDayAsync(
                WorkspaceId.From(M0SchemaSeed.Alpha.WorkspaceId),
                ItemId.From(VisibleContainer),
                "done",
                splitKey: "note",
                measureKey: null,
                firstDay: null,
                lastDay: null,
                seriesLimit: 6,
                cellLimit: 1000,
                Cancellation);

            var dated = days.Cells.Where(cell => cell.Bucket is not null).ToList();
            Assert.All(
                dated.GroupBy(cell => cell.Bucket),
                day => Assert.True(day.Count() <= 7, $"{day.Key} has {day.Count()} cells"));
            Assert.Equal(6, dated.Where(cell => !cell.Other).Select(cell => cell.Series).Distinct().Count());
            Assert.Equal(40, dated.Sum(cell => cell.Children));
            Assert.Equal(40, days.SeriesValues);

            var categories = await aggregates.BucketBySeriesAsync(
                WorkspaceId.From(M0SchemaSeed.Alpha.WorkspaceId),
                ItemId.From(VisibleContainer),
                "done",
                "note",
                measureKey: null,
                seriesLimit: 6,
                bucketLimit: 10,
                cellLimit: 1000,
                Cancellation);

            Assert.All(
                categories.Cells.GroupBy(cell => cell.Bucket),
                bucket => Assert.True(bucket.Count() <= 7));
            Assert.Equal(41, categories.Children);
        }
    }

    [Fact]
    public async Task The_series_joins_keep_empty_text_and_unset_values_distinct()
    {
        await SetPropertiesAsync(VisibleChild, """{"title":"unset","status":"Todo","done":"2026-03-04"}""");
        await AddChildAsync(
            new Guid("201100f0-1111-4111-8111-201100f00030"),
            """{"title":"empty","status":"Todo","done":"2026-03-04","owner":""}""");

        var work = await _fixture.Application.BeginUnitOfWorkAsync(TestTenants.AlphaContext, Cancellation);
        await using (work.ConfigureAwait(false))
        {
            var aggregates = work.Resolve<IChildAggregates>();
            var workspace = WorkspaceId.From(M0SchemaSeed.Alpha.WorkspaceId);
            var parent = ItemId.From(VisibleContainer);
            var categories = await aggregates.BucketBySeriesAsync(workspace, parent, "status", "owner", null, 6, 10, 100, Cancellation);
            var days = await aggregates.BucketByDayAsync(workspace, parent, "done", "owner", null, null, null, 6, 100, Cancellation);

            Assert.Equal(2, categories.SeriesValues);
            Assert.Equal(2, days.SeriesValues);
            foreach (var cells in new[] { categories.Cells, days.Cells })
            {
                Assert.Equal(2, cells.Count);
                Assert.Contains(cells, cell => cell.Series is null && cell.Children == 1 && !cell.Other);
                Assert.Contains(cells, cell => cell.Series is { Length: 0 } && cell.Children == 1 && !cell.Other);
            }
        }
    }

    private async Task AddChildrenAsync(Guid parent, int count, string properties)
    {
        var tenant = Literal(M0SchemaSeed.Alpha.TenantId);
        var workspace = Literal(M0SchemaSeed.Alpha.WorkspaceId);
        var principal = Literal(M0SchemaSeed.Alpha.PrincipalId);

        var connection = await _fixture.OpenMigratorConnectionAsync();
        await using (connection.ConfigureAwait(false))
        {
            await RawSql.ExecuteAsync(
                connection,
                transaction: null,
                $$"""
                  INSERT INTO item
                      (id, tenant_id, workspace_id, type, parent_id, seq, properties,
                       lifecycle_state, purge_after, created_by, last_modified_by, created_at,
                       last_modified_at)
                  SELECT gen_random_uuid(), {{tenant}}, {{workspace}}, 'note', {{Literal(parent)}},
                         800000 + n, {{properties}}, 'active', NULL, {{principal}}, {{principal}},
                         now(), now()
                  FROM generate_series(1, {{count}}) AS n;

                  INSERT INTO item_closure (descendant_id, ancestor_id, tenant_id, workspace_id, depth)
                  SELECT id, id, tenant_id, workspace_id, 0 FROM item WHERE seq BETWEEN 800001 AND {{800000 + count}};

                  INSERT INTO item_closure (descendant_id, ancestor_id, tenant_id, workspace_id, depth)
                  SELECT id, {{Literal(parent)}}, tenant_id, workspace_id, 1
                  FROM item WHERE seq BETWEEN 800001 AND {{800000 + count}};
                  """);
        }
    }

    private async Task AddChildAsync(
        Guid id,
        string properties,
        string lifecycle = "active",
        bool templateOwned = false)
    {
        var tenant = Literal(M0SchemaSeed.Alpha.TenantId);
        var workspace = Literal(M0SchemaSeed.Alpha.WorkspaceId);
        var principal = Literal(M0SchemaSeed.Alpha.PrincipalId);
        var template = templateOwned ? Literal(M0SchemaSeed.Alpha.TemplateId) : "NULL";
        var source = templateOwned ? Literal(VisibleChild) : "NULL";

        var connection = await _fixture.OpenMigratorConnectionAsync();
        await using (connection.ConfigureAwait(false))
        {
            await RawSql.ExecuteAsync(
                connection,
                transaction: null,
                $$"""
                  INSERT INTO item
                      (id, tenant_id, workspace_id, type, parent_id, seq, properties,
                       lifecycle_state, purge_after, created_by, last_modified_by, created_at,
                       last_modified_at, template_id, template_source_id)
                  VALUES
                      ({{Literal(id)}}, {{tenant}}, {{workspace}}, 'note', {{Literal(VisibleContainer)}},
                       (SELECT coalesce(max(seq), 0) + 1 FROM item),
                       '{{properties}}'::jsonb, '{{lifecycle}}', NULL, {{principal}}, {{principal}},
                       now(), now(), {{template}}, {{source}});

                  INSERT INTO item_closure (descendant_id, ancestor_id, tenant_id, workspace_id, depth)
                  VALUES
                      ({{Literal(id)}}, {{Literal(id)}}, {{tenant}}, {{workspace}}, 0),
                      ({{Literal(id)}}, {{Literal(VisibleContainer)}}, {{tenant}}, {{workspace}}, 1);
                  """);
        }
    }

    private async Task SetPropertiesAsync(Guid id, string properties)
    {
        var connection = await _fixture.OpenMigratorConnectionAsync();
        await using (connection.ConfigureAwait(false))
        {
            await RawSql.ExecuteAsync(
                connection,
                transaction: null,
                $"UPDATE item SET properties = '{properties}'::jsonb WHERE id = {Literal(id)};");
        }
    }

    private async Task AddChildrenWithEstimateAsync(Guid parent, int count)
    {
        var tenant = Literal(M0SchemaSeed.Alpha.TenantId);
        var workspace = Literal(M0SchemaSeed.Alpha.WorkspaceId);
        var principal = Literal(M0SchemaSeed.Alpha.PrincipalId);

        var connection = await _fixture.OpenMigratorConnectionAsync();
        await using (connection.ConfigureAwait(false))
        {
            await RawSql.ExecuteAsync(
                connection,
                transaction: null,
                $$"""
                  INSERT INTO item
                      (id, tenant_id, workspace_id, type, parent_id, seq, properties,
                       lifecycle_state, purge_after, created_by, last_modified_by, created_at,
                       last_modified_at)
                  SELECT gen_random_uuid(), {{tenant}}, {{workspace}}, 'note', {{Literal(parent)}},
                         900000 + n,
                         jsonb_build_object('title', 'Big ' || n, 'estimate', 1000000000000000::numeric),
                         'active', NULL, {{principal}}, {{principal}}, now(), now()
                  FROM generate_series(1, {{count}}) AS n;

                  INSERT INTO item_closure (descendant_id, ancestor_id, tenant_id, workspace_id, depth)
                  SELECT id, id, tenant_id, workspace_id, 0 FROM item WHERE seq >= 900001;

                  INSERT INTO item_closure (descendant_id, ancestor_id, tenant_id, workspace_id, depth)
                  SELECT id, {{Literal(parent)}}, tenant_id, workspace_id, 1
                  FROM item WHERE seq >= 900001;
                  """);
        }
    }

    private async Task SeedAsync()
    {
        var tenant = Literal(M0SchemaSeed.Alpha.TenantId);
        var workspace = Literal(M0SchemaSeed.Alpha.WorkspaceId);
        var principal = Literal(M0SchemaSeed.Alpha.PrincipalId);
        var betaTenant = Literal(M0SchemaSeed.Beta.TenantId);
        var betaWorkspace = Literal(M0SchemaSeed.Beta.WorkspaceId);
        var betaPrincipal = Literal(M0SchemaSeed.Beta.PrincipalId);

        var sql = $$"""
            INSERT INTO item
                (id, tenant_id, workspace_id, type, parent_id, seq, properties,
                 lifecycle_state, purge_after, created_by, last_modified_by, created_at,
                 last_modified_at)
            VALUES
                ({{Literal(DeletedAncestor)}}, {{tenant}}, {{workspace}}, 'note', NULL, 1000,
                 '{"title":"Deleted ancestor"}'::jsonb, 'deleted', NULL,
                 {{principal}}, {{principal}}, now(), now()),
                ({{Literal(HiddenContainer)}}, {{tenant}}, {{workspace}}, 'note',
                 {{Literal(DeletedAncestor)}}, 2000, '{"title":"Hidden container"}'::jsonb,
                 'active', NULL, {{principal}}, {{principal}}, now(), now()),
                ({{Literal(HiddenChild)}}, {{tenant}}, {{workspace}}, 'note',
                 {{Literal(HiddenContainer)}}, 3000,
                 '{"title":"Hidden child","estimate":13,"status":"Doing"}'::jsonb,
                 'active', NULL, {{principal}}, {{principal}}, now(), now()),
                ({{Literal(VisibleContainer)}}, {{tenant}}, {{workspace}}, 'note', NULL, 4000,
                 '{"title":"Visible container"}'::jsonb,
                 'active', NULL, {{principal}}, {{principal}}, now(), now()),
                ({{Literal(VisibleChild)}}, {{tenant}}, {{workspace}}, 'note',
                 {{Literal(VisibleContainer)}}, 5000,
                 '{"title":"Visible child","estimate":7,"status":"Todo"}'::jsonb,
                 'active', NULL, {{principal}}, {{principal}}, now(), now()),
                ({{Literal(BetaContainer)}}, {{betaTenant}}, {{betaWorkspace}}, 'note', NULL, 6000,
                 '{"title":"Other tenant container"}'::jsonb,
                 'active', NULL, {{betaPrincipal}}, {{betaPrincipal}}, now(), now()),
                ({{Literal(BetaChild)}}, {{betaTenant}}, {{betaWorkspace}}, 'note',
                 {{Literal(BetaContainer)}}, 7000,
                 '{"title":"Other tenant child","estimate":99,"status":"Done"}'::jsonb,
                 'active', NULL, {{betaPrincipal}}, {{betaPrincipal}}, now(), now());

            INSERT INTO item_closure
                (descendant_id, ancestor_id, tenant_id, workspace_id, depth)
            VALUES
                ({{Literal(DeletedAncestor)}}, {{Literal(DeletedAncestor)}}, {{tenant}}, {{workspace}}, 0),
                ({{Literal(HiddenContainer)}}, {{Literal(HiddenContainer)}}, {{tenant}}, {{workspace}}, 0),
                ({{Literal(HiddenContainer)}}, {{Literal(DeletedAncestor)}}, {{tenant}}, {{workspace}}, 1),
                ({{Literal(HiddenChild)}}, {{Literal(HiddenChild)}}, {{tenant}}, {{workspace}}, 0),
                ({{Literal(HiddenChild)}}, {{Literal(HiddenContainer)}}, {{tenant}}, {{workspace}}, 1),
                ({{Literal(HiddenChild)}}, {{Literal(DeletedAncestor)}}, {{tenant}}, {{workspace}}, 2),
                ({{Literal(VisibleContainer)}}, {{Literal(VisibleContainer)}}, {{tenant}}, {{workspace}}, 0),
                ({{Literal(VisibleChild)}}, {{Literal(VisibleChild)}}, {{tenant}}, {{workspace}}, 0),
                ({{Literal(VisibleChild)}}, {{Literal(VisibleContainer)}}, {{tenant}}, {{workspace}}, 1),
                ({{Literal(BetaContainer)}}, {{Literal(BetaContainer)}}, {{betaTenant}}, {{betaWorkspace}}, 0),
                ({{Literal(BetaChild)}}, {{Literal(BetaChild)}}, {{betaTenant}}, {{betaWorkspace}}, 0),
                ({{Literal(BetaChild)}}, {{Literal(BetaContainer)}}, {{betaTenant}}, {{betaWorkspace}}, 1);
            """;

        var connection = await _fixture.OpenMigratorConnectionAsync();
        await using (connection.ConfigureAwait(false))
        {
            await RawSql.ExecuteAsync(connection, transaction: null, sql);
        }
    }

    private async Task SetAncestorBoundaryAsync(string lifecycle, bool templateOwned)
    {
        var template = templateOwned ? Literal(M0SchemaSeed.Alpha.TemplateId) : "NULL";
        var source = templateOwned ? Literal(DeletedAncestor) : "NULL";

        var connection = await _fixture.OpenMigratorConnectionAsync();
        await using (connection.ConfigureAwait(false))
        {
            await RawSql.ExecuteAsync(
                connection,
                transaction: null,
                $$"""
                  UPDATE item
                     SET lifecycle_state = '{{lifecycle}}',
                         template_id = {{template}},
                         template_source_id = {{source}}
                   WHERE id = {{Literal(DeletedAncestor)}};
                  """);
        }
    }

    private async Task SetLifecycleAsync(Guid id, string lifecycle)
    {
        var connection = await _fixture.OpenMigratorConnectionAsync();
        await using (connection.ConfigureAwait(false))
        {
            await RawSql.ExecuteAsync(
                connection,
                transaction: null,
                $$"""
                  UPDATE item SET lifecycle_state = '{{lifecycle}}' WHERE id = {{Literal(id)}};
                  """);
        }
    }

    private static string Literal(Guid value) =>
        $"'{value.ToString("D", CultureInfo.InvariantCulture)}'::uuid";
}
