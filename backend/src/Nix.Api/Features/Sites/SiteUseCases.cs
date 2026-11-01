using System.Security.Cryptography;
using System.Text;
using System.Text.Json;
using Nix.Abstractions;
using Nix.Abstractions.Workers;
using Nix.Domain.Items;
using Nix.Domain.Primitives;
using Nix.Domain.Sites;
using Nix.Domain.Tenancy;
using Nix.Messaging;
using Nix.Persistence.ObjectStorage;

namespace Nix.Features.Sites;

/// <summary>Creates a site over an item's subtree.</summary>
/// <param name="Request">The site to create.</param>
public sealed record CreateSite(CreateSiteRequest Request) : ICommand<SiteResponse>;

/// <summary>Changes a site's settings, mode, exclusions or dated collections.</summary>
/// <param name="SiteId">The site.</param>
/// <param name="Request">The changes.</param>
public sealed record UpdateSite(Guid SiteId, UpdateSiteRequest Request) : ICommand<SiteResponse>;

/// <summary>Replaces a site's custom hostnames.</summary>
/// <param name="SiteId">The site.</param>
/// <param name="Hostnames">The custom hostnames.</param>
public sealed record SetSiteHostnames(Guid SiteId, IReadOnlyList<string> Hostnames) : ICommand<SiteResponse>;

/// <summary>Queues a build of a site.</summary>
/// <param name="SiteId">The site.</param>
/// <param name="IdempotencyKey">Makes a repeated request return the same build.</param>
/// <param name="RefreshPaths">Re-derives the paths a manager did not pin.</param>
/// <param name="AcknowledgeDisclosure">Acknowledges the content becomes public; required on the first publish.</param>
/// <param name="Origin"><c>manual</c>, or <c>auto</c> when the republish planner asked.</param>
public sealed record PublishSite(
    Guid SiteId,
    string IdempotencyKey,
    bool RefreshPaths,
    bool AcknowledgeDisclosure,
    string Origin) : ICommand<SiteBuildResponse>;

/// <summary>Points a site back at a previous build.</summary>
/// <param name="SiteId">The site.</param>
/// <param name="BuildId">The build to serve again.</param>
public sealed record RollbackSite(Guid SiteId, Guid BuildId) : ICommand<SiteBuildResponse>;

/// <summary>Withdraws a site.</summary>
/// <param name="SiteId">The site.</param>
public sealed record UnpublishSite(Guid SiteId) : ICommand<SiteResponse>;

/// <summary>Sets and pins one page's path.</summary>
/// <param name="SiteId">The site.</param>
/// <param name="ItemId">The page's item.</param>
/// <param name="Path">The new path.</param>
public sealed record SetSitePagePath(Guid SiteId, Guid ItemId, string Path) : ICommand<SitePageResponse>;

/// <summary>Deletes a site that is not live and has no objects left.</summary>
/// <param name="SiteId">The site.</param>
public sealed record DeleteSite(Guid SiteId) : ICommand<Guid>;

/// <summary>Reads a site.</summary>
/// <param name="SiteId">The site.</param>
public sealed record GetSite(Guid SiteId) : IQuery<Result<SiteResponse>>;

/// <summary>Reads the site rooted at an item.</summary>
/// <param name="ItemId">The root item.</param>
public sealed record GetItemSite(Guid ItemId) : IQuery<Result<SiteResponse>>;

/// <summary>Lists the sites of a workspace.</summary>
/// <param name="WorkspaceId">The workspace.</param>
public sealed record ListSites(Guid WorkspaceId) : IQuery<Result<SiteListResponse>>;

/// <summary>Lists a site's builds.</summary>
/// <param name="SiteId">The site.</param>
public sealed record ListBuilds(Guid SiteId) : IQuery<Result<SiteBuildListResponse>>;

/// <summary>Reads one build of a site.</summary>
/// <param name="SiteId">The site.</param>
/// <param name="BuildId">The build.</param>
public sealed record GetBuild(Guid SiteId, Guid BuildId) : IQuery<Result<SiteBuildResponse>>;

/// <summary>Lists a site's path table.</summary>
/// <param name="SiteId">The site.</param>
public sealed record ListPages(Guid SiteId) : IQuery<Result<SitePageListResponse>>;

