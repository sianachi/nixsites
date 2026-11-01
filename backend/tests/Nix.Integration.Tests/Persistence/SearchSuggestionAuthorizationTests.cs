using System.Globalization;
using System.Text;
using Nix.Abstractions;
using Nix.Domain.Items;
using Nix.Domain.Primitives;
using Nix.Domain.Tenancy;
using Nix.Features.Locks;
using Nix.Features.Search;
using Nix.Integration.Tests.Harness;
using Nix.Messaging;

namespace Nix.Integration.Tests.Persistence;

/// <summary>
/// Related items, mention matching and the richer search hit return only what the acting principal
/// may read, with the filtering inside the statements, against real Postgres.
/// </summary>
/// <remarks>
/// <para>
/// Written from the refused side first, like <see cref="SearchAuthorizationTests"/>, and from the
/// same seat: a viewer of one workspace, not the seeded tenant administrator, so a missing
/// workspace predicate fails here rather than passing because an administrator reaches everything.
/// </para>
/// <para>
/// The link graph, for the related-items assertions. Every item is in the open workspace unless
/// it says otherwise:
/// </para>
/// <list type="bullet">
/// <item><c>SourceA</c> links to Target, Shared, OnlyA, PrivateItem (closed workspace), Hidden,
/// Child (under Folder), DeletedItem and TemplateItem.</item>
/// <item><c>SourceB</c> links to Target, Shared, Hidden, DeletedItem and TemplateItem.</item>
/// <item><c>SourceUnderLock</c> sits in LockedFolder and links to Target and OnlyUnderLock.</item>
/// <item><c>LockedSource</c> links to Target and OnlyLocked, and is locked by the tests that need it.</item>
/// <item><c>PrivateSource</c> (closed workspace) links to Target and OnlyPrivate.</item>
/// <item>Target links to itself and to Outgoing - its own body, which is not a co-citation.</item>
/// </list>
/// </remarks>
[Collection(PostgresSecondaryCollectionDefinition.Name)]
public sealed class SearchSuggestionAuthorizationTests : IAsyncLifetime
{
    private static readonly Guid PrivateWorkspace = new("5ec0c000-1111-4111-8111-5ec0c0000001");
    private static readonly Guid Member = new("5ec0c000-1111-4111-8111-5ec0c0000002");
    private static readonly Guid Target = new("5ec0c000-1111-4111-8111-5ec0c0000010");
    private static readonly Guid SourceA = new("5ec0c000-1111-4111-8111-5ec0c0000011");
    private static readonly Guid SourceB = new("5ec0c000-1111-4111-8111-5ec0c0000012");
    private static readonly Guid LockedSource = new("5ec0c000-1111-4111-8111-5ec0c0000013");
    private static readonly Guid PrivateSource = new("5ec0c000-1111-4111-8111-5ec0c0000014");
    private static readonly Guid Shared = new("5ec0c000-1111-4111-8111-5ec0c0000020");
    private static readonly Guid OnlyA = new("5ec0c000-1111-4111-8111-5ec0c0000021");
    private static readonly Guid OnlyLocked = new("5ec0c000-1111-4111-8111-5ec0c0000022");
    private static readonly Guid OnlyPrivate = new("5ec0c000-1111-4111-8111-5ec0c0000023");
    private static readonly Guid PrivateItem = new("5ec0c000-1111-4111-8111-5ec0c0000024");
    private static readonly Guid Hidden = new("5ec0c000-1111-4111-8111-5ec0c0000025");
    private static readonly Guid DeletedFolder = new("5ec0c000-1111-4111-8111-5ec0c0000026");
    private static readonly Guid Outgoing = new("5ec0c000-1111-4111-8111-5ec0c0000027");
    private static readonly Guid Folder = new("5ec0c000-1111-4111-8111-5ec0c0000028");
    private static readonly Guid Child = new("5ec0c000-1111-4111-8111-5ec0c0000029");
    private static readonly Guid[] WeeklyReviews =
    [
        new("5ec0c000-1111-4111-8111-5ec0c0000030"),
        new("5ec0c000-1111-4111-8111-5ec0c0000031"),
        new("5ec0c000-1111-4111-8111-5ec0c0000032"),
        new("5ec0c000-1111-4111-8111-5ec0c0000033"),
    ];

