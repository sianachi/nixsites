using System.Text.Json;
using Microsoft.AspNetCore.Http;
using Microsoft.Extensions.DependencyInjection;
using Nix.Abstractions;
using Nix.Domain.Audit;
using Nix.Domain.Identity;
using Nix.Domain.Items;
using Nix.Domain.Primitives;
using Nix.Domain.Sites;
using Nix.Errors;

namespace Nix.Features.Sites;

/// <summary>The deployment-level switch in front of every sites route.</summary>
public static class SiteGate
{
    /// <summary>
    /// Refuses every sites route with <c>sites.not_configured</c> (503) while the feature is off, reads
    /// included, so a disabled deployment exposes no usable sites entry point. Stored sites are left
    /// as they are.
    /// </summary>
    /// <param name="context">The invocation.</param>
    /// <param name="next">The route, run only when sites are enabled.</param>
    /// <returns>The route's result, or the refusal.</returns>
    public static async ValueTask<object?> RequireEnabled(EndpointFilterInvocationContext context, EndpointFilterDelegate next)
    {
        ArgumentNullException.ThrowIfNull(context);
        ArgumentNullException.ThrowIfNull(next);
        var options = context.HttpContext.RequestServices.GetRequiredService<SiteOptions>();
        if (options.IsEnabled)
        {
            return await next(context).ConfigureAwait(false);
        }

        var error = SiteErrors.NotConfigured();
        return TypedResults.Problem(ApiProblem.Create(
            context.HttpContext, SiteErrors.StatusFor(error.Code), error.Code, "Request refused", error.Message));
    }
}

/// <summary>Stable failure codes for sites, and the status each is published with.</summary>
public static class SiteErrors
{
    /// <summary>No such site, or the caller cannot read its workspace.</summary>
    public const string NotFoundCode = "sites.not_found";

    /// <summary>The caller can read the workspace but may not manage it.</summary>
    public const string ManagerRequiredCode = "sites.manager_required";

    /// <summary>This deployment has no sites domain, bucket or object store.</summary>
    public const string NotConfiguredCode = "sites.not_configured";

    /// <summary>A field is outside its bounds.</summary>
    public const string InvalidCode = "sites.request_invalid";

    /// <summary>The slug belongs to another site.</summary>
    public const string SlugTakenCode = "sites.slug_taken";

    /// <summary>The root item already has a site.</summary>
    public const string ExistsCode = "sites.exists";

    /// <summary>A hostname belongs to another site.</summary>
    public const string HostnameTakenCode = "sites.hostname_taken";

    /// <summary>A hostname is not allowed.</summary>
    public const string HostnameReservedCode = "sites.hostname_reserved";

    /// <summary>The root or one of its ancestors is locked.</summary>
    public const string RootLockedCode = "sites.root_locked";

    /// <summary>The root is trashed, hidden, excluded or otherwise not publishable.</summary>
    public const string RootUnavailableCode = "sites.root_unavailable";

    /// <summary>The first publish needs the disclosure acknowledged.</summary>
    public const string DisclosureRequiredCode = "sites.disclosure_required";

    /// <summary>A build or activation is already under way.</summary>
    public const string BuildInProgressCode = "sites.build_in_progress";

    /// <summary>The subtree has more pages than a build may hold.</summary>
    public const string TooManyPagesCode = "sites.too_many_pages";

    /// <summary>No such build of the site.</summary>
    public const string BuildNotFoundCode = "sites.build_not_found";

    /// <summary>The build cannot be served again.</summary>
    public const string BuildUnavailableCode = "sites.build_unavailable";

    /// <summary>The site is not live.</summary>
    public const string NotPublishedCode = "sites.not_published";

    /// <summary>The site is live and must be unpublished first.</summary>
    public const string UnpublishFirstCode = "sites.unpublish_first";

    /// <summary>Objects of the site are still being deleted.</summary>
    public const string PurgePendingCode = "sites.purge_pending";

    /// <summary>The path belongs to another page.</summary>
    public const string PathTakenCode = "sites.path_taken";

    /// <summary>The site has no such page.</summary>
    public const string PageNotFoundCode = "sites.page_not_found";

    /// <summary>The root page's path is always <c>/</c>.</summary>
    public const string RootPathFixedCode = "sites.root_path_fixed";

