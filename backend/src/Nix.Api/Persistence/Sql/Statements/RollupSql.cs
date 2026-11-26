namespace Nix.Persistence.Sql.Statements;

/// <summary>
/// Aggregates over an item's children: what a rollup property reduces to, and what a chart groups.
/// </summary>
/// <remarks>
/// <para>
/// <b>Hand-written because a rollup is an aggregate, and an aggregate belongs where the rows
/// are.</b> The alternative is the client fetching every child of every item it draws a rollup for,
/// which the stress row (2.5) puts at 3,000+ children per container and which is not expressible at
/// all for a list of a hundred items each showing one. ADR-0044 records the split.
/// </para>
/// <para>
/// <b>One statement for a whole page, and for every rollup on it.</b> The parents come in as an
/// array and the property keys come in as a second array, so a page of fifty items declaring three
/// rollups is one query, not a hundred and fifty. Each parent's children are read once and fanned
/// out per key inside, rather than once per key.
/// </para>
/// <para>
/// <b>The lateral is the shape, and it is there because the measurement said so.</b> Written as a
/// plain join from <c>unnest(@parent_ids)</c> to <c>item</c>, the planner hashed the fifty parents
/// and read the whole workspace: over a 120,000-child corpus it chose a parallel sequential scan
/// and touched every row to answer a question about a tenth of them. That plan is not wrong at that
/// size - it is wrong at the next size, because its cost grows with the workspace rather than with
/// the page. A lateral subquery carrying an aggregate cannot be hoisted into a hash join, so the
/// parents drive: one index range per parent, and the cost of drawing a page depends on what is
/// under the page. <c>RollupPlanEvidenceTests</c> holds both halves of that.
/// </para>
/// <para>
/// <b>Every reduction is computed in the same pass, and the caller picks the one its property
/// declared.</b> The alternative - a statement per aggregate, or SQL assembled from the aggregate
/// name - would either multiply the scans or interpolate a value into statement text, and the
/// second is the thing this codebase does not do. The extra aggregates are folds over rows already
/// being scanned; they cost arithmetic, not I/O.
/// </para>
/// <para>
/// <b>Types are checked in jsonb rather than cast hopefully.</b> A property value is
/// client-influenced data, and <c>(properties->>'estimate')::numeric</c> over a bag where one row
/// holds the text "soon" fails the whole statement - one bad value would cost every rollup on the
/// page. <c>jsonb_typeof</c> guards each cast, so a value of the wrong shape is not counted rather
/// than fatal, which is the same posture <c>ItemMapping.ReadProperties</c> takes for the same
/// reason. Absence is told from an explicit null the same way: <c>jsonb_typeof</c> answers SQL null
/// for a key the bag does not carry and the text <c>null</c> for one it carries as null, and
/// neither counts as a value.
/// </para>
/// <para>
/// <b>Magnitude is bounded as well as kind, and that is a crash rather than a tidiness rule.</b>
/// Postgres <c>numeric</c> is arbitrary precision and <see cref="decimal"/> is not, so a value the
/// property validator accepts - it admits anything that reads as a <c>double</c>, which includes
/// <c>1e308</c> - would reach the reader as a number that does not fit and throw. Measured in the
/// review of goal 2.2 against the pinned driver: one child holding <c>1e308</c>, or twenty each
/// holding a perfectly ordinary <c>1e28</c>, both raise <c>OverflowException</c> - and the blast
/// radius is not the rollup but the whole of <c>GET /workspaces/{id}/items</c>, as an opaque 500.
/// One person typing one number would break the listing of a container for everyone.
/// <para>
/// So each value is counted only when it is within 1e15, and the sum only when the total is within
/// 1e28. A value outside the bound is not counted rather than fatal, exactly as a value of the
/// wrong kind is not - the same posture, extended from kind to size. A sum that overflows answers
/// null, which <see cref="Nix.Domain.Properties.ChildAggregate"/> publishes as "no answer" rather
/// than as a zero somebody would act on. The remaining half of the fix belongs in
/// <c>PropertyValidator</c>, where an unrepresentable number should not be storable at all; that
/// is a change to what every Number property accepts and is recorded as owed rather than smuggled
/// in here.
/// </para>
/// </para>
/// <para>
/// <b>The <c>?</c> containment operator is deliberately not used</b>, though it would read more
/// directly. It is the one jsonb operator whose spelling collides with a parameter placeholder in
/// several drivers, and a statement that works until somebody changes how parameters are bound is
/// a statement waiting to break for a reason nobody would look for here.
/// </para>
/// <para>
/// <b>Tenant-parameterised as well as row-level-security-scoped</b>, defence in depth as the
/// security model requires and what lets the planner use an index condition rather than evaluating
/// the policy per row. Deleted and template rows are excluded here rather than filtered afterwards:
/// a rollup that counted a deleted child would disagree with the list drawn beside it.
/// </para>
/// <para>
/// <b>Derived visibility is checked on the parent, not on each child, and the two are the same
/// question.</b> A child's proper ancestors are its parent plus its parent's - so asking whether
/// the parent's own path is entirely active answers it for every child of that parent at once, in
/// fifty probes rather than fifteen thousand. That is why the probe reads
/// <c>visibility_edge.depth &gt;= 0</c> where every other bulk read reads <c>&gt; 0</c>: the anchor
/// here is the parent, whose own lifecycle is one of the facts a child's visibility depends on.
/// </para>
/// <para>
/// <b>The same goes for a locked one.</b> A container covered by a lock this credential has not
/// opened folds to nothing, so a count or a total cannot describe children the lock withholds.
/// </para>
/// <para>
/// <b>Without it, a deleted container discloses its children by aggregate.</b>
/// <c>GET /workspaces/{id}/items?includeDeleted=true</c> is an ordinary read and its page can carry
/// a deleted item; the fold would then answer count, sum, minimum, maximum and average over that
/// item's still-active children - rows every other endpoint refuses, since a point read of one is
/// a 404 and listing them is a refused parent. A minimum and a maximum are not counts: they are
/// exact stored values of particular hidden rows. Found in the security review of goal 2.2; the
/// six bulk reads that <c>03db4db</c> corrected carry the same predicate for the same reason, and
/// <c>BulkItemVisibilityStatementTests</c> is where a seventh that forgets it is caught.
/// </para>
/// <para>
/// <b>Index dependency, as measured rather than as hoped: <c>IX_item_tenant_id_parent_id</c></b>,
/// one index range per parent. Not <c>IX_item_workspace_id_parent_id_seq</c>, which this comment
/// named first and which the planner does not choose - the lateral's condition is on the tenant and
/// the parent, and the workspace is a filter on top. <c>RollupPlanEvidenceTests</c> captures and
/// explains the production command under the runtime role and RLS.
/// </para>
/// <para>
/// <b>What the lateral costs, and why it is still right.</b> Measured over the 120,000-child corpus,
/// folding 50 containers of 300 children each - a page wanting an eighth of the workspace, which is
/// dense for a real one: the sequential plan ran in 23.5 ms over 4,054 buffers and the lateral in
/// 39.7 ms over 15,100. The lateral is the slower of the two <em>at that size</em>, because an index
/// path pays about a buffer per row where a sequential scan gets thirty rows to a page. It is the
/// right one anyway: its cost is a function of what is under the page, and the other's is a function
/// of how big the workspace has become. The first is a number that stays where it is; the second is
/// the one that ends a phase.
/// </para>
/// <para>
/// <b>The per-key fan-out is a tuplestore, not an extra read, and its cost is temp I/O rather than
/// buffers.</b> Postgres puts <c>unnest(@keys)</c> on the outer side of the inner nested loop and
/// stacks a <c>Materialize</c> over the index scan, so the children are read once per parent and
/// replayed from a tuplestore once per key. Measured in the review of goal 2.2: 50 parents x 300
/// children x 2 keys costs 15,100 buffers whether there are one or two keys - the second key is
/// free in I/O. What it is not free in is memory: the tuplestore holds whole child tuples, so a
/// container of 3,000 children whose property bags sit just under the TOAST threshold (~1.4 KB,
/// which is an ordinary item with a few text properties) spilled 4.4 MB of temp per parent at
/// three keys, where the same corpus at one key built no tuplestore at all. A bag large enough to
/// TOAST does not spill, because the tuplestore then holds a pointer - so the hazard is the middle
/// size, not the large one.
/// </para>
/// <para>
/// <b>Which is a real trade and is taken deliberately.</b> The alternative measured to help is one
/// execution per key - one to three statements per page instead of one, each with every parent, no
/// <c>Materialize</c> and no temp. That is the shape to move to if a schema's rollup count grows;
/// it is not taken now because it multiplies the round trips for the one-to-three-key case that
/// every real schema has, and because the spill needs a container of thousands to appear at all.
/// The number to beat if it is revisited: zero temp blocks for 3,000 children x 3 keys, against
/// 548 written and 1,096 read today.
/// </para>
/// </remarks>
public static class RollupSql
{
    /// <summary>A child's value for the key being folded, read through the shared guard.</summary>
    private static readonly string ChildNumber = NumberSql.Bounded("c.properties", "k.key");