    private static readonly Guid LockedFolder = new("5ec0c000-1111-4111-8111-5ec0c0000040");
    private static readonly Guid SourceUnderLock = new("5ec0c000-1111-4111-8111-5ec0c0000041");
    private static readonly Guid OnlyUnderLock = new("5ec0c000-1111-4111-8111-5ec0c0000042");
    private static readonly Guid DeletedItem = new("5ec0c000-1111-4111-8111-5ec0c0000050");
    private static readonly Guid TemplateItem = new("5ec0c000-1111-4111-8111-5ec0c0000051");

    /// <summary>The browser session the administrator locks with.</summary>
    private static readonly Guid Locker = new("5ec0c000-1111-4111-8111-5ec0c00000aa");

    private readonly NixPostgresFixture _fixture;

    public SearchSuggestionAuthorizationTests(NixPostgresFixture fixture) => _fixture = fixture;

    private static CancellationToken Cancellation => TestContext.Current.CancellationToken;

    private static NixSessionContext MemberContext => TestTenants.ContextFor(
        M0SchemaSeed.Alpha.TenantId,
        M0SchemaSeed.Alpha.WorkspaceId,
        Member);

    public async ValueTask InitializeAsync()
    {
        await _fixture.ResetAsync();
        await M0SchemaSeed.SeedBothTenantsAsync(_fixture);
        await SeedAsync();
    }

    public ValueTask DisposeAsync() => ValueTask.CompletedTask;

    [Fact]
    public async Task Related_items_rank_by_shared_readable_sources()
    {
        var related = await RelatedAsync(Target);

        Assert.True(related.IsSuccess);
        var first = related.Value.Related[0];
        Assert.Equal(ItemId.From(Shared), first.Item.Id);
        Assert.Equal(2, first.SharedSources);
        Assert.Contains(related.Value.Related, item => item.Item.Id == ItemId.From(OnlyA) && item.SharedSources == 1);
    }

    [Fact]
    public async Task Related_items_never_include_the_target_or_what_its_own_body_links_to()
    {
        var related = await RelatedAsync(Target);

        // Target links to itself and to Outgoing. Neither is a co-citation: one is the item asked
        // about, the other is its own outgoing link.
        Assert.DoesNotContain(related.Value.Related, item => item.Item.Id == ItemId.From(Target));
        Assert.DoesNotContain(related.Value.Related, item => item.Item.Id == ItemId.From(Outgoing));
    }

    [Fact]
    public async Task Related_items_omit_an_item_in_a_workspace_the_caller_cannot_read()
    {
        var related = await RelatedAsync(Target);

        Assert.DoesNotContain(related.Value.Related, item => item.Item.Id == ItemId.From(PrivateItem));
    }

    [Fact]
    public async Task A_source_the_caller_cannot_read_contributes_nothing()
    {
        var related = await RelatedAsync(Target);

        // OnlyPrivate is readable, but the only document linking it alongside Target is in a
        // workspace the caller cannot reach. Returning it would say what that document links to.
        Assert.DoesNotContain(related.Value.Related, item => item.Item.Id == ItemId.From(OnlyPrivate));
    }

    [Fact]
    public async Task A_locked_source_contributes_nothing_to_related_items()
    {
        Assert.Contains((await RelatedAsync(Target)).Value.Related, item => item.Item.Id == ItemId.From(OnlyLocked));

        await LockAsync(LockedSource);

        // The edge to OnlyLocked was extracted from the locked body. Not relaxed for the session
        // that holds it open either: this is a workspace-wide question.
        Assert.DoesNotContain(
            (await RelatedAsync(Target, credential: Locker)).Value.Related,
            item => item.Item.Id == ItemId.From(OnlyLocked));
        Assert.DoesNotContain(
            (await RelatedAsync(Target)).Value.Related,
            item => item.Item.Id == ItemId.From(OnlyLocked));
    }

    [Fact]
    public async Task Related_items_omit_an_active_item_below_a_deleted_ancestor()
    {
        var related = await RelatedAsync(Target);

        // Hidden is co-cited by both readable sources - it would rank first - but its folder is
        // deleted, so it is not visible and must not spend a slot either.
        Assert.DoesNotContain(related.Value.Related, item => item.Item.Id == ItemId.From(Hidden));
    }

    [Fact]
    public async Task A_deleted_or_template_item_is_never_related_even_when_co_cited_most()
    {
        var related = await RelatedAsync(Target);

        // Both are co-cited by both readable sources, as often as Shared. Neither is readable as
        // an ordinary item, so neither is returned or spends a slot.
        Assert.DoesNotContain(related.Value.Related, item => item.Item.Id == ItemId.From(DeletedItem));
        Assert.DoesNotContain(related.Value.Related, item => item.Item.Id == ItemId.From(TemplateItem));
    }

