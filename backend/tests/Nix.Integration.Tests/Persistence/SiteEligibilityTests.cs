using System.Text.Json.Nodes;
using Nix.Abstractions;
using Nix.Domain.Items;
using Nix.Domain.Sites;
using Nix.Features.Items;
using Nix.Features.Sites;
using Nix.Integration.Tests.Harness;

namespace Nix.Integration.Tests.Persistence;

/// <summary>
/// [SEC] What a site may publish. ADR-0063 puts the whole disclosure risk in the eligibility
/// statement, so each way an item can be withheld has its own case, and the same set is asserted
/// again on the build manifest that a worker is later handed.
/// </summary>
[Collection(PostgresCollectionDefinition.Name)]
public sealed class SiteEligibilityTests(NixPostgresFixture fixture) : IAsyncLifetime
{
    private SiteScenario _scenario = null!;
    private Guid _siteId;
    private readonly Dictionary<string, ItemId> _items = [];

    private static CancellationToken Cancellation => TestContext.Current.CancellationToken;

    private static readonly Guid OtherWorkspace = new("5a5a5a5a-1111-4111-8111-5a5a5a5a5a5a");

    private static ItemId Root => ItemId.From(M0SchemaSeed.Alpha.ItemId);

    public async ValueTask InitializeAsync()
    {
        await fixture.ResetAsync();
        await M0SchemaSeed.SeedBothTenantsAsync(fixture);
        _scenario = await SiteScenario.CreateAsync(fixture);
        await BuildTreeAsync();
    }

    public async ValueTask DisposeAsync() => await _scenario.DisposeAsync();

    [Fact]
    public async Task Only_the_items_a_visitor_may_see_are_eligible_and_they_come_in_pre_order()
    {
        var eligible = await EligibleAsync();

        Assert.Equal(
            ["root", "Guide", "Install", "Visible after exclusion", "Blog", "Past post"],
            eligible.Select(Name).ToArray());
    }

    [Fact]
    public async Task A_message_under_a_site_page_is_never_a_page()
    {
        Assert.DoesNotContain("A message", (await EligibleAsync()).Select(Name));
    }

    [Fact]
    public async Task A_locked_item_and_everything_under_it_is_withheld_even_when_the_publisher_unlocked_it()
    {
        var eligible = (await EligibleAsync()).Select(Name).ToHashSet();

        Assert.DoesNotContain("Locked", eligible);
        Assert.DoesNotContain("Under the lock", eligible);
    }

    [Fact]
    public async Task A_locked_root_cannot_be_published_and_cannot_become_a_site()
    {
        await Sql($"INSERT INTO item_lock (item_id, tenant_id, password_hash, locked_by, locked_at) VALUES ('{Root.Value}', '{TestTenants.Alpha}', 'pbkdf2-sha256$1$AAAAAAAAAAAAAAAAAAAAAA==$AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA=', '{TestTenants.AlphaPrincipal}', now()) ON CONFLICT DO NOTHING");

        var publish = await Publish("locked-root");
        Assert.True(publish.IsFailure);
        Assert.Equal(SiteErrors.RootLockedCode, publish.Error.Code);

        var another = await _scenario.CreateItemAsync("Another root", Root, "folder");
        await Sql($"INSERT INTO item_lock (item_id, tenant_id, password_hash, locked_by, locked_at) VALUES ('{another.Value}', '{TestTenants.Alpha}', 'pbkdf2-sha256$1$AAAAAAAAAAAAAAAAAAAAAA==$AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA=', '{TestTenants.AlphaPrincipal}', now())");
        var create = await _scenario.SendAsync<CreateSite, SiteResponse>(
            SiteScenario.Manager,
            new CreateSite(new CreateSiteRequest(another.Value, "locked-site", "docs", null)));
        Assert.Equal(SiteErrors.RootLockedCode, create.Error.Code);
    }

