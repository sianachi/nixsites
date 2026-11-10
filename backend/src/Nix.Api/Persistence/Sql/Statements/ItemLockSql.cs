namespace Nix.Persistence.Sql.Statements;

/// <summary>
/// Setting, checking and removing item locks, and issuing the grants past them.
/// </summary>
/// <remarks>
/// <para>
/// <b>Nothing here decides whether the caller may see the item.</b> Every statement is reached
/// only after the handler has asked the permission resolver, so these answer the narrower
/// question - is this body locked, and has this credential unlocked it - and nothing wider.
/// </para>
/// <para>
/// The clock is a parameter rather than <c>now()</c>, so expiry is judged against the same instant
/// the handler reported to the caller, and a test can move it.
/// </para>
/// <para>
/// <b>A lock covers its subtree.</b> The reads below walk an item's ancestors through the closure
/// table, so a folder's lock closes everything under it - bodies, and the children lists and views
/// that show them - until the folder is opened.
/// </para>
/// <para>
/// Index dependencies: the closure primary key <c>(descendant_id, ancestor_id)</c> for an item's
/// ancestor path, <c>AK_item_lock_tenant_id_item_id</c> for every lock probe (an index-only scan,
/// since every statement filters on the tenant too) and <c>PK_item_unlock</c> for grants.
/// </para>
/// </remarks>
public static class ItemLockSql
{
    /// <summary>
    /// The locks covering the item - its own and every ancestor's - as this credential sees them.
    /// </summary>
    /// <remarks>
    /// <para>
    /// <b>A lock covers its whole subtree.</b> The item is locked when it or any ancestor carries a
    /// lock, and open only when this credential holds an unexpired grant for every one of them, so
    /// <c>unlocked_until</c> is the earliest of those grants and null while any is missing.
    /// </para>
    /// <para>
    /// <c>lock_item_id</c> names the lock the caller has to open next: the nearest one without a
    /// grant, or - when every covering lock is open - the nearest one, which is the one "lock
    /// again" closes. <c>self_locked</c> says whether the item carries a lock of its own, which is
    /// what setting, changing or removing a password on it acts on.
    /// </para>
    /// <para>
    /// A null credential matches no grant, so every covering lock holds.
    /// </para>
    /// </remarks>
    public const string State = """
        WITH covering AS MATERIALIZED (
            SELECT item_lock.item_id,
                   edge.depth,
                   (
                       SELECT item_unlock.expires_at FROM item_unlock
                       WHERE item_unlock.tenant_id = @tenant_id
                         AND item_unlock.item_id = item_lock.item_id
                         AND item_unlock.credential_id = @credential_id
                         AND item_unlock.expires_at > @now
                   ) AS unlocked_until
            FROM item_closure AS edge
            JOIN item_lock
              ON item_lock.tenant_id = edge.tenant_id
             AND item_lock.item_id = edge.ancestor_id
            WHERE edge.tenant_id = @tenant_id
              AND edge.descendant_id = @item_id
        )
        SELECT count(*) > 0 AS locked,
               CASE WHEN count(*) > 0 AND count(unlocked_until) = count(*)
                    THEN min(unlocked_until)
               END AS unlocked_until,
               (array_agg(item_id ORDER BY unlocked_until IS NOT NULL, depth))[1] AS lock_item_id,
               COALESCE(bool_or(depth = 0), false) AS self_locked
        FROM covering
        """;

    /// <summary>
    /// Whether this credential may read the item's body and list its children: no lock covers it,
    /// or this credential holds an unexpired grant for every lock that does.
    /// </summary>
    /// <remarks>
    /// Covering means the item's own lock and every ancestor's, through the closure's self edge and
    /// its ancestor edges alike, so a child of a locked folder is closed until the folder is opened.
    /// </remarks>
    public const string MayReadBodyItemLocksOnly = """
        SELECT NOT EXISTS (
            SELECT 1
            FROM item_closure AS edge
            JOIN item_lock
              ON item_lock.tenant_id = edge.tenant_id
             AND item_lock.item_id = edge.ancestor_id
            WHERE edge.tenant_id = @tenant_id
              AND edge.descendant_id = @item_id
              AND NOT EXISTS (
                  SELECT 1 FROM item_unlock
                  WHERE item_unlock.tenant_id = @tenant_id
                    AND item_unlock.item_id = item_lock.item_id
                    AND item_unlock.credential_id = @credential_id
                    AND item_unlock.expires_at > @now
              )
        )
        """;