/// <summary>Creates sites.</summary>
public sealed class CreateSiteHandler(
    ISiteStore sites,
    IItemTree tree,
    IItemLocks locks,
    IPermissionResolver permissions,
    INixSessionContextAccessor session,
    SiteOptions options,
    SiteViews views,
    SiteHostnameProvisioner provisioner,
    SiteAudit audit,
    TimeProvider clock) : ICommandHandler<CreateSite, SiteResponse>
{
    public async ValueTask<Result<SiteResponse>> HandleAsync(CreateSite command, CancellationToken cancellationToken)
    {
        ArgumentNullException.ThrowIfNull(command);
        var request = command.Request;
        if (!options.IsEnabled)
        {
            return Result.Failure<SiteResponse>(SiteErrors.NotConfigured());
        }

        if (!SiteRules.IsSlug(request.Slug) || !SiteRules.IsLayout(request.Layout) || request.RootItemId == Guid.Empty)
        {
            return Result.Failure<SiteResponse>(SiteErrors.Invalid(
                "A site needs a root item, a slug of 2 to 40 lowercase letters, digits and single hyphens, and a docs, blog or custom layout."));
        }

        var root = await tree.FindAsync(ItemId.From(request.RootItemId), cancellationToken).ConfigureAwait(false);
        if (root is null || !await permissions.CanReadWorkspaceAsync(root.WorkspaceId, cancellationToken).ConfigureAwait(false))
        {
            return Result.Failure<SiteResponse>(SiteErrors.ItemNotFound());
        }

        if (!await permissions.CanManageWorkspaceAsync(root.WorkspaceId, cancellationToken).ConfigureAwait(false))
        {
            return Result.Failure<SiteResponse>(SiteErrors.ManagerRequired());
        }

        if (options.AutomatesDefaultHostnames)
        {
            // The tunnel before any site row, the order every hostname path keeps.
            await provisioner.LockTunnelAsync(cancellationToken).ConfigureAwait(false);
        }

        if (!options.MayClaimSlug(request.Slug, root.WorkspaceId.Value))
        {
            return Result.Failure<SiteResponse>(new(SiteErrors.SlugReservedCode, "That slug is reserved on this deployment."));
        }

        // Fixed: the tenant's create lock (taken after the tunnel lock, the order every path keeps)
        // makes the count exact, so two concurrent creates can no longer both pass the cap.
        await sites.LockTenantCreatesAsync(cancellationToken).ConfigureAwait(false);
        if (await sites.CountAsync(cancellationToken).ConfigureAwait(false) >= options.MaximumSitesPerTenant)
        {
            return Result.Failure<SiteResponse>(new(
                SiteErrors.LimitReachedCode, $"An organization may have at most {options.MaximumSitesPerTenant} sites. Delete one first."));
        }

        SiteSettingsDto settings;
        if (request.Settings is null)
        {
            var title = ItemProperties.ReadTitle(root.Properties);
            var defaults = SiteSettings.Default(string.IsNullOrWhiteSpace(title) ? request.Slug : title);
            settings = new SiteSettingsDto(
                defaults.Name, defaults.Description, defaults.Accent, [], defaults.FooterText, defaults.BuiltWithNix, defaults.Language);
        }
        else
        {
            var checkedSettings = SiteViews.CheckSettings(request.Settings);
            if (checkedSettings.IsFailure)
            {
                return Result.Failure<SiteResponse>(checkedSettings.Error);
            }

            settings = checkedSettings.Value;
        }

        var themeRefusal = await views.CheckThemeAsync(request.Layout, settings.ThemeItemId, request.RootItemId, cancellationToken).ConfigureAwait(false);
        if (themeRefusal is not null)
        {
            return Result.Failure<SiteResponse>(themeRefusal.Value);
        }

        if ((await locks.GetStateAsync(root.Id, cancellationToken).ConfigureAwait(false)).Locked)
        {
            return Result.Failure<SiteResponse>(new(SiteErrors.RootLockedCode, "The root or one of its ancestors is locked. Remove the lock before making it a site."));
        }

        if (await sites.FindByRootAsync(root.Id, cancellationToken).ConfigureAwait(false) is not null)
        {
            return Result.Failure<SiteResponse>(new(SiteErrors.ExistsCode, "This item already has a site."));
        }

        var context = session.Current
            ?? throw new InvalidOperationException("No session context; the pipeline must establish one.");
        var now = clock.GetUtcNow();
        var site = new Site
        {
            TenantId = context.TenantId,
            Id = Guid.CreateVersion7(),
            WorkspaceId = root.WorkspaceId,
            RootItemId = root.Id,
            Slug = request.Slug,
            Layout = request.Layout,
            Settings = JsonSerializer.Serialize(settings, SitesJsonContext.Default.SiteSettingsDto),
            CreatedBy = context.PrincipalId,
            CreatedAt = now,
            UpdatedAt = now,
        };
        var hostname = new SiteHostname
        {
            TenantId = context.TenantId,
            Hostname = options.DefaultHostname(site.Slug),
            SiteId = site.Id,
            Kind = SiteRules.DefaultHost,
            VerifiedAt = now,
            CreatedAt = now,
        };
        var outcome = await sites.AddAsync(site, hostname, cancellationToken).ConfigureAwait(false);
        if (outcome != SiteWriteOutcome.Written)
        {
            return Result.Failure<SiteResponse>(outcome switch
            {
                SiteWriteOutcome.SlugTaken => new(SiteErrors.SlugTakenCode, "That slug is already used by another site."),
                SiteWriteOutcome.RootTaken => new(SiteErrors.ExistsCode, "This item already has a site."),
                _ => new(SiteErrors.HostnameTakenCode, "That hostname is already used by another site."),
            });
        }

        audit.Record(site, "site.created", null, new { slug = site.Slug, hosts = new[] { hostname.Hostname }, mode = site.RepublishMode, layout = site.Layout });
        // A failed record does not fail the create: the error shows on the hostname and the next publish retries.
        var dns = await provisioner.EnsureDefaultAsync(site, hostname, cancellationToken).ConfigureAwait(false);
        if (dns.Changed || dns.Error is not null)
        {
            audit.Record(site, "site.hostname_dns_written", null, new { hostname = hostname.Hostname, error = dns.Error });
        }

        await sites.SaveAsync(cancellationToken).ConfigureAwait(false);
        return Result.Success(await views.ToResponseAsync(site, cancellationToken).ConfigureAwait(false));
    }
}

