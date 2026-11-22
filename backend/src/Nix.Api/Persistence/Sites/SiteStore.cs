using Microsoft.EntityFrameworkCore;
using Nix.Abstractions;
using Nix.Domain.Audit;
using Nix.Domain.Items;
using Nix.Domain.Sites;
using Nix.Domain.Tenancy;
using Nix.Domain.Workers;
using Nix.Persistence.Sql;
using Nix.Persistence.Sql.Statements;
using Npgsql;
using NpgsqlTypes;
using static Nix.Persistence.Sql.NixParameter;

namespace Nix.Persistence.Sites;

/// <summary>
/// EF- and SQL-backed storage for sites, running inside the current unit of work.
/// </summary>
/// <remarks>
/// The tenant always comes from the session the unit of work was opened with. Nothing here decides
/// who may do what: the handlers ask the permission resolver first, and this store answers the
/// narrower question of what the rows say.
/// </remarks>
public sealed class SiteStore(NixDbContext database, NixSqlExecutor sql, INixSessionContextAccessor session) : ISiteStore
{
    private const string Savepoint = "site_store_guard";

    private TenantId Tenant => (session.Current
        ?? throw new InvalidOperationException("No session context has been established for this unit of work.")).TenantId;

    /// <inheritdoc />
    public async ValueTask LockSiteAsync(Guid siteId, CancellationToken cancellationToken) =>
        _ = await sql.ScalarOrDefaultAsync<int>(
            "SELECT 1 FROM site WHERE tenant_id = @tenant_id AND id = @site_id FOR UPDATE",
            [TenantParameter(), Uuid("site_id", siteId)],
            cancellationToken).ConfigureAwait(false);

    /// <inheritdoc />
    public ValueTask LockTenantCreatesAsync(CancellationToken cancellationToken) =>
        new AdvisoryLocks(database).LockSiteCreationAsync(Tenant.Value, cancellationToken);

    /// <inheritdoc />
    public async ValueTask<int> CountAsync(CancellationToken cancellationToken) =>
        await database.Sites.AsNoTracking().CountAsync(cancellationToken).ConfigureAwait(false);

    /// <inheritdoc />
    public async ValueTask<bool> HasLiveOrStoredSiteAsync(WorkspaceId workspaceId, ItemId? rootItemId, CancellationToken cancellationToken)
    {
        var scoped = database.Sites.AsNoTracking()
            .Where(site => site.WorkspaceId == workspaceId && (rootItemId == null || site.RootItemId == rootItemId));
        return await scoped.AnyAsync(
                site => site.Status == SiteRules.PublishedStatus
                    || database.SiteBuilds.Any(build => build.SiteId == site.Id
                        && database.SiteBuildObjects.Any(buildObject => buildObject.BuildId == build.Id)),
                cancellationToken)
            .ConfigureAwait(false);
    }

    /// <inheritdoc />
    public async ValueTask<bool> IsAnyAssetPurgingAsync(IReadOnlyCollection<string> keys, CancellationToken cancellationToken)
    {
        ArgumentNullException.ThrowIfNull(keys);
        return keys.Count > 0 && await (
            from buildObject in database.SiteBuildObjects.AsNoTracking()
            join build in database.SiteBuilds.AsNoTracking()
                on new { buildObject.TenantId, buildObject.BuildId } equals new { build.TenantId, BuildId = build.Id }
            where buildObject.Kind == SiteRules.AssetObject
                && keys.Contains(buildObject.Key)
                && build.PurgeId != null
                && build.Status != SiteRules.PurgedBuild
            select buildObject.Key).AnyAsync(cancellationToken).ConfigureAwait(false);
    }

    /// <inheritdoc />
    public async ValueTask<bool> TrySaveActivationAsync(CancellationToken cancellationToken)
    {
        var violation = await TrySaveAsync(PostgresErrorCodes.UniqueViolation, cancellationToken).ConfigureAwait(false);
        return violation?.ConstraintName switch
        {
            null => true,
            "ux_site_activation_generation" => false,
            _ => throw new InvalidOperationException($"Unexpected unique violation {violation.ConstraintName}."),
        };
    }

    /// <inheritdoc />
    public async ValueTask<Site?> FindAsync(Guid siteId, CancellationToken cancellationToken) =>
        await database.Sites.AsNoTracking()
            .SingleOrDefaultAsync(site => site.Id == siteId, cancellationToken).ConfigureAwait(false);

    /// <inheritdoc />
    public async ValueTask<Site?> FindForUpdateAsync(Guid siteId, CancellationToken cancellationToken) =>
        await database.Sites.AsTracking()
            .SingleOrDefaultAsync(site => site.Id == siteId, cancellationToken).ConfigureAwait(false);

    /// <inheritdoc />
    public async ValueTask<Site?> FindByRootAsync(ItemId rootItemId, CancellationToken cancellationToken) =>
        await database.Sites.AsNoTracking()
            .SingleOrDefaultAsync(site => site.RootItemId == rootItemId, cancellationToken).ConfigureAwait(false);