    /// <summary>The slug is reserved for the deployment.</summary>
    public const string SlugReservedCode = "sites.slug_reserved";

    /// <summary>The tenant already has as many sites as the deployment allows.</summary>
    public const string LimitReachedCode = "sites.limit_reached";

    /// <summary>An item named in the request is not under the site's root.</summary>
    public const string ItemOutsideSiteCode = "sites.item_outside_site";

    /// <summary>A manager asked for a check again too soon after the last one.</summary>
    public const string CheckTooSoonCode = "sites.check_too_soon";

    /// <summary>The DNS records Nix created could not be deleted, so the hostname was kept.</summary>
    public const string DnsCleanupFailedCode = "sites.dns_cleanup_failed";

    /// <summary>The site has no such hostname.</summary>
    public const string HostnameNotFoundCode = "sites.hostname_not_found";

    /// <summary>The first publish waits for an operator; ask for approval first.</summary>
    public const string ApprovalRequiredCode = "sites.approval_required";

    /// <summary>An approval request is already waiting for an operator.</summary>
    public const string ApprovalPendingCode = "sites.approval_pending";

    /// <summary>This deployment does not ask for approval, or the site is already live.</summary>
    public const string ApprovalNotNeededCode = "sites.approval_not_needed";

    /// <summary>Only an operator may decide approvals.</summary>
    public const string OperatorRequiredCode = "sites.operator_required";

    /// <summary>The operator is set in configuration, so Settings cannot revoke it.</summary>
    public const string OperatorConfiguredCode = "sites.operator_configured";

    /// <summary>No such principal in the caller's tenant.</summary>
    public const string PrincipalNotFoundCode = "identity.principal_not_found";

    /// <summary>The site has no pending approval request.</summary>
    public const string NoApprovalPendingCode = "sites.no_approval_pending";

    /// <summary>No such item, or the caller cannot see it.</summary>
    public const string ItemNotFoundCode = "items.not_found";

    internal static NixError NotFound() => new(NotFoundCode, "No such site is visible.");

    internal static NixError ItemNotFound() => new(ItemNotFoundCode, "No such item is visible.");

    internal static NixError ManagerRequired() =>
        new(ManagerRequiredCode, "Only a workspace manager can change or publish a site.");

    internal static NixError OperatorRequired() =>
        new(OperatorRequiredCode, "Only an operator of this deployment may decide first publishes.");

    internal static NixError PrincipalNotFound() => new(PrincipalNotFoundCode, "No such person in this organization.");

    internal static NixError NotConfigured() =>
        new(NotConfiguredCode, "Sites are not enabled on this deployment.");

    internal static NixError Invalid(string detail) => new(InvalidCode, detail);

    /// <summary>A concurrent change deadlocked with this one; retrying is safe.</summary>
    public static NixError Deadlocked() =>
        new(BuildInProgressCode, "Another change to this site ran at the same moment. Try again.");

    /// <summary>Whether the exception, or one it wraps, is a Postgres deadlock (40P01).</summary>
    public static bool IsDeadlock(Exception? exception)
    {
        for (; exception is not null; exception = exception.InnerException)
        {
            if (exception is Npgsql.PostgresException { SqlState: Npgsql.PostgresErrorCodes.DeadlockDetected })
            {
                return true;
            }
        }

        return false;
    }

    internal static NixError ActivationRaced() =>
        new(BuildInProgressCode, "Another change of what is live was recorded at the same time. Try again.");

    /// <summary>The HTTP status a code is published with.</summary>
    /// <param name="code">A sites error code.</param>
    /// <returns>The status.</returns>
    public static int StatusFor(string code) => code switch
    {
        NotFoundCode or ItemNotFoundCode or PrincipalNotFoundCode or BuildNotFoundCode or PageNotFoundCode or HostnameNotFoundCode => StatusCodes.Status404NotFound,
        ManagerRequiredCode or OperatorRequiredCode => StatusCodes.Status403Forbidden,
        CheckTooSoonCode => StatusCodes.Status429TooManyRequests,
        NotConfiguredCode => StatusCodes.Status503ServiceUnavailable,
        InvalidCode or DisclosureRequiredCode or TooManyPagesCode or HostnameReservedCode or SlugReservedCode
            or RootPathFixedCode or ItemOutsideSiteCode => StatusCodes.Status422UnprocessableEntity,
        _ => StatusCodes.Status409Conflict,
    };
}

