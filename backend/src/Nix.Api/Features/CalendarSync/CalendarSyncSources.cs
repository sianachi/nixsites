using Nix.Abstractions;
using Nix.Abstractions.Calendar;
using Nix.Abstractions.Scheduling;
using Nix.Domain.Authorization;
using Nix.Domain.Calendar;
using Nix.Domain.Items;
using Nix.Domain.Scheduling;

namespace Nix.Features.CalendarSync;

/// <summary>
/// The five-minute poll (<c>calendar.sync</c>, Amendment 1 A5): one trigger per active link, at the
/// next five-minute UTC boundary plus the link's own stagger.
/// </summary>
public sealed class CalendarPlannedSyncSource(ICalendarLinkFinder finder, CalendarSyncFiring firing) : ITriggerSource
{
    /// <summary>The finder's page size.</summary>
    internal const int PageSize = 500;

    /// <summary>A ceiling on pages per pass: 100,000 links.</summary>
    internal const int MaxPages = 200;

    /// <inheritdoc />
    public string Name => CalendarSyncRules.PlannedSource;

    /// <inheritdoc />
    public TriggerKind Kind => TriggerKind.Calendar;

    /// <inheritdoc />
    public async Task<TriggerPlan> PlanAsync(PlanWindow window, CancellationToken cancellationToken)
    {
        ArgumentNullException.ThrowIfNull(window);
        var desired = new List<DesiredTrigger>();
        var after = Guid.Empty;
        for (var page = 0; page < MaxPages; page++)
        {
            var links = await finder.FindActiveAsync(PageSize, after, cancellationToken).ConfigureAwait(false);
            foreach (var link in links)
            {
                var (slot, fireAt) = CalendarSyncRules.PlannedSlot(link.LinkId, window.Start);
                desired.Add(new DesiredTrigger(
                    link.TenantId,
                    link.WorkspaceId,
                    link.PrincipalId,
                    link.ContainerItemId,
                    link.LinkId,
                    fireAt,
                    CalendarSyncRules.PlannedKey(link.LinkId, slot)));
            }

            if (links.Count < PageSize)
            {
                return new TriggerPlan(desired, Complete: true);
            }

            after = links[^1].LinkId;
        }

        return new TriggerPlan(desired, Complete: false);
    }

    /// <inheritdoc />
    public Task<TriggerOutcome> FireAsync(DueTrigger trigger, CancellationToken cancellationToken) =>
        firing.FireAsync(trigger, CalendarTriggerKind.Planned, cancellationToken);
}

/// <summary>
/// A write in a linked container (<c>calendar.dirty</c>), inserted by the
/// <c>item_calendar_link_dirty</c> database trigger, and by a round that left changes behind. The
/// planner never reconciles it.
/// </summary>
public sealed class CalendarDirtySyncSource(CalendarSyncFiring firing) : ITriggerSource
{
    /// <inheritdoc />
    public string Name => CalendarSyncRules.DirtySource;

    /// <inheritdoc />
    public TriggerKind Kind => TriggerKind.Calendar;

    /// <inheritdoc />
    public bool IsPlanned => false;

    /// <inheritdoc />
    public Task<TriggerPlan> PlanAsync(PlanWindow window, CancellationToken cancellationToken) =>
        Task.FromResult(TriggerPlan.Empty);

    /// <inheritdoc />
    public Task<TriggerOutcome> FireAsync(DueTrigger trigger, CancellationToken cancellationToken) =>
        firing.FireAsync(trigger, CalendarTriggerKind.Dirty, cancellationToken);
}