/// <summary>Changes sites.</summary>
public sealed class UpdateSiteHandler(
    ISiteStore sites,
    SiteAccess access,
    INixSessionContextAccessor session,
    SiteViews views,
    SiteAudit audit,
    TimeProvider clock) : ICommandHandler<UpdateSite, SiteResponse>
{
    public async ValueTask<Result<SiteResponse>> HandleAsync(UpdateSite command, CancellationToken cancellationToken)
    {
        ArgumentNullException.ThrowIfNull(command);
        var request = command.Request;
        var guarded = await access.ManageAsync(command.SiteId, cancellationToken).ConfigureAwait(false);
        if (guarded.IsFailure)
        {
            return Result.Failure<SiteResponse>(guarded.Error);
        }

        var site = guarded.Value;
        if ((request.Layout is not null && !SiteRules.IsLayout(request.Layout))
            || (request.RepublishMode is not null && !SiteRules.IsRepublishMode(request.RepublishMode))
            || (request.DebounceSeconds is { } debounce
                && (debounce < SiteRules.MinimumDebounceSeconds || debounce > SiteRules.MaximumDebounceSeconds)))
        {
            return Result.Failure<SiteResponse>(SiteErrors.Invalid(
                "The layout must be docs, blog or custom, the mode manual, auto or on_release, and the debounce 60 to 3600 seconds."));
        }

        SiteSettingsDto? settings = null;
        if (request.Settings is not null)
        {
            var checkedSettings = SiteViews.CheckSettings(request.Settings);
            if (checkedSettings.IsFailure)
            {
                return Result.Failure<SiteResponse>(checkedSettings.Error);
            }

            settings = checkedSettings.Value;
        }

        var themeRefusal = await views.CheckThemeAsync(
            request.Layout ?? site.Layout,
            settings is null ? SiteViews.ReadSettings(site).ThemeItemId : settings.ThemeItemId,
            site.RootItemId.Value,
            cancellationToken).ConfigureAwait(false);
        if (themeRefusal is not null)
        {
            return Result.Failure<SiteResponse>(themeRefusal.Value);
        }

        var excluded = request.ExcludedItemIds?.Select(ItemId.From).Distinct().ToArray();
        var dated = request.DatedCollections;
        if (excluded is not null && (excluded.Contains(site.RootItemId) || excluded.Length > 1000))
        {
            return Result.Failure<SiteResponse>(SiteErrors.Invalid("The root cannot be excluded, and at most 1000 items may be."));
        }

        if (dated is not null
            && (dated.Count > 50
                || dated.Select(setting => setting.ItemId).Distinct().Count() != dated.Count
                || dated.Any(setting => !ValidProperty(setting.DateProperty)
                    || !OptionalProperty(setting.TagsProperty)
                    || !OptionalProperty(setting.CoverProperty)
                    || !OptionalProperty(setting.SummaryProperty))))
        {
            return Result.Failure<SiteResponse>(SiteErrors.Invalid(
                "Each dated collection needs a distinct item and a date property of at most 128 characters."));
        }

        var named = (excluded ?? []).Concat((dated ?? []).Select(setting => ItemId.From(setting.ItemId))).ToArray();
        if (!await sites.AreInSubtreeAsync(site.RootItemId, named, cancellationToken).ConfigureAwait(false))
        {
            return Result.Failure<SiteResponse>(new(SiteErrors.ItemOutsideSiteCode, "Every excluded item and dated collection must be under the site's root."));
        }

        var exclusionsBefore = excluded is null ? null : await sites.ListExclusionsAsync(site.Id, cancellationToken).ConfigureAwait(false);
        var datedBefore = dated is null ? null : await sites.ListDatedCollectionsAsync(site.Id, cancellationToken).ConfigureAwait(false);
        var before = new
        {
            mode = site.RepublishMode,
            layout = site.Layout,
            excludedItemIds = exclusionsBefore?.Select(itemId => itemId.Value).ToArray(),
            datedCollections = datedBefore?.Select(setting => new { itemId = setting.ItemId.Value, dateProperty = setting.DateProperty }).ToArray(),
        };
        if (settings is not null)
        {
            site.Settings = JsonSerializer.Serialize(settings, SitesJsonContext.Default.SiteSettingsDto);
        }

        if (request.Layout is not null)
        {
            site.Layout = request.Layout;
        }

        if (request.DebounceSeconds is { } seconds)
        {
            site.DebounceSeconds = seconds;
        }

        if (request.RepublishMode is { } mode && mode != site.RepublishMode)
        {
            var context = session.Current
                ?? throw new InvalidOperationException("No session context; the pipeline must establish one.");

            // Automatic rebuilds run as whoever turned them on, and stop if that person loses the
            // authority to publish; they are never inherited by the next person who saves.
            site.AutoPrincipalId = mode == SiteRules.AutoMode ? context.PrincipalId : null;
            site.RepublishMode = mode;
        }

        if (excluded is not null)
        {
            await sites.ReplaceExclusionsAsync(site, excluded, cancellationToken).ConfigureAwait(false);
        }

        if (dated is not null)
        {
            await sites.ReplaceDatedCollectionsAsync(
                site,
                [.. dated.Select(setting => new SiteDatedCollectionSetting
                {
                    TenantId = site.TenantId,
                    SiteId = site.Id,
                    ItemId = ItemId.From(setting.ItemId),
                    DateProperty = setting.DateProperty,
                    TagsProperty = setting.TagsProperty,
                    CoverProperty = setting.CoverProperty,
                    SummaryProperty = setting.SummaryProperty,
                })],
                cancellationToken).ConfigureAwait(false);
        }

        site.UpdatedAt = clock.GetUtcNow();
        audit.Record(site, "site.updated", before, new
        {
            mode = site.RepublishMode,
            layout = site.Layout,
            excludedItemIds = excluded?.Select(itemId => itemId.Value).Order().ToArray(),
            datedCollections = dated?.Select(setting => new { itemId = setting.ItemId, dateProperty = setting.DateProperty }).ToArray(),
        });
        await sites.SaveAsync(cancellationToken).ConfigureAwait(false);
        return Result.Success(await views.ToResponseAsync(site, cancellationToken).ConfigureAwait(false));
    }

    private static bool ValidProperty(string? name) => name is { Length: > 0 and <= 128 } && !name.Any(char.IsControl);

    private static bool OptionalProperty(string? name) => name is null || ValidProperty(name);
}