/// <summary>Loads a site and applies the read and manage rules every site operation shares.</summary>
public sealed class SiteAccess(ISiteStore sites, IPermissionResolver permissions)
{
    /// <summary>A site the caller may read; anything else is not found.</summary>
    public async ValueTask<Result<Site>> ReadAsync(Guid siteId, CancellationToken cancellationToken)
    {
        var site = await sites.FindAsync(siteId, cancellationToken).ConfigureAwait(false);
        return site is null || !await permissions.CanReadWorkspaceAsync(site.WorkspaceId, cancellationToken).ConfigureAwait(false)
            ? Result.Failure<Site>(SiteErrors.NotFound())
            : Result.Success(site);
    }

    /// <summary>
    /// The manage rule without the row lock, for work that must call out (DNS, Cloudflare) before it
    /// takes the lock. Whoever writes afterwards takes <see cref="ManageAsync"/> again.
    /// </summary>
    public async ValueTask<Result<Site>> AuthorizeManageAsync(Guid siteId, CancellationToken cancellationToken)
    {
        var site = await sites.FindAsync(siteId, cancellationToken).ConfigureAwait(false);
        if (site is null || !await permissions.CanReadWorkspaceAsync(site.WorkspaceId, cancellationToken).ConfigureAwait(false))
        {
            return Result.Failure<Site>(SiteErrors.NotFound());
        }

        return await permissions.CanManageWorkspaceAsync(site.WorkspaceId, cancellationToken).ConfigureAwait(false)
            ? Result.Success(site)
            : Result.Failure<Site>(SiteErrors.ManagerRequired());
    }

    /// <summary>
    /// A site the caller may manage. A caller who cannot even read the workspace learns nothing
    /// (404); one who can read it is told they lack the authority (403). The site's row lock is
    /// taken before it is read, so every managing change is serialised with the others and with
    /// the worker's seal and activation.
    /// </summary>
    public async ValueTask<Result<Site>> ManageAsync(Guid siteId, CancellationToken cancellationToken)
    {
        await sites.LockSiteAsync(siteId, cancellationToken).ConfigureAwait(false);
        var site = await sites.FindForUpdateAsync(siteId, cancellationToken).ConfigureAwait(false);
        if (site is null || !await permissions.CanReadWorkspaceAsync(site.WorkspaceId, cancellationToken).ConfigureAwait(false))
        {
            return Result.Failure<Site>(SiteErrors.NotFound());
        }

        return await permissions.CanManageWorkspaceAsync(site.WorkspaceId, cancellationToken).ConfigureAwait(false)
            ? Result.Success(site)
            : Result.Failure<Site>(SiteErrors.ManagerRequired());
    }
}

/// <summary>Writes the audit trail of site actions. Before and after hold the envelope only, never content.</summary>
public sealed class SiteAudit(
    ISiteStore sites,
    INixSessionContextAccessor session,
    TimeProvider clock,
    IHttpContextAccessor? http = null)
{
    /// <summary>
    /// The actor recorded for what the background hostname checker does on its own (verifying,
    /// unverifying, withdrawing an abandoned claim). Not a principal row: audit actors carry no
    /// foreign key, and no person did these things.
    /// </summary>
    public static readonly PrincipalId SystemActor = PrincipalId.From(new Guid("5175e000-0000-4000-8000-00000000c4ec"));

    /// <summary>Queues one audit event as <see cref="SystemActor"/>.</summary>
    public void RecordSystem(Site site, string action, object? before, object? after) =>
        Write(site, SystemActor, action, before, after);

    /// <summary>Queues one audit event; it is saved with the surrounding unit of work.</summary>
    /// <param name="site">The site acted on.</param>
    /// <param name="action">The action, such as <c>site.published</c>.</param>
    /// <param name="before">The envelope before, if any.</param>
    /// <param name="after">The envelope after, if any.</param>
    public void Record(Site site, string action, object? before, object? after)
    {
        var context = session.Current
            ?? throw new InvalidOperationException("No session context; the pipeline must establish one.");
        Write(site, context.PrincipalId, action, before, after);
    }

    private void Write(Site site, PrincipalId actor, string action, object? before, object? after)
    {
        ArgumentNullException.ThrowIfNull(site);
        sites.AddAudit(new AuditEvent
        {
            Id = AuditEventId.Create(),
            TenantId = site.TenantId,
            WorkspaceId = site.WorkspaceId,
            ActorId = actor,
            OnBehalfOf = null,
            Action = action,
            SubjectId = site.Id,
            SubjectType = "site",
            Before = before is null ? null : JsonSerializer.Serialize(before),
            After = after is null ? null : JsonSerializer.Serialize(after),
            ActorIp = http?.HttpContext?.Connection.RemoteIpAddress,
            OccurredAt = clock.GetUtcNow(),
        });
    }
}