/// <summary>
/// Fires either calendar source under the owner's scoped transaction: re-verifies the link, its
/// connection, the owner and their write access to the container, then enqueues one
/// <c>calendar.sync</c> job.
/// </summary>
public sealed class CalendarSyncFiring(
    ICalendarSyncStore store,
    CalendarSyncSupport support,
    IPermissionResolver permissions,
    IWorkspaceMembershipIgnoringLock membership,
    IPrincipalStatusChecker principals,
    IItemTree tree,
    IItemLocks locks,
    TimeProvider clock)
{
    /// <summary>Re-verifies and enqueues.</summary>
    [System.Diagnostics.CodeAnalysis.SuppressMessage("Design", "CA1030:Use events where appropriate", Justification = "FireAsync verifies and acts on a trigger; it is not a .NET event.")]
    public async Task<TriggerOutcome> FireAsync(DueTrigger trigger, CalendarTriggerKind expected, CancellationToken cancellationToken)
    {
        ArgumentNullException.ThrowIfNull(trigger);
        if (!CalendarSyncRules.TryParseKey(trigger.DedupeKey, out var key) || key.Kind != expected
            || trigger.RuleId is not { } linkId || key.LinkId != linkId)
        {
            return TriggerOutcome.Skipped("malformed_key");
        }

        // Locked until this firing commits: a concurrent firing (or "Sync now") of the same link
        // waits here, then sees the round this one enqueued and coalesces onto it.
        var link = await store.LockLinkAsync(linkId, cancellationToken).ConfigureAwait(false);
        if (link is null)
        {
            return TriggerOutcome.Skipped("link_missing");
        }

        if (link.Status != "active")
        {
            return TriggerOutcome.Skipped("link_inactive");
        }

        var connection = await store.GetConnectionAsync(link.ConnectionId, cancellationToken).ConfigureAwait(false);
        if (connection is not { Status: "active" })
        {
            return TriggerOutcome.Skipped("connection_inactive");
        }

        if (expected == CalendarTriggerKind.Dirty && link.Direction == "import_only")
        {
            return TriggerOutcome.Skipped("import_only");
        }

        if (!await principals.IsActiveAsync(link.PrincipalId, cancellationToken).ConfigureAwait(false))
        {
            return TriggerOutcome.Skipped("owner_inactive");
        }

        // A7: the owner must still be able to write the container at every fire; a lost write
        // stops the link rather than pushing a workspace they no longer belong to.
        var container = await tree.FindAsync(link.ContainerItemId, cancellationToken).ConfigureAwait(false);
        if (container is not null
            && container.LifecycleState == ItemLifecycleState.Active
            && container.WorkspaceId == link.WorkspaceId
            && !await permissions.CanWriteWorkspaceAsync(link.WorkspaceId, cancellationToken).ConfigureAwait(false)
            && await membership.RoleIgnoringLockAsync(link.WorkspaceId, cancellationToken).ConfigureAwait(false) is { } held
            && held.GrantsWrite())
        {
            // A workspace password closes the workspace to this unattended firing, which holds no
            // credential. The owner has not lost access: nothing is pushed, and the link is kept.
            return TriggerOutcome.Skipped("workspace_locked");
        }

        if (container is null
            || container.LifecycleState != ItemLifecycleState.Active
            || container.WorkspaceId != link.WorkspaceId
            || !await permissions.CanWriteWorkspaceAsync(link.WorkspaceId, cancellationToken).ConfigureAwait(false))
        {
            await store.SetLinkErrorAsync(link.Id, "error", "access_lost", clock.GetUtcNow(), cancellationToken).ConfigureAwait(false);
            return TriggerOutcome.Skipped("access_lost");
        }

        // Locks bind whoever is asking, as for reminders and automations: nothing under a locked
        // container is read or pushed until it is unlocked.
        if ((await locks.LockedAmongAsync([container.Id], cancellationToken).ConfigureAwait(false)).Contains(container.Id))
        {
            return TriggerOutcome.Skipped("container_locked");
        }

        if (await support.ActiveJobAsync(link, cancellationToken).ConfigureAwait(false) is not null)
        {
            // A write that lands while a round runs may miss that round; a follow-up dirty trigger
            // for the next minute catches it once the round is done.
            if (expected == CalendarTriggerKind.Dirty)
            {
                await store.EnqueueDirtyAsync(link, clock.GetUtcNow(), cancellationToken).ConfigureAwait(false);
            }

            return TriggerOutcome.Skipped("already_running");
        }

        await support.EnqueueAsync(link, CalendarSyncRules.JobKey(key), full: false, cancellationToken).ConfigureAwait(false);
        return TriggerOutcome.Fired("enqueued");
    }
}