/// <summary>Replaces custom hostnames.</summary>
/// <remarks>
/// The bulk form: new names get a verification token and wait for their records; Cloudflare
/// automation and per-name settings go through the single-hostname routes. A removed name that was
/// served loses its host manifest, and the DNS records Nix created for it are deleted.
/// </remarks>
public sealed class SetSiteHostnamesHandler(
    ISiteStore sites,
    SiteAccess access,
    SiteOptions options,
    SiteHostnameService hostnameService,
    SiteHostnameProvisioner provisioner,
    SiteViews views,
    SiteAudit audit,
    TimeProvider clock) : ICommandHandler<SetSiteHostnames, SiteResponse>
{
    public async ValueTask<Result<SiteResponse>> HandleAsync(SetSiteHostnames command, CancellationToken cancellationToken)
    {
        ArgumentNullException.ThrowIfNull(command);
        await provisioner.LockTunnelAsync(cancellationToken).ConfigureAwait(false);
        var guarded = await access.ManageAsync(command.SiteId, cancellationToken).ConfigureAwait(false);
        if (guarded.IsFailure)
        {
            return Result.Failure<SiteResponse>(guarded.Error);
        }

        var site = guarded.Value;
        var hostnames = (command.Hostnames ?? []).Select(SiteRules.NormalizeHost).Distinct(StringComparer.Ordinal).ToArray();
        if (hostnames.Length > SiteRules.MaximumCustomHostnames || hostnames.Any(hostname => !SiteRules.IsHostname(hostname)))
        {
            return Result.Failure<SiteResponse>(SiteErrors.Invalid(
                "Give at most 10 valid, lowercase hostnames such as 'docs.example.com'."));
        }

        if (hostnames.Select(hostname => SiteHostnamePolicy.Refusal(options, hostname)).FirstOrDefault(refusal => refusal is not null) is { } refused)
        {
            return Result.Failure<SiteResponse>(refused);
        }

        var removed = (await sites.ListHostnamesAsync([site.Id], cancellationToken).ConfigureAwait(false))
            .Where(hostname => hostname.Kind == SiteRules.CustomHost && !hostnames.Contains(hostname.Hostname))
            .ToArray();
        var retired = removed.Where(SiteHostnameRules.IsServed).Select(hostname => hostname.Hostname).ToArray();
        if (retired.Length > 0 && site.Status == SiteRules.PublishedStatus && await hostnameService.IsBusyAsync(site, cancellationToken).ConfigureAwait(false))
        {
            return Result.Failure<SiteResponse>(new(SiteErrors.BuildInProgressCode, "A build or a change of what is live is under way. Try again in a moment."));
        }

        var now = clock.GetUtcNow();
        var outcome = await sites.ReplaceCustomHostnamesAsync(site.Id, hostnames, now, cancellationToken).ConfigureAwait(false);
        if (outcome != SiteWriteOutcome.Written)
        {
            return Result.Failure<SiteResponse>(new(SiteErrors.HostnameTakenCode, "One of those hostnames is already used by another site."));
        }

        foreach (var hostname in removed)
        {
            if (await provisioner.RemoveAsync(hostname, cancellationToken).ConfigureAwait(false) is { } cleanup)
            {
                return Result.Failure<SiteResponse>(new(
                    SiteErrors.DnsCleanupFailedCode,
                    $"The DNS records Nix created for {hostname.Hostname} could not be deleted ({cleanup}), so nothing changed."));
            }
        }

        // The savepoint in the store clears the change tracker on a refusal; the tracked site is
        // re-read so its timestamp is written with the audit event.
        var tracked = await sites.FindForUpdateAsync(site.Id, cancellationToken).ConfigureAwait(false);
        if (tracked is null)
        {
            return Result.Failure<SiteResponse>(SiteErrors.NotFound());
        }

        if (removed.Any(hostname => hostname.Hostname == tracked.PrimaryHostname))
        {
            tracked.PrimaryHostname = null;
        }

        tracked.UpdatedAt = now;
        audit.Record(tracked, "site.hostname_changed", null, new { hosts = hostnames });
        if (retired.Length > 0
            && await hostnameService.QueueActivationAsync(
                tracked, await sites.ListHostnamesAsync([site.Id], cancellationToken).ConfigureAwait(false), retired, cancellationToken).ConfigureAwait(false))
        {
            if (!await sites.TrySaveActivationAsync(cancellationToken).ConfigureAwait(false))
            {
                return Result.Failure<SiteResponse>(SiteErrors.ActivationRaced());
            }
        }
        else
        {
            await sites.SaveAsync(cancellationToken).ConfigureAwait(false);
        }

        return Result.Success(await views.ToResponseAsync(tracked, cancellationToken).ConfigureAwait(false));
    }
}