/// <summary>Maps stored sites and builds onto their published shapes.</summary>
public sealed class SiteViews(ISiteStore sites, IPermissionResolver permissions, SiteOptions options)
{
    /// <summary>Maps a site with its hostnames, settings and latest builds.</summary>
    public async ValueTask<SiteResponse> ToResponseAsync(Site site, CancellationToken cancellationToken)
    {
        ArgumentNullException.ThrowIfNull(site);
        var hostnames = await sites.ListHostnamesAsync([site.Id], cancellationToken).ConfigureAwait(false);
        var excluded = await sites.ListExclusionsAsync(site.Id, cancellationToken).ConfigureAwait(false);
        var dated = await sites.ListDatedCollectionsAsync(site.Id, cancellationToken).ConfigureAwait(false);
        var latest = (await sites.ListBuildsAsync(site.Id, 1, cancellationToken).ConfigureAwait(false)) is { Count: > 0 } recent ? recent[0] : null;
        var live = site.LiveBuildId is { } liveId
            ? await sites.FindBuildAsync(site.Id, liveId, cancellationToken).ConfigureAwait(false)
            : null;
        return new SiteResponse(
            site.Id,
            site.WorkspaceId.Value,
            site.RootItemId.Value,
            site.Slug,
            site.Layout,
            ReadSettings(site),
            site.RepublishMode,
            site.DebounceSeconds,
            site.Status,
            await permissions.CanManageWorkspaceAsync(site.WorkspaceId, cancellationToken).ConfigureAwait(false),
            [.. hostnames.Select(hostname => ToHostname(site, hostname))],
            [.. excluded.Select(itemId => itemId.Value)],
            [.. dated.Select(setting => new SiteDatedCollectionDto(
                setting.ItemId.Value, setting.DateProperty, setting.TagsProperty, setting.CoverProperty, setting.SummaryProperty))],
            live is null ? null : ToBuild(live),
            latest is null ? null : ToBuild(latest),
            site.CreatedAt,
            site.UpdatedAt,
            site.PrimaryHostname,
            options.RequireOperatorApproval && site.Status != SiteRules.PublishedStatus && site.ApprovalState != "approved",
            site.ApprovalState is { } state && site.ApprovalRequestedAt is { } requestedAt
                ? new SiteApprovalDto(state, requestedAt, site.ApprovalDecidedAt, site.ApprovalNote)
                : null);
    }

    /// <summary>Maps one hostname with its status and the records a manager creates for it.</summary>
    public SiteHostnameResponse ToHostname(Site site, SiteHostname hostname)
    {
        ArgumentNullException.ThrowIfNull(site);
        ArgumentNullException.ThrowIfNull(hostname);
        var custom = hostname.Kind == SiteRules.CustomHost;
        var managed = custom && options.Cloudflare.ZoneFor(hostname.Hostname, site.WorkspaceId.Value) is not null;
        var status = !custom || (hostname.VerifiedAt is not null && hostname.CheckFailures == 0) ? "verified"
            : hostname.VerifiedAt is not null ? "failing"
            : hostname.CheckedAt is null ? "checking"
            : "pending";
        var records = new List<SiteDnsRecordDto>(2);
        if (custom && hostname.VerificationToken is { } token)
        {
            records.Add(new("TXT", SiteHostnameRules.VerificationName(hostname.Hostname), SiteHostnameRules.VerificationValue(token), "verification"));
            if (SiteHostnameProvisioner.RoutingTargetFor(options, managed) is { } target)
            {
                records.Add(new("CNAME", hostname.Hostname, target, "routing"));
            }
        }

        return new SiteHostnameResponse(
            hostname.Hostname,
            options.PublicUrl(hostname.Hostname),
            hostname.Kind,
            SiteHostnameRules.IsServed(hostname),
            custom ? site.PrimaryHostname == hostname.Hostname : site.PrimaryHostname is null,
            hostname.ServeMode,
            status,
            hostname.CheckedAt,
            hostname.CheckError,
            managed,
            records);
    }