    [Fact]
    public async Task A_source_under_a_locked_ancestor_contributes_nothing_to_related_items()
    {
        Assert.Contains((await RelatedAsync(Target)).Value.Related, item => item.Item.Id == ItemId.From(OnlyUnderLock));

        await LockAsync(LockedFolder);

        // The source is not locked itself; its folder is, and a lock covers its subtree. Not
        // relaxed for the credential holding the folder open: the edge came from a body.
        Assert.DoesNotContain(
            (await RelatedAsync(Target)).Value.Related,
            item => item.Item.Id == ItemId.From(OnlyUnderLock));
        Assert.DoesNotContain(
            (await RelatedAsync(Target, credential: Locker)).Value.Related,
            item => item.Item.Id == ItemId.From(OnlyUnderLock));
    }

    [Fact]
    public async Task A_related_item_under_a_closed_lock_is_left_out_until_the_lock_is_opened()
    {
        Assert.Contains((await RelatedAsync(Target)).Value.Related, item => item.Item.Id == ItemId.From(Child));

        await LockAsync(Folder);

        // ADR-0056: a lock hides the titles under it. Child is co-cited by a readable, unlocked
        // source, but it sits in a folder this credential has not opened.
        Assert.DoesNotContain((await RelatedAsync(Target)).Value.Related, item => item.Item.Id == ItemId.From(Child));
        Assert.Contains(
            (await RelatedAsync(Target, credential: Locker)).Value.Related,
            item => item.Item.Id == ItemId.From(Child));
    }

    [Fact]
    public async Task Related_items_of_another_tenant_s_item_are_reported_as_not_found()
    {
        var related = await RelatedAsync(M0SchemaSeed.Beta.ItemId);

        Assert.True(related.IsFailure);
        Assert.Equal("items.not_found", related.Error.Code);
    }

    [Fact]
    public async Task Related_items_honour_the_limit_and_say_when_it_was_reached()
    {
        var related = await RelatedAsync(Target, limit: 1);

        var only = Assert.Single(related.Value.Related);
        Assert.Equal(ItemId.From(Shared), only.Item.Id);
        Assert.True(related.Value.Truncated);
    }

    [Fact]
    public async Task Related_items_of_an_item_the_caller_cannot_read_are_reported_as_not_found()
    {
        var related = await RelatedAsync(PrivateItem);

        Assert.True(related.IsFailure);
        Assert.Equal("items.not_found", related.Error.Code);
    }

    [Fact]
    public async Task Related_items_of_an_identifier_that_does_not_exist_are_reported_as_not_found()
    {
        var related = await RelatedAsync(new Guid("5ec0c000-1111-4111-8111-5ec0c00000ff"));

        Assert.True(related.IsFailure);
        Assert.Equal("items.not_found", related.Error.Code);
    }

    [Fact]
    public async Task A_mention_is_a_readable_title_named_as_a_whole_phrase_in_any_case()
    {
        var found = await MentionsAsync("Notes from the PROJECT ATLAS kickoff.");

        var mention = Assert.Single(found.Mentions);
        Assert.Equal(ItemId.From(Shared), mention.Item.Id);
        Assert.Equal("PROJECT ATLAS", mention.Phrase);
    }

    [Fact]
    public async Task A_fragment_of_a_title_is_not_a_mention()
    {
        var found = await MentionsAsync("The atlas was on the table.");

        Assert.DoesNotContain(found.Mentions, mention => mention.Item.Id == ItemId.From(Shared));
    }

    [Fact]
    public async Task A_title_in_a_workspace_the_caller_cannot_read_is_never_a_mention()
    {
        // PrivateItem is titled "Confidential ledger". Matching it would let a passage test whether
        // a document with a given name exists in a workspace the caller cannot reach.
        var found = await MentionsAsync("We discussed the confidential ledger at length.");

        Assert.Empty(found.Mentions);
    }

    [Fact]
    public async Task A_title_below_a_deleted_ancestor_is_never_a_mention()
    {
        var found = await MentionsAsync("See the hidden roadmap for details.");

        Assert.Empty(found.Mentions);
    }

    [Fact]
    public async Task A_title_in_another_tenant_is_never_a_mention()
    {
        // Named outright, and with the other tenant's workspace named as the scope: neither
        // reaches it. RLS and the tenant predicate both stand between.
        Assert.Empty((await MentionsAsync("Notes on the Beta launch plan")).Mentions);
        Assert.Empty((await MentionsAsync(
            "Notes on the Beta launch plan",
            workspace: M0SchemaSeed.Beta.WorkspaceId)).Mentions);
    }

