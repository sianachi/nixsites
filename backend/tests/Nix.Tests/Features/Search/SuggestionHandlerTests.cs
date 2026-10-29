using Nix.Abstractions;
using Nix.Domain.Identity;
using Nix.Domain.Items;
using Nix.Domain.Links;
using Nix.Domain.Tenancy;
using Nix.Features.Search;

namespace Nix.Tests.Features.Search;

/// <summary>
/// What the related-items and mention use cases do before, during and after they ask for rows.
/// </summary>
/// <remarks>
/// <para>
/// Both are bulk disclosures of titles, so the assertions worth writing here are about the
/// handlers' relationship with the permission resolver and the bounds they hand down: an unreadable
/// target never reaches the reader, the readable set the resolver produced is the exact set handed
/// into the query, and the ceilings the contract publishes are the ones applied.
/// </para>
/// <para>
/// Rows are proven against real Postgres in <c>Nix.Integration.Tests</c>
/// (<c>SearchSuggestionAuthorizationTests</c>). This suite stays free of Testcontainers, so the
/// ports are fakes that record what they were asked.
/// </para>
/// </remarks>
public sealed class SuggestionHandlerTests
{
    private static readonly WorkspaceId Readable = WorkspaceId.From(new Guid("11111111-1111-4111-8111-111111111111"));
    private static readonly WorkspaceId AlsoReadable = WorkspaceId.From(new Guid("22222222-2222-4222-8222-222222222222"));
    private static readonly WorkspaceId Refused = WorkspaceId.From(new Guid("33333333-3333-4333-8333-333333333333"));
    private static readonly ItemId Target = ItemId.From(new Guid("44444444-4444-4444-8444-444444444444"));
    private static readonly PrincipalId Actor = PrincipalId.From(new Guid("66666666-6666-4666-8666-666666666666"));

    private static CancellationToken Cancellation => TestContext.Current.CancellationToken;

    [Fact]
    public async Task Related_items_of_a_target_in_an_unreadable_workspace_are_not_found_and_never_queried()
    {
        var links = new RecordingLinks();
        var handler = new GetRelatedItemsHandler(links, new TargetTree(Refused), new StubPermissions([Readable]));

        var result = await handler.HandleAsync(new GetRelatedItems(Target, 10), Cancellation);

        Assert.True(result.IsFailure);
        Assert.Equal("items.not_found", result.Error.Code);
        Assert.Equal(0, links.Calls);
    }

    [Fact]
    public async Task Related_items_of_a_target_that_is_not_visible_are_not_found()
    {
        var links = new RecordingLinks();
        var handler = new GetRelatedItemsHandler(links, new TargetTree(null), new StubPermissions([Readable]));

        var result = await handler.HandleAsync(new GetRelatedItems(Target, 10), Cancellation);

        Assert.True(result.IsFailure);
        Assert.Equal("items.not_found", result.Error.Code);
        Assert.Equal(0, links.Calls);
    }

    [Fact]
    public async Task Related_items_are_filtered_by_the_resolver_s_whole_readable_set_and_bounded_sources()
    {
        var links = new RecordingLinks();
        var handler = new GetRelatedItemsHandler(
            links,
            new TargetTree(Readable),
            new StubPermissions([Readable, AlsoReadable]));

        var result = await handler.HandleAsync(new GetRelatedItems(Target, 10), Cancellation);

        Assert.True(result.IsSuccess);
        Assert.Equal<IReadOnlyList<WorkspaceId>>([Readable, AlsoReadable], links.LastReadableWorkspaces);
        Assert.Equal(GetRelatedItemsHandler.MaximumSources, links.LastSourceLimit);
        Assert.Equal(Target, links.LastTargetId);
    }