    [Fact]
    public async Task A_trashed_item_and_an_item_under_a_trashed_ancestor_are_withheld()
    {
        var eligible = (await EligibleAsync()).Select(Name).ToHashSet();

        Assert.DoesNotContain("Trashed", eligible);
        Assert.DoesNotContain("Under the trash", eligible);
        Assert.DoesNotContain("Kept in trashed folder", eligible);
    }

    [Fact]
    public async Task An_excluded_item_takes_its_subtree_with_it()
    {
        var eligible = (await EligibleAsync()).Select(Name).ToHashSet();

        Assert.DoesNotContain("Excluded", eligible);
        Assert.DoesNotContain("Inside the exclusion", eligible);
        Assert.Contains("Visible after exclusion", eligible);
    }

    [Fact]
    public async Task A_post_with_a_future_or_missing_or_unreadable_date_is_withheld()
    {
        var eligible = (await EligibleAsync()).Select(Name).ToHashSet();

        Assert.Contains("Past post", eligible);
        Assert.DoesNotContain("Future post", eligible);
        Assert.DoesNotContain("Undated post", eligible);
        Assert.DoesNotContain("Garbled date post", eligible);
        Assert.DoesNotContain("Child of a future post", eligible);
    }

    [Fact]
    public async Task A_build_reports_the_dated_posts_that_were_withheld_without_naming_locked_ones()
    {
        var locked = await Item("Locked future post", _items["Blog"], props: new JsonObject { ["published"] = "2999-01-01" });
        await Sql($"""
            INSERT INTO item_lock (item_id, tenant_id, password_hash, locked_by, locked_at)
            VALUES ('{locked.Value}', '{TestTenants.Alpha}', 'pbkdf2-sha256$1$AAAAAAAAAAAAAAAAAAAAAA==$AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA=', '{TestTenants.AlphaPrincipal}', now())
            """);

        var withheld = await _scenario.ReadAsync(SiteScenario.Manager, async unit =>
        {
            var store = unit.Resolve<ISiteStore>();
            var site = await store.FindAsync(_siteId, Cancellation);
            return await store.WithheldDatedPostsAsync(site!, DateTimeOffset.UtcNow, Cancellation);
        });
        Assert.Collection(withheld,
            post => Assert.Equal("Future post", post.Title),
            post => Assert.Equal("Undated post", post.Title),
            post => Assert.Equal("Garbled date post", post.Title));

        var published = await Publish("withheld");
        Assert.True(published.IsSuccess, published.IsFailure ? published.Error.Message : string.Empty);
        Assert.Equal(
            [
                "scheduled: Future post is scheduled for 2999-01-01.",
                "draft: Undated post has no date.",
                "draft: Garbled date post has an invalid date.",
            ],
            published.Value.Loss);
    }

    [Fact]
    public async Task A_build_bounds_its_withheld_post_report_and_discloses_truncation()
    {
        for (var index = 0; index < SiteRules.MaximumLossEntries + 2; index++)
        {
            _ = await Item($"Draft {index}", _items["Blog"]);
        }

        var published = await Publish("many-withheld");
        Assert.True(published.IsSuccess, published.IsFailure ? published.Error.Message : string.Empty);
        Assert.Equal(SiteRules.MaximumLossEntries, published.Value.Loss.Count);
        Assert.Equal("omitted: Additional dated posts were withheld.", published.Value.Loss[^1]);
    }

    [Fact]
    public async Task A_post_dated_with_a_zoned_date_time_is_published_with_its_instant()
    {
        var zoned = await Item("Zoned post", _items["Blog"], props: new JsonObject { ["published"] = "2026-01-01T09:00:00+01:00[Europe/Paris]" });
        await Item("Zoned future post", _items["Blog"], props: new JsonObject { ["published"] = "2999-01-01T09:00:00+01:00[Europe/Paris]" });

        var eligible = (await EligibleAsync()).Select(Name).ToHashSet();
        Assert.Contains("Zoned post", eligible);
        Assert.DoesNotContain("Zoned future post", eligible);

        var published = await Publish("zoned");
        Assert.True(published.IsSuccess, published.IsFailure ? published.Error.Message : string.Empty);
        var page = await _scenario.ReadAsync(SiteScenario.Manager, async unit =>
            await unit.Resolve<ISiteStore>().FindBuildPageAsync(published.Value.Id, zoned, Cancellation));
        Assert.Equal(new DateTimeOffset(2026, 1, 1, 8, 0, 0, TimeSpan.Zero), page!.PublishedAt);
    }