    /// <summary>A chart's measure, read through the same guard as queries and child folds.</summary>
    private static readonly string ChartNumber = NumberSql.Bounded("c.properties", "@measure_key");

    /// <summary>
    /// Every reduction of every named property, over the children of each of the given parents.
    /// </summary>
    /// <remarks>
    /// Columns, in order: the parent, the property key, how many children the parent has, how many
    /// of them carry a value for that key, and then the numeric fold (count of numbers, sum, min,
    /// max) and the boolean fold (count of booleans, count of true ones). A parent with no children
    /// produces no row at all, so the answer is the size of what was found rather than the size of
    /// what was asked.
    /// </remarks>
    public static readonly string AggregateChildProperties = $"""
        SELECT container.id AS parent_id,
               fold.key,
               fold.children,
               fold.present,
               fold.numbers,
               fold.total,
               fold.smallest,
               fold.largest,
               fold.booleans,
               fold.truths
        FROM unnest(@parent_ids) AS container(id)
        CROSS JOIN LATERAL (
            SELECT k.key,
                   count(*) AS children,
                   count(*) FILTER (
                       WHERE jsonb_typeof(c.properties -> k.key) IS NOT NULL
                         AND jsonb_typeof(c.properties -> k.key) <> 'null'
                   ) AS present,
                   count({ChildNumber}) AS numbers,
                   {NumberSql.CappedSum(ChildNumber)} AS total,
                   min({ChildNumber}) AS smallest,
                   max({ChildNumber}) AS largest,
                   count(*) FILTER (WHERE jsonb_typeof(c.properties -> k.key) = 'boolean') AS booleans,
                   count(*) FILTER (WHERE c.properties -> k.key = 'true'::jsonb) AS truths
            FROM item AS c
            CROSS JOIN unnest(@keys) AS k(key)
            WHERE c.tenant_id = @tenant_id
              AND c.workspace_id = @workspace_id
              AND c.parent_id = container.id
              AND c.lifecycle_state = 'active'
              AND c.template_id IS NULL
              AND c.type <> 'message'
            GROUP BY k.key
        ) AS fold
        WHERE {ItemVisibilitySql.NoHiddenStoredAncestor("container.id", includeSelf: true)}
          AND {ItemLockSql.ContainerIsOpen}
        """;