    [Fact]
    public async Task Mentions_are_matched_only_in_the_named_workspace()
    {
        // The caller can read the closed workspace as a member of it, but the passage is being
        // written in the open one, and a suggestion to link across workspaces is not one this
        // lookup makes.
        var connection = await _fixture.OpenMigratorConnectionAsync();
        await using (connection.ConfigureAwait(false))
        {
            await RawSql.ExecuteAsync(connection, transaction: null, $"""
                INSERT INTO workspace_member
                    (workspace_id, subject_type, subject_id, tenant_id, role, granted_by, granted_at)
                VALUES ({Literal(PrivateWorkspace)}, 'principal', {Literal(M0SchemaSeed.Alpha.PrincipalId)},
                        {Literal(M0SchemaSeed.Alpha.TenantId)}, 'viewer', {Literal(M0SchemaSeed.Alpha.PrincipalId)}, now());
                """);
        }

        var inOpen = await MentionsAsync(
            "We discussed the confidential ledger at length.",
            context: TestTenants.AlphaContext);
        var inClosed = await MentionsAsync(
            "We discussed the confidential ledger at length.",
            workspace: PrivateWorkspace,
            context: TestTenants.AlphaContext);

        Assert.Empty(inOpen.Mentions);
        Assert.Equal(ItemId.From(PrivateItem), Assert.Single(inClosed.Mentions).Item.Id);
    }

    [Fact]
    public async Task A_workspace_the_caller_cannot_read_finds_nothing()
    {
        var found = await MentionsAsync("We discussed the confidential ledger at length.", workspace: PrivateWorkspace);

        Assert.Empty(found.Mentions);
        Assert.False(found.Truncated);
    }

    [Fact]
    public async Task An_excluded_item_is_never_a_mention()
    {
        var found = await MentionsAsync("Notes on Project Atlas and the Atlas Roadmap Review", exclude: [Shared]);

        Assert.DoesNotContain(found.Mentions, mention => mention.Item.Id == ItemId.From(Shared));
        Assert.Contains(found.Mentions, mention => mention.Item.Id == ItemId.From(OnlyA));
    }

    [Fact]
    public async Task One_phrase_yields_at_most_three_mentions_most_recently_modified_first()
    {
        var found = await MentionsAsync("Notes from the weekly review.");

        // Four items are titled "Weekly review"; the newest three are kept so one common title
        // cannot fill the answer.
        Assert.Equal(
            [ItemId.From(WeeklyReviews[3]), ItemId.From(WeeklyReviews[2]), ItemId.From(WeeklyReviews[1])],
            found.Mentions.Select(mention => mention.Item.Id).ToList());
    }

    [Fact]
    public async Task A_deleted_or_template_item_is_never_a_mention()
    {
        var found = await MentionsAsync("The retired plan replaced the template plan.");

        Assert.Empty(found.Mentions);
    }

    [Fact]
    public async Task A_title_under_a_closed_lock_is_never_a_mention_until_the_lock_is_opened()
    {
        Assert.Contains((await MentionsAsync("See the nested child.")).Mentions, mention => mention.Item.Id == ItemId.From(Child));

        await LockAsync(Folder);

        Assert.Empty((await MentionsAsync("See the nested child.")).Mentions);
        Assert.Contains(
            (await MentionsAsync("See the nested child.", credential: Locker)).Mentions,
            mention => mention.Item.Id == ItemId.From(Child));
    }

    [Fact]
    public async Task Hidden_same_title_items_never_crowd_out_a_readable_one()
    {
        // The security review's reproduction. The three newest "Weekly review" items move into
        // Folder, which is then locked. Were the per-phrase cap (three, newest first) applied
        // before the lock, all three slots would go to hidden items and the readable one would
        // vanish - and its absence would say that three or more hidden items with that title were
        // edited more recently. Hidden items are dropped before any cap, so it is still returned.
        await MoveUnderFolderAsync(WeeklyReviews[1], WeeklyReviews[2], WeeklyReviews[3]);
        await LockAsync(Folder);

        var found = await MentionsAsync("Notes from the weekly review.");

        Assert.Equal(ItemId.From(WeeklyReviews[0]), Assert.Single(found.Mentions).Item.Id);
    }