    [Fact]
    public async Task Siblings_with_the_same_order_key_come_in_identifier_order_every_time()
    {
        var folder = await Item("Tied", Root, "folder");
        var first = await Item("Tie one", folder);
        var second = await Item("Tie two", folder);
        await Sql($"UPDATE item SET seq = 7 WHERE id IN ('{first.Value}', '{second.Value}')");

        var tied = (await EligibleAsync()).Where(id => id == first || id == second).ToArray();

        Assert.Equal([.. new[] { first, second }.OrderBy(id => id.Value.ToString("D"), StringComparer.Ordinal)], tied);
    }

    [Fact]
    public async Task A_template_item_another_workspace_and_another_tenant_never_appear()
    {
        var eligible = (await EligibleAsync()).Select(Name).ToHashSet();

        Assert.DoesNotContain("Template body", eligible);
        Assert.DoesNotContain("Foreign workspace", eligible);
        Assert.DoesNotContain(eligible, name => name.Contains("beta", StringComparison.OrdinalIgnoreCase));
    }

    [Fact]
    public async Task The_database_itself_refuses_a_child_that_lives_in_another_workspace_than_its_parent()
    {
        var crafted = await Assert.ThrowsAsync<Npgsql.PostgresException>(() => Sql($"""
            INSERT INTO item (id, tenant_id, workspace_id, type, parent_id, seq, properties, lifecycle_state, created_by, last_modified_by, created_at, last_modified_at)
            VALUES (gen_random_uuid(), '{TestTenants.Alpha}', '{OtherWorkspace}', 'note', '{Root.Value}', 99000,
                    jsonb_build_object('title', 'Smuggled'), 'active', '{TestTenants.AlphaPrincipal}', '{TestTenants.AlphaPrincipal}', now(), now())
            """));

        Assert.Equal("23514", crafted.SqlState);
    }

    [Fact]
    public async Task The_build_manifest_holds_exactly_the_eligible_pages_with_their_paths()
    {
        var published = await Publish("manifest", acknowledge: true);
        Assert.True(published.IsSuccess, published.IsFailure ? published.Error.Message : string.Empty);

        var pages = await _scenario.ReadAsync(SiteScenario.Manager, async unit =>
            await unit.Resolve<ISiteStore>().ListBuildPagesAsync(published.Value.Id, -1, 100, Cancellation));

        Assert.Equal(
            [("/", "root"), ("/guide/", "Guide"), ("/guide/install/", "Install"), ("/visible-after-exclusion/", "Visible after exclusion"), ("/blog/", "Blog"), ("/blog/past-post/", "Past post")],
            pages.Select(page => (page.Path, Name(page.ItemId))).ToArray());
        Assert.Equal(Enumerable.Range(0, pages.Count), pages.Select(page => page.Ordinal));
        Assert.Equal(6, published.Value.PageCount);
    }