    /// <summary>
    /// The children of one item, bucketed by one property's value, counted and summed.
    /// </summary>
    /// <remarks>
    /// <para>
    /// What a chart draws (goal 2.3). Server-side for the reason the rollup above is: a chart over
    /// a container whose children the client has only partly loaded would be a picture of the first
    /// page presented as a picture of the whole, which is exactly the dishonest state the UI rules
    /// forbid.
    /// </para>
    /// <para>
    /// The bucket key is the grouping property's value as text, with children that have none
    /// collected under a null key rather than dropped - "unset" is a real and often large bucket,
    /// and a chart that hid it would misreport every proportion on it.
    /// </para>
    /// <para>
    /// Totals use six decimal places, as workspace query aggregates do, so even a stored number
    /// with a scale beyond <see cref="decimal"/> can be read after folding.
    /// </para>
    /// <para>
    /// <b>Ordered and bounded here rather than by the caller.</b> A grouping property whose values
    /// are not a declared list can produce a bucket per child; the limit is what stops a chart
    /// request over a free-text column from returning a row per item. The caller is told the total
    /// number of distinct buckets separately so it can say the chart was truncated instead of
    /// quietly drawing the top few as if they were all of them.
    /// </para>
    /// </remarks>
    public static readonly string BucketChildrenByProperty = $"""
        SELECT c.properties ->> @group_key AS bucket,
               count(*) AS children,
               round({NumberSql.CappedSum(ChartNumber)}, 6) AS total,
               count(*) OVER () AS buckets,
               sum(count(*)) OVER () AS all_children
        FROM item AS c
        WHERE c.tenant_id = @tenant_id
          AND c.workspace_id = @workspace_id
          AND c.parent_id = @parent_id
          AND c.lifecycle_state = 'active'
          AND c.template_id IS NULL
          AND c.type <> 'message'
          AND {ItemVisibilitySql.NoHiddenStoredAncestor("@parent_id", includeSelf: true)}
        GROUP BY c.properties ->> @group_key
        ORDER BY count(*) DESC, bucket ASC NULLS LAST
        LIMIT @limit
        """;