    /// <inheritdoc />
    public async ValueTask<IReadOnlyList<Site>> ListAsync(WorkspaceId workspaceId, CancellationToken cancellationToken) =>
        await database.Sites.AsNoTracking()
            .Where(site => site.WorkspaceId == workspaceId)
            .OrderBy(site => site.CreatedAt).ThenBy(site => site.Id)
            .ToListAsync(cancellationToken).ConfigureAwait(false);

    /// <inheritdoc />
    public async ValueTask<SiteWriteOutcome> AddAsync(Site site, SiteHostname defaultHostname, CancellationToken cancellationToken)
    {
        ArgumentNullException.ThrowIfNull(site);
        ArgumentNullException.ThrowIfNull(defaultHostname);
        database.Sites.Add(site);
        database.SiteHostnames.Add(defaultHostname);
        return await SaveGuardedAsync(cancellationToken).ConfigureAwait(false);
    }

    /// <inheritdoc />
    public async ValueTask RemoveAsync(Site site, CancellationToken cancellationToken)
    {
        ArgumentNullException.ThrowIfNull(site);
        await database.Sites.Where(candidate => candidate.Id == site.Id)
            .ExecuteDeleteAsync(cancellationToken).ConfigureAwait(false);
    }

    /// <inheritdoc />
    public async ValueTask<bool> HasUnpurgedObjectsAsync(Guid siteId, CancellationToken cancellationToken) =>
        await (from buildObject in database.SiteBuildObjects.AsNoTracking()
               join build in database.SiteBuilds.AsNoTracking()
                   on new { buildObject.TenantId, buildObject.BuildId } equals new { build.TenantId, BuildId = build.Id }
               where build.SiteId == siteId
               select buildObject.Key).AnyAsync(cancellationToken).ConfigureAwait(false);

    /// <inheritdoc />
    public async ValueTask<IReadOnlyList<SiteHostname>> ListHostnamesAsync(
        IReadOnlyCollection<Guid> siteIds, CancellationToken cancellationToken)
    {
        ArgumentNullException.ThrowIfNull(siteIds);
        return await database.SiteHostnames.AsNoTracking()
            .Where(hostname => siteIds.Contains(hostname.SiteId))
            .OrderBy(hostname => hostname.Kind).ThenBy(hostname => hostname.Hostname)
            .ToListAsync(cancellationToken).ConfigureAwait(false);
    }

    /// <inheritdoc />
    public async ValueTask<SiteWriteOutcome> ReplaceCustomHostnamesAsync(
        Guid siteId, IReadOnlyCollection<string> hostnames, DateTimeOffset now, CancellationToken cancellationToken)
    {
        ArgumentNullException.ThrowIfNull(hostnames);
        var existing = await database.SiteHostnames.AsNoTracking()
            .Where(hostname => hostname.SiteId == siteId && hostname.Kind == SiteRules.CustomHost)
            .Select(hostname => hostname.Hostname)
            .ToListAsync(cancellationToken).ConfigureAwait(false);
        var removed = existing.Where(hostname => !hostnames.Contains(hostname)).ToArray();
        if (removed.Length > 0)
        {
            await database.SiteHostnames
                .Where(hostname => hostname.SiteId == siteId && removed.Contains(hostname.Hostname))
                .ExecuteDeleteAsync(cancellationToken).ConfigureAwait(false);
        }

        foreach (var added in hostnames.Where(hostname => !existing.Contains(hostname)))
        {
            database.SiteHostnames.Add(new SiteHostname
            {
                TenantId = Tenant,
                Hostname = added,
                SiteId = siteId,
                Kind = SiteRules.CustomHost,
                CreatedAt = now,
                VerificationToken = SiteHostnameRules.NewToken(),
            });
        }

        return await SaveGuardedAsync(cancellationToken).ConfigureAwait(false);
    }

    /// <inheritdoc />
    public async ValueTask<IReadOnlyList<ItemId>> ListExclusionsAsync(Guid siteId, CancellationToken cancellationToken) =>
        await database.SiteExclusions.AsNoTracking()
            .Where(exclusion => exclusion.SiteId == siteId)
            .OrderBy(exclusion => exclusion.ItemId)
            .Select(exclusion => exclusion.ItemId)
            .ToListAsync(cancellationToken).ConfigureAwait(false);

    /// <inheritdoc />
    public async ValueTask ReplaceExclusionsAsync(Site site, IReadOnlyCollection<ItemId> itemIds, CancellationToken cancellationToken)
    {
        ArgumentNullException.ThrowIfNull(site);
        ArgumentNullException.ThrowIfNull(itemIds);
        await database.SiteExclusions.Where(exclusion => exclusion.SiteId == site.Id)
            .ExecuteDeleteAsync(cancellationToken).ConfigureAwait(false);
        foreach (var itemId in itemIds.Distinct())
        {
            database.SiteExclusions.Add(new SiteExclusion { TenantId = site.TenantId, SiteId = site.Id, ItemId = itemId });
        }
    }