/// <summary>Points a site back at a previous build.</summary>
public sealed class RollbackSiteHandler(
    ISiteStore sites,
    SiteAccess access,
    SiteOptions options,
    IWorkerJobStore jobs,
    INixSessionContextAccessor session,
    SiteAudit audit,
    TimeProvider clock) : ICommandHandler<RollbackSite, SiteBuildResponse>
{
    public async ValueTask<Result<SiteBuildResponse>> HandleAsync(RollbackSite command, CancellationToken cancellationToken)
    {
        ArgumentNullException.ThrowIfNull(command);
        var guarded = await access.ManageAsync(command.SiteId, cancellationToken).ConfigureAwait(false);
        if (guarded.IsFailure)
        {
            return Result.Failure<SiteBuildResponse>(guarded.Error);
        }

        var site = guarded.Value;
        if (site.Status != SiteRules.PublishedStatus)
        {
            return Result.Failure<SiteBuildResponse>(new(SiteErrors.NotPublishedCode, "Only a live site can be rolled back."));
        }

        var target = await sites.FindBuildAsync(site.Id, command.BuildId, cancellationToken).ConfigureAwait(false);
        if (target is null)
        {
            return Result.Failure<SiteBuildResponse>(new(SiteErrors.BuildNotFoundCode, "No such build of this site."));
        }

        if (target.Build.Status != SiteRules.SupersededBuild || target.Build.PurgeId is not null)
        {
            return Result.Failure<SiteBuildResponse>(new(SiteErrors.BuildUnavailableCode, "Only a previous build that has not been retired can be served again."));
        }

        if (await sites.HasBuildInFlightAsync(site.Id, cancellationToken).ConfigureAwait(false)
            || await sites.HasActivationInFlightAsync(site.Id, cancellationToken).ConfigureAwait(false))
        {
            return Result.Failure<SiteBuildResponse>(new(SiteErrors.BuildInProgressCode, "A build or a change of what is live is already under way."));
        }

        var now = clock.GetUtcNow();
        var hostnames = await sites.ListHostnamesAsync([site.Id], cancellationToken).ConfigureAwait(false);
        var generation = await sites.NextGenerationAsync(site.Id, cancellationToken).ConfigureAwait(false);
        var ops = SiteHostManifests.Puts(site, target.Build.Id, hostnames, generation, now, options.PublicUrl);
        await SiteActivations.QueueAsync(
            sites, jobs, session, site, target.Build.Id, SiteRules.RollbackActivation, generation, ops, now, cancellationToken).ConfigureAwait(false);
        audit.Record(site, "site.rolled_back", new { buildId = site.LiveBuildId }, new { buildId = target.Build.Id });
        if (!await sites.TrySaveActivationAsync(cancellationToken).ConfigureAwait(false))
        {
            return Result.Failure<SiteBuildResponse>(SiteErrors.ActivationRaced());
        }

        return Result.Success(SiteViews.ToBuild(target));
    }
}

/// <summary>Withdraws sites.</summary>
public sealed class UnpublishSiteHandler(
    ISiteStore sites,
    SiteAccess access,
    IWorkerJobStore jobs,
    INixSessionContextAccessor session,
    SiteViews views,
    SiteAudit audit,
    TimeProvider clock) : ICommandHandler<UnpublishSite, SiteResponse>
{
    public async ValueTask<Result<SiteResponse>> HandleAsync(UnpublishSite command, CancellationToken cancellationToken)
    {
        ArgumentNullException.ThrowIfNull(command);
        var guarded = await access.ManageAsync(command.SiteId, cancellationToken).ConfigureAwait(false);
        if (guarded.IsFailure)
        {
            return Result.Failure<SiteResponse>(guarded.Error);
        }

        var site = guarded.Value;
        if (site.Status != SiteRules.PublishedStatus || site.LiveBuildId is not { } liveBuildId)
        {
            return Result.Failure<SiteResponse>(new(SiteErrors.NotPublishedCode, "This site is not live."));
        }

        // A build still in flight would put the site back on the internet the moment it finished.
        if (await sites.HasBuildInFlightAsync(site.Id, cancellationToken).ConfigureAwait(false)
            || await sites.HasActivationInFlightAsync(site.Id, cancellationToken).ConfigureAwait(false))
        {
            return Result.Failure<SiteResponse>(new(SiteErrors.BuildInProgressCode, "A build or a change of what is live is already under way."));
        }

        var now = clock.GetUtcNow();
        var hostnames = await sites.ListHostnamesAsync([site.Id], cancellationToken).ConfigureAwait(false);
        var generation = await sites.NextGenerationAsync(site.Id, cancellationToken).ConfigureAwait(false);
        await SiteActivations.QueueAsync(
            sites, jobs, session, site, liveBuildId, SiteRules.UnpublishActivation, generation, SiteHostManifests.Deletes(hostnames), now, cancellationToken)
            .ConfigureAwait(false);
        audit.Record(site, "site.unpublished", new { status = site.Status, buildId = liveBuildId }, new { status = "unpublishing" });
        if (!await sites.TrySaveActivationAsync(cancellationToken).ConfigureAwait(false))
        {
            return Result.Failure<SiteResponse>(SiteErrors.ActivationRaced());
        }

        return Result.Success(await views.ToResponseAsync(site, cancellationToken).ConfigureAwait(false));
    }
}