    /// <summary>
    /// The children of one item, bucketed by one property's value and split by a second, counted
    /// and summed per (bucket, series) cell, with every series past the cap folded into one.
    /// </summary>
    /// <remarks>
    /// <para>
    /// What a chart of categories split into series draws (plan 2.3). The same children, the same
    /// visibility rule and the same bounded total as <see cref="BucketChildrenByProperty"/>; a
    /// missing value is its own bucket and its own series, for the reason that statement gives.
    /// </para>
    /// <para>
    /// <b>Series are capped here, not in the application.</b> Series are ranked by how many children
    /// carry them across the whole container, and every one past <c>@series_limit</c> is folded into
    /// a single row per bucket flagged <c>other</c> - so a split by a property with a value per child
    /// returns at most buckets times (cap + 1) rows rather than one per child. <c>series_count</c>
    /// says how many series exist, so the caller can report how many the Other row stands for.
    /// </para>
    /// <para>
    /// <b>Bounded by bucket, not by cell.</b> Buckets are ranked by how many children they hold, and
    /// only the largest <c>@bucket_limit</c> are returned whole, with every series cell they have.
    /// <c>buckets</c> carries how many buckets exist; <c>kept_cells</c> is counted after the bucket
    /// filter and before <c>@cell_limit</c>, so a read the cell ceiling cut short says so.
    /// </para>
    /// <para>
    /// Cost scales with the container's children: every child is read once, through the parent
    /// index, whatever the limits are. The limits bound the work after that and the payload.
    /// </para>
    /// <para>
    /// Match null series through two equality keys: coalesced text and a separate null flag.
    /// Postgres cannot hash an IS NOT DISTINCT FROM join, which otherwise compares every child
    /// with every ranked series on a high-cardinality split. The null flag keeps an unset series
    /// distinct from an empty string while allowing a hash join.
    /// </para>
    /// </remarks>
    public static readonly string BucketChildrenByPropertyAndSeries = $"""
        WITH cell AS (
            SELECT c.properties ->> @group_key AS bucket,
                   c.properties ->> @split_key AS series,
                   {ChartNumber} AS measure
            FROM item AS c
            WHERE c.tenant_id = @tenant_id
              AND c.workspace_id = @workspace_id
              AND c.parent_id = @parent_id
              AND c.lifecycle_state = 'active'
              AND c.template_id IS NULL
              AND c.type <> 'message'
              AND {ItemVisibilitySql.NoHiddenStoredAncestor("@parent_id", includeSelf: true)}
        ),
        series_ranked AS (
            SELECT cell.series,
                   dense_rank() OVER (ORDER BY count(*) DESC, cell.series ASC NULLS LAST) AS series_rank
            FROM cell
            GROUP BY cell.series
        ),
        folded AS (
            SELECT cell.bucket,
                   CASE WHEN ranked_series.series_rank > @series_limit THEN NULL ELSE cell.series END AS series,
                   ranked_series.series_rank > @series_limit AS other,
                   count(*) AS children,
                   round({NumberSql.CappedSum("cell.measure")}, 6) AS total,
                   sum(count(*)) OVER (PARTITION BY cell.bucket)::bigint AS bucket_children,
                   sum(count(*)) OVER ()::bigint AS all_children
            FROM cell
            JOIN series_ranked AS ranked_series
              ON coalesce(ranked_series.series, '') = coalesce(cell.series, '')
             AND (ranked_series.series IS NULL) = (cell.series IS NULL)
            GROUP BY 1, 2, 3
        ),
        ranked AS (
            SELECT folded.*,
                   dense_rank() OVER (
                       ORDER BY folded.bucket_children DESC, folded.bucket ASC NULLS LAST) AS bucket_rank
            FROM folded
        ),
        counted AS (
            SELECT ranked.*, max(ranked.bucket_rank) OVER () AS buckets
            FROM ranked
        )
        SELECT counted.bucket,
               counted.series,
               counted.other,
               counted.children,
               counted.total,
               counted.buckets,
               count(*) OVER () AS kept_cells,
               counted.all_children,
               (SELECT count(*) FROM series_ranked) AS series_count
        FROM counted
        WHERE counted.bucket_rank <= @bucket_limit
        ORDER BY counted.bucket_rank, counted.other, counted.series ASC NULLS LAST
        LIMIT @cell_limit
        """;