    [Fact]
    public async Task A_locked_item_s_own_title_is_still_a_mention()
    {
        await LockAsync(Folder);

        // ADR-0056: the lock withholds the body and what is under the item, not the item's own
        // title - the same line its parent's listing draws.
        var found = await MentionsAsync("Put it in the Folder.");

        Assert.Equal(ItemId.From(Folder), Assert.Single(found.Mentions).Item.Id);
    }

    [Fact]
    public async Task A_title_search_cannot_rebuild_a_locked_folder_s_listing()
    {
        Assert.Contains(await SearchAsync("nested"), hit => hit.ParentId == ItemId.From(Folder));

        await LockAsync(Folder);

        // Search hits carry parentId. Were a title search to keep returning what sits under a
        // closed lock, filtering hits by parentId would list the folder's children one query at a
        // time, which is exactly what the children read refuses.
        Assert.DoesNotContain(await SearchAsync("nested"), hit => hit.ParentId == ItemId.From(Folder));
        Assert.DoesNotContain(await SearchAsync("child"), hit => hit.Id == ItemId.From(Child));
        Assert.Contains(await SearchAsync("nested", credential: Locker), hit => hit.Id == ItemId.From(Child));
    }

    [Fact]
    public async Task A_locked_item_s_own_title_is_still_found_by_search()
    {
        await LockAsync(Folder);

        Assert.Contains(await SearchAsync("folder"), hit => hit.Id == ItemId.From(Folder));
    }

    [Fact]
    public async Task A_title_in_another_tenant_is_never_found_by_search()
    {
        Assert.DoesNotContain(await SearchAsync("beta launch", context: TestTenants.AlphaContext), hit => hit.Id == ItemId.From(M0SchemaSeed.Beta.ItemId));
    }

    [Fact]
    public async Task Too_many_exclusions_are_refused_with_their_stable_code()
    {
        var work = await _fixture.Application.BeginUnitOfWorkAsync(MemberContext, Cancellation);
        await using (work.ConfigureAwait(false))
        {
            var excluded = Enumerable.Range(0, FindMentionsHandler.MaximumExclusions + 1)
                .Select(_ => ItemId.From(Guid.NewGuid()))
                .ToList();
            var result = await work.Resolve<NixDispatcher>()
                .QueryAsync<FindMentions, Result<MentionResults>>(
                    new FindMentions("Project Atlas", WorkspaceId.From(M0SchemaSeed.Alpha.WorkspaceId), excluded),
                    Cancellation);

            Assert.True(result.IsFailure);
            Assert.Equal("search.too_many_mention_exclusions", result.Error.Code);
        }
    }

    [Fact]
    public async Task Mentions_come_back_longest_phrase_first()
    {
        var found = await MentionsAsync("Project Atlas and Atlas Roadmap Review again");

        Assert.Equal(
            [ItemId.From(OnlyA), ItemId.From(Shared)],
            found.Mentions.Select(mention => mention.Item.Id).ToList());
    }

    [Fact]
    public async Task Text_over_the_ceiling_is_refused_with_its_stable_code()
    {
        var work = await _fixture.Application.BeginUnitOfWorkAsync(MemberContext, Cancellation);
        await using (work.ConfigureAwait(false))
        {
            var result = await work.Resolve<NixDispatcher>()
                .QueryAsync<FindMentions, Result<MentionResults>>(
                    new FindMentions(
                        new string('x', FindMentionsHandler.MaximumTextLength + 1),
                        WorkspaceId.From(M0SchemaSeed.Alpha.WorkspaceId),
                        []),
                    Cancellation);

            Assert.True(result.IsFailure);
            Assert.Equal("search.mention_text_too_long", result.Error.Code);
        }
    }

    [Fact]
    public async Task A_passage_with_more_phrases_than_the_ceiling_still_matches_and_says_it_was_cut()
    {
        var text = new StringBuilder("Project Atlas ");
        for (var index = 0; text.Length < FindMentionsHandler.MaximumTextLength - 10; index++)
        {
            text.Append('w').Append(index.ToString(CultureInfo.InvariantCulture)).Append(' ');
        }

        var found = await MentionsAsync(text.ToString());

        Assert.Contains(found.Mentions, mention => mention.Item.Id == ItemId.From(Shared));
        Assert.True(found.Truncated);
    }