    /// <summary>
    /// <see cref="MayReadBodyItemLocksOnly"/> and also closed when the item's workspace has a
    /// password this credential has not entered, so callers that ask only this (a notification
    /// title, a worker reading for a job) get the answer the resolver gives.
    /// </summary>
    public const string MayReadBody = $"""
        {MayReadBodyItemLocksOnly}
        AND NOT EXISTS (
            SELECT 1
            FROM item
            JOIN workspace_lock
              ON workspace_lock.tenant_id = item.tenant_id
             AND workspace_lock.workspace_id = item.workspace_id
            WHERE item.tenant_id = @tenant_id
              AND item.id = @item_id
              AND NOT EXISTS (
                  SELECT 1 FROM workspace_unlock
                  WHERE workspace_unlock.tenant_id = @tenant_id
                    AND workspace_unlock.workspace_id = workspace_lock.workspace_id
                    AND workspace_unlock.credential_id = @credential_id
                    AND workspace_unlock.expires_at > @now
              )
        )
        """;

    /// <summary>Whether this credential holds an unexpired grant past the item's own lock.</summary>
    /// <remarks>
    /// Only the item's own lock, unlike <see cref="MayReadBody"/>: this is how an unlock learns its
    /// grant was written, and a still-closed ancestor says nothing about that.
    /// </remarks>
    public const string HoldsGrant = """
        SELECT EXISTS (
            SELECT 1 FROM item_unlock
            WHERE item_unlock.tenant_id = @tenant_id
              AND item_unlock.item_id = @item_id
              AND item_unlock.credential_id = @credential_id
              AND item_unlock.expires_at > @now
        )
        """;

    /// <summary>
    /// Whether the item, any active item under it, or any item above it is locked. Trashed
    /// descendants are not counted: an export leaves them out, and the collaboration service
    /// withholds a locked body on its own if one is ever included.
    /// </summary>
    /// <remarks>
    /// <para>
    /// The subtree half is driven from the tenant's locks rather than the subtree's descendants: a
    /// tenant has few locks and a workspace export may have a hundred thousand descendants, so this
    /// costs one closure probe per lock instead of one lock probe per descendant. The closure
    /// carries the depth-0 self edge, so the root is covered by the same join.
    /// </para>
    /// <para>
    /// The ancestor half is there because a lock covers everything under it: a subtree whose root
    /// sits inside a locked folder is as locked as the folder.
    /// </para>
    /// </remarks>
    public const string AnyInSubtree = """
        SELECT EXISTS (
            SELECT 1
            FROM item_lock
            JOIN item_closure AS edge
              ON edge.tenant_id = item_lock.tenant_id
             AND edge.descendant_id = item_lock.item_id
             AND edge.ancestor_id = @item_id
            JOIN item
              ON item.tenant_id = item_lock.tenant_id
             AND item.id = item_lock.item_id
            WHERE item_lock.tenant_id = @tenant_id
              AND (edge.depth = 0 OR item.lifecycle_state = 'active')
        )
        OR EXISTS (
            SELECT 1
            FROM item_closure AS edge
            JOIN item_lock
              ON item_lock.tenant_id = edge.tenant_id
             AND item_lock.item_id = edge.ancestor_id
            WHERE edge.tenant_id = @tenant_id
              AND edge.descendant_id = @item_id
              AND edge.depth > 0
        )
        """;

    /// <summary>Which of a set of items are locked, by their own lock or an ancestor's.</summary>
    public const string LockedAmong = """
        SELECT DISTINCT edge.descendant_id
        FROM item_closure AS edge
        JOIN item_lock
          ON item_lock.tenant_id = edge.tenant_id
         AND item_lock.item_id = edge.ancestor_id
        WHERE edge.tenant_id = @tenant_id
          AND edge.descendant_id = ANY(@item_ids)
        """;

    /// <summary>
    /// The locks this credential has not opened, as one array: the <c>@closed_lock_ids</c> that
    /// <see cref="ContainerIsOpen"/> and <see cref="ItemIsNotUnderClosedLock"/> bind.
    /// </summary>
    /// <remarks>
    /// Read once, before the statement that filters by it, so the filter is a point probe per row
    /// rather than a join the planner has to guess the size of. See <see cref="ContainerIsOpen"/>.
    /// </remarks>
    public const string ClosedLockIds = """
        SELECT COALESCE(array_agg(item_lock.item_id), ARRAY[]::uuid[])
        FROM item_lock
        WHERE item_lock.tenant_id = @tenant_id
          AND NOT EXISTS (
              SELECT 1 FROM item_unlock
              WHERE item_unlock.tenant_id = @tenant_id
                AND item_unlock.item_id = item_lock.item_id
                AND item_unlock.credential_id = @credential_id
                AND item_unlock.expires_at > @now
          )
        """;

