using Nix.Domain.Items;

namespace Nix.Persistence.Sql.Statements;

/// <summary>
/// The repeating items a workspace calendar has to expand: their rule, and the day the series is
/// anchored to.
/// </summary>
/// <remarks>
/// <para>
/// <b>Candidates, not occurrences.</b> A series is a rule plus an anchor, and the days it lands on
/// are computed in <c>RecurrenceExpansion</c> against the window being drawn. This statement's job
/// is to find the few items that have a rule at all, cheaply, and hand them over whole.
/// </para>
/// <para>
/// <b>The anchor is always the item's reserved <c>due_date</c>, and the container's own axis is
/// projected beside it so the caller can refuse to draw a series the calendar is not showing.</b>
/// A series repeats from the day it is due - that is what <c>RecurrenceRule</c> means by an anchor -
/// so anchoring on whatever else a container happened to place by would make "completed the
/// occurrence" and "drew the occurrence" disagree about which day an occurrence is. Where a
/// container's calendar places by something other than <c>due_date</c>, the honest answer is that
/// this calendar cannot show the series, which the caller reports as unplaceable rather than
/// drawing occurrences on an axis nobody asked for.
/// </para>
/// <para>
/// <b>Two predicates, not one</b>, matching <see cref="CalendarSql"/> exactly: the workspace asked
/// for, and the workspaces the caller may read. Same rule, same reason.
/// </para>
/// <para>
/// <b>The window prunes by its end, never by its start.</b> A series anchored a year ago still
/// expands into today - pruning the anchor by <c>@from</c> would be the obvious symmetry with the
/// concrete arm and would silently drop every long-running series, which is the whole feature.
/// Only <c>until</c> prunes from the near side, inclusively: a series ending on the window's first
/// day still has that occurrence. <c>completedThrough</c> prunes nothing at all - a completed
/// occurrence is still drawn, as done.
/// </para>
/// <para>
/// Index dependency: <c>ix_item_recurs</c> (tenant, workspace, parent; partial on
/// <c>recurrence IS NOT NULL</c>), measured against a prototype of this statement at 2.704 ms /
/// 407 buffers on a 50k workspace where the unindexed shape took 44.807 ms / 24,760. The plan
/// evidence for the real statement is this goal's to add. The <c>until</c> comparison is a heap
/// filter by construction - a jsonb read cannot be an index condition under row security
/// (ADR-0043) - which is fine: the partial index has already cut the set to a few hundred rows.
/// </para>
/// </remarks>
public static class RecurrenceSql
{
    /// <summary>
    /// Every recurring child of a calendar-declaring container in one workspace, with its anchor.
    /// </summary>
    /// <remarks>
    /// A candidate whose anchor is null comes back with a null <c>anchor</c> rather than being
    /// dropped, so the caller can say "repeats, but has no date to repeat from" instead of the
    /// series quietly not existing.
    /// </remarks>
    public static readonly string WorkspaceRecurrenceCandidates = $"""
        WITH calendar_view AS (
            SELECT container.id AS container_id,
                   container.properties ->> 'title' AS container_title,
                   entry.value ->> 'dateProperty' AS date_property,
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
            SELECT container_id, container_title, date_property
            FROM calendar_view
            WHERE rank = 1
        )
        SELECT child.id AS item_id,
               child.properties ->> 'title' AS item_title,
               chosen.container_id AS container_id,
               chosen.container_title AS container_title,
               chosen.date_property AS date_property,
               left(child.properties ->> 'due_date', 10) AS anchor,
               child.recurrence::text AS recurrence
        FROM chosen
        JOIN item AS child
          ON child.parent_id = chosen.container_id
         AND child.tenant_id = @tenant_id
         AND child.workspace_id = @workspace_id
         AND child.workspace_id = ANY(@workspace_ids)
         AND child.lifecycle_state = 'active'
         AND child.template_id IS NULL
         AND child.recurrence IS NOT NULL
        WHERE chosen.date_property IS NOT NULL
          AND (child.due_day IS NULL OR child.due_day <= @to)
          AND (child.recurrence ->> 'until' IS NULL
               OR child.recurrence ->> 'until' >= @from)
        ORDER BY child.seq, child.id
        LIMIT @candidate_limit
        """;