/// <summary>Sets and pins page paths.</summary>
public sealed class SetSitePagePathHandler(
    ISiteStore sites,
    SiteAccess access,
    SiteAudit audit,
    TimeProvider clock) : ICommandHandler<SetSitePagePath, SitePageResponse>
{
    public async ValueTask<Result<SitePageResponse>> HandleAsync(SetSitePagePath command, CancellationToken cancellationToken)
    {
        ArgumentNullException.ThrowIfNull(command);
        var guarded = await access.ManageAsync(command.SiteId, cancellationToken).ConfigureAwait(false);
        if (guarded.IsFailure)
        {
            return Result.Failure<SitePageResponse>(guarded.Error);
        }

        var site = guarded.Value;
        var path = command.Path?.Trim() ?? string.Empty;
        if (!SiteRules.IsPath(path))
        {
            return Result.Failure<SitePageResponse>(SiteErrors.Invalid("A path is lowercase letters, digits and hyphens between slashes, such as '/blog/hello/'."));
        }

        var (pages, redirects) = await sites.LoadPathsAsync(site.Id, cancellationToken).ConfigureAwait(false);
        var itemId = ItemId.From(command.ItemId);
        var page = pages.SingleOrDefault(candidate => candidate.ItemId == itemId);
        if (page is null)
        {
            return Result.Failure<SitePageResponse>(new(SiteErrors.PageNotFoundCode, "This site has no such page. Publish it first."));
        }

        if (itemId == site.RootItemId)
        {
            return Result.Failure<SitePageResponse>(new(SiteErrors.RootPathFixedCode, "The root page is always '/'."));
        }

        var now = clock.GetUtcNow();
        if (page.Path != path)
        {
            if (pages.Any(candidate => candidate.Path == path))
            {
                return Result.Failure<SitePageResponse>(new(SiteErrors.PathTakenCode, "Another page already has that path."));
            }

            // The new path is live now, so an old redirect from it is retired; the path being
            // left becomes a permanent redirect to this page.
            if (redirects.SingleOrDefault(candidate => candidate.FromPath == path) is { } shadowed)
            {
                sites.RemoveRedirect(shadowed);
            }

            if (!redirects.Any(candidate => candidate.FromPath == page.Path))
            {
                sites.AddRedirect(new SiteRedirect { TenantId = site.TenantId, SiteId = site.Id, FromPath = page.Path, ItemId = itemId, CreatedAt = now });
            }

            audit.Record(site, "site.path_changed", new { itemId = itemId.Value, path = page.Path }, new { itemId = itemId.Value, path });
            page.Path = path;
            page.UpdatedAt = now;
        }

        page.Pinned = true;
        await sites.SaveAsync(cancellationToken).ConfigureAwait(false);
        var title = (await sites.ListPagesAsync(site.Id, cancellationToken).ConfigureAwait(false))
            .SingleOrDefault(row => row.ItemId == itemId)?.Title;
        return Result.Success(new SitePageResponse(itemId.Value, page.Path, page.Pinned, title));
    }
}

/// <summary>Deletes sites.</summary>
public sealed class DeleteSiteHandler(
    ISiteStore sites,
    SiteAccess access,
    SiteHostnameProvisioner provisioner,
    SiteAudit audit) : ICommandHandler<DeleteSite, Guid>
{
    public async ValueTask<Result<Guid>> HandleAsync(DeleteSite command, CancellationToken cancellationToken)
    {
        ArgumentNullException.ThrowIfNull(command);
        await provisioner.LockTunnelAsync(cancellationToken).ConfigureAwait(false);
        var guarded = await access.ManageAsync(command.SiteId, cancellationToken).ConfigureAwait(false);
        if (guarded.IsFailure)
        {
            return Result.Failure<Guid>(guarded.Error);
        }

        var site = guarded.Value;
        if (site.Status == SiteRules.PublishedStatus)
        {
            return Result.Failure<Guid>(new(SiteErrors.UnpublishFirstCode, "Unpublish the site before deleting it."));
        }

        if (await sites.HasBuildInFlightAsync(site.Id, cancellationToken).ConfigureAwait(false)
            || await sites.HasActivationInFlightAsync(site.Id, cancellationToken).ConfigureAwait(false))
        {
            return Result.Failure<Guid>(new(SiteErrors.BuildInProgressCode, "A build or a change of what is live is under way."));
        }

        // Deleting the rows would orphan whatever is still in the bucket and forget what names it.
        if (await sites.HasUnpurgedObjectsAsync(site.Id, cancellationToken).ConfigureAwait(false))
        {
            return Result.Failure<Guid>(new(SiteErrors.PurgePendingCode, "The site's files are still being deleted. Try again in a moment."));
        }

        // The DNS records Nix created for the site's hostnames go with it; records it did not create stay.
        foreach (var hostname in await sites.ListHostnamesAsync([site.Id], cancellationToken).ConfigureAwait(false))
        {
            if (await provisioner.RemoveAsync(hostname, cancellationToken).ConfigureAwait(false) is { } cleanup)
            {
                return Result.Failure<Guid>(new(
                    SiteErrors.DnsCleanupFailedCode,
                    $"The DNS records Nix created for {hostname.Hostname} could not be deleted ({cleanup}), so the site was kept."));
            }
        }

        audit.Record(site, "site.deleted", new { slug = site.Slug, status = site.Status }, null);
        await sites.SaveAsync(cancellationToken).ConfigureAwait(false);
        await sites.RemoveAsync(site, cancellationToken).ConfigureAwait(false);
        return Result.Success(site.Id);
    }
}