    /// <summary>
    /// Every lock in the tenant, whoever has it open, as one array: the <c>@lock_ids</c> the search
    /// and graph statements bind, since what they withhold does not depend on who is asking.
    /// </summary>
    public const string AllLockIds = """
        SELECT COALESCE(array_agg(item_lock.item_id), ARRAY[]::uuid[])
        FROM item_lock
        WHERE item_lock.tenant_id = @tenant_id
        """;

    /// <summary>
    /// A predicate, for a statement whose rows are containers aliased <c>container</c>: none of
    /// <c>@closed_lock_ids</c> covers the container, so its children may be shown.
    /// </summary>
    /// <remarks>
    /// <para>
    /// Binds <c>@tenant_id</c> and <c>@closed_lock_ids</c> (read by <see cref="ClosedLockIds"/>).
    /// The same rule as <see cref="MayReadBody"/>, written inline so a collated view drops a closed
    /// container's children while the query runs rather than after it has spent its ceiling.
    /// </para>
    /// <para>
    /// <b>Why the lock ids arrive as an array.</b> Two earlier shapes were measured and failed. A
    /// join from the tenant's locks through the closure let the planner guess each locked subtree
    /// at a handful of rows, then rescan a materialised copy of it for every outer row: about a
    /// second for a saved query over ten thousand locked items. A <c>NOT IN</c> took a flat half
    /// off the row estimate and pushed the query off its ordered index. Here each row costs one
    /// probe of the closure primary key <c>(descendant_id, ancestor_id)</c>, bounded by the
    /// number of closed locks rather than the size of what they cover, and with no closed lock the
    /// <c>cardinality</c> test folds the whole predicate away at plan time.
    /// </para>
    /// </remarks>
    public const string ContainerIsOpen = """
        (cardinality(@closed_lock_ids) = 0
               OR NOT EXISTS (
                  SELECT 1
                  FROM item_closure AS lock_edge
                  WHERE lock_edge.tenant_id = @tenant_id
                    AND lock_edge.descendant_id = container.id
                    AND lock_edge.ancestor_id = ANY(@closed_lock_ids)
              ))
        """;

    /// <summary>
    /// A predicate, for a statement whose rows are items aliased <c>item</c>: none of
    /// <c>@closed_lock_ids</c> sits above the item, so it may be listed.
    /// </summary>
    /// <remarks>
    /// Binds <c>@tenant_id</c> and <c>@closed_lock_ids</c>, in the shape and for the reasons
    /// <see cref="ContainerIsOpen"/> gives. Proper ancestors only: a locked item itself is still
    /// listed, title and properties included, as it is in its parent's children; what its lock
    /// withholds is its body and everything under it.
    /// </remarks>
    public const string ItemIsNotUnderClosedLock = """
        (cardinality(@closed_lock_ids) = 0
               OR NOT EXISTS (
                  SELECT 1
                  FROM item_closure AS lock_edge
                  WHERE lock_edge.tenant_id = @tenant_id
                    AND lock_edge.descendant_id = item.id
                    AND lock_edge.depth > 0
                    AND lock_edge.ancestor_id = ANY(@closed_lock_ids)
              ))
        """;

    /// <summary>
    /// A common table expression, <c>closed_lock_descendants</c>: every item with a proper
    /// ancestor among <c>@closed_lock_ids</c>, read once. A bulk statement lists it in its
    /// <c>WITH</c> and anti-joins it -
    /// <c>NOT EXISTS (SELECT 1 FROM closed_lock_descendants AS hidden WHERE hidden.descendant_id = x.id)</c>
    /// - where a per-row <see cref="ItemIsNotUnderClosedLock"/> probe would be costed against every
    /// row the statement scans.
    /// </summary>
    /// <remarks>
    /// <para>
    /// <b>Why a set rather than a probe, for scans.</b> The probe is cheap per row, but the planner
    /// charges its subplan to every row it expects, and over a title scan of a large readable
    /// corpus that pushed the estimate to about 1.96 million and JIT-compiled every search for
    /// anyone with a closed lock (about +180 ms). Materialised, the set costs one walk of
    /// <c>IX_item_closure_tenant_id_ancestor_id_depth</c> per closed lock, bounded by what those
    /// locks cover, and the anti-join is a hash lookup per row. With no closed lock the set is
    /// empty and the anti-join removes nothing.
    /// </para>
    /// <para>
    /// The same rule as <see cref="ItemIsNotUnderClosedLock"/>: proper descendants only, so a
    /// locked item itself is not in the set. Binds <c>@tenant_id</c> and <c>@closed_lock_ids</c>.
    /// </para>
    /// </remarks>
    public const string ClosedLockDescendants = """
        closed_lock_descendants AS MATERIALIZED (
            SELECT lock_edge.descendant_id
            FROM item_closure AS lock_edge
            WHERE lock_edge.tenant_id = @tenant_id
              AND lock_edge.ancestor_id = ANY(@closed_lock_ids)
              AND lock_edge.depth > 0
        )
        """;