    [Fact]
    public async Task A_page_was_last_modified_when_its_body_last_changed_unless_the_item_changed_later()
    {
        var item = new DateTimeOffset(2026, 1, 1, 0, 0, 0, TimeSpan.Zero);
        var body = new DateTimeOffset(2026, 3, 4, 10, 0, 0, TimeSpan.Zero);
        await Sql($"UPDATE item SET last_modified_at = '{item:O}' WHERE id = '{Root.Value}'");
        await Sql($"UPDATE content_update SET created_at = '{body:O}' WHERE doc_id = (SELECT doc_id FROM content_doc WHERE item_id = '{Root.Value}')");

        Assert.Equal(body, await RootModifiedAsync());

        // A head update pruned by retention falls back to the base snapshot retention keeps at that seq.
        var snapshot = new DateTimeOffset(2026, 2, 2, 9, 0, 0, TimeSpan.Zero);
        await Sql($"UPDATE content_snapshot SET created_at = '{snapshot:O}' WHERE doc_id = (SELECT doc_id FROM content_doc WHERE item_id = '{Root.Value}') AND seq = (SELECT head_seq FROM content_doc WHERE item_id = '{Root.Value}')");
        await Sql($"DELETE FROM content_update WHERE doc_id = (SELECT doc_id FROM content_doc WHERE item_id = '{Root.Value}')");
        Assert.Equal(snapshot, await RootModifiedAsync());

        // With neither row left, the item's own time stands.
        await Sql($"DELETE FROM content_snapshot WHERE doc_id = (SELECT doc_id FROM content_doc WHERE item_id = '{Root.Value}')");
        Assert.Equal(item, await RootModifiedAsync());
    }

    private async Task<DateTimeOffset> RootModifiedAsync()
    {
        var pages = await _scenario.ReadAsync(SiteScenario.Manager, async unit =>
        {
            var store = unit.Resolve<ISiteStore>();
            var site = await store.FindAsync(_siteId, Cancellation);
            return await store.EligiblePagesAsync(site!, DateTimeOffset.UtcNow, Cancellation);
        });
        return pages.Single(page => page.Id == Root).LastModifiedAt;
    }

    [Fact]
    public async Task A_chart_is_withheld_when_any_active_child_of_its_container_is_not_eligible()
    {
        var container = await _scenario.CreateItemAsync("Chart container", Root, "folder");
        var shown = await _scenario.CreateItemAsync("Shown row", container);
        var hidden = await _scenario.CreateItemAsync("Hidden row", container);

        var withHidden = await _scenario.ReadAsync(SiteScenario.Manager, async unit =>
            await unit.Resolve<ISiteStore>().ContainersWithHiddenChildrenAsync([container], [container, shown], Cancellation));
        var allShown = await _scenario.ReadAsync(SiteScenario.Manager, async unit =>
            await unit.Resolve<ISiteStore>().ContainersWithHiddenChildrenAsync([container], [container, shown, hidden], Cancellation));

        Assert.Equal([container], withHidden);
        Assert.Empty(allShown);
    }