    [Theory]
    [InlineData(0, 1)]
    [InlineData(10, 10)]
    [InlineData(1000, GetRelatedItemsHandler.MaximumLimit)]
    public async Task Related_items_clamp_the_limit_to_the_published_ceiling(int asked, int applied)
    {
        var links = new RecordingLinks();
        var handler = new GetRelatedItemsHandler(links, new TargetTree(Readable), new StubPermissions([Readable]));

        var result = await handler.HandleAsync(new GetRelatedItems(Target, asked), Cancellation);

        Assert.Equal(applied, links.LastLimit);
        Assert.Equal(applied, result.Value.Limit);
    }

    [Fact]
    public void The_related_items_defaults_are_the_ones_the_contract_describes()
    {
        Assert.Equal(10, GetRelatedItemsHandler.DefaultLimit);
        Assert.Equal(25, GetRelatedItemsHandler.MaximumLimit);
    }

    [Fact]
    public async Task Text_longer_than_the_ceiling_is_refused_with_a_stable_code_before_any_query()
    {
        var search = new RecordingSearch();
        var handler = new FindMentionsHandler(search, new StubPermissions([Readable]));

        var result = await handler.HandleAsync(
            Mentions(new string('a', FindMentionsHandler.MaximumTextLength + 1)),
            Cancellation);

        Assert.True(result.IsFailure);
        Assert.Equal("search.mention_text_too_long", result.Error.Code);
        Assert.Equal(0, search.Calls);
    }

    [Fact]
    public async Task Text_exactly_at_the_ceiling_is_accepted()
    {
        var search = new RecordingSearch();
        var handler = new FindMentionsHandler(search, new StubPermissions([Readable]));
        var text = string.Concat(Enumerable.Repeat("word ", FindMentionsHandler.MaximumTextLength / 5));

        var result = await handler.HandleAsync(Mentions(text), Cancellation);

        Assert.True(result.IsSuccess);
    }

    [Fact]
    public async Task Text_with_no_candidate_phrase_never_reaches_the_database()
    {
        var search = new RecordingSearch();
        var handler = new FindMentionsHandler(search, new StubPermissions([Readable]));

        var result = await handler.HandleAsync(Mentions("ok. no. 42"), Cancellation);

        Assert.True(result.IsSuccess);
        Assert.Empty(result.Value.Mentions);
        Assert.Equal(0, search.Calls);
    }

    [Fact]
    public async Task Mentions_are_matched_in_the_named_workspace_only_and_at_most_the_ceiling()
    {
        var search = new RecordingSearch();
        var handler = new FindMentionsHandler(search, new StubPermissions([Readable, AlsoReadable]));

        await handler.HandleAsync(Mentions("Notes on Project Atlas"), Cancellation);

        // The caller named one workspace; the other readable one is not searched.
        Assert.Equal<IReadOnlyList<WorkspaceId>>([Readable], search.LastReadableWorkspaces);
        Assert.Equal(FindMentionsHandler.MaximumMentions, search.LastLimit);
        Assert.Contains("project atlas", search.LastPhrases);
        Assert.True(search.LastPhrases.Count <= MentionPhrases.MaximumPhrases);
    }

    [Fact]
    public async Task A_mention_carries_the_words_as_they_appear_in_the_text()
    {
        var search = new RecordingSearch { Answer = phrase => phrase == "project atlas" };
        var handler = new FindMentionsHandler(search, new StubPermissions([Readable]));

        var result = await handler.HandleAsync(Mentions("Notes on Project Atlas."), Cancellation);

        var mention = Assert.Single(result.Value.Mentions);
        Assert.Equal("Project Atlas", mention.Phrase);
        Assert.False(result.Value.Truncated);
    }

    [Fact]
    public async Task Reaching_the_mention_ceiling_reports_a_partial_answer()
    {
        var search = new RecordingSearch { Answer = _ => true };
        var handler = new FindMentionsHandler(search, new StubPermissions([Readable]));

        var result = await handler.HandleAsync(
            Mentions(string.Join(' ', Enumerable.Range(0, 40).Select(index => $"topic{index}"))),
            Cancellation);

        Assert.Equal(FindMentionsHandler.MaximumMentions, result.Value.Mentions.Count);
        Assert.True(result.Value.Truncated);
    }

