using System.Globalization;
using Nix.Abstractions;
using Nix.Abstractions.Scheduling;
using Nix.Domain.Identity;
using Nix.Domain.Scheduling;
using Nix.Domain.Sites;
using Nix.Domain.Tenancy;
using Nix.Messaging;

namespace Nix.Features.Sites;

/// <summary>
/// Automatic republish (ADR-0063): when a site in <c>auto</c> mode has changed since its live build
/// was requested, queues a rebuild after the site's debounce, as the principal who turned the mode
/// on.
/// </summary>
/// <remarks>
/// <para>
/// Planning crosses every tenant through <c>nix_site_rebuild_candidates</c>, the one SECURITY
/// DEFINER reader this needs, exactly as the reminder finders do. It returns identifiers and
/// instants only. Firing runs in the dispatcher's own transaction, scoped to the trigger's tenant,
/// workspace and principal, so the rebuild is authorized as that principal and nothing else.
/// </para>
/// <para>
/// <b>Authority is re-checked at fire time.</b> If the principal is no longer active, or is no
/// longer a workspace manager, the mode returns to <c>manual</c>, the stop is audited, and the site
/// stays at its last build. <c>on_release</c> has no trigger here: the release procedure runs
/// <c>nixctl site publish</c> for those sites.
/// </para>
/// </remarks>
public sealed class SiteRebuildTriggerSource(
    ISiteRebuildCandidates candidates,
    ISiteStore sites,
    IPermissionResolver permissions,
    IWorkspaceMembershipIgnoringLock membership,
    IPrincipalStatusChecker principalStatus,
    NixDispatcher dispatcher,
    SiteAudit audit,
    TimeProvider clock) : ITriggerSource
{
    public const string SourceName = "site.rebuild";

    private const int PageSize = 500;
    private const string KeyPrefix = SourceName + ":";

    /// <inheritdoc />
    public string Name => SourceName;

    /// <inheritdoc />
    public TriggerKind Kind => TriggerKind.System;

    /// <inheritdoc />
    public async Task<TriggerPlan> PlanAsync(PlanWindow window, CancellationToken cancellationToken)
    {
        ArgumentNullException.ThrowIfNull(window);
        var found = await candidates.FindAsync(window.Start, PageSize, cancellationToken).ConfigureAwait(false);
        var desired = new List<DesiredTrigger>(found.Count);
        foreach (var candidate in found)
        {
            if (candidate.FireAt >= window.End)
            {
                continue;
            }

            // The change instant is in the key: the same edit is planned once, and a later edit is
            // a new trigger even after this one has fired. The failure count is too, so a build that
            // failed is tried again after its backoff rather than never.
            desired.Add(new DesiredTrigger(
                candidate.TenantId,
                candidate.WorkspaceId,
                candidate.PrincipalId,
                SourceItemId: null,
                RuleId: null,
                candidate.FireAt,
                KeyPrefix + candidate.SiteId.ToString("N") + ":" + candidate.ChangedAt.ToUnixTimeMilliseconds().ToString(CultureInfo.InvariantCulture)
                    + ":" + candidate.Failures.ToString(CultureInfo.InvariantCulture)));
        }

        return new TriggerPlan(desired, Complete: found.Count < PageSize);
    }

    /// <inheritdoc />
    public async Task<TriggerOutcome> FireAsync(DueTrigger trigger, CancellationToken cancellationToken)
    {
        ArgumentNullException.ThrowIfNull(trigger);
        if (!TryReadSite(trigger.DedupeKey, out var siteId))
        {
            return TriggerOutcome.Skipped("malformed_key");
        }

        await sites.LockSiteAsync(siteId, cancellationToken).ConfigureAwait(false);
        var site = await sites.FindForUpdateAsync(siteId, cancellationToken).ConfigureAwait(false);
        if (site is null)
        {
            return TriggerOutcome.Skipped("site_gone");
        }

        if (site.RepublishMode != SiteRules.AutoMode
            || site.Status != SiteRules.PublishedStatus
            || site.AutoPrincipalId != trigger.PrincipalId)
        {
            return TriggerOutcome.Skipped("mode_changed");
        }

        var principalActive = await principalStatus.IsActiveAsync(trigger.PrincipalId, cancellationToken).ConfigureAwait(false);
        if (principalActive
            && !await permissions.CanManageWorkspaceAsync(site.WorkspaceId, cancellationToken).ConfigureAwait(false)
            && await membership.RoleIgnoringLockAsync(site.WorkspaceId, cancellationToken).ConfigureAwait(false)
                == Nix.Domain.Authorization.WorkspaceRole.Owner)
        {
            // A workspace password closes the workspace to this unattended rebuild, which holds no
            // credential. The manager has not lost authority, so the mode stays: the site keeps its
            // last build until someone with the workspace open publishes it again.
            return TriggerOutcome.Skipped("workspace_locked");
        }

        if (!principalActive
            || !await permissions.CanManageWorkspaceAsync(site.WorkspaceId, cancellationToken).ConfigureAwait(false))
        {
            site.RepublishMode = SiteRules.ManualMode;
            site.AutoPrincipalId = null;
            site.UpdatedAt = clock.GetUtcNow();
            audit.Record(site, "site.auto_republish_stopped", new { mode = SiteRules.AutoMode }, new { mode = SiteRules.ManualMode });
            await sites.SaveAsync(cancellationToken).ConfigureAwait(false);
            return TriggerOutcome.Skipped("manager_lost");
        }

        var result = await dispatcher
            .SendAsync<PublishSite, SiteBuildResponse>(
                new PublishSite(site.Id, "auto:" + trigger.DedupeKey, RefreshPaths: false, AcknowledgeDisclosure: false, "auto"),
                cancellationToken)
            .ConfigureAwait(false);
        return result.IsSuccess
            ? TriggerOutcome.Fired("site_rebuild_queued")
            : TriggerOutcome.Skipped(result.Error.Code);
    }

    private static bool TryReadSite(string dedupeKey, out Guid siteId)
    {
        siteId = Guid.Empty;
        if (!dedupeKey.StartsWith(KeyPrefix, StringComparison.Ordinal))
        {
            return false;
        }

        var parts = dedupeKey[KeyPrefix.Length..].Split(':');
        return parts.Length is 2 or 3 && Guid.TryParseExact(parts[0], "N", out siteId);
    }
}