    /// <inheritdoc />
    public async ValueTask<IReadOnlyList<SiteDatedCollectionSetting>> ListDatedCollectionsAsync(Guid siteId, CancellationToken cancellationToken) =>
        await database.SiteDatedCollectionSettings.AsNoTracking()
            .Where(setting => setting.SiteId == siteId)
            .OrderBy(setting => setting.ItemId)
            .ToListAsync(cancellationToken).ConfigureAwait(false);

    /// <inheritdoc />
    public async ValueTask ReplaceDatedCollectionsAsync(
        Site site, IReadOnlyCollection<SiteDatedCollectionSetting> collections, CancellationToken cancellationToken)
    {
        ArgumentNullException.ThrowIfNull(site);
        ArgumentNullException.ThrowIfNull(collections);
        await database.SiteDatedCollectionSettings.Where(setting => setting.SiteId == site.Id)
            .ExecuteDeleteAsync(cancellationToken).ConfigureAwait(false);
        database.SiteDatedCollectionSettings.AddRange(collections);
    }

    /// <inheritdoc />
    public async ValueTask<bool> AreInSubtreeAsync(
        ItemId rootItemId, IReadOnlyCollection<ItemId> itemIds, CancellationToken cancellationToken)
    {
        ArgumentNullException.ThrowIfNull(itemIds);
        var distinct = itemIds.Select(itemId => itemId.Value).Distinct().ToArray();
        if (distinct.Length == 0)
        {
            return true;
        }

        var counted = await sql.ScalarOrDefaultAsync<long>(
            SiteEligibilitySql.CountInSubtree,
            [TenantParameter(), Uuid("root_id", rootItemId.Value), UuidArray("item_ids", distinct)],
            cancellationToken).ConfigureAwait(false);
        return counted == distinct.Length;
    }

    /// <inheritdoc />
    public async ValueTask<IReadOnlyList<SitePageRow>> ListPagesAsync(Guid siteId, CancellationToken cancellationToken)
    {
        var pages = await database.SitePages.AsNoTracking()
            .Where(page => page.SiteId == siteId)
            .OrderBy(page => page.Path)
            .ToListAsync(cancellationToken).ConfigureAwait(false);
        var titles = new Dictionary<Guid, string?>();
        if (pages.Count > 0)
        {
            var rows = sql.QueryAsync<(Guid Id, string? Title), TitleMapper>(
                SiteEligibilitySql.Titles,
                default,
                [TenantParameter(), UuidArray("item_ids", pages.Select(page => page.ItemId.Value).ToArray())],
                cancellationToken);
            await foreach (var row in rows.WithCancellation(cancellationToken).ConfigureAwait(false))
            {
                titles[row.Id] = row.Title;
            }
        }

        return [.. pages.Select(page => new SitePageRow(
            page.ItemId, page.Path, page.Pinned, titles.GetValueOrDefault(page.ItemId.Value)))];
    }

    /// <inheritdoc />
    public async ValueTask<(List<SitePage> Pages, List<SiteRedirect> Redirects)> LoadPathsAsync(
        Guid siteId, CancellationToken cancellationToken)
    {
        var pages = await database.SitePages.AsTracking()
            .Where(page => page.SiteId == siteId)
            .ToListAsync(cancellationToken).ConfigureAwait(false);
        var redirects = await database.SiteRedirects.AsTracking()
            .Where(redirect => redirect.SiteId == siteId)
            .ToListAsync(cancellationToken).ConfigureAwait(false);
        return (pages, redirects);
    }

    /// <inheritdoc />
    public void AddPage(SitePage page) => database.SitePages.Add(page);

    /// <inheritdoc />
    public void AddRedirect(SiteRedirect redirect) => database.SiteRedirects.Add(redirect);

    /// <inheritdoc />
    public void RemoveRedirect(SiteRedirect redirect) => database.SiteRedirects.Remove(redirect);

    /// <inheritdoc />
    public async ValueTask<IReadOnlyList<SiteBuildView>> ListBuildsAsync(Guid siteId, int limit, CancellationToken cancellationToken)
    {
        var builds = await database.SiteBuilds.AsNoTracking()
            .Where(build => build.SiteId == siteId)
            .OrderByDescending(build => build.CreatedAt).ThenByDescending(build => build.Id)
            .Take(limit)
            .ToListAsync(cancellationToken).ConfigureAwait(false);
        return await WithJobsAsync(builds, cancellationToken).ConfigureAwait(false);
    }

    /// <inheritdoc />
    public async ValueTask<SiteBuildView?> FindBuildAsync(Guid siteId, Guid buildId, CancellationToken cancellationToken)
    {
        var build = await database.SiteBuilds.AsNoTracking()
            .SingleOrDefaultAsync(candidate => candidate.SiteId == siteId && candidate.Id == buildId, cancellationToken)
            .ConfigureAwait(false);
        return build is null ? null : (await WithJobsAsync([build], cancellationToken).ConfigureAwait(false))[0];
    }

    /// <inheritdoc />
    public async ValueTask<SiteBuildView?> FindBuildByKeyAsync(Guid siteId, string idempotencyKey, CancellationToken cancellationToken)
    {
        var build = await database.SiteBuilds.AsNoTracking()
            .SingleOrDefaultAsync(candidate => candidate.SiteId == siteId && candidate.IdempotencyKey == idempotencyKey, cancellationToken)
            .ConfigureAwait(false);
        return build is null ? null : (await WithJobsAsync([build], cancellationToken).ConfigureAwait(false))[0];
    }