    [Fact]
    public async Task A_workspace_the_caller_cannot_read_finds_nothing_and_is_never_queried()
    {
        // Intersected with the readable set, not trusted: a named workspace the caller cannot reach
        // answers exactly as a workspace with no matching titles does.
        var search = new RecordingSearch { Answer = _ => true };
        var handler = new FindMentionsHandler(search, new StubPermissions([Readable]));

        var result = await handler.HandleAsync(
            new FindMentions("Notes on Project Atlas", Refused, []),
            Cancellation);

        Assert.True(result.IsSuccess);
        Assert.Empty(result.Value.Mentions);
        Assert.False(result.Value.Truncated);
        Assert.Equal(0, search.Calls);
    }

    [Fact]
    public async Task A_request_naming_no_workspace_is_refused_with_a_stable_code()
    {
        var search = new RecordingSearch();
        var handler = new FindMentionsHandler(search, new StubPermissions([Readable]));

        var result = await handler.HandleAsync(new FindMentions("Project Atlas", null, []), Cancellation);

        Assert.True(result.IsFailure);
        Assert.Equal("search.mention_workspace_required", result.Error.Code);
        Assert.Equal(0, search.Calls);
    }

    [Fact]
    public async Task The_excluded_items_are_handed_to_the_statement()
    {
        var search = new RecordingSearch();
        var handler = new FindMentionsHandler(search, new StubPermissions([Readable]));
        ItemId[] excluded = [Target, ItemId.From(new Guid("77777777-7777-4777-8777-777777777777"))];

        await handler.HandleAsync(new FindMentions("Notes on Project Atlas", Readable, excluded), Cancellation);

        Assert.Equal<IReadOnlyList<ItemId>>(excluded, search.LastExcluded);
    }

    [Fact]
    public async Task More_exclusions_than_the_ceiling_are_refused_before_any_query()
    {
        var search = new RecordingSearch();
        var handler = new FindMentionsHandler(search, new StubPermissions([Readable]));
        var excluded = Enumerable.Range(0, FindMentionsHandler.MaximumExclusions + 1)
            .Select(_ => ItemId.From(Guid.NewGuid()))
            .ToList();

        var result = await handler.HandleAsync(new FindMentions("Project Atlas", Readable, excluded), Cancellation);

        Assert.True(result.IsFailure);
        Assert.Equal("search.too_many_mention_exclusions", result.Error.Code);
        Assert.Equal(0, search.Calls);
    }

    [Fact]
    public async Task Exactly_the_exclusion_ceiling_is_accepted()
    {
        var search = new RecordingSearch();
        var handler = new FindMentionsHandler(search, new StubPermissions([Readable]));
        var excluded = Enumerable.Range(0, FindMentionsHandler.MaximumExclusions)
            .Select(_ => ItemId.From(Guid.NewGuid()))
            .ToList();

        var result = await handler.HandleAsync(new FindMentions("Project Atlas", Readable, excluded), Cancellation);

        Assert.True(result.IsSuccess);
        Assert.Equal(256, FindMentionsHandler.MaximumExclusions);
    }

    [Fact]
    public void The_mention_refusal_maps_to_bad_request()
    {
        Assert.Equal("search.mention_text_too_long", SearchErrors.MentionTextTooLong("why").Code);
    }

    private static FindMentions Mentions(string text) => new(text, Readable, []);

    private static ItemDigest Digest(string title) =>
        new(
            ItemId.From(Guid.NewGuid()),
            Readable,
            "note",
            title,
            null,
            DateTimeOffset.UnixEpoch);

    /// <summary>Answers with a fixed readable set, the way the resolver does for one principal.</summary>
    private sealed class StubPermissions(IReadOnlyList<WorkspaceId> readable) : IPermissionResolver
    {
        public ValueTask<bool> CanReadWorkspaceAsync(WorkspaceId workspaceId, CancellationToken cancellationToken) =>
            ValueTask.FromResult(readable.Contains(workspaceId));

