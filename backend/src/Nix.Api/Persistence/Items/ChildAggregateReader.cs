using System.Collections.Frozen;
using System.Globalization;
using Nix.Abstractions;
using Nix.Domain.Items;
using Nix.Domain.Properties;
using Nix.Domain.Tenancy;
using Nix.Persistence.Locks;
using Nix.Persistence.Sql;
using Nix.Persistence.Sql.Statements;
using Npgsql;
using NpgsqlTypes;

namespace Nix.Persistence.Items;

/// <summary>
/// Folds children over Postgres: the rollup reduction and the chart bucketing, in one place.
/// </summary>
/// <remarks>
/// <para>
/// Hand-written SQL rather than LINQ, per the data-access rule and for the reason
/// <see cref="RollupSql"/> states: this is an aggregate whose plan has to be legible, and the
/// expression tree that would produce it helps nobody read it.
/// </para>
/// <para>
/// <b>Tenant-bound as well as row-level-security-scoped.</b> The policy would filter anyway; the
/// explicit predicate is what lets the planner use an index condition rather than evaluating the
/// policy per row, and it is the defence in depth the security model asks for.
/// </para>
/// </remarks>
public sealed class ChildAggregateReader(
    NixSqlExecutor sql,
    INixSessionContextAccessor session,
    CredentialSessionContext credential,
    TimeProvider clock)
    : IChildAggregates
{
    /// <summary>The most buckets a chart read will return, whatever was asked for.</summary>
    /// <remarks>
    /// A ceiling rather than a refusal, the same posture <c>ListItemsHandler</c> takes: a grouping
    /// property that is not a declared list can take a distinct value per child, and a chart of
    /// three thousand bars is a chart nobody can read as well as a response nobody should be sent.
    /// The read reports how many buckets there really are, so the view says it was truncated
    /// instead of drawing the top few as though they were all of them.
    /// </remarks>
    public const int MaximumBuckets = 100;

    private readonly INixSessionContextAccessor _session = session;

    private TenantId Tenant => _session.Current?.TenantId
        ?? throw new InvalidOperationException(
            "No session context has been established for this unit of work. Folding children "
            + "reads tenant-scoped rows and there is no unscoped path.");

    /// <inheritdoc />
    public async ValueTask<IReadOnlyDictionary<ChildAggregateKey, ChildAggregate>> FoldAsync(
        WorkspaceId workspaceId,
        IReadOnlyList<ItemId> parents,
        IReadOnlyList<string> keys,
        CancellationToken cancellationToken)
    {
        ArgumentNullException.ThrowIfNull(parents);
        ArgumentNullException.ThrowIfNull(keys);

        if (parents.Count == 0 || keys.Count == 0)
        {
            return EmptyFold;
        }

        var parentIds = new Guid[parents.Count];
        for (var index = 0; index < parents.Count; index++)
        {
            parentIds[index] = parents[index].Value;
        }

        var propertyKeys = new string[keys.Count];
        for (var index = 0; index < keys.Count; index++)
        {
            propertyKeys[index] = keys[index];
        }

        var folds = new Dictionary<ChildAggregateKey, ChildAggregate>(parents.Count * keys.Count);

        var rows = sql.QueryAsync<FoldRow, FoldRowMapper>(
            RollupSql.AggregateChildProperties,
            default,
            [
                Uuid("tenant_id", Tenant.Value),
                Uuid("workspace_id", workspaceId.Value),
                UuidArray("parent_ids", parentIds),
                TextArray("keys", propertyKeys),
                await LockFilterParameters.ClosedLocksAsync(sql, Tenant, credential, clock, cancellationToken).ConfigureAwait(false),
            ],
            cancellationToken);

        await foreach (var row in rows.ConfigureAwait(false))
        {
            folds[new ChildAggregateKey(ItemId.From(row.Parent), row.Key)] = row.Aggregate;
        }

        return folds;
    }

    /// <inheritdoc />
    public async ValueTask<ChildBuckets> BucketAsync(
        WorkspaceId workspaceId,
        ItemId parent,
        string groupKey,
        string? measureKey,
        int limit,
        CancellationToken cancellationToken)
    {
        ArgumentException.ThrowIfNullOrEmpty(groupKey);

        var capped = Math.Clamp(limit, 1, MaximumBuckets);

        var buckets = new List<ChildBucket>(Math.Min(capped, 16));
        long distinct = 0;
        long children = 0;

        var rows = sql.QueryAsync<BucketRow, BucketRowMapper>(
            RollupSql.BucketChildrenByProperty,
            default,
            [
                Uuid("tenant_id", Tenant.Value),
                Uuid("workspace_id", workspaceId.Value),
                Uuid("parent_id", parent.Value),
                Text("group_key", groupKey),

                // A measure is optional, and an absent one binds null rather than the group key:
                // `jsonb -> NULL` is null, so the sum folds over nothing and answers nothing.
                // Binding the group key instead would have Postgres total the property the chart
                // is grouping by and the reader throw the answer away - and would drag that
                // property through the numeric bound for no reason.
                NullableText("measure_key", measureKey),
                Int("limit", capped),
            ],
            cancellationToken);

        await foreach (var row in rows.ConfigureAwait(false))
        {
            distinct = row.Distinct;
            children = row.AllChildren;
            buckets.Add(new ChildBucket(
                row.Value,
                row.Children,
                measureKey is null ? null : row.Total));
        }

        return new ChildBuckets(buckets, distinct, children);
    }

    /// <inheritdoc />
    public async ValueTask<ChildCells> BucketBySeriesAsync(
        WorkspaceId workspaceId,
        ItemId parent,
        string groupKey,
        string splitKey,
        string? measureKey,
        int seriesLimit,
        int bucketLimit,
        int cellLimit,
        CancellationToken cancellationToken)
    {
        ArgumentException.ThrowIfNullOrEmpty(groupKey);
        ArgumentException.ThrowIfNullOrEmpty(splitKey);

        var cells = Math.Clamp(cellLimit, 1, MaximumCells);

        var read = new List<ChildCell>(Math.Min(cells, 64));
        long distinct = 0;
        long children = 0;
        long kept = 0;
        long series = 0;

        var rows = sql.QueryAsync<SeriesCellRow, SeriesCellRowMapper>(
            RollupSql.BucketChildrenByPropertyAndSeries,
            default,
            [
                Uuid("tenant_id", Tenant.Value),
                Uuid("workspace_id", workspaceId.Value),
                Uuid("parent_id", parent.Value),
                Text("group_key", groupKey),
                Text("split_key", splitKey),

                // Null rather than the group key, for the reason BucketAsync gives.
                NullableText("measure_key", measureKey),
                Int("series_limit", Math.Clamp(seriesLimit, 1, MaximumSeries)),
                Int("bucket_limit", Math.Clamp(bucketLimit, 1, MaximumBuckets)),
                Int("cell_limit", cells),
            ],
            cancellationToken);

        await foreach (var row in rows.ConfigureAwait(false))
        {
            distinct = row.Buckets;
            kept = row.KeptCells;
            children = row.AllChildren;
            series = row.SeriesCount;
            read.Add(new ChildCell(
                row.Bucket,
                row.Series,
                row.Children,
                measureKey is null ? null : row.Total,
                row.Other));
        }

        return new ChildCells(read, children, distinct, kept > read.Count, SeriesValues: series);
    }

    /// <inheritdoc />
    public async ValueTask<ChildCells> BucketByDayAsync(
        WorkspaceId workspaceId,
        ItemId parent,
        string dateKey,
        string? splitKey,
        string? measureKey,
        DateOnly? firstDay,
        DateOnly? lastDay,
        int seriesLimit,
        int cellLimit,
        CancellationToken cancellationToken)
    {
        ArgumentException.ThrowIfNullOrEmpty(dateKey);

        var cells = Math.Clamp(cellLimit, 1, MaximumCells);

        var read = new List<ChildCell>(Math.Min(cells, 64));
        long children = 0;
        long total = 0;
        long outside = 0;
        long series = 0;
        var rowsRead = 0;

        var rows = sql.QueryAsync<DayCellRow, DayCellRowMapper>(
            RollupSql.BucketChildrenByDay,
            default,
            [
                Uuid("tenant_id", Tenant.Value),
                Uuid("workspace_id", workspaceId.Value),
                Uuid("parent_id", parent.Value),
                Text("group_key", dateKey),
                NullableText("split_key", splitKey),
                NullableText("measure_key", measureKey),
                NullableText("from_day", firstDay?.ToString("yyyy-MM-dd", CultureInfo.InvariantCulture)),
                NullableText("to_day", lastDay?.ToString("yyyy-MM-dd", CultureInfo.InvariantCulture)),
                Int("series_limit", Math.Clamp(seriesLimit, 1, MaximumSeries)),
                Int("cell_limit", cells),
            ],
            cancellationToken);

        await foreach (var row in rows.ConfigureAwait(false))
        {
            rowsRead++;
            total = row.Cells;
            children = row.AllChildren;
            series = row.SeriesCount;

            // Outside the window is a count, not a cell: it is in no period the chart draws.
            if (row.Outside)
            {
                outside += row.Children;
                continue;
            }

            read.Add(new ChildCell(
                row.Bucket,
                row.Series,
                row.Children,
                measureKey is null ? null : row.Total,
                row.Other));
        }

        return new ChildCells(
            read,
            children - outside,
            DistinctBuckets: null,
            total > rowsRead,
            outside,
            series);
    }

    /// <summary>The most series a split read names before folding the rest into Other.</summary>
    public const int MaximumSeries = 12;

    /// <summary>The most cells a series or day read will return, whatever was asked for.</summary>
    /// <remarks>
    /// A row is a few dozen bytes, so this bounds a response's memory near half a megabyte. It is
    /// generous on purpose - a year of days split twelve ways is under five thousand - and only a
    /// container with decades of daily entries and no window ever meets it, in which case the reader
    /// says it was cut and the oldest periods are the ones left out.
    /// </remarks>
    public const int MaximumCells = 10_000;

    /// <summary>
    /// Frozen rather than an empty <c>Dictionary</c>: published behind a read-only interface, a
    /// mutable static can be downcast and filled by anybody who takes the shortcut once.
    /// </summary>
    private static readonly FrozenDictionary<ChildAggregateKey, ChildAggregate> EmptyFold =
        FrozenDictionary<ChildAggregateKey, ChildAggregate>.Empty;

    private static NpgsqlParameter Uuid(string name, Guid value) =>
        new(name, NpgsqlDbType.Uuid) { Value = value };

    private static NpgsqlParameter UuidArray(string name, Guid[] values) =>
        new(name, NpgsqlDbType.Uuid | NpgsqlDbType.Array) { Value = values };

    private static NpgsqlParameter TextArray(string name, string[] values) =>
        new(name, NpgsqlDbType.Text | NpgsqlDbType.Array) { Value = values };

    private static NpgsqlParameter Text(string name, string value) =>
        new(name, NpgsqlDbType.Text) { Value = value };

    private static NpgsqlParameter NullableText(string name, string? value) =>
        new(name, NpgsqlDbType.Text) { Value = value is null ? DBNull.Value : value };

    private static NpgsqlParameter Int(string name, int value) =>
        new(name, NpgsqlDbType.Integer) { Value = value };

    private readonly record struct FoldRow(Guid Parent, string Key, ChildAggregate Aggregate);

    /// <summary>Reads one folded (parent, property) row.</summary>
    /// <remarks>A struct so the query loop devirtualises and nothing is allocated per row.</remarks>
    private readonly struct FoldRowMapper : INixRowMapper<FoldRow>
    {
        /// <inheritdoc />
        public FoldRow Map(NpgsqlDataReader reader)
        {
            ArgumentNullException.ThrowIfNull(reader);

            return new FoldRow(
                reader.GetGuid(0),
                reader.GetString(1),
                new ChildAggregate(
                    reader.GetInt64(2),
                    reader.GetInt64(3),
                    reader.GetInt64(4),
                    NullableDecimal(reader, 5),
                    NullableDecimal(reader, 6),
                    NullableDecimal(reader, 7),
                    reader.GetInt64(8),
                    reader.GetInt64(9)));
        }

        private static decimal? NullableDecimal(NpgsqlDataReader reader, int ordinal) =>
            reader.IsDBNull(ordinal) ? null : reader.GetDecimal(ordinal);
    }

    private readonly record struct SeriesCellRow(
        string? Bucket,
        string? Series,
        bool Other,
        long Children,
        decimal? Total,
        long Buckets,
        long KeptCells,
        long AllChildren,
        long SeriesCount);

    /// <summary>Reads one (bucket, series) cell.</summary>
    private readonly struct SeriesCellRowMapper : INixRowMapper<SeriesCellRow>
    {
        /// <inheritdoc />
        public SeriesCellRow Map(NpgsqlDataReader reader)
        {
            ArgumentNullException.ThrowIfNull(reader);

            return new SeriesCellRow(
                reader.IsDBNull(0) ? null : reader.GetString(0),
                reader.IsDBNull(1) ? null : reader.GetString(1),
                reader.GetBoolean(2),
                reader.GetInt64(3),
                reader.IsDBNull(4) ? null : reader.GetDecimal(4),
                reader.GetInt64(5),
                reader.GetInt64(6),
                reader.GetInt64(7),
                reader.GetInt64(8));
        }
    }

    private readonly record struct DayCellRow(
        string? Bucket,
        string? Series,
        bool Other,
        bool Outside,
        long Children,
        decimal? Total,
        long Cells,
        long AllChildren,
        long SeriesCount);

    /// <summary>Reads one (day, series) cell.</summary>
    private readonly struct DayCellRowMapper : INixRowMapper<DayCellRow>
    {
        /// <inheritdoc />
        public DayCellRow Map(NpgsqlDataReader reader)
        {
            ArgumentNullException.ThrowIfNull(reader);

            return new DayCellRow(
                reader.IsDBNull(0) ? null : reader.GetString(0),
                reader.IsDBNull(1) ? null : reader.GetString(1),
                reader.GetBoolean(2),
                reader.GetBoolean(3),
                reader.GetInt64(4),
                reader.IsDBNull(5) ? null : reader.GetDecimal(5),
                reader.GetInt64(6),
                reader.GetInt64(7),
                reader.GetInt64(8));
        }
    }

    private readonly record struct BucketRow(
        string? Value,
        long Children,
        decimal? Total,
        long Distinct,
        long AllChildren);

    /// <summary>Reads one chart bucket.</summary>
    private readonly struct BucketRowMapper : INixRowMapper<BucketRow>
    {
        /// <inheritdoc />
        public BucketRow Map(NpgsqlDataReader reader)
        {
            ArgumentNullException.ThrowIfNull(reader);

            return new BucketRow(
                reader.IsDBNull(0) ? null : reader.GetString(0),
                reader.GetInt64(1),
                reader.IsDBNull(2) ? null : reader.GetDecimal(2),
                reader.GetInt64(3),
                reader.GetInt64(4));
        }
    }
}
