namespace Nix.Persistence.Sql.Statements;

/// <summary>
/// The two candidate reads behind My Day: items that might be tasks, and items carrying habit
/// settings, both in one workspace.
/// </summary>
/// <remarks>
/// <para>
/// <b>Candidates, not verdicts.</b> Whether an item is a task is decided by its effective schema,
/// which only the handler can resolve; these statements return a superset narrow enough that the
/// ceiling is not spent on finished work. The visibility rules - tenant, workspace, active,
/// non-template, no hidden ancestor, no closed lock above - are the workspace query's own
/// fragments and run before <c>LIMIT</c>, so a ceiling is never consumed by rows the caller
/// cannot see. Binds <c>@tenant_id</c>, <c>@workspace_id</c>, <c>@closed_lock_ids</c> and
/// <c>@candidate_limit</c>; the task statement also binds <c>@today</c> (<c>yyyy-MM-dd</c>) and
/// <c>@me</c> (the acting principal's canonical identifier).
/// </para>
/// <para>
/// Day comparisons use <c>item.due_day</c>, the generated column, because a bag read is not
/// servable from an index under row security (see <see cref="QuerySql"/>).
/// </para>
/// <para>
/// shortcut: the task statement scans the tenant's items, because the assignee test is a bag read
/// no index can serve under row security and its OR defeats <c>ix_item_due_day</c>. Measured as
/// the runtime role on 55,000 items: 23.7 ms / 3,572 buffers (<c>TaskSemanticsPlanEvidenceTests</c>).
/// Upgrade by adding a leakproof generated column for the assignee and splitting that arm into
/// its own indexed statement once a tenant outgrows this. The habit statement is served by
/// <c>ix_item_habit_marker</c>, whose partial predicate is the marker test itself.
/// </para>
/// </remarks>
public static class MyDaySql
{
    private const string Rows = $"""
        SELECT item.id,
               item.parent_id,
               parent.properties ->> 'title' AS container_title,
               item.properties ->> 'title' AS title,
               item.properties::text AS properties,
               item.recurrence::text AS recurrence
        FROM item
        LEFT JOIN item AS parent
               ON parent.id = item.parent_id
              AND parent.tenant_id = @tenant_id
              AND parent.workspace_id = @workspace_id
              AND parent.template_id IS NULL
              AND parent.lifecycle_state = 'active'
        WHERE item.tenant_id = @tenant_id
          AND item.workspace_id = @workspace_id
          AND item.lifecycle_state = 'active'
          AND item.template_id IS NULL
          AND {ItemVisibilitySql.NoHiddenAncestor}
          AND {ItemLockSql.ItemIsNotUnderClosedLock}
        """;

    /// <summary>
    /// Unfinished one-off items due today or earlier or assigned to the caller, and every series
    /// that has begun and not ended.
    /// </summary>
    /// <remarks>
    /// Ordered by what the handler ranks first - today and series, then overdue (newest first),
    /// then assigned - so a ceiling cuts the least urgent candidates, not today's.
    /// A series is never filtered by its generic <c>completion</c>: occurrence completion lives in
    /// the rule, and the handler judges it. A series with no due day is kept so the handler can
    /// report it as unreadable rather than letting it vanish.
    /// </remarks>
    public const string Tasks = $"""
        {Rows}
          AND (
              (item.recurrence IS NULL
               AND item.properties ->> 'completion' IS DISTINCT FROM 'true'
               AND (item.due_day <= @today OR item.properties ->> 'assignee' = @me))
              OR
              (item.recurrence IS NOT NULL
               AND (item.due_day IS NULL OR item.due_day <= @today)
               AND (item.recurrence ->> 'until' IS NULL OR item.recurrence ->> 'until' >= @today))
          )
        ORDER BY CASE WHEN item.recurrence IS NOT NULL OR item.due_day = @today THEN 0
                      WHEN item.due_day < @today THEN 1
                      ELSE 2 END,
                 item.due_day DESC NULLS LAST,
                 item.id
        LIMIT @candidate_limit
        """;

    /// <summary>Every item carrying habit settings, malformed ones included.</summary>
    /// <remarks>
    /// Matched on the presence of the reserved frequency key, so a habit whose other settings are
    /// invalid still arrives and is reported as partial coverage instead of silently missing.
    /// </remarks>
    public const string Habits = $"""
        {Rows}
          AND item.properties ->> '$habit_frequency' IS NOT NULL
          AND COALESCE(item.properties ->> '$habit_status', 'active') NOT IN ('paused', 'archived')
        ORDER BY item.id
        LIMIT @candidate_limit
        """;
}