        public ValueTask<bool> CanWriteWorkspaceAsync(WorkspaceId workspaceId, CancellationToken cancellationToken) =>
            ValueTask.FromResult(false);

        public ValueTask<bool> CanCommentWorkspaceAsync(WorkspaceId workspaceId, CancellationToken cancellationToken) => ValueTask.FromResult(false);


        public ValueTask<bool> CanManageWorkspaceAsync(WorkspaceId workspaceId, CancellationToken cancellationToken) =>
            ValueTask.FromResult(false);

        public ValueTask<IReadOnlyList<WorkspaceId>> ReadableWorkspacesAsync(CancellationToken cancellationToken) =>
            ValueTask.FromResult(readable);

        public ValueTask<bool> IsTenantAdministratorAsync(CancellationToken cancellationToken) =>
            ValueTask.FromResult(false);
    }

    /// <summary>A link reader that returns nothing and remembers what it was asked for.</summary>
    private sealed class RecordingLinks : IItemLinks
    {
        internal int Calls { get; private set; }

        internal ItemId LastTargetId { get; private set; }

        internal IReadOnlyList<WorkspaceId> LastReadableWorkspaces { get; private set; } = [];

        internal int LastSourceLimit { get; private set; }

        internal int LastLimit { get; private set; }

        public ValueTask<IReadOnlyList<Backlink>> BacklinksAsync(
            ItemId targetId,
            IReadOnlyList<WorkspaceId> readableWorkspaces,
            int limit,
            CancellationToken cancellationToken) =>
            throw new InvalidOperationException("Related items must not read backlinks.");

        public ValueTask<IReadOnlyList<RelatedItem>> RelatedAsync(
            ItemId targetId,
            IReadOnlyList<WorkspaceId> readableWorkspaces,
            int sourceLimit,
            int limit,
            CancellationToken cancellationToken)
        {
            Calls++;
            LastTargetId = targetId;
            LastReadableWorkspaces = readableWorkspaces;
            LastSourceLimit = sourceLimit;
            LastLimit = limit;
            return ValueTask.FromResult<IReadOnlyList<RelatedItem>>([]);
        }
    }

    /// <summary>A search port whose mention answer is decided per phrase by the test.</summary>
    private sealed class RecordingSearch : IItemSearch
    {
        internal Func<string, bool> Answer { get; init; } = _ => false;

        internal int Calls { get; private set; }

        internal IReadOnlyList<string> LastPhrases { get; private set; } = [];

        internal IReadOnlyList<WorkspaceId> LastReadableWorkspaces { get; private set; } = [];

        internal int LastLimit { get; private set; }

        internal IReadOnlyList<ItemId> LastExcluded { get; private set; } = [];

        public ValueTask<IReadOnlyList<ItemDigest>> FindAsync(
            string query,
            IReadOnlyList<WorkspaceId> readableWorkspaces,
            int limit,
            CancellationToken cancellationToken) =>
            throw new InvalidOperationException("Mentions must not run a text search.");

        public ValueTask<IReadOnlyList<ItemDigest>> ResolveAsync(
            IReadOnlyList<ItemId> itemIds,
            IReadOnlyList<WorkspaceId> readableWorkspaces,
            CancellationToken cancellationToken) =>
            throw new InvalidOperationException("Mentions must not resolve identifiers.");

        public ValueTask<IReadOnlyList<TitleMention>> MentionsAsync(
            IReadOnlyList<string> phrases,
            IReadOnlyList<WorkspaceId> readableWorkspaces,
            IReadOnlyList<ItemId> excludedItems,
            int limit,
            CancellationToken cancellationToken)
        {
            Calls++;
            LastPhrases = phrases;
            LastReadableWorkspaces = readableWorkspaces;
            LastExcluded = excludedItems;
            LastLimit = limit;

            var matches = phrases
                .Where(Answer)
                .Take(limit)
                .Select(phrase => new TitleMention(Digest(phrase), phrase))
                .ToList();
            return ValueTask.FromResult<IReadOnlyList<TitleMention>>(matches);
        }
    }