    /// <summary>The stored verifier, or no row when the item is not locked.</summary>
    public const string Verifier = """
        SELECT password_hash FROM item_lock
        WHERE tenant_id = @tenant_id AND item_id = @item_id
        """;

    /// <summary>
    /// Locks an unlocked item. Writes nothing when it is already locked, so a second lock cannot
    /// silently replace the first password.
    /// </summary>
    public const string Lock = """
        INSERT INTO item_lock (item_id, tenant_id, password_hash, locked_by, locked_at)
        VALUES (@item_id, @tenant_id, @password_hash, @principal_id, @now)
        ON CONFLICT (item_id) DO NOTHING
        """;

    /// <summary>
    /// Replaces a lock's verifier - only if it still carries the one the current password was
    /// checked against, so of two changes racing from the same old password the second finds
    /// nothing to replace rather than overwriting a password it never proved.
    /// </summary>
    public const string ChangeVerifier = """
        UPDATE item_lock
        SET password_hash = @password_hash, locked_by = @principal_id, locked_at = @now
        WHERE tenant_id = @tenant_id AND item_id = @item_id AND password_hash = @expected_hash
        """;

    /// <summary>
    /// Drops every grant past one lock. Run with <see cref="ChangeVerifier"/>, so nobody holding an
    /// unlock from the old password keeps reading under the new one.
    /// </summary>
    public const string RevokeAll = """
        DELETE FROM item_unlock
        WHERE tenant_id = @tenant_id AND item_id = @item_id
        """;

    /// <summary>Removes a lock; its grants go with it by cascade.</summary>
    public const string Remove = """
        DELETE FROM item_lock
        WHERE tenant_id = @tenant_id AND item_id = @item_id AND password_hash = @expected_hash
        """;

    /// <summary>
    /// Issues or extends one credential's grant - only while the lock still carries the verifier the
    /// password was just checked against - and sweeps the tenant's expired grants while here.
    /// </summary>
    /// <remarks>
    /// <para>
    /// The verifier condition closes two races the key derivation's few hundred milliseconds open:
    /// a lock removed meanwhile (the insert would otherwise fail the foreign key), and a password
    /// changed meanwhile (the insert would otherwise issue a grant under the old password after
    /// the change revoked every other). Either way no row is written and the caller is told.
    /// </para>
    /// <para>
    /// <c>FOR SHARE</c> on the lock row makes a concurrent change or removal wait for this grant
    /// and then revoke it, or - if it committed first - leaves this insert with nothing to select.
    /// </para>
    /// <para>
    /// The sweep is housekeeping rather than enforcement - every read compares the expiry with the
    /// clock - and it runs here because an unlock is the only thing that adds rows. It skips rows
    /// another transaction holds rather than waiting on them: waiting on another credential's
    /// grant is how two unlocks deadlock.
    /// </para>
    /// </remarks>
    public const string Grant = """
        DELETE FROM item_unlock
        WHERE (item_id, credential_id) IN (
            SELECT item_id, credential_id FROM item_unlock
            WHERE tenant_id = @tenant_id AND expires_at <= @now
            FOR UPDATE SKIP LOCKED);

        INSERT INTO item_unlock (item_id, credential_id, tenant_id, principal_id, expires_at)
        SELECT item_lock.item_id, @credential_id, item_lock.tenant_id, @principal_id, @expires_at
        FROM item_lock
        WHERE item_lock.tenant_id = @tenant_id
          AND item_lock.item_id = @item_id
          AND item_lock.password_hash = @password_hash
        FOR SHARE
        ON CONFLICT (item_id, credential_id)
        DO UPDATE SET expires_at = EXCLUDED.expires_at, principal_id = EXCLUDED.principal_id
        """;

    /// <summary>Ends one credential's grant: the "lock again" button.</summary>
    public const string Revoke = """
        DELETE FROM item_unlock
        WHERE tenant_id = @tenant_id AND item_id = @item_id AND credential_id = @credential_id
        """;
}