    /// <inheritdoc />
    public async ValueTask<bool> HasBuildInFlightAsync(Guid siteId, CancellationToken cancellationToken)
    {
        var open = await database.SiteBuilds.AsNoTracking()
            .Where(build => build.SiteId == siteId
                && (build.Status == SiteRules.QueuedBuild || build.Status == SiteRules.SealedBuild))
            .ToListAsync(cancellationToken).ConfigureAwait(false);
        if (open.Count == 0)
        {
            return false;
        }

        // A build whose job already ended (or was pruned) without activating it is abandoned, not
        // in flight; counting it would block every later publish.
        return (await WithJobsAsync(open, cancellationToken).ConfigureAwait(false))
            .Any(view => view.JobStatus is "queued" or "running");
    }

    /// <inheritdoc />
    public async ValueTask<bool> HasActivationInFlightAsync(Guid siteId, CancellationToken cancellationToken)
    {
        var jobIds = (await database.SiteActivations.AsNoTracking()
            .Where(activation => activation.SiteId == siteId
                && activation.AppliedAt == null
                && activation.Reason != SiteRules.PublishActivation)
            .Select(activation => activation.JobId)
            .ToListAsync(cancellationToken).ConfigureAwait(false))
            .Select(WorkerJobId.From)
            .ToList();
        return jobIds.Count > 0
            && await database.WorkerJobs.AsNoTracking()
                .AnyAsync(job => jobIds.Contains(job.Id) && (job.Status == "queued" || job.Status == "running"), cancellationToken)
                .ConfigureAwait(false);
    }

    /// <inheritdoc />
    public async ValueTask<IReadOnlyList<EligiblePage>> EligiblePagesAsync(Site site, DateTimeOffset now, CancellationToken cancellationToken)
    {
        ArgumentNullException.ThrowIfNull(site);
        var pages = new List<EligiblePage>();
        var rows = sql.QueryAsync<EligiblePage, EligiblePageMapper>(
            SiteEligibilitySql.EligiblePages,
            default,
            [
                TenantParameter(),
                Uuid("workspace_id", site.WorkspaceId.Value),
                Uuid("root_id", site.RootItemId.Value),
                Uuid("site_id", site.Id),
                new NpgsqlParameter("now", NpgsqlDbType.TimestampTz) { Value = now },
            ],
            cancellationToken);
        await foreach (var row in rows.WithCancellation(cancellationToken).ConfigureAwait(false))
        {
            pages.Add(row);
        }

        return pages;
    }

    /// <inheritdoc />
    public async ValueTask<IReadOnlyList<WithheldDatedPost>> WithheldDatedPostsAsync(Site site, DateTimeOffset now, CancellationToken cancellationToken)
    {
        ArgumentNullException.ThrowIfNull(site);
        var posts = new List<WithheldDatedPost>();
        var rows = sql.QueryAsync<WithheldDatedPost, WithheldDatedPostMapper>(
            SiteEligibilitySql.WithheldDatedPosts,
            default,
            [
                TenantParameter(),
                Uuid("workspace_id", site.WorkspaceId.Value),
                Uuid("root_id", site.RootItemId.Value),
                Uuid("site_id", site.Id),
                new NpgsqlParameter("now", NpgsqlDbType.TimestampTz) { Value = now },
                new NpgsqlParameter("limit", NpgsqlDbType.Integer) { Value = SiteRules.MaximumLossEntries + 1 },
            ],
            cancellationToken);
        await foreach (var row in rows.WithCancellation(cancellationToken).ConfigureAwait(false))
        {
            posts.Add(row);
        }

        return posts;
    }

    /// <inheritdoc />
    public async ValueTask<IReadOnlySet<ItemId>> ContainersWithHiddenChildrenAsync(
        IReadOnlyCollection<ItemId> containerIds, IReadOnlyCollection<ItemId> eligibleIds, CancellationToken cancellationToken)
    {
        ArgumentNullException.ThrowIfNull(containerIds);
        ArgumentNullException.ThrowIfNull(eligibleIds);
        var hidden = new HashSet<ItemId>();
        if (containerIds.Count == 0)
        {
            return hidden;
        }

        var rows = sql.QueryAsync<Guid, IdentifierMapper>(
            SiteEligibilitySql.ContainersWithHiddenChildren,
            default,
            [
                TenantParameter(),
                UuidArray("container_ids", containerIds.Select(id => id.Value).ToArray()),
                UuidArray("eligible_ids", eligibleIds.Select(id => id.Value).ToArray()),
            ],
            cancellationToken);
        await foreach (var row in rows.WithCancellation(cancellationToken).ConfigureAwait(false))
        {
            hidden.Add(ItemId.From(row));
        }

        return hidden;
    }