    /// <summary>An item tree that knows one item, in one workspace, or nothing.</summary>
    private sealed class TargetTree(WorkspaceId? workspace) : IItemTree
    {
        public ValueTask<Item?> FindAsync(ItemId id, CancellationToken cancellationToken) =>
            ValueTask.FromResult(workspace is { } value && id == Target ? TargetItem(value) : null);

        public ValueTask<Item?> FindStoredAsync(ItemId id, CancellationToken cancellationToken) =>
            FindAsync(id, cancellationToken);

        public ValueTask<IReadOnlySet<ItemId>> WithChildrenAsync(
            WorkspaceId workspaceId,
            IReadOnlyList<ItemId> parents,
            CancellationToken cancellationToken) => throw new NotSupportedException();

        public ValueTask<IReadOnlyList<Item>> ListChildrenAsync(
            WorkspaceId workspaceId,
            ItemId? parentId,
            bool includeDeleted,
            long? afterSeq,
            int limit,
            CancellationToken cancellationToken) => throw new NotSupportedException();

        public ValueTask<bool> WorkspaceExistsAsync(WorkspaceId workspaceId, CancellationToken cancellationToken) =>
            throw new NotSupportedException();

        public ValueTask<long> NextSiblingSequenceAsync(
            WorkspaceId workspaceId,
            ItemId? parentId,
            CancellationToken cancellationToken) => throw new NotSupportedException();

        public ValueTask<long> AllocateSiblingSequenceAsync(
            WorkspaceId workspaceId,
            ItemId? parentId,
            ItemId movingId,
            ItemId? afterId,
            CancellationToken cancellationToken) => throw new NotSupportedException();

        public ValueTask InsertAsync(Item item, CancellationToken cancellationToken) =>
            throw new NotSupportedException();

        public ValueTask UpdatePropertiesAsync(
            ItemId id,
            string properties,
            PrincipalId actor,
            DateTimeOffset at,
            CancellationToken cancellationToken) => throw new NotSupportedException();

        public ValueTask UpdateSchemaAsync(
            ItemId id,
            string? schema,
            PrincipalId actor,
            DateTimeOffset at,
            CancellationToken cancellationToken) => throw new NotSupportedException();

        public ValueTask UpdateViewsAsync(
            ItemId id,
            string? views,
            PrincipalId actor,
            DateTimeOffset at,
            CancellationToken cancellationToken) => throw new NotSupportedException();

        public ValueTask TouchAsync(
            ItemId id,
            PrincipalId actor,
            DateTimeOffset at,
            CancellationToken cancellationToken) => throw new NotSupportedException();

        public ValueTask<bool> WouldCreateCycleAsync(
            ItemId id,
            ItemId parentId,
            CancellationToken cancellationToken) => throw new NotSupportedException();

        public ValueTask ReparentAsync(
            ItemId id,
            ItemId? newParentId,
            long seq,
            PrincipalId actor,
            DateTimeOffset at,
            CancellationToken cancellationToken) => throw new NotSupportedException();

        public ValueTask SetLifecycleAsync(
            ItemId id,
            ItemLifecycleState state,
            PrincipalId actor,
            DateTimeOffset at,
            CancellationToken cancellationToken) => throw new NotSupportedException();

        private static Item TargetItem(WorkspaceId value) => new()
        {
            Id = Target,
            TenantId = TenantId.From(new Guid("55555555-5555-4555-8555-555555555555")),
            WorkspaceId = value,
            Type = "note",
            Seq = 1000,
            Properties = """{"title":"Target"}""",
            LifecycleState = ItemLifecycleState.Active,
            CreatedBy = Actor,
            LastModifiedBy = Actor,
            CreatedAt = DateTimeOffset.UnixEpoch,
            LastModifiedAt = DateTimeOffset.UnixEpoch,
        };
    }
}