    [Fact]
    public async Task A_search_hit_carries_its_parent_and_modification_time()
    {
        var work = await _fixture.Application.BeginUnitOfWorkAsync(MemberContext, Cancellation);
        await using (work.ConfigureAwait(false))
        {
            var result = await work.Resolve<NixDispatcher>()
                .QueryAsync<SearchItems, Result<SearchResults>>(
                    new SearchItems("nested child", SearchItemsHandler.DefaultLimit),
                    Cancellation);

            var hit = Assert.Single(result.Value.Hits);
            Assert.Equal(ItemId.From(Child), hit.Id);
            Assert.Equal(ItemId.From(Folder), hit.ParentId);
            Assert.Equal(new DateTimeOffset(2026, 9, 1, 12, 0, 0, TimeSpan.Zero), hit.UpdatedAt);
        }
    }

    [Fact]
    public async Task A_root_item_resolves_with_no_parent()
    {
        var work = await _fixture.Application.BeginUnitOfWorkAsync(MemberContext, Cancellation);
        await using (work.ConfigureAwait(false))
        {
            var result = await work.Resolve<NixDispatcher>()
                .QueryAsync<ResolveReferences, Result<ResolvedReferences>>(
                    new ResolveReferences([ItemId.From(Folder), ItemId.From(Child)]),
                    Cancellation);

            Assert.Null(result.Value.Resolutions[0].Item?.ParentId);
            Assert.Equal(ItemId.From(Folder), result.Value.Resolutions[1].Item?.ParentId);
        }
    }

    private async Task<Result<RelatedItemResults>> RelatedAsync(
        Guid target,
        int limit = GetRelatedItemsHandler.DefaultLimit,
        Guid? credential = null)
    {
        var work = await _fixture.Application.BeginUnitOfWorkAsync(MemberContext, Cancellation);
        await using (work.ConfigureAwait(false))
        {
            if (credential is { } id)
            {
                work.Resolve<CredentialSessionContext>().Set(id);
            }

            return await work.Resolve<NixDispatcher>()
                .QueryAsync<GetRelatedItems, Result<RelatedItemResults>>(
                    new GetRelatedItems(ItemId.From(target), limit),
                    Cancellation);
        }
    }

    private async Task<MentionResults> MentionsAsync(
        string text,
        Guid? workspace = null,
        IReadOnlyList<Guid>? exclude = null,
        NixSessionContext? context = null,
        Guid? credential = null)
    {
        var work = await _fixture.Application.BeginUnitOfWorkAsync(context ?? MemberContext, Cancellation);
        await using (work.ConfigureAwait(false))
        {
            if (credential is { } id)
            {
                work.Resolve<CredentialSessionContext>().Set(id);
            }

            var excluded = (exclude ?? []).Select(ItemId.From).ToList();
            var result = await work.Resolve<NixDispatcher>()
                .QueryAsync<FindMentions, Result<MentionResults>>(
                    new FindMentions(text, WorkspaceId.From(workspace ?? M0SchemaSeed.Alpha.WorkspaceId), excluded),
                    Cancellation);

            Assert.True(result.IsSuccess, result.IsFailure ? result.Error.Message : string.Empty);
            return result.Value;
        }
    }

    private async Task<IReadOnlyList<ItemDigest>> SearchAsync(
        string query,
        NixSessionContext? context = null,
        Guid? credential = null)
    {
        var work = await _fixture.Application.BeginUnitOfWorkAsync(context ?? MemberContext, Cancellation);
        await using (work.ConfigureAwait(false))
        {
            if (credential is { } id)
            {
                work.Resolve<CredentialSessionContext>().Set(id);
            }

            var result = await work.Resolve<NixDispatcher>()
                .QueryAsync<SearchItems, Result<SearchResults>>(
                    new SearchItems(query, SearchItemsHandler.DefaultLimit),
                    Cancellation);

            Assert.True(result.IsSuccess, result.IsFailure ? result.Error.Message : string.Empty);
            return result.Value.Hits;
        }
    }

    /// <summary>Re-parents root items under <see cref="Folder"/>, closure included, as the migrator.</summary>
    private async Task MoveUnderFolderAsync(params Guid[] items)
    {
        var tenant = Literal(M0SchemaSeed.Alpha.TenantId);
        var open = Literal(M0SchemaSeed.Alpha.WorkspaceId);
        var sql = new StringBuilder();
        foreach (var item in items)
        {
            sql.Append(CultureInfo.InvariantCulture, $"UPDATE item SET parent_id = {Literal(Folder)} WHERE id = {Literal(item)};\n");
            sql.Append(CultureInfo.InvariantCulture, $"INSERT INTO item_closure (descendant_id, ancestor_id, tenant_id, workspace_id, depth) VALUES ({Literal(item)}, {Literal(Folder)}, {tenant}, {open}, 1);\n");
        }

        var connection = await _fixture.OpenMigratorConnectionAsync();
        await using (connection.ConfigureAwait(false))
        {
            await RawSql.ExecuteAsync(connection, transaction: null, sql.ToString());
        }
    }