    /// <summary>
    /// The children of one item, bucketed by the day a date property names, optionally split by a
    /// second property, counted and summed per (day, series) cell.
    /// </summary>
    /// <remarks>
    /// <para>
    /// What a chart on a time axis draws (plan 2.2). Days rather than periods, deliberately: the
    /// period arithmetic - which week a day is in - lives once in <c>DatePeriods</c>, which folds
    /// these rows, so the database and the application cannot disagree about where a week starts.
    /// The day is the value's leading <c>yyyy-MM-dd</c>: a date is exactly that, and a stored
    /// timestamp's date part is the local day it was written on, which is the day the person
    /// meant. A value with no such prefix, or one that is not a real date (<c>2026-13-01</c>), is
    /// undated: collected under a null day and reported as unplaced rather than dropped, whatever
    /// the window - a chart that silently lost every undated item would misreport its own total.
    /// </para>
    /// <para>
    /// <b>The window bounds the work and the payload, not the read.</b> Every child of the
    /// container is read once through the parent index, so cost scales with the container's
    /// children. Dated children outside the window are not dropped either: they are counted into a
    /// single row flagged <c>outside</c>, so a chart whose items all fall elsewhere can say so
    /// rather than look empty. Compared as text under the C collation, where same-length ISO dates
    /// sort as dates.
    /// </para>
    /// <para>
    /// <b>Series are capped here</b>, ranked by children across the window, the rest folded into
    /// one row per day flagged <c>other</c>, for the reason the series statement above gives.
    /// </para>
    /// <para>
    /// <b>Newest first and bounded.</b> A time axis keeps its most recent periods when it cannot
    /// keep them all, so the rows are ordered latest day first (undated and outside rows first of
    /// all) and cut at <c>@cell_limit</c>; <c>cells</c> says how many there were, so the caller
    /// knows the earliest day it holds may be incomplete.
    /// </para>
    /// </remarks>
    public static readonly string BucketChildrenByDay = $$"""
        WITH placed AS (
            SELECT CASE WHEN pg_input_is_valid(prefix.day, 'date') THEN prefix.day END AS day,
                   c.properties ->> @split_key AS series,
                   {{ChartNumber}} AS measure
            FROM item AS c
            CROSS JOIN LATERAL (
                SELECT substring(c.properties ->> @group_key from '^[0-9]{4}-[0-9]{2}-[0-9]{2}')
                           COLLATE "C" AS day
            ) AS prefix
            WHERE c.tenant_id = @tenant_id
              AND c.workspace_id = @workspace_id
              AND c.parent_id = @parent_id
              AND c.lifecycle_state = 'active'
              AND c.template_id IS NULL
              AND c.type <> 'message'
              AND {{ItemVisibilitySql.NoHiddenStoredAncestor("@parent_id", includeSelf: true)}}
        ),
        windowed AS (
            SELECT placed.day,
                   placed.series,
                   placed.measure,
                   placed.day IS NOT NULL
                       AND ((@from_day::text IS NOT NULL AND placed.day < @from_day::text COLLATE "C")
                            OR (@to_day::text IS NOT NULL AND placed.day > @to_day::text COLLATE "C"))
                       AS outside
            FROM placed
        ),
        series_ranked AS (
            SELECT windowed.series,
                   dense_rank() OVER (ORDER BY count(*) DESC, windowed.series ASC NULLS LAST) AS series_rank
            FROM windowed
            WHERE windowed.day IS NOT NULL AND NOT windowed.outside
            GROUP BY windowed.series
        )
        SELECT CASE WHEN windowed.outside THEN NULL ELSE windowed.day END AS bucket,
               CASE WHEN windowed.outside OR windowed.day IS NULL
                         OR ranked_series.series_rank > @series_limit
                    THEN NULL ELSE windowed.series END AS series,
               coalesce(ranked_series.series_rank > @series_limit, false) AS other,
               windowed.outside,
               count(*) AS children,
               round({{NumberSql.CappedSum("windowed.measure")}}, 6) AS total,
               count(*) OVER () AS cells,
               sum(count(*)) OVER ()::bigint AS all_children,
               (SELECT count(*) FROM series_ranked) AS series_count
        FROM windowed
        LEFT JOIN series_ranked AS ranked_series
          ON windowed.day IS NOT NULL
         AND NOT windowed.outside
         AND coalesce(ranked_series.series, '') = coalesce(windowed.series, '')
         AND (ranked_series.series IS NULL) = (windowed.series IS NULL)
        GROUP BY 1, 2, 3, 4
        ORDER BY 1 DESC NULLS FIRST, 3, 2 ASC NULLS LAST
        LIMIT @cell_limit
        """;
}