    /// <inheritdoc />
    public async ValueTask<SiteFileCandidate?> FindFileAsync(Site site, ItemId fileItemId, DateTimeOffset now, CancellationToken cancellationToken)
    {
        ArgumentNullException.ThrowIfNull(site);
        var rows = sql.QueryAsync<SiteFileCandidate, FileMapper>(
            SiteEligibilitySql.EligibleFile,
            default,
            [
                TenantParameter(),
                Uuid("workspace_id", site.WorkspaceId.Value),
                Uuid("root_id", site.RootItemId.Value),
                Uuid("site_id", site.Id),
                new NpgsqlParameter("now", NpgsqlDbType.TimestampTz) { Value = now },
                Uuid("file_item_id", fileItemId.Value),
            ],
            cancellationToken);
        await foreach (var row in rows.WithCancellation(cancellationToken).ConfigureAwait(false))
        {
            return row;
        }

        return null;
    }

    /// <inheritdoc />
    public void AddBuild(SiteBuild build) => database.SiteBuilds.Add(build);

    /// <inheritdoc />
    public void AddBuildPage(SiteBuildPage page) => database.SiteBuildPages.Add(page);

    /// <inheritdoc />
    public void AddBuildFile(SiteBuildFile file) => database.SiteBuildFiles.Add(file);

    /// <inheritdoc />
    public void AddActivation(SiteActivation activation) => database.SiteActivations.Add(activation);

    /// <inheritdoc />
    public void AddAudit(AuditEvent auditEvent) => database.AuditEvents.Add(auditEvent);

    /// <inheritdoc />
    public async ValueTask SaveAsync(CancellationToken cancellationToken) =>
        await database.SaveChangesAsync(cancellationToken).ConfigureAwait(false);

    /// <inheritdoc />
    public async ValueTask<int> NextGenerationAsync(Guid siteId, CancellationToken cancellationToken) =>
        (await database.SiteActivations.AsNoTracking()
            .Where(activation => activation.SiteId == siteId)
            .MaxAsync(activation => (int?)activation.Generation, cancellationToken).ConfigureAwait(false) ?? 0) + 1;

    /// <inheritdoc />
    public async ValueTask<SiteBuild?> FindBuildForUpdateAsync(Guid buildId, CancellationToken cancellationToken) =>
        await database.SiteBuilds.AsTracking()
            .SingleOrDefaultAsync(build => build.Id == buildId, cancellationToken).ConfigureAwait(false);

    /// <inheritdoc />
    public async ValueTask<SiteBuild?> FindBuildByJobAsync(Guid jobId, CancellationToken cancellationToken) =>
        await database.SiteBuilds.AsTracking()
            .SingleOrDefaultAsync(build => build.JobId == jobId, cancellationToken).ConfigureAwait(false);

    /// <inheritdoc />
    public async ValueTask<IReadOnlyList<SiteBuildPage>> ListBuildPagesAsync(Guid buildId, int after, int limit, CancellationToken cancellationToken) =>
        await database.SiteBuildPages.AsNoTracking()
            .Where(page => page.BuildId == buildId && page.Ordinal > after)
            .OrderBy(page => page.Ordinal)
            .Take(limit)
            .ToListAsync(cancellationToken).ConfigureAwait(false);

    /// <inheritdoc />
    public async ValueTask<SiteBuildPage?> FindBuildPageAsync(Guid buildId, ItemId itemId, CancellationToken cancellationToken) =>
        await database.SiteBuildPages.AsNoTracking()
            .SingleOrDefaultAsync(page => page.BuildId == buildId && page.ItemId == itemId, cancellationToken).ConfigureAwait(false);

    /// <inheritdoc />
    public async ValueTask<SiteFileRecording> RecordFileAsync(
        SiteBuild build, ItemId sourceItemId, SiteFileCandidate file, DateTimeOffset now, CancellationToken cancellationToken)
    {
        ArgumentNullException.ThrowIfNull(build);
        ArgumentNullException.ThrowIfNull(file);
        if (await database.SiteBuildFiles.AsNoTracking().AnyAsync(
                existing => existing.BuildId == build.Id
                    && existing.SourceItemId == sourceItemId
                    && existing.FileItemId == file.FileItemId,
                cancellationToken).ConfigureAwait(false))
        {
            return SiteFileRecording.Recorded;
        }

        database.SiteBuildFiles.Add(new SiteBuildFile
        {
            TenantId = build.TenantId,
            BuildId = build.Id,
            SourceItemId = sourceItemId,
            FileItemId = file.FileItemId,
            FileVersionId = file.FileVersionId,
            Sha256 = file.Sha256,
            MediaType = file.MediaType,
            ByteLength = file.ByteLength,
            CreatedAt = now,
        });

        // The trigger refuses a row once the build has left the queue. Reported, not thrown: the
        // request raced the seal, and the caller answers 409.
        var refused = await TrySaveAsync(PostgresErrorCodes.CheckViolation, cancellationToken).ConfigureAwait(false);
        return refused is null ? SiteFileRecording.Recorded : SiteFileRecording.BuildClosed;
    }

    /// <inheritdoc />
    public async ValueTask<IReadOnlyList<SiteBuildObject>> ListObjectsAsync(Guid buildId, CancellationToken cancellationToken) =>
        await database.SiteBuildObjects.AsNoTracking()
            .Where(buildObject => buildObject.BuildId == buildId)
            .OrderBy(buildObject => buildObject.Key)
            .ToListAsync(cancellationToken).ConfigureAwait(false);