    /// <summary>Locks an item as the tenant administrator, the way the lock route does.</summary>
    private async Task LockAsync(Guid itemId)
    {
        var work = await _fixture.Application.BeginUnitOfWorkAsync(TestTenants.AlphaContext, Cancellation);
        await using (work.ConfigureAwait(false))
        {
            work.Resolve<CredentialSessionContext>().Set(Locker);
            var result = await work.Resolve<NixDispatcher>()
                .SendAsync<LockItem, bool>(new LockItem(ItemId.From(itemId), "hunter22", null), Cancellation);
            Assert.True(result.IsSuccess, result.IsFailure ? result.Error.Message : string.Empty);
            await work.CommitAsync(Cancellation);
        }
    }

    /// <summary>
    /// Seeds the graph described on the class, as the migrator: Core holds <c>SELECT</c> on
    /// <c>item_link</c> and could not write these rows itself.
    /// </summary>
    private async Task SeedAsync()
    {
        var tenant = Literal(M0SchemaSeed.Alpha.TenantId);
        var open = Literal(M0SchemaSeed.Alpha.WorkspaceId);
        var closed = Literal(PrivateWorkspace);
        var principal = Literal(M0SchemaSeed.Alpha.PrincipalId);

        string Row(
            Guid id,
            string workspace,
            string title,
            int seq,
            string state = "active",
            Guid? parent = null,
            string modified = "2026-09-01T12:00:00Z",
            bool template = false) =>
            $"({Literal(id)}, {tenant}, {workspace}, 'note', {(parent is { } p ? Literal(p) : "NULL")}, {seq}, "
            + $"'{{\"title\": \"{title}\"}}'::jsonb, '{state}', NULL, {principal}, {principal}, "
            + $"'2026-09-01T12:00:00Z', '{modified}', "
            + (template
                ? $"(SELECT template_id FROM workspace_template WHERE tenant_id = {tenant} LIMIT 1), gen_random_uuid())"
                : "NULL, NULL)");

        string Self(Guid id, string workspace) => $"({Literal(id)}, {Literal(id)}, {tenant}, {workspace}, 0)";

        string Edge(Guid source, Guid target) =>
            $"({tenant}, {Literal(source)}, {Literal(target)}, 1, 1)";

        var sql = $$"""
            INSERT INTO principal
                (principal_id, tenant_id, external_subject, kind, display_name, email, status,
                 deprovisioned_at)
            VALUES ({{Literal(Member)}}, {{tenant}}, 'alpha-suggest-member', 'user', 'Member',
                    'suggest-member@example.test', 'active', NULL);

            INSERT INTO workspace_member
                (workspace_id, subject_type, subject_id, tenant_id, role, granted_by, granted_at)
            VALUES ({{open}}, 'principal', {{Literal(Member)}}, {{tenant}}, 'viewer', {{principal}}, now());

            INSERT INTO workspace
                (workspace_id, tenant_id, name, version_retention_days, coalesce_window_min,
                 storage_quota_bytes, created_at)
            VALUES ({{closed}}, {{tenant}}, 'Alpha private', 30, 10, 1073741824, now());

            INSERT INTO item
                (id, tenant_id, workspace_id, type, parent_id, seq, properties, lifecycle_state,
                 purge_after, created_by, last_modified_by, created_at, last_modified_at, template_id,
                 template_source_id)
            VALUES
                {{Row(Target, open, "Target note", 2000)}},
                {{Row(SourceA, open, "Source A", 2100)}},
                {{Row(SourceB, open, "Source B", 2200)}},
                {{Row(LockedSource, open, "Locked source", 2300)}},
                {{Row(PrivateSource, closed, "Private source", 2400)}},
                {{Row(Shared, open, "Project Atlas", 2500)}},
                {{Row(OnlyA, open, "Atlas Roadmap Review", 2600)}},
                {{Row(OnlyLocked, open, "Only locked", 2700)}},
                {{Row(OnlyPrivate, open, "Only private", 2800)}},
                {{Row(PrivateItem, closed, "Confidential ledger", 2900)}},
                {{Row(DeletedFolder, open, "Deleted folder", 3000, "deleted")}},
                {{Row(Hidden, open, "Hidden roadmap", 3100, parent: DeletedFolder)}},
                {{Row(Outgoing, open, "Outgoing", 3200)}},
                {{Row(Folder, open, "Folder", 3300)}},
                {{Row(Child, open, "Nested child", 3400, parent: Folder)}},
                {{Row(WeeklyReviews[0], open, "Weekly review", 3500, modified: "2026-09-01T12:00:00Z")}},
                {{Row(WeeklyReviews[1], open, "Weekly Review", 3510, modified: "2026-09-02T12:00:00Z")}},
                {{Row(WeeklyReviews[2], open, "weekly review", 3520, modified: "2026-09-03T12:00:00Z")}},
                {{Row(WeeklyReviews[3], open, "WEEKLY REVIEW", 3530, modified: "2026-09-04T12:00:00Z")}},
                {{Row(LockedFolder, open, "Locked folder", 3600)}},
                {{Row(SourceUnderLock, open, "Source under lock", 3610, parent: LockedFolder)}},
                {{Row(OnlyUnderLock, open, "Only under lock", 3620)}},
                {{Row(DeletedItem, open, "Retired plan", 3700, "deleted")}},
                {{Row(TemplateItem, open, "Template plan", 3710, template: true)}};

            UPDATE item SET properties = '{"title": "Beta launch plan"}'::jsonb
            WHERE id = {{Literal(M0SchemaSeed.Beta.ItemId)}};

            INSERT INTO item_closure (descendant_id, ancestor_id, tenant_id, workspace_id, depth)
            VALUES
                {{Self(Target, open)}}, {{Self(SourceA, open)}}, {{Self(SourceB, open)}},
                {{Self(LockedSource, open)}}, {{Self(PrivateSource, closed)}}, {{Self(Shared, open)}},
                {{Self(OnlyA, open)}}, {{Self(OnlyLocked, open)}}, {{Self(OnlyPrivate, open)}},
                {{Self(PrivateItem, closed)}}, {{Self(DeletedFolder, open)}}, {{Self(Hidden, open)}},
                {{Self(Outgoing, open)}}, {{Self(Folder, open)}}, {{Self(Child, open)}},
                {{Self(WeeklyReviews[0], open)}}, {{Self(WeeklyReviews[1], open)}},
                {{Self(WeeklyReviews[2], open)}}, {{Self(WeeklyReviews[3], open)}},
                {{Self(LockedFolder, open)}}, {{Self(SourceUnderLock, open)}}, {{Self(OnlyUnderLock, open)}},
                {{Self(DeletedItem, open)}}, {{Self(TemplateItem, open)}},
                ({{Literal(Hidden)}}, {{Literal(DeletedFolder)}}, {{tenant}}, {{open}}, 1),
                ({{Literal(Child)}}, {{Literal(Folder)}}, {{tenant}}, {{open}}, 1),
                ({{Literal(SourceUnderLock)}}, {{Literal(LockedFolder)}}, {{tenant}}, {{open}}, 1);

            INSERT INTO item_link (tenant_id, source_item_id, target_item_id, occurrences, seq)
            VALUES
                {{Edge(SourceA, Target)}}, {{Edge(SourceA, Shared)}}, {{Edge(SourceA, OnlyA)}},
                {{Edge(SourceA, PrivateItem)}}, {{Edge(SourceA, Hidden)}}, {{Edge(SourceA, Child)}},
                {{Edge(SourceA, DeletedItem)}}, {{Edge(SourceA, TemplateItem)}},
                {{Edge(SourceB, Target)}}, {{Edge(SourceB, Shared)}}, {{Edge(SourceB, Hidden)}},
                {{Edge(SourceB, DeletedItem)}}, {{Edge(SourceB, TemplateItem)}},
                {{Edge(SourceUnderLock, Target)}}, {{Edge(SourceUnderLock, OnlyUnderLock)}},
                {{Edge(LockedSource, Target)}}, {{Edge(LockedSource, OnlyLocked)}},
                {{Edge(PrivateSource, Target)}}, {{Edge(PrivateSource, OnlyPrivate)}},
                {{Edge(Target, Target)}}, {{Edge(Target, Outgoing)}};
            """;

        var connection = await _fixture.OpenMigratorConnectionAsync();
        await using (connection.ConfigureAwait(false))
        {
            await RawSql.ExecuteAsync(connection, transaction: null, sql);
        }
    }

    private static string Literal(Guid value) =>
        $"'{value.ToString("D", CultureInfo.InvariantCulture)}'::uuid";
}