/// <summary>Reads sites.</summary>
public sealed class SiteQueryHandlers(
    ISiteStore sites,
    SiteAccess access,
    IItemTree tree,
    IPermissionResolver permissions,
    SiteViews views) :
    IQueryHandler<GetSite, Result<SiteResponse>>,
    IQueryHandler<GetItemSite, Result<SiteResponse>>,
    IQueryHandler<ListSites, Result<SiteListResponse>>,
    IQueryHandler<ListBuilds, Result<SiteBuildListResponse>>,
    IQueryHandler<GetBuild, Result<SiteBuildResponse>>,
    IQueryHandler<ListPages, Result<SitePageListResponse>>
{
    private const int BuildListLimit = 50;

    public async ValueTask<Result<SiteResponse>> HandleAsync(GetSite query, CancellationToken cancellationToken)
    {
        ArgumentNullException.ThrowIfNull(query);
        var found = await access.ReadAsync(query.SiteId, cancellationToken).ConfigureAwait(false);
        return found.IsFailure
            ? Result.Failure<SiteResponse>(found.Error)
            : Result.Success(await views.ToResponseAsync(found.Value, cancellationToken).ConfigureAwait(false));
    }

    public async ValueTask<Result<SiteResponse>> HandleAsync(GetItemSite query, CancellationToken cancellationToken)
    {
        ArgumentNullException.ThrowIfNull(query);
        var item = await tree.FindAsync(ItemId.From(query.ItemId), cancellationToken).ConfigureAwait(false);
        if (item is null || !await permissions.CanReadWorkspaceAsync(item.WorkspaceId, cancellationToken).ConfigureAwait(false))
        {
            return Result.Failure<SiteResponse>(SiteErrors.ItemNotFound());
        }

        var site = await sites.FindByRootAsync(item.Id, cancellationToken).ConfigureAwait(false);
        return site is null
            ? Result.Failure<SiteResponse>(SiteErrors.NotFound())
            : Result.Success(await views.ToResponseAsync(site, cancellationToken).ConfigureAwait(false));
    }

    public async ValueTask<Result<SiteListResponse>> HandleAsync(ListSites query, CancellationToken cancellationToken)
    {
        ArgumentNullException.ThrowIfNull(query);
        var workspaceId = WorkspaceId.From(query.WorkspaceId);
        if (!await permissions.CanReadWorkspaceAsync(workspaceId, cancellationToken).ConfigureAwait(false))
        {
            return Result.Failure<SiteListResponse>(SiteErrors.NotFound());
        }

        var listed = new List<SiteResponse>();
        foreach (var site in await sites.ListAsync(workspaceId, cancellationToken).ConfigureAwait(false))
        {
            listed.Add(await views.ToResponseAsync(site, cancellationToken).ConfigureAwait(false));
        }

        return Result.Success(new SiteListResponse(listed));
    }

    public async ValueTask<Result<SiteBuildListResponse>> HandleAsync(ListBuilds query, CancellationToken cancellationToken)
    {
        ArgumentNullException.ThrowIfNull(query);
        var found = await access.ReadAsync(query.SiteId, cancellationToken).ConfigureAwait(false);
        if (found.IsFailure)
        {
            return Result.Failure<SiteBuildListResponse>(found.Error);
        }

        var builds = await sites.ListBuildsAsync(found.Value.Id, BuildListLimit, cancellationToken).ConfigureAwait(false);
        return Result.Success(new SiteBuildListResponse([.. builds.Select(SiteViews.ToBuild)]));
    }

    public async ValueTask<Result<SiteBuildResponse>> HandleAsync(GetBuild query, CancellationToken cancellationToken)
    {
        ArgumentNullException.ThrowIfNull(query);
        var found = await access.ReadAsync(query.SiteId, cancellationToken).ConfigureAwait(false);
        if (found.IsFailure)
        {
            return Result.Failure<SiteBuildResponse>(found.Error);
        }

        var build = await sites.FindBuildAsync(found.Value.Id, query.BuildId, cancellationToken).ConfigureAwait(false);
        return build is null
            ? Result.Failure<SiteBuildResponse>(new(SiteErrors.BuildNotFoundCode, "No such build of this site."))
            : Result.Success(SiteViews.ToBuild(build));
    }

    public async ValueTask<Result<SitePageListResponse>> HandleAsync(ListPages query, CancellationToken cancellationToken)
    {
        ArgumentNullException.ThrowIfNull(query);
        var found = await access.ReadAsync(query.SiteId, cancellationToken).ConfigureAwait(false);
        if (found.IsFailure)
        {
            return Result.Failure<SitePageListResponse>(found.Error);
        }

        var pages = await sites.ListPagesAsync(found.Value.Id, cancellationToken).ConfigureAwait(false);
        return Result.Success(new SitePageListResponse(
            [.. pages.Select(page => new SitePageResponse(page.ItemId.Value, page.Path, page.Pinned, page.Title))]));
    }
}