    /// <inheritdoc />
    public void AddObject(SiteBuildObject buildObject) => database.SiteBuildObjects.Add(buildObject);

    /// <inheritdoc />
    public async ValueTask<SiteActivation?> FindActivationByJobAsync(Guid jobId, CancellationToken cancellationToken) =>
        await database.SiteActivations.AsTracking()
            .SingleOrDefaultAsync(activation => activation.JobId == jobId, cancellationToken).ConfigureAwait(false);

    /// <inheritdoc />
    public async ValueTask<Guid?> ActivateAsync(
        Site site, SiteBuild build, SiteActivation activation, int buildsRetained, DateTimeOffset now, CancellationToken cancellationToken)
    {
        ArgumentNullException.ThrowIfNull(site);
        ArgumentNullException.ThrowIfNull(build);
        ArgumentNullException.ThrowIfNull(activation);
        var previous = site.LiveBuildId;
        site.LiveBuildId = build.Id;
        site.Status = SiteRules.PublishedStatus;
        site.UpdatedAt = now;
        build.Status = SiteRules.LiveBuild;
        build.ActivatedAt = now;
        activation.AppliedAt = now;
        if (previous is { } superseded && superseded != build.Id)
        {
            await SetStatusAsync([superseded], SiteRules.SupersededBuild, cancellationToken).ConfigureAwait(false);
        }

        await database.SaveChangesAsync(cancellationToken).ConfigureAwait(false);

        // Builds whose job ended without activating them never will; they are failed, not waiting.
        var abandoned = (await WithJobsAsync(
            await database.SiteBuilds.AsNoTracking()
                .Where(candidate => candidate.SiteId == site.Id
                    && candidate.Id != build.Id
                    && (candidate.Status == SiteRules.QueuedBuild || candidate.Status == SiteRules.SealedBuild))
                .ToListAsync(cancellationToken).ConfigureAwait(false),
            cancellationToken).ConfigureAwait(false))
            .Where(view => view.JobStatus is null or "failed" or "cancelled")
            .Select(view => view.Build.Id)
            .ToArray();
        if (abandoned.Length > 0)
        {
            await SetStatusAsync(abandoned, SiteRules.FailedBuild, cancellationToken).ConfigureAwait(false);
        }

        var kept = Math.Max(buildsRetained - 1, 0);
        var finished = await database.SiteBuilds.AsNoTracking()
            .Where(candidate => candidate.SiteId == site.Id
                && candidate.Id != build.Id
                && candidate.PurgeId == null
                && (candidate.Status == SiteRules.SupersededBuild || candidate.Status == SiteRules.FailedBuild))
            .OrderByDescending(candidate => candidate.CreatedAt).ThenByDescending(candidate => candidate.Id)
            .ToListAsync(cancellationToken).ConfigureAwait(false);
        var retired = finished.Where(candidate => candidate.Status == SiteRules.FailedBuild)
            .Concat(finished.Where(candidate => candidate.Status == SiteRules.SupersededBuild).Skip(kept))
            .Select(candidate => candidate.Id)
            .ToArray();
        return await RetireAsync(retired, cancellationToken).ConfigureAwait(false);
    }

    /// <inheritdoc />
    public async ValueTask RollBackAsync(
        Site site, SiteBuild target, SiteActivation activation, DateTimeOffset now, CancellationToken cancellationToken)
    {
        ArgumentNullException.ThrowIfNull(site);
        ArgumentNullException.ThrowIfNull(target);
        ArgumentNullException.ThrowIfNull(activation);
        var previous = site.LiveBuildId;
        site.LiveBuildId = target.Id;
        site.Status = SiteRules.PublishedStatus;
        site.UpdatedAt = now;
        target.Status = SiteRules.LiveBuild;
        target.ActivatedAt = now;
        activation.AppliedAt = now;
        if (previous is { } superseded && superseded != target.Id)
        {
            await SetStatusAsync([superseded], SiteRules.SupersededBuild, cancellationToken).ConfigureAwait(false);
        }

        await database.SaveChangesAsync(cancellationToken).ConfigureAwait(false);
    }

    /// <inheritdoc />
    public async ValueTask<Guid?> WithdrawAsync(Site site, SiteActivation activation, DateTimeOffset now, CancellationToken cancellationToken)
    {
        ArgumentNullException.ThrowIfNull(site);
        ArgumentNullException.ThrowIfNull(activation);
        site.LiveBuildId = null;
        site.Status = SiteRules.UnpublishedStatus;
        site.UpdatedAt = now;

        // The operator approves the first publish after an unpublish too (ADR-0063).
        site.ApprovalState = null;
        activation.AppliedAt = now;
        await database.SaveChangesAsync(cancellationToken).ConfigureAwait(false);

        var everything = await database.SiteBuilds.AsNoTracking()
            .Where(candidate => candidate.SiteId == site.Id
                && candidate.PurgeId == null
                && candidate.Status != SiteRules.PurgedBuild)
            .Select(candidate => candidate.Id)
            .ToArrayAsync(cancellationToken).ConfigureAwait(false);
        return await RetireAsync(everything, cancellationToken).ConfigureAwait(false);
    }

