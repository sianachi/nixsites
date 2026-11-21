namespace Nix.Persistence.Sql.Statements;

/// <summary>
/// Collating every calendar in a workspace: which containers place their children on a date, and
/// which children that puts where.
/// </summary>
/// <remarks>
/// <para>
/// <b>The permission filter is a predicate in the statement, not a pass over the results.</b> The
/// readable workspaces are resolved through <c>IPermissionResolver</c> before the query runs and
/// are never sent by the client. This is the rule <see cref="GraphSql"/> states and the reason is
/// the same: a collated calendar is bulk disclosure. Filtering afterwards would spend the ceiling
/// on rows the caller may not see, so a month that is full could come back looking empty.
/// </para>
/// <para>
/// <b>Two predicates, not one.</b> Every arm carries both <c>workspace_id = @workspace_id</c> (which
/// workspace was asked for) and <c>workspace_id = ANY(@workspace_ids)</c> (which ones may be
/// answered). While visibility is per workspace the second is implied by a membership test the
/// handler has already made; it is still written, because the handler's test is a fact about the
/// request and the predicate is a fact about the rows. When access control entries make visibility
/// per item, the predicate is the line that grows and the handler does not move.
/// </para>
/// <para>
/// Index dependencies, measured rather than asserted (2026-08-21, 100k corpus, runtime role):
/// the container arm now rides <c>ix_item_declares_views</c> - the partial index the
/// TaskSemantics migration added after measurement showed the old shape reading all 10,001 rows
/// of a 10k workspace to find its 30 view-declaring containers (container CTE: 4.432 ms / 473
/// buffers before, 0.708 ms / 4 after). The child join stays on <c>IX_item_parent_id_seq</c>-shaped
/// access and remains proportional to workspace size; a single workspace past ~200k items puts
/// this statement beyond 250 ms, which is the recorded threshold for revisiting it. The figures
/// are the design measurement's; <c>TaskSemanticsPlanEvidenceTests</c> is the standing check and
/// asserts the index choice, not the milliseconds.
/// </para>
/// </remarks>
public static class CalendarSql
{
    /// <summary>
    /// The dated children of every container that offers a calendar, plus the containers that offer
    /// one and place nothing.
    /// </summary>
    /// <remarks>
    /// <para>
    /// <b>Which property is the date is a fact in the data, not a parameter.</b> A container stores
    /// its views as JSON on its own row, and a calendar view names the property it places by. So
    /// the whole resolution is one lateral join - no round trip per container, and no client
    /// deciding what a container meant.
    /// </para>
    /// <para>
    /// <b>An item appears once.</b> A container may configure several calendar views, on different
    /// properties. <c>WITH ORDINALITY</c> plus <c>row_number()</c> takes the first as the array
    /// stores it, so the answer is the same on every read rather than whichever row the planner
    /// happened to emit first. The alternative - returning the item once per calendar view - would
    /// put the same note on two days with no way for a reader to tell which was meant.
    /// </para>
    /// <para>
    /// <b>The window compares the first ten characters, and must not cast.</b> A <c>date</c> is
    /// stored <c>yyyy-MM-dd</c> and a <c>timestamp</c> as RFC 9557 with a bracketed zone
    /// (<c>2026-03-17T09:00:00+00:00[Europe/London]</c>). Both begin with the same ten characters,
    /// so <c>left(value, 10)</c> is a day for either. Casting to <c>timestamptz</c> would be the
    /// obvious move and would throw on every zoned value in the table, because Postgres does not
    /// parse the bracketed suffix.
    /// </para>
    /// <para>
    /// <b>The ceiling is applied to the entries alone.</b> The unplaceable containers are the part
    /// of the answer that explains what is missing, so truncating them with the same limit could
    /// remove the explanation for the truncation. They are counted in tens at worst - one per
    /// misconfigured container.
    /// </para>
    /// <para>
    /// The ordering is stable, so the same window cuts the same entries twice rather than a
    /// different subset per request. Entries enter by date, then by the workspace's own sibling
    /// order, so a truncated read keeps the earliest of the window rather than an arbitrary sample.
    /// </para>
    /// <para>
    /// <b>Daily notes ride the same read when the workspace asks for them.</b> A daily note is
    /// filed under the Daily notes root, directly or inside a year or month folder, so it is not
    /// the direct child of anything with a calendar view and the container arm cannot reach it. The
    /// second arm of <c>entries</c> reads the notes through the closure of the root instead, and
    /// is gated by <c>daily_on</c>: the workspace's <c>showOnCalendar</c> setting together with
    /// its <c>enabled</c> flag (whose default is on for a personal workspace and off for a shared
    /// one), read in the statement beside everything else so the whole answer is one instant. While
    /// daily notes are switched off, or <c>showOnCalendar</c> is false, absent or not a boolean, the
    /// gate is a one-time filter and the arm never runs.
    /// </para>
    /// <para>
    /// A note counts only when it sits under the root the reader derives for this workspace
    /// (any generation in <c>@daily_root_ids</c>) and carries a well-formed <c>$daily</c> date, so the marker typed
    /// onto an unrelated item does not put it on the calendar. The note is shown under the same
    /// rules as any other entry: active, not a template, no deleted or template ancestor, and no
    /// closed lock over its parent or any ancestor of its parent. A lock on the note itself is not
    /// consulted, which is what the container arm already does for a locked child of an open
    /// container: the entry carries a title and a date, and the lock withholds the body. The note
    /// is reported under its own parent, which is the root or the folder it is filed in. A note
    /// that the container arm also returns - its parent has a calendar view whose property puts
    /// it in the window - is left to that arm, so an item is never listed twice. The entry ceiling
    /// and the ordering apply to the two arms together, so truncation stays honest.
    /// </para>
    /// </remarks>
    public static readonly string WorkspaceCalendar = $"""
        WITH calendar_view AS (
            SELECT container.id AS container_id,
                   container.properties ->> 'title' AS container_title,
                   entry.value ->> 'dateProperty' AS date_property,
                   entry.value ->> 'endDateProperty' AS end_property,
                   row_number() OVER (PARTITION BY container.id ORDER BY entry.ordinality) AS rank
            FROM item AS container
            CROSS JOIN LATERAL jsonb_array_elements(container.views -> 'views')
                WITH ORDINALITY AS entry(value, ordinality)
            WHERE container.tenant_id = @tenant_id
              AND container.workspace_id = @workspace_id
              AND container.workspace_id = ANY(@workspace_ids)
              AND container.lifecycle_state = 'active'
              AND container.template_id IS NULL
              AND {ItemVisibilitySql.NoHiddenStoredAncestor("container.id")}
              AND container.views IS NOT NULL
              AND entry.value ->> 'kind' = 'calendar'
              AND {ItemLockSql.ContainerIsOpen}
        ),
        chosen AS (
            SELECT container_id, container_title, date_property, end_property
            FROM calendar_view
            WHERE rank = 1
        ),
        daily_on AS (
            SELECT 1
            FROM workspace AS w
            WHERE w.tenant_id = @tenant_id
              AND w.workspace_id = @workspace_id
              AND w.workspace_id = ANY(@workspace_ids)
              AND {WorkspaceAdministrationSql.DailyNoteEnabled}
              AND COALESCE(
                    CASE WHEN jsonb_typeof(w.daily_notes -> 'showOnCalendar') = 'boolean'
                         THEN (w.daily_notes ->> 'showOnCalendar')::boolean END,
                    false)
        ),
        entries AS (
            SELECT candidate.item_id, candidate.item_title, candidate.container_id,
                   candidate.container_title, candidate.date_property, candidate.value,
                   candidate.end_property, candidate.end_value, candidate.seq
            FROM (
                SELECT child.id AS item_id,
                       child.properties ->> 'title' AS item_title,
                       chosen.container_id AS container_id,
                       chosen.container_title AS container_title,
                       chosen.date_property AS date_property,
                       child.properties ->> chosen.date_property AS value,
                       chosen.end_property AS end_property,
                       CASE
                           WHEN chosen.end_property IS NULL THEN NULL
                           ELSE child.properties ->> chosen.end_property
                       END AS end_value,
                       child.seq AS seq
                FROM chosen
                JOIN item AS child
                  ON child.parent_id = chosen.container_id
                 AND child.tenant_id = @tenant_id
                 AND child.workspace_id = @workspace_id
                 AND child.workspace_id = ANY(@workspace_ids)
                 AND child.lifecycle_state = 'active'
                 AND child.template_id IS NULL
                WHERE chosen.date_property IS NOT NULL
                  AND child.properties ->> chosen.date_property IS NOT NULL
                  AND left(child.properties ->> chosen.date_property, 10) >= @from
                  AND left(child.properties ->> chosen.date_property, 10) <= @to

                UNION ALL

                SELECT note.id AS item_id,
                       note.properties ->> 'title' AS item_title,
                       container.id AS container_id,
                       container.properties ->> 'title' AS container_title,
                       '$daily' AS date_property,
                       note.properties ->> '$daily' AS value,
                       NULL AS end_property,
                       NULL AS end_value,
                       note.seq AS seq
                FROM item_closure AS under_root
                JOIN item AS note
                  ON note.tenant_id = @tenant_id
                 AND note.id = under_root.descendant_id
                JOIN item AS container
                  ON container.tenant_id = @tenant_id
                 AND container.id = note.parent_id
                WHERE EXISTS (SELECT 1 FROM daily_on)
                  AND under_root.tenant_id = @tenant_id
                  AND under_root.ancestor_id = ANY(@daily_root_ids)
                  AND under_root.depth > 0
                  AND note.workspace_id = @workspace_id
                  AND note.workspace_id = ANY(@workspace_ids)
                  AND note.lifecycle_state = 'active'
                  AND note.template_id IS NULL
                  AND note.properties ->> '$daily' ~ '^[0-9][0-9][0-9][0-9]-(0[1-9]|1[0-2])-(0[1-9]|[12][0-9]|3[01])$'
                  AND note.properties ->> '$daily' >= @from
                  AND note.properties ->> '$daily' <= @to
                  AND {ItemVisibilitySql.NoHiddenStoredAncestor("note.id")}
                  AND {ItemLockSql.ContainerIsOpen}
                  AND NOT EXISTS (
                      SELECT 1
                      FROM chosen
                      WHERE chosen.container_id = note.parent_id
                        AND chosen.date_property IS NOT NULL
                        AND left(note.properties ->> chosen.date_property, 10) >= @from
                        AND left(note.properties ->> chosen.date_property, 10) <= @to
                  )
            ) AS candidate
            ORDER BY candidate.value, candidate.seq, candidate.item_id
            LIMIT @entry_limit
        )
        SELECT 0 AS row_kind,
               entries.item_id AS item_id,
               entries.item_title AS item_title,
               entries.container_id AS container_id,
               entries.container_title AS container_title,
               entries.date_property AS date_property,
               entries.value AS value,
               entries.end_property AS end_property,
               entries.end_value AS end_value
        FROM entries

        UNION ALL

        SELECT 1 AS row_kind,
               NULL AS item_id,
               NULL AS item_title,
               chosen.container_id AS container_id,
               chosen.container_title AS container_title,
               NULL AS date_property,
               NULL AS value,
               NULL AS end_property,
               NULL AS end_value
        FROM chosen
        WHERE chosen.date_property IS NULL

        ORDER BY row_kind, value, item_id
        """;
}