    /// <summary>Maps a build, deriving its status from its worker job while it is unfinished.</summary>
    public static SiteBuildResponse ToBuild(SiteBuildView view)
    {
        ArgumentNullException.ThrowIfNull(view);
        var build = view.Build;
        var jobEnded = view.JobStatus is "failed" or "cancelled";
        var status = build.Status switch
        {
            SiteRules.QueuedBuild when jobEnded => SiteRules.FailedBuild,
            SiteRules.QueuedBuild when view.JobStatus == "running" => "building",
            SiteRules.SealedBuild when jobEnded => SiteRules.FailedBuild,
            var other => other,
        };
        return new SiteBuildResponse(
            build.Id,
            build.SiteId,
            status,
            build.Origin,
            build.PageCount,
            build.FileCount,
            build.TotalBytes,
            JsonSerializer.Deserialize(build.Loss, SitesJsonContext.Default.StringArray) ?? [],
            status == SiteRules.FailedBuild ? view.JobErrorCode ?? "build_failed" : null,
            build.CreatedAt,
            build.ActivatedAt);
    }

    /// <summary>Refuses a custom layout without a theme page, or whose theme page lies outside the site root.</summary>
    public async ValueTask<NixError?> CheckThemeAsync(string layout, Guid? themeItemId, Guid rootItemId, CancellationToken cancellationToken)
    {
        if (SiteRules.ThemeRefusal(layout, themeItemId) is { } refusal)
        {
            return SiteErrors.Invalid(refusal);
        }

        // The theme page is never published, so the root (the home page) cannot be it.
        return layout == SiteRules.CustomLayout
            && (themeItemId == rootItemId
                || !await sites.AreInSubtreeAsync(ItemId.From(rootItemId), [ItemId.From(themeItemId!.Value)], cancellationToken).ConfigureAwait(false))
            ? new NixError(SiteErrors.ItemOutsideSiteCode, "The theme page must be a page under the site's root, not the root itself.")
            : null;
    }

    /// <summary>Reads the stored settings document.</summary>
    public static SiteSettingsDto ReadSettings(Site site)
    {
        ArgumentNullException.ThrowIfNull(site);
        return JsonSerializer.Deserialize(site.Settings, SitesJsonContext.Default.SiteSettingsDto)
            ?? throw new InvalidOperationException("The stored site settings could not be read.");
    }

    /// <summary>Validates a settings document and returns its stored form, or the refusal.</summary>
    public static Result<SiteSettingsDto> CheckSettings(SiteSettingsDto? dto)
    {
        if (dto is null)
        {
            return Result.Failure<SiteSettingsDto>(SiteErrors.Invalid("Settings are required."));
        }

        var settings = new SiteSettings(
            dto.Name?.Trim() ?? string.Empty,
            dto.Description ?? string.Empty,
            dto.Accent,
            [.. (dto.Navigation ?? []).Select(link => new SiteNavLink(link?.Label ?? string.Empty, link?.Path ?? string.Empty))],
            dto.FooterText ?? string.Empty,
            dto.BuiltWithNix,
            dto.Language,
            dto.Noindex,
            string.IsNullOrWhiteSpace(dto.Author) ? null : dto.Author.Trim(),
            dto.HeadingMark ?? "square",
            dto.Typeface ?? "rounded",
            dto.Spacing ?? "comfortable",
            dto.ThemeItemId);
        return settings.Validate() is { } refusal
            ? Result.Failure<SiteSettingsDto>(SiteErrors.Invalid(refusal))
            : Result.Success(new SiteSettingsDto(
                settings.Name,
                settings.Description,
                settings.Accent,
                [.. settings.Navigation.Select(link => new SiteNavLinkDto(link.Label, link.Path))],
                settings.FooterText,
                settings.BuiltWithNix,
                settings.Language,
                settings.Noindex,
                settings.Author,
                settings.HeadingMark,
                settings.Typeface,
                settings.Spacing,
                settings.ThemeItemId));
    }
}