    /// <inheritdoc />
    public async ValueTask<IReadOnlyList<string>> ListPurgeObjectsAsync(
        Guid purgeId, string? afterKey, int limit, CancellationToken cancellationToken)
    {
        var purging = database.SiteBuilds.Where(build => build.PurgeId == purgeId).Select(build => build.Id);
        var candidates = database.SiteBuildObjects.AsNoTracking()
            .Where(buildObject => purging.Contains(buildObject.BuildId)
                && (buildObject.Kind == SiteRules.BuildObject
                    || !database.SiteBuildObjects.Any(other => other.Kind == SiteRules.AssetObject
                        && other.Key == buildObject.Key
                        && other.TenantId == buildObject.TenantId
                        && !purging.Contains(other.BuildId))));
        if (afterKey is not null)
        {
            candidates = candidates.Where(buildObject => buildObject.Key.CompareTo(afterKey) > 0);
        }

        return await candidates.Select(buildObject => buildObject.Key).Distinct().OrderBy(key => key).Take(limit)
            .ToListAsync(cancellationToken).ConfigureAwait(false);
    }

    /// <inheritdoc />
    public async ValueTask<int> MarkPurgedAsync(Guid purgeId, IReadOnlyCollection<string> keys, CancellationToken cancellationToken)
    {
        ArgumentNullException.ThrowIfNull(keys);
        var purging = database.SiteBuilds.Where(build => build.PurgeId == purgeId).Select(build => build.Id);

        // The deleted keys, plus the rows of this purge's builds for images another build still
        // holds: the object stays, but the retired build no longer lists it.
        var removed = await database.SiteBuildObjects
            .Where(buildObject => purging.Contains(buildObject.BuildId)
                && (keys.Contains(buildObject.Key)
                    || (buildObject.Kind == SiteRules.AssetObject
                        && database.SiteBuildObjects.Any(other => other.Kind == SiteRules.AssetObject
                            && other.Key == buildObject.Key
                            && other.TenantId == buildObject.TenantId
                            && !purging.Contains(other.BuildId)))))
            .ExecuteDeleteAsync(cancellationToken).ConfigureAwait(false);
        await database.SiteBuilds
            .Where(build => build.PurgeId == purgeId
                && build.Status != SiteRules.PurgedBuild
                && !database.SiteBuildObjects.Any(buildObject => buildObject.BuildId == build.Id))
            .ExecuteUpdateAsync(setters => setters.SetProperty(build => build.Status, SiteRules.PurgedBuild), cancellationToken)
            .ConfigureAwait(false);
        return removed;
    }

    private async ValueTask<IReadOnlyList<SiteBuildView>> WithJobsAsync(List<SiteBuild> builds, CancellationToken cancellationToken)
    {
        if (builds.Count == 0)
        {
            return [];
        }

        var jobIds = builds.Select(build => WorkerJobId.From(build.JobId)).ToArray();
        var jobs = await database.WorkerJobs.AsNoTracking()
            .Where(job => jobIds.Contains(job.Id))
            .Select(job => new { job.Id, job.Status, job.ErrorCode })
            .ToListAsync(cancellationToken).ConfigureAwait(false);
        var byId = jobs.ToDictionary(job => job.Id.Value);
        return [.. builds.Select(build => byId.TryGetValue(build.JobId, out var job)
            ? new SiteBuildView(build, job.Status, job.ErrorCode)
            : new SiteBuildView(build, null, null))];
    }

    private async ValueTask SetStatusAsync(Guid[] buildIds, string status, CancellationToken cancellationToken) =>
        await database.SiteBuilds.Where(build => buildIds.Contains(build.Id))
            .ExecuteUpdateAsync(setters => setters.SetProperty(build => build.Status, status), cancellationToken)
            .ConfigureAwait(false);

    /// <summary>
    /// Retires builds: those with objects join a new purge, those without are simply purged.
    /// </summary>
    private async ValueTask<Guid?> RetireAsync(Guid[] buildIds, CancellationToken cancellationToken)
    {
        if (buildIds.Length == 0)
        {
            return null;
        }

        var withObjects = await database.SiteBuildObjects.AsNoTracking()
            .Where(buildObject => buildIds.Contains(buildObject.BuildId))
            .Select(buildObject => buildObject.BuildId)
            .Distinct()
            .ToListAsync(cancellationToken).ConfigureAwait(false);
        var empty = buildIds.Except(withObjects).ToArray();
        if (empty.Length > 0)
        {
            await SetStatusAsync(empty, SiteRules.PurgedBuild, cancellationToken).ConfigureAwait(false);
        }

        if (withObjects.Count == 0)
        {
            return null;
        }

        var purgeId = Guid.CreateVersion7();
        await database.SiteBuilds.Where(build => withObjects.Contains(build.Id))
            .ExecuteUpdateAsync(setters => setters.SetProperty(build => build.PurgeId, purgeId), cancellationToken)
            .ConfigureAwait(false);
        return purgeId;
    }