    private async Task BuildTreeAsync()
    {
        _items["root"] = Root;
        var guide = await Item("Guide", Root);
        await Item("Install", guide);
        var message = await Item("A message", guide);
        await Sql($"UPDATE item SET type = 'message' WHERE id = '{message.Value}'");

        var locked = await Item("Locked", Root);
        await Item("Under the lock", locked);
        await Sql($"""
            INSERT INTO item_lock (item_id, tenant_id, password_hash, locked_by, locked_at)
            VALUES ('{locked.Value}', '{TestTenants.Alpha}', 'pbkdf2-sha256$1$AAAAAAAAAAAAAAAAAAAAAA==$AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA=', '{TestTenants.AlphaPrincipal}', now());
            INSERT INTO item_unlock (item_id, credential_id, tenant_id, principal_id, expires_at)
            VALUES ('{locked.Value}', '{TestTenants.AlphaPrincipal}', '{TestTenants.Alpha}', '{TestTenants.AlphaPrincipal}', now() + interval '15 minutes');
            """);

        var trashed = await Item("Trashed", Root);
        await Item("Under the trash", trashed);
        var trash = await _scenario.SendAsync<DeleteItem, ItemId>(SiteScenario.Manager, new DeleteItem(trashed));
        Assert.True(trash.IsSuccess);

        var trashedFolder = await Item("Trashed folder", Root);
        await Item("Kept in trashed folder", trashedFolder);
        await Sql($"UPDATE item SET lifecycle_state = 'trashed', purge_after = now() + interval '30 days' WHERE id = '{trashedFolder.Value}'");

        var excluded = await Item("Excluded", Root);
        await Item("Inside the exclusion", excluded);
        await Item("Visible after exclusion", Root);

        var blog = await Item("Blog", Root, "folder");
        await Item("Past post", blog, props: new JsonObject { ["published"] = "2026-01-01" });
        var future = await Item("Future post", blog, props: new JsonObject { ["published"] = "2999-01-01" });
        await Item("Child of a future post", future);
        await Item("Undated post", blog);
        await Item("Garbled date post", blog, props: new JsonObject { ["published"] = "soon" });

        var template = await Item("Template body", Root);
        await Sql($"UPDATE item SET template_id = '{M0SchemaSeed.Alpha.TemplateId}', template_source_id = gen_random_uuid() WHERE id = '{template.Value}'");

        // Another workspace in the same tenant, with an item of its own.
        var elsewhere = ItemId.Create();
        _items["Foreign workspace"] = elsewhere;
        await Sql($"""
            INSERT INTO workspace (workspace_id, tenant_id, name, version_retention_days, coalesce_window_min, storage_quota_bytes, created_at)
            VALUES ('{OtherWorkspace}', '{TestTenants.Alpha}', 'other', 30, 10, 1073741824, now());
            INSERT INTO item (id, tenant_id, workspace_id, type, parent_id, seq, properties, lifecycle_state, created_by, last_modified_by, created_at, last_modified_at)
            VALUES ('{elsewhere.Value}', '{TestTenants.Alpha}', '{OtherWorkspace}', 'note', NULL, 1000,
                    jsonb_build_object('title', 'Foreign workspace'), 'active', '{TestTenants.AlphaPrincipal}', '{TestTenants.AlphaPrincipal}', now(), now());
            INSERT INTO item_closure (descendant_id, ancestor_id, tenant_id, workspace_id, depth)
            VALUES ('{elsewhere.Value}', '{elsewhere.Value}', '{TestTenants.Alpha}', '{OtherWorkspace}', 0);
            """);

        var created = await _scenario.SendAsync<CreateSite, SiteResponse>(
            SiteScenario.Manager,
            new CreateSite(new CreateSiteRequest(Root.Value, "eligibility", "docs", null)));
        Assert.True(created.IsSuccess, created.IsFailure ? created.Error.Message : string.Empty);
        _siteId = created.Value.Id;

        var updated = await _scenario.SendAsync<UpdateSite, SiteResponse>(
            SiteScenario.Manager,
            new UpdateSite(
                _siteId,
                new UpdateSiteRequest(
                    null,
                    null,
                    null,
                    null,
                    [excluded.Value],
                    [new SiteDatedCollectionDto(blog.Value, "published", null, null, null)])));
        Assert.True(updated.IsSuccess, updated.IsFailure ? updated.Error.Message : string.Empty);
    }

    private async Task<ItemId> Item(string title, ItemId parent, string type = "note", JsonObject? props = null)
    {
        var id = await _scenario.CreateItemAsync(title, parent, type, props);
        _items[title] = id;
        return id;
    }

    private string Name(ItemId id) => _items.Single(pair => pair.Value == id).Key;

    private async Task<IReadOnlyList<ItemId>> EligibleAsync()
    {
        var pages = await _scenario.ReadAsync(SiteScenario.Manager, async unit =>
        {
            var store = unit.Resolve<ISiteStore>();
            var site = await store.FindAsync(_siteId, Cancellation);
            return await store.EligiblePagesAsync(site!, DateTimeOffset.UtcNow, Cancellation);
        });
        return [.. pages.Select(page => page.Id)];
    }

    private Task<Nix.Domain.Primitives.Result<SiteBuildResponse>> Publish(string key, bool acknowledge = true) =>
        _scenario.SendAsync<PublishSite, SiteBuildResponse>(
            SiteScenario.Manager,
            new PublishSite(_siteId, key, RefreshPaths: false, acknowledge, "manual"));

    private async Task Sql(string statement)
    {
        var connection = await fixture.OpenMigratorConnectionAsync();
        await using (connection.ConfigureAwait(false))
        {
            await RawSql.ExecuteAsync(connection, transaction: null, statement);
        }
    }
}