    /// <summary>
    /// Sets or clears one item's recurrence rule.
    /// </summary>
    /// <remarks>
    /// <para>
    /// <c>@recurrence</c> is <see langword="null"/> to clear the series and a rule's JSON text to
    /// set or replace it - the same parameter serves both, because "no rule" and "a different rule"
    /// are the same write from the database's point of view.
    /// </para>
    /// <para>
    /// <c>tenant_id = @tenant_id</c> is asserted even though row-level security already enforces
    /// it: same belt-and-braces convention as <see cref="CalendarSql"/>'s two workspace predicates
    /// - the caller's authorization is a fact about the request, and this predicate is a fact about
    /// the rows, and the two are checked separately on purpose.
    /// </para>
    /// <para>
    /// <c>template_id IS NULL</c> excludes template-owned items, which never carry a live schedule
    /// of their own; <c>lifecycle_state = 'active'</c> excludes items already trashed. Either
    /// predicate failing, or the item simply not existing, are indistinguishable from this
    /// statement's zero-rows result - the caller reports all three as "item not found" alike.
    /// </para>
    /// <para>
    /// <b>A recurrence write is a schedule write.</b> Setting, changing or clearing the rule
    /// re-targets a dated item's due reminders, so it re-attributes
    /// <see cref="ItemProperties.DueSetByKey"/> to <c>@actor</c> exactly as a write of
    /// <c>due_date</c> would (<see cref="ItemProperties.StampSetBy"/>, ADR-0051 Amendment 4). An
    /// item without a due date keeps its bag untouched.
    /// </para>
    /// </remarks>
    public const string SetRecurrence = $"""
        UPDATE item
           SET recurrence = @recurrence::jsonb,
               properties = CASE
                   WHEN properties ->> '{ItemProperties.DueDateKey}' IS NOT NULL
                   THEN properties || jsonb_build_object('{ItemProperties.DueSetByKey}', @actor::text)
                   ELSE properties
               END,
               last_modified_at = now(),
               last_modified_by = @actor
         WHERE tenant_id = @tenant_id
           AND id = @item_id
           AND lifecycle_state = 'active'
           AND template_id IS NULL
        """;

    /// <summary>
    /// Reads one item's recurrence rule as text, or nothing at all when the item does not exist or
    /// does not qualify.
    /// </summary>
    /// <remarks>
    /// Same tenant, lifecycle, and template predicates as <see cref="SetRecurrence"/>, so a rule
    /// visible to a write is the same rule visible to a read. Casts to <c>text</c> rather than
    /// leaving <c>jsonb</c> for the same reason
    /// <see cref="Nix.Persistence.Calendar.RecurrenceCandidateReader"/> does: the caller
    /// round-trips the stored rule through the same JSON representation it wrote, not through
    /// whatever canonical form Postgres's <c>jsonb</c> output happens to choose.
    /// </remarks>
    public const string ReadRecurrence = """
        SELECT recurrence::text
        FROM item
        WHERE tenant_id = @tenant_id
          AND id = @item_id
          AND lifecycle_state = 'active'
          AND template_id IS NULL
        """;

    /// <summary>
    /// Advances a series past its next occurrence by replacing its rule, idempotently.
    /// </summary>
    /// <remarks>
    /// <para>
    /// <b>The idempotence is the last predicate.</b> <c>recurrence IS DISTINCT FROM
    /// @recurrence::jsonb</c> means a repeat of the same completion - the same advanced rule
    /// arriving twice, the ordinary shape of a retried request - matches zero rows instead of
    /// re-applying an advance that already happened, and instead of raising an error over a write
    /// that has nothing left to do. <c>recurrence IS NOT NULL</c> alongside it excludes an item
    /// that never had a rule at all, so this statement only ever advances a series, never invents
    /// one.
    /// </para>
    /// <para>
    /// <b>The comparison is <c>jsonb</c> on both sides, never text.</b> Comparing
    /// <c>recurrence::text</c> against the parameter compares Postgres's canonical rendering - keys
    /// reordered, whitespace normalised - against whatever the client serialised, so two documents
    /// that say exactly the same thing are never equal and the idempotence predicate never fires.
    /// Casting the parameter instead makes the comparison semantic, which is the property the whole
    /// statement rests on. Found by <c>RecurrenceStoreTests</c>: completing an occurrence twice
    /// reported success twice and wrote twice.
    /// </para>
    /// <para>
    /// <b>Zero rows affected is ambiguous, on purpose.</b> It means one of three things - the item
    /// does not exist, the item exists but is not recurring, or the item is recurring and this
    /// exact completion already landed - and this statement cannot tell them apart from its own
    /// result. <see cref="Nix.Persistence.Recurrence.RecurrenceStore"/> disambiguates with one
    /// more read of <see cref="ReadRecurrence"/> inside the same transaction: no row means not
    /// found, a row with a rule means already complete, a row with no rule means not recurring.
    /// </para>
    /// </remarks>
    public const string CompleteOccurrence = """
        UPDATE item
           SET recurrence = @recurrence::jsonb,
               last_modified_at = now(),
               last_modified_by = @actor
         WHERE tenant_id = @tenant_id
           AND id = @item_id
           AND lifecycle_state = 'active'
           AND template_id IS NULL
           AND recurrence IS NOT NULL
           AND recurrence IS DISTINCT FROM @recurrence::jsonb
        """;
}