    private async ValueTask<SiteWriteOutcome> SaveGuardedAsync(CancellationToken cancellationToken)
    {
        var violation = await TrySaveAsync(PostgresErrorCodes.UniqueViolation, cancellationToken).ConfigureAwait(false);
        return violation?.ConstraintName switch
        {
            null => SiteWriteOutcome.Written,
            "ux_site_slug" => SiteWriteOutcome.SlugTaken,
            "ux_site_root" => SiteWriteOutcome.RootTaken,
            "pk_site_hostname" or "ux_site_hostname_verified" => SiteWriteOutcome.HostnameTaken,
            _ => throw new InvalidOperationException($"Unexpected unique violation {violation.ConstraintName}."),
        };
    }

    /// <summary>
    /// Saves, and when Postgres refuses with <paramref name="sqlState"/> rolls back to a savepoint
    /// taken just before so the surrounding unit of work stays usable, and returns the refusal.
    /// </summary>
    private async ValueTask<PostgresException?> TrySaveAsync(string sqlState, CancellationToken cancellationToken)
    {
        var transaction = database.Database.CurrentTransaction;
        if (transaction is not null)
        {
            await transaction.CreateSavepointAsync(Savepoint, cancellationToken).ConfigureAwait(false);
        }

        try
        {
            await database.SaveChangesAsync(cancellationToken).ConfigureAwait(false);
            if (transaction is not null)
            {
                await transaction.ReleaseSavepointAsync(Savepoint, cancellationToken).ConfigureAwait(false);
            }

            return null;
        }
        catch (DbUpdateException exception) when (exception.InnerException is PostgresException { } refusal
            && refusal.SqlState == sqlState
            // Only the trigger's RAISE (no constraint name) is a refusal; a ck_* violation is a bug.
            && (sqlState != PostgresErrorCodes.CheckViolation || refusal.ConstraintName is null)
            && transaction is not null)
        {
            await transaction.RollbackToSavepointAsync(Savepoint, cancellationToken).ConfigureAwait(false);
            database.ChangeTracker.Clear();
            return refusal;
        }
    }

    private NpgsqlParameter TenantParameter() => Uuid("tenant_id", Tenant.Value);

    private readonly struct IdentifierMapper : INixRowMapper<Guid>
    {
        public Guid Map(NpgsqlDataReader reader)
        {
            ArgumentNullException.ThrowIfNull(reader);
            return reader.GetGuid(0);
        }
    }

    private readonly struct TitleMapper : INixRowMapper<(Guid Id, string? Title)>
    {
        public (Guid Id, string? Title) Map(NpgsqlDataReader reader)
        {
            ArgumentNullException.ThrowIfNull(reader);
            return (reader.GetGuid(0), reader.IsDBNull(1) ? null : reader.GetString(1));
        }
    }

    private readonly struct FileMapper : INixRowMapper<SiteFileCandidate>
    {
        public SiteFileCandidate Map(NpgsqlDataReader reader)
        {
            ArgumentNullException.ThrowIfNull(reader);
            return new SiteFileCandidate(
                ItemId.From(reader.GetGuid(0)),
                reader.GetGuid(1),
                reader.GetString(2),
                reader.GetString(3),
                reader.GetInt64(4),
                reader.GetString(5),
                reader.GetString(6));
        }
    }

    /// <summary>Reads the eleven columns the eligibility statement projects, in order.</summary>
    private readonly struct EligiblePageMapper : INixRowMapper<EligiblePage>
    {
        public EligiblePage Map(NpgsqlDataReader reader)
        {
            ArgumentNullException.ThrowIfNull(reader);
            var id = ItemId.From(reader.GetGuid(0));
            ItemId? parent = reader.IsDBNull(1) ? null : ItemId.From(reader.GetGuid(1));
            var type = reader.GetString(2);
            var seq = reader.GetInt64(3);
            var properties = reader.IsDBNull(4) ? null : reader.GetString(4);
            var schema = reader.IsDBNull(5) ? null : reader.GetString(5);
            var views = reader.IsDBNull(6) ? null : reader.GetString(6);
            var created = reader.GetFieldValue<DateTimeOffset>(7);
            var modified = reader.GetFieldValue<DateTimeOffset>(8);
            Guid? docId = reader.IsDBNull(9) ? null : reader.GetGuid(9);
            long? head = reader.IsDBNull(10) ? null : reader.GetInt64(10);
            return new EligiblePage(id, parent, type, seq, properties, schema, views, created, modified, docId, head);
        }
    }

    private readonly struct WithheldDatedPostMapper : INixRowMapper<WithheldDatedPost>
    {
        public WithheldDatedPost Map(NpgsqlDataReader reader)
        {
            ArgumentNullException.ThrowIfNull(reader);
            return new WithheldDatedPost(
                reader.IsDBNull(0) ? null : reader.GetString(0),
                reader.IsDBNull(1) ? null : reader.GetString(1),
                reader.IsDBNull(2) ? null : reader.GetFieldValue<DateTimeOffset>(2));
        }
    }
}
