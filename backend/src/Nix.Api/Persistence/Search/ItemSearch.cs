using Nix.Abstractions;
using Nix.Domain.Items;
using Nix.Domain.Links;
using Nix.Domain.Tenancy;
using Nix.Persistence.Embeddings;
using Nix.Persistence.Locks;
using Nix.Persistence.Query;
using Nix.Persistence.Sql;
using Nix.Persistence.Sql.Statements;
using Npgsql;
using NpgsqlTypes;

namespace Nix.Persistence.Search;

/// <summary>
/// Finds items with Postgres's own text search: a trigram index over titles and a
/// <c>tsvector</c> over document text, joined in one statement.
/// </summary>
/// <remarks>
/// <para>
/// Both statements take the readable workspaces as an array parameter, so the permission filter is
/// evaluated by the planner alongside the tenant predicate rather than applied to rows after they
/// have been read, ranked and counted.
/// </para>
/// <para>
/// Results are materialised into a list rather than streamed, unlike most of what
/// <see cref="NixSqlExecutor"/> serves. The bound is the caller's <c>limit</c>, which is small by
/// construction - a palette shows twenty rows and a person reads about five - so the list is
/// tens of small records and never grows with the corpus.
/// </para>
/// </remarks>
public sealed class ItemSearch(
    NixSqlExecutor sql,
    INixSessionContextAccessor session,
    CredentialSessionContext credential,
    TimeProvider clock,
    LocalEmbedder embedder)
    : IItemSearch
{
    private readonly INixSessionContextAccessor _session = session;

    private TenantId Tenant => (_session.Current
        ?? throw new InvalidOperationException(
            "No session context has been established for this unit of work. A search runs on "
            + "behalf of a specific principal in a specific tenant; there is no anonymous path."))
        .TenantId;

    /// <inheritdoc />
    public async ValueTask<IReadOnlyList<ItemDigest>> FindAsync(
        string query,
        IReadOnlyList<WorkspaceId> readableWorkspaces,
        int limit,
        CancellationToken cancellationToken)
    {
        ArgumentNullException.ThrowIfNull(query);
        ArgumentNullException.ThrowIfNull(readableWorkspaces);

        if (readableWorkspaces.Count == 0)
        {
            // A principal who belongs to nowhere searches nothing. Returning early keeps that a
            // fact about their membership rather than a round trip that was always going to
            // return no rows.
            return [];
        }

        var rows = sql.QueryAsync<ItemDigest, DigestMapper>(
            SearchSql.MatchingItems,
            default,
            [
                Uuid("tenant_id", Tenant.Value),
                UuidArray("workspace_ids", readableWorkspaces),
                new NpgsqlParameter("title_pattern", NpgsqlDbType.Text) { Value = ContainsPattern(query) },
                new NpgsqlParameter("query", NpgsqlDbType.Text) { Value = query },
                new NpgsqlParameter("limit", NpgsqlDbType.Integer) { Value = limit },
                await LockFilterParameters.AllLocksAsync(sql, Tenant, cancellationToken).ConfigureAwait(false),
                await ClosedLocksAsync(cancellationToken).ConfigureAwait(false),
            ],
            cancellationToken);

        return await CollectAsync(rows, limit, cancellationToken).ConfigureAwait(false);
    }

    /// <inheritdoc />
    public async ValueTask<IReadOnlyList<ItemDigest>> ResolveAsync(
        IReadOnlyList<ItemId> itemIds,
        IReadOnlyList<WorkspaceId> readableWorkspaces,
        CancellationToken cancellationToken)
    {
        ArgumentNullException.ThrowIfNull(itemIds);
        ArgumentNullException.ThrowIfNull(readableWorkspaces);

        if (itemIds.Count == 0 || readableWorkspaces.Count == 0)
        {
            return [];
        }

        var rows = sql.QueryAsync<ItemDigest, DigestMapper>(
            SearchSql.ReadableItemsById,
            default,
            [
                Uuid("tenant_id", Tenant.Value),
                ItemIdArray("item_ids", itemIds),
                UuidArray("workspace_ids", readableWorkspaces),
            ],
            cancellationToken);

        return await CollectAsync(rows, itemIds.Count, cancellationToken).ConfigureAwait(false);
    }

    /// <inheritdoc />
    public async ValueTask<IReadOnlyList<NotePassage>> FindPassagesAsync(
        ItemId? rootId,
        string query,
        IReadOnlyList<WorkspaceId> readableWorkspaces,
        int limit,
        CancellationToken cancellationToken)
    {
        ArgumentNullException.ThrowIfNull(query);
        ArgumentNullException.ThrowIfNull(readableWorkspaces);

        if (readableWorkspaces.Count == 0 || string.IsNullOrWhiteSpace(query))
        {
            return [];
        }

        var vector = embedder.EmbedQuery(query);
        var locks = await LockFilterParameters.AllLocksAsync(sql, Tenant, cancellationToken).ConfigureAwait(false);

        // The root may be a whole workspace's top folder and the cosine arm scans every chunk under
        // it, so the read runs under the ad-hoc query timeout instead of holding a connection open.
        return await ItemQueryReader.GuardedAsync<IReadOnlyList<NotePassage>>(sql, async () =>
        {
            var rows = sql.QueryAsync<NotePassage, PassageMapper>(
                SearchSql.Passages,
                default,
                [
                    Uuid("tenant_id", Tenant.Value),
                    new NpgsqlParameter("root_id", NpgsqlDbType.Uuid) { Value = rootId is { } root ? root.Value : DBNull.Value },
                    UuidArray("workspace_ids", readableWorkspaces),
                    new NpgsqlParameter("query", NpgsqlDbType.Text) { Value = query },
                    new NpgsqlParameter("query_embedding", NpgsqlDbType.Text)
                    {
                        Value = vector is null ? DBNull.Value : LocalEmbedder.ToLiteral(vector),
                    },
                    new NpgsqlParameter("limit", NpgsqlDbType.Integer) { Value = limit },
                    locks,
                ],
                cancellationToken);

            var passages = new List<NotePassage>(limit);
            await foreach (var passage in rows.WithCancellation(cancellationToken).ConfigureAwait(false))
            {
                passages.Add(passage);
            }

            return passages;
        }, cancellationToken).ConfigureAwait(false);
    }

    /// <summary>
    /// The most title matches the mention statement probes for locks and visibility before
    /// ranking.
    /// </summary>
    /// <remarks>
    /// Ten times the largest mention result. It exists to bound what the planner may assume about
    /// an expression it has no statistics for; <see cref="SearchSql.ItemsTitledAs"/> records the
    /// measurement behind it.
    /// </remarks>
    internal const int MentionCandidateLimit = 200;

    /// <summary>The most items one phrase may contribute to a mention answer.</summary>
    /// <remarks>
    /// Applied before <see cref="MentionCandidateLimit"/>, so a title shared by hundreds of items
    /// ("Meeting notes", a date) cannot take every candidate slot. Three is enough to offer a
    /// choice between same-named notes; more would be a list nobody reads under one underline.
    /// </remarks>
    internal const int MentionsPerPhrase = 3;

    /// <inheritdoc />
    public async ValueTask<IReadOnlyList<TitleMention>> MentionsAsync(
        IReadOnlyList<string> phrases,
        IReadOnlyList<WorkspaceId> readableWorkspaces,
        IReadOnlyList<ItemId> excludedItems,
        int limit,
        CancellationToken cancellationToken)
    {
        ArgumentNullException.ThrowIfNull(phrases);
        ArgumentNullException.ThrowIfNull(readableWorkspaces);
        ArgumentNullException.ThrowIfNull(excludedItems);

        if (phrases.Count == 0 || readableWorkspaces.Count == 0)
        {
            return [];
        }

        var values = new string[phrases.Count];
        for (var index = 0; index < phrases.Count; index++)
        {
            values[index] = phrases[index];
        }

        var rows = sql.QueryAsync<TitleMention, MentionMapper>(
            SearchSql.ItemsTitledAs,
            default,
            [
                Uuid("tenant_id", Tenant.Value),
                UuidArray("workspace_ids", readableWorkspaces),
                new NpgsqlParameter("phrases", NpgsqlDbType.Array | NpgsqlDbType.Text) { Value = values },
                ItemIdArray("exclude_ids", excludedItems),
                new NpgsqlParameter("per_phrase_limit", NpgsqlDbType.Integer) { Value = MentionsPerPhrase },
                new NpgsqlParameter("candidate_limit", NpgsqlDbType.Integer)
                {
                    Value = Math.Max(limit, MentionCandidateLimit),
                },
                new NpgsqlParameter("limit", NpgsqlDbType.Integer) { Value = limit },
                await ClosedLocksAsync(cancellationToken).ConfigureAwait(false),
            ],
            cancellationToken);

        var mentions = new List<TitleMention>(limit);
        await foreach (var mention in rows.WithCancellation(cancellationToken).ConfigureAwait(false))
        {
            mentions.Add(mention);
        }

        return mentions;
    }

    /// <summary>
    /// Wraps a person's words in a containment pattern, with the pattern's own metacharacters
    /// neutralised.
    /// </summary>
    /// <remarks>
    /// <para>
    /// This is not an injection guard - the value is bound as a parameter and could not be one.
    /// It is a correctness guard: <c>%</c> and <c>_</c> mean something to <c>ILIKE</c>, so
    /// somebody searching for a literal underscore in a filename would otherwise get every title
    /// with any character in that position, and somebody who typed a stray <c>%</c> would match
    /// every item in the tenant.
    /// </para>
    /// <para>
    /// The backslash is escaped first and deliberately. Doing it after the others would go back
    /// over the backslashes they just introduced and double them, so a search for <c>a_b</c> would
    /// come out looking for a literal backslash. The statement names <c>ESCAPE '\'</c> to match.
    /// </para>
    /// </remarks>
    internal static string ContainsPattern(string query) =>
        string.Concat(
            "%",
            query.Replace("\\", "\\\\", StringComparison.Ordinal)
                .Replace("%", "\\%", StringComparison.Ordinal)
                .Replace("_", "\\_", StringComparison.Ordinal),
            "%");

    private static async ValueTask<IReadOnlyList<ItemDigest>> CollectAsync(
        IAsyncEnumerable<ItemDigest> rows,
        int expected,
        CancellationToken cancellationToken)
    {
        var digests = new List<ItemDigest>(expected);
        await foreach (var digest in rows.WithCancellation(cancellationToken).ConfigureAwait(false))
        {
            digests.Add(digest);
        }

        return digests;
    }

    private ValueTask<NpgsqlParameter> ClosedLocksAsync(CancellationToken cancellationToken) =>
        LockFilterParameters.ClosedLocksAsync(sql, Tenant, credential, clock, cancellationToken);

    private static NpgsqlParameter Uuid(string name, Guid value) =>
        new(name, NpgsqlDbType.Uuid) { Value = value };

    private static NpgsqlParameter ItemIdArray(string name, IReadOnlyList<ItemId> values)
    {
        var identifiers = new Guid[values.Count];
        for (var index = 0; index < values.Count; index++)
        {
            identifiers[index] = values[index].Value;
        }

        return new NpgsqlParameter(name, NpgsqlDbType.Array | NpgsqlDbType.Uuid) { Value = identifiers };
    }

    private static NpgsqlParameter UuidArray(string name, IReadOnlyList<WorkspaceId> values)
    {
        var identifiers = new Guid[values.Count];
        for (var index = 0; index < values.Count; index++)
        {
            identifiers[index] = values[index].Value;
        }

        return new NpgsqlParameter(name, NpgsqlDbType.Array | NpgsqlDbType.Uuid) { Value = identifiers };
    }

    /// <summary>Reads the digest columns every item listing projects.</summary>
    /// <remarks>
    /// A struct so the query loop devirtualises and allocates nothing per row beyond the record
    /// itself. The column contract lives in <see cref="ItemDigestColumns"/>.
    /// </remarks>
    private readonly struct DigestMapper : INixRowMapper<ItemDigest>
    {
        /// <inheritdoc />
        public ItemDigest Map(NpgsqlDataReader reader) => ItemDigestColumns.Read(reader);
    }

    /// <summary>Reads a passage row of <see cref="SearchSql.SubtreePassages"/>.</summary>
    private readonly struct PassageMapper : INixRowMapper<NotePassage>
    {
        /// <inheritdoc />
        public NotePassage Map(NpgsqlDataReader reader)
        {
            ArgumentNullException.ThrowIfNull(reader);

            return new NotePassage(
                ItemId.From(reader.GetGuid(0)),
                reader.GetString(1),
                reader.GetString(2),
                reader.GetInt32(3),
                reader.GetString(4));
        }
    }

    /// <summary>Reads a title match and the phrase it matched.</summary>
    /// <remarks>A struct so the query loop devirtualises and allocates nothing per row.</remarks>
    private readonly struct MentionMapper : INixRowMapper<TitleMention>
    {
        /// <inheritdoc />
        public TitleMention Map(NpgsqlDataReader reader)
        {
            ArgumentNullException.ThrowIfNull(reader);

            return new TitleMention(ItemDigestColumns.Read(reader), reader.GetString(ItemDigestColumns.Count));
        }
    }
}
