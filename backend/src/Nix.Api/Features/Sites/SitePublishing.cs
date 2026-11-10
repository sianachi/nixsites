using System.Globalization;
using System.Text.Json;
using System.Text.Json.Nodes;
using Nix.Abstractions;
using Nix.Abstractions.Workers;
using Nix.Domain.Items;
using Nix.Domain.Primitives;
using Nix.Domain.Sites;
using Nix.Domain.Views;
using Nix.Features.Charts;
using Nix.Features.Properties;
using Nix.Features.Views;
using Nix.Messaging;
using Nix.Persistence.ObjectStorage;
using Nix.Serialization;

namespace Nix.Features.Sites;

/// <summary>
/// Queues a build: enumerates what the publisher may publish, fixes it as an immutable manifest
/// and hands the worker a job. Everything a visitor can ever see was decided here.
/// </summary>
/// <remarks>
/// <para>
/// The whole request runs in the caller's unit of work, so the manifest, the path assignments,
/// the redirects, the audit event and the job commit together or not at all.
/// </para>
/// <para>
/// <b>Charts are published only when nothing under their container is hidden.</b> An aggregate
/// counts every active child, so a chart over a container with an excluded, locked or future-dated
/// child would disclose that the child exists. Such a container gets no chart; the renderer shows
/// a notice. Property images are resolved here against the eligibility rules; body images are
/// resolved later, one at a time, by the worker's file route.
/// </para>
/// </remarks>
public sealed class PublishSiteHandler(
    ISiteStore sites,
    SiteAccess access,
    IItemTree tree,
    IItemLocks locks,
    IWorkspaceLocks workspaceLocks,
    IWorkerJobStore jobs,
    INixSessionContextAccessor session,
    NixDispatcher dispatcher,
    SiteOptions options,
    SiteCapabilitySigner signer,
    ISiteHostnameStore hostnames,
    SiteHostnameProvisioner provisioner,
    SiteAudit audit,
    TimeProvider clock) : ICommandHandler<PublishSite, SiteBuildResponse>
{
    private const string FileReferencePrefix = "nix-file:";
    private const int MaximumPropertyFilesPerPage = 20;

    public async ValueTask<Result<SiteBuildResponse>> HandleAsync(PublishSite command, CancellationToken cancellationToken)
    {
        ArgumentNullException.ThrowIfNull(command);
        var key = command.IdempotencyKey?.Trim() ?? string.Empty;
        if (key.Length is 0 or > 160 || command.Origin is not ("manual" or "auto"))
        {
            return Result.Failure<SiteBuildResponse>(SiteErrors.Invalid("A publish needs an idempotency key of at most 160 characters."));
        }

        if (options.AutomatesDefaultHostnames)
        {
            // The tunnel before the site lock, the order every hostname path keeps.
            await provisioner.LockTunnelAsync(cancellationToken).ConfigureAwait(false);
        }

        var guarded = await access.ManageAsync(command.SiteId, cancellationToken).ConfigureAwait(false);
        if (guarded.IsFailure)
        {
            return Result.Failure<SiteBuildResponse>(guarded.Error);
        }

        var site = guarded.Value;
        if (!options.IsEnabled || !signer.IsConfigured)
        {
            return Result.Failure<SiteBuildResponse>(SiteErrors.NotConfigured());
        }

        // The build worker reads page bodies through an execution token, which never holds a
        // workspace unlock, so every body read would be refused partway through the build. Say so
        // now. A site already published keeps serving its last build; only new builds are refused.
        // The token is not widened to make this work.
        if (command.Origin == "manual"
            && (await workspaceLocks.GetStateAsync(site.WorkspaceId, cancellationToken).ConfigureAwait(false)).PasswordProtected)
        {
            return Result.Failure<SiteBuildResponse>(new(
                "sites.workspace_protected",
                "A site cannot be published from a password-protected workspace. Remove the workspace password to publish."));
        }

        if (await sites.FindBuildByKeyAsync(site.Id, key, cancellationToken).ConfigureAwait(false) is { } repeated)
        {
            return Result.Success(SiteViews.ToBuild(repeated));
        }

        // A first publish (and the first after an unpublish) on a deployment that asks for it waits
        // for an operator; the approval then publishes as the manager who asked.
        if (options.RequireOperatorApproval && site.Status != SiteRules.PublishedStatus && site.ApprovalState != "approved")
        {
            return Result.Failure<SiteBuildResponse>(site.ApprovalState == "pending"
                ? new(SiteErrors.ApprovalPendingCode, "This site's first publish is waiting for the operator's approval; it starts on its own once approved.")
                : new(SiteErrors.ApprovalRequiredCode, "This deployment's operator approves each site's first publish. Ask for approval first."));
        }

        // Republishing what was taken down discloses it again, so it is acknowledged again.
        if ((site.Status is SiteRules.DraftStatus or SiteRules.UnpublishedStatus) && !command.AcknowledgeDisclosure)
        {
            return Result.Failure<SiteBuildResponse>(new(
                SiteErrors.DisclosureRequiredCode,
                "Publishing makes this content public. Search engines and web archives may keep a copy after you unpublish it; acknowledge this to continue."));
        }

        var root = await tree.FindAsync(site.RootItemId, cancellationToken).ConfigureAwait(false);
        if (root is null)
        {
            return Result.Failure<SiteBuildResponse>(new(SiteErrors.RootUnavailableCode, "The site's root item is trashed or no longer visible."));
        }

        if ((await locks.GetStateAsync(root.Id, cancellationToken).ConfigureAwait(false)).Locked)
        {
            return Result.Failure<SiteBuildResponse>(new(
                SiteErrors.RootLockedCode,
                "The root or one of its ancestors is locked. Remove the lock before publishing."));
        }

        if (await sites.HasBuildInFlightAsync(site.Id, cancellationToken).ConfigureAwait(false)
            || await sites.HasActivationInFlightAsync(site.Id, cancellationToken).ConfigureAwait(false))
        {
            return Result.Failure<SiteBuildResponse>(new(SiteErrors.BuildInProgressCode, "A build or a change of what is live is already under way."));
        }

        var context = session.Current
            ?? throw new InvalidOperationException("No session context; the pipeline must establish one.");
        var now = clock.GetUtcNow();
        var eligible = await sites.EligiblePagesAsync(site, now, cancellationToken).ConfigureAwait(false);
        if (eligible.Count == 0 || eligible[0].Id != site.RootItemId)
        {
            return Result.Failure<SiteBuildResponse>(new(SiteErrors.RootUnavailableCode, "The site's root item cannot be published."));
        }

        if (eligible.Count > SiteRules.MaximumPages)
        {
            return Result.Failure<SiteBuildResponse>(new(
                SiteErrors.TooManyPagesCode,
                $"A site may have at most {SiteRules.MaximumPages} pages; this subtree has {eligible.Count}. Exclude some of it."));
        }

        var withheld = await sites.WithheldDatedPostsAsync(site, now, cancellationToken).ConfigureAwait(false);

        var dated = (await sites.ListDatedCollectionsAsync(site.Id, cancellationToken).ConfigureAwait(false))
            .ToDictionary(setting => setting.ItemId);
        var paths = await AssignPathsAsync(site, eligible, command.RefreshPaths, now, cancellationToken).ConfigureAwait(false);

        var eligibleIds = eligible.Select(page => page.Id).ToArray();
        var charts = await ChartContainersAsync(eligible, eligibleIds, cancellationToken).ConfigureAwait(false);

        var buildId = Guid.CreateVersion7();
        var pages = new List<SiteBuildPage>(eligible.Count);
        var files = new List<SiteBuildFile>();
        foreach (var (page, ordinal) in eligible.Select((page, ordinal) => (page, ordinal)))
        {
            pages.Add(await BuildPageAsync(
                site, buildId, page, ordinal, paths, dated, charts, files, now, cancellationToken).ConfigureAwait(false));
        }

        var redirects = paths.Redirects
            .Where(redirect => paths.Assigned.TryGetValue(redirect.ItemId, out var current) && current != redirect.FromPath)
            .Select(redirect => new SiteManifestRedirect(redirect.FromPath, redirect.ItemId.Value))
            .OrderBy(redirect => redirect.From, StringComparer.Ordinal)
            .ToArray();
        var canonicalHost = SiteHostnameRules.Canonical(
            site.PrimaryHostname, await sites.ListHostnamesAsync([site.Id], cancellationToken).ConfigureAwait(false));
        var canonical = options.PublicUrl(canonicalHost.Hostname).GetLeftPart(UriPartial.Authority);
        var manifest = new SiteBuildManifest(
            1,
            site.Id,
            buildId,
            site.WorkspaceId.Value,
            site.RootItemId.Value,
            site.Layout,
            SiteViews.ReadSettings(site),
            canonical,
            now,
            pages.Count,
            [.. dated.Values.Select(setting => new SiteDatedCollectionDto(
                setting.ItemId.Value, setting.DateProperty, setting.TagsProperty, setting.CoverProperty, setting.SummaryProperty))],
            redirects);

        WorkerJobRecord job;
        try
        {
            job = await jobs.CreateAsync(
                context.TenantId,
                context.PrincipalId,
                site.WorkspaceId,
                SiteJobKinds.Build,
                BuildJobKey(site.Id, key),
                JsonSerializer.Serialize(new SiteBuildJobPayload(site.Id, buildId), SitesJsonContext.Default.SiteBuildJobPayload),
                cancellationToken).ConfigureAwait(false);
        }
        catch (WorkerJobIdempotencyConflictException)
        {
            return Result.Failure<SiteBuildResponse>(new(SiteErrors.BuildInProgressCode, "This build was already requested."));
        }

        var build = new SiteBuild
        {
            TenantId = context.TenantId,
            Id = buildId,
            SiteId = site.Id,
            Status = SiteRules.QueuedBuild,
            JobId = job.Id,
            PublisherId = context.PrincipalId,
            Origin = command.Origin,
            IdempotencyKey = key,
            Header = JsonSerializer.Serialize(manifest, SitesJsonContext.Default.SiteBuildManifest),
            PageCount = pages.Count,
            Loss = JsonSerializer.Serialize(WithheldDatedLosses(withheld), SitesJsonContext.Default.StringArray),
            CreatedAt = now,
        };
        sites.AddBuild(build);
        sites.AddBuildPage(pages[0]);
        foreach (var page in pages.Skip(1))
        {
            sites.AddBuildPage(page);
        }

        // The build row and its pages are written first: the trigger on the file table refuses a
        // row whose build is not yet queued.
        await sites.SaveAsync(cancellationToken).ConfigureAwait(false);
        foreach (var file in files)
        {
            sites.AddBuildFile(file);
        }

        // Each publish re-ensures the default hostname's record (idempotent), repairing a failed or
        // removed one; a failure is shown on the hostname and never blocks the build.
        if (options.AutomatesDefaultHostnames
            && (await hostnames.LoadForUpdateAsync(site.Id, cancellationToken).ConfigureAwait(false))
                .FirstOrDefault(row => row.Kind == SiteRules.DefaultHost) is { } defaultHost)
        {
            var dns = await provisioner.EnsureDefaultAsync(site, defaultHost, cancellationToken).ConfigureAwait(false);
            if (dns.Changed || dns.Error is not null)
            {
                audit.Record(site, "site.hostname_dns_written", null, new { hostname = defaultHost.Hostname, error = dns.Error });
            }
        }

        audit.Record(
            site,
            "site.published",
            null,
            new { buildId, pageCount = pages.Count, mode = site.RepublishMode, origin = command.Origin });
        await sites.SaveAsync(cancellationToken).ConfigureAwait(false);
        return Result.Success(SiteViews.ToBuild(new SiteBuildView(build, job.Status, null)));
    }

    private static string[] WithheldDatedLosses(IReadOnlyList<WithheldDatedPost> posts)
    {
        var losses = posts.Take(SiteRules.MaximumLossEntries).Select(post => post.PublishedAt is { } published
            ? $"scheduled: {LossTitle(post.Title)} is scheduled for {published.ToString("yyyy-MM-dd", CultureInfo.InvariantCulture)}."
            : string.IsNullOrWhiteSpace(post.DateValue)
                ? $"draft: {LossTitle(post.Title)} has no date."
                : $"draft: {LossTitle(post.Title)} has an invalid date.").ToList();
        if (posts.Count > losses.Count)
        {
            losses[^1] = "omitted: Additional dated posts were withheld.";
        }

        return [.. losses];
    }

    private static string LossTitle(string? rawTitle)
    {
        var title = (rawTitle ?? string.Empty).Trim();
        if (title.Length == 0 || title.Any(char.IsControl))
        {
            return "Untitled";
        }

        return title.Length <= 200 ? title : title[..200];
    }

    private async ValueTask<PathPlan> AssignPathsAsync(
        Site site,
        IReadOnlyList<EligiblePage> eligible,
        bool refresh,
        DateTimeOffset now,
        CancellationToken cancellationToken)
    {
        var (rows, redirects) = await sites.LoadPathsAsync(site.Id, cancellationToken).ConfigureAwait(false);
        var existing = rows.ToDictionary(row => row.ItemId);
        var taken = new HashSet<string>(rows.Select(row => row.Path), StringComparer.Ordinal);
        taken.UnionWith(redirects.Select(redirect => redirect.FromPath));
        var assigned = new Dictionary<ItemId, string>();
        var added = new List<SiteRedirect>();
        foreach (var page in eligible)
        {
            existing.TryGetValue(page.Id, out var row);
            if (page.Id == site.RootItemId)
            {
                assigned[page.Id] = "/";
                if (row is null)
                {
                    taken.Add("/");
                    sites.AddPage(NewPage(site, page.Id, "/", now));
                }

                continue;
            }

            var parentPath = page.ParentId is { } parentId && assigned.TryGetValue(parentId, out var found) ? found : "/";
            var title = ItemProperties.ReadTitle(page.Properties);
            if (row is null)
            {
                var path = SiteRules.DerivePath(parentPath, title, taken.Contains);
                taken.Add(path);
                sites.AddPage(NewPage(site, page.Id, path, now));
                assigned[page.Id] = path;
            }
            else if (refresh && !row.Pinned)
            {
                var current = row.Path;
                var path = SiteRules.DerivePath(parentPath, title, candidate => candidate != current && taken.Contains(candidate));
                if (path != current)
                {
                    taken.Add(path);
                    if (!redirects.Concat(added).Any(redirect => redirect.FromPath == current))
                    {
                        var redirect = new SiteRedirect { TenantId = site.TenantId, SiteId = site.Id, FromPath = current, ItemId = page.Id, CreatedAt = now };
                        sites.AddRedirect(redirect);
                        added.Add(redirect);
                    }

                    row.Path = path;
                    row.UpdatedAt = now;
                }

                assigned[page.Id] = row.Path;
            }
            else
            {
                assigned[page.Id] = row.Path;
            }
        }

        return new PathPlan(assigned, [.. redirects, .. added]);
    }

    private static SitePage NewPage(Site site, ItemId itemId, string path, DateTimeOffset now) => new()
    {
        TenantId = site.TenantId,
        SiteId = site.Id,
        ItemId = itemId,
        Path = path,
        CreatedAt = now,
        UpdatedAt = now,
    };

    /// <summary>The chart views to draw: containers with a chart view and no hidden active child.</summary>
    private async ValueTask<Dictionary<ItemId, string>> ChartContainersAsync(
        IReadOnlyList<EligiblePage> eligible,
        ItemId[] eligibleIds,
        CancellationToken cancellationToken)
    {
        var wanted = new Dictionary<ItemId, string>();
        foreach (var page in eligible)
        {
            var chart = ViewDefinitionsJson.Read(page.Views).Views.FirstOrDefault(view => view.Kind == ViewKind.Chart);
            if (chart is not null)
            {
                wanted[page.Id] = chart.Id;
            }
        }

        if (wanted.Count == 0)
        {
            return wanted;
        }

        var hidden = await sites.ContainersWithHiddenChildrenAsync([.. wanted.Keys], eligibleIds, cancellationToken).ConfigureAwait(false);
        foreach (var container in hidden)
        {
            wanted.Remove(container);
        }

        return wanted;
    }

    private async ValueTask<SiteBuildPage> BuildPageAsync(
        Site site,
        Guid buildId,
        EligiblePage page,
        int ordinal,
        PathPlan paths,
        Dictionary<ItemId, SiteDatedCollectionSetting> dated,
        Dictionary<ItemId, string> charts,
        List<SiteBuildFile> files,
        DateTimeOffset now,
        CancellationToken cancellationToken)
    {
        var properties = page.Properties is { Length: > 0 } text && text[0] == '{' ? text : "{}";
        var title = ItemProperties.ReadTitle(properties);
        string? schema = null;
        string? views = null;
        if (page.Views is not null)
        {
            var effective = await dispatcher
                .QueryAsync<GetEffectiveSchema, Result<EffectiveSchema>>(new GetEffectiveSchema(page.Id), cancellationToken)
                .ConfigureAwait(false);
            if (effective.IsSuccess)
            {
                schema = JsonSerializer.Serialize(
                    PropertyMapping.ToResponse(effective.Value.Effective, effective.Value.Declared),
                    StructureJsonContext.Default.EffectiveSchemaResponse);
            }

            var set = await dispatcher
                .QueryAsync<GetContainerViews, Result<ContainerViewSet>>(new GetContainerViews(page.Id), cancellationToken)
                .ConfigureAwait(false);
            if (set.IsSuccess)
            {
                views = JsonSerializer.Serialize(
                    new ContainerViewsResponse(
                        [.. set.Value.Views.Select(ViewMapping.ToResponse)],
                        set.Value.Unrenderable,
                        set.Value.Default,
                        set.Value.HideDocument,
                        set.Value.Version),
                    StructureJsonContext.Default.ContainerViewsResponse);
            }
        }

        string? chart = null;
        if (charts.TryGetValue(page.Id, out var viewId))
        {
            var drawn = await dispatcher
                .QueryAsync<RunItemChart, Result<ItemChart>>(new RunItemChart(page.Id, viewId), cancellationToken)
                .ConfigureAwait(false);
            if (drawn.IsSuccess)
            {
                chart = JsonSerializer.Serialize(
                    ChartMapping.ToResponse(page.Id.Value, viewId, drawn.Value),
                    ChartJsonContext.Default.ChartResponse);
            }
        }

        var propertyFiles = new List<SitePropertyFile>();
        foreach (var fileItemId in FileReferences(properties).Take(MaximumPropertyFilesPerPage))
        {
            var candidate = await sites.FindFileAsync(site, fileItemId, now, cancellationToken).ConfigureAwait(false);
            if (candidate is null)
            {
                continue;
            }

            propertyFiles.Add(new SitePropertyFile(
                candidate.FileItemId.Value, candidate.FileVersionId, candidate.Sha256, candidate.MediaType, candidate.ByteLength));
            files.Add(new SiteBuildFile
            {
                TenantId = site.TenantId,
                BuildId = buildId,
                SourceItemId = page.Id,
                FileItemId = candidate.FileItemId,
                FileVersionId = candidate.FileVersionId,
                Sha256 = candidate.Sha256,
                MediaType = candidate.MediaType,
                ByteLength = candidate.ByteLength,
                CreatedAt = now,
            });
        }

        ItemId? collection = null;
        DateTimeOffset? publishedAt = null;
        if (page.ParentId is { } parentId && dated.TryGetValue(parentId, out var setting))
        {
            collection = parentId;
            publishedAt = ReadDate(properties, setting.DateProperty);
        }

        return new SiteBuildPage
        {
            TenantId = site.TenantId,
            BuildId = buildId,
            Ordinal = ordinal,
            ItemId = page.Id,
            ParentItemId = page.Id == site.RootItemId ? null : page.ParentId,
            Path = paths.Assigned[page.Id],
            Title = title.Length > 500 ? title[..500] : title,
            Type = page.Type,
            Seq = page.Seq,
            ItemCreatedAt = page.CreatedAt,
            ItemUpdatedAt = page.LastModifiedAt,
            Properties = properties,
            Schema = schema,
            Views = views,
            Chart = chart,
            DocId = page.DocId,
            ContentSeq = page.HeadSeq,
            DatedCollectionId = collection,
            PublishedAt = publishedAt,
            PropertyFiles = JsonSerializer.Serialize(propertyFiles.ToArray(), SitesJsonContext.Default.SitePropertyFileArray),
        };
    }

    /// <summary>
    /// The worker job's idempotency key: the site and the caller's key, hashed to fit. Two requests
    /// with the same key then meet at the job store, never at the build's unique index.
    /// </summary>
    internal static string BuildJobKey(Guid siteId, string idempotencyKey) =>
        "site.build:" + siteId.ToString("N") + ":"
        + Convert.ToHexStringLower(System.Security.Cryptography.SHA256.HashData(System.Text.Encoding.UTF8.GetBytes(idempotencyKey)));

    /// <summary>File items a property bag references as <c>nix-file:&lt;id&gt;</c>, in order, without repeats.</summary>
    public static IEnumerable<ItemId> FileReferences(string properties)
    {
        JsonNode? root;
        try
        {
            root = JsonNode.Parse(properties);
        }
        catch (JsonException)
        {
            yield break;
        }

        var seen = new HashSet<Guid>();
        if (root is not JsonObject bag)
        {
            yield break;
        }

        foreach (var (_, value) in bag)
        {
            foreach (var text in Strings(value))
            {
                if (text.StartsWith(FileReferencePrefix, StringComparison.Ordinal)
                    && Guid.TryParse(text.AsSpan(FileReferencePrefix.Length), out var id)
                    && id != Guid.Empty
                    && seen.Add(id))
                {
                    yield return ItemId.From(id);
                }
            }
        }
    }

    private static IEnumerable<string> Strings(JsonNode? node)
    {
        if (node is JsonValue value && value.TryGetValue<string>(out var text))
        {
            yield return text;
        }
        else if (node is JsonArray array)
        {
            foreach (var entry in array.Take(50))
            {
                if (entry is JsonValue inner && inner.TryGetValue<string>(out var entryText))
                {
                    yield return entryText;
                }
            }
        }
    }

    private static DateTimeOffset? ReadDate(string properties, string property)
    {
        try
        {
            return JsonNode.Parse(properties) is JsonObject bag
                && bag.TryGetPropertyValue(property, out var node)
                && node is JsonValue value
                && value.TryGetValue<string>(out var text)
                && DateTimeOffset.TryParse(
                    text.Split('[', 2)[0],
                    CultureInfo.InvariantCulture,
                    DateTimeStyles.AssumeUniversal | DateTimeStyles.AdjustToUniversal,
                    out var date)
                    ? date
                    : null;
        }
        catch (JsonException)
        {
            return null;
        }
    }

    private sealed record PathPlan(Dictionary<ItemId, string> Assigned, IReadOnlyList<SiteRedirect> Redirects);
}