/// <summary>The job kinds of the sites worker role (queue <c>nix.worker.sites.v1</c>, bound to <c>site.#</c>).</summary>
internal static class SiteJobKinds
{
    /// <summary>Builds a site and writes its objects.</summary>
    internal const string Build = "site.build";

    /// <summary>Applies a rollback or an unpublish to the host manifests.</summary>
    internal const string Activate = "site.activate";

    /// <summary>Deletes the objects of retired builds.</summary>
    internal const string Purge = "site.purge";
}

/// <summary>Queues the worker job that applies host-manifest operations.</summary>
internal static class SiteActivations
{
    /// <summary>Records an activation and queues its job.</summary>
    internal static async ValueTask QueueAsync(
        ISiteStore sites,
        IWorkerJobStore jobs,
        INixSessionContextAccessor session,
        Site site,
        Guid buildId,
        string reason,
        int generation,
        IReadOnlyList<SiteActivationOpRecord> ops,
        DateTimeOffset now,
        CancellationToken cancellationToken)
    {
        var context = session.Current
            ?? throw new InvalidOperationException("No session context; the pipeline must establish one.");
        var activationId = Guid.CreateVersion7();
        var job = await jobs.CreateAsync(
            context.TenantId,
            context.PrincipalId,
            site.WorkspaceId,
            SiteJobKinds.Activate,
            "site.activate:" + activationId.ToString("D"),
            JsonSerializer.Serialize(new SiteActivateJobPayload(site.Id, activationId), SitesJsonContext.Default.SiteActivateJobPayload),
            cancellationToken).ConfigureAwait(false);
        sites.AddActivation(new SiteActivation
        {
            TenantId = context.TenantId,
            Id = activationId,
            SiteId = site.Id,
            JobId = job.Id,
            BuildId = buildId,
            Reason = reason,
            Generation = generation,
            Ops = JsonSerializer.Serialize(ops.ToArray(), SitesJsonContext.Default.SiteActivationOpRecordArray),
            CreatedAt = now,
        });
    }
}

/// <summary>Builds the host manifests that map hostnames to a build, byte for byte.</summary>
public static class SiteHostManifests
{
    /// <summary>
    /// One <c>put</c> per served hostname, each carrying its exact bytes and their digest. Every
    /// manifest names the canonical host; a non-primary hostname in <c>redirect</c> mode also
    /// carries the origin the serving process sends visitors to with a 308.
    /// </summary>
    /// <param name="site">The site.</param>
    /// <param name="buildId">The build the hostnames point at.</param>
    /// <param name="hostnames">Every hostname of the site.</param>
    /// <param name="generation">The activation generation.</param>
    /// <param name="now">The activation instant.</param>
    /// <param name="publicUrl">Maps a hostname to its public root URL; https by default.</param>
    public static IReadOnlyList<SiteActivationOpRecord> Puts(
        Site site,
        Guid buildId,
        IReadOnlyList<SiteHostname> hostnames,
        int generation,
        DateTimeOffset now,
        Func<string, Uri>? publicUrl = null)
    {
        ArgumentNullException.ThrowIfNull(site);
        ArgumentNullException.ThrowIfNull(hostnames);
        var served = Served(hostnames);
        var canonical = SiteHostnameRules.Canonical(site.PrimaryHostname, served);
        var origin = (publicUrl ?? (host => new Uri("https://" + host + "/")))(canonical.Hostname).GetLeftPart(UriPartial.Authority);
        return [.. served.Select(hostname =>
        {
            var body = JsonSerializer.Serialize(
                new SiteHostManifest(
                    1,
                    site.Id,
                    buildId,
                    generation,
                    ObjectStorageKeys.SiteBuildPrefix(site.Id, buildId),
                    ObjectStorageKeys.SiteAssetsPrefix(site.Id),
                    canonical.Hostname,
                    now,
                    SiteHostnameRules.Redirects(hostname, canonical) ? origin : null),
                SitesJsonContext.Default.SiteHostManifest);
            Span<byte> bytes = stackalloc byte[2048];
            var length = Encoding.UTF8.GetBytes(body, bytes);
            var digest = Convert.ToHexStringLower(SHA256.HashData(bytes[..length]));
            return new SiteActivationOpRecord("put", hostname.Hostname, ObjectStorageKeys.SiteHost(hostname.Hostname), body, digest, length);
        })];
    }

    /// <summary>One <c>delete</c> per served hostname.</summary>
    public static IReadOnlyList<SiteActivationOpRecord> Deletes(IReadOnlyList<SiteHostname> hostnames)
    {
        ArgumentNullException.ThrowIfNull(hostnames);
        return [.. Served(hostnames).Select(hostname => new SiteActivationOpRecord(
            "delete", hostname.Hostname, ObjectStorageKeys.SiteHost(hostname.Hostname), null, null, 0))];
    }

    // Only a default hostname, or one whose ownership was verified, gets a host manifest.
    private static SiteHostname[] Served(IReadOnlyList<SiteHostname> hostnames) =>
        [.. hostnames
            .Where(SiteHostnameRules.IsServed)
            .OrderBy(hostname => hostname.Hostname, StringComparer.Ordinal)];
}
