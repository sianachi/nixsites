using System.Globalization;
using System.Text.Json;
using Microsoft.AspNetCore.Mvc;
using Microsoft.Extensions.Configuration;
using Nix.Abstractions;
using Nix.Abstractions.Workers;
using Nix.Authentication;
using Nix.Domain.Items;
using Nix.Domain.Sites;
using Nix.Errors;
using Nix.Features.Exports;
using Nix.Persistence.ObjectStorage;

namespace Nix.Features.Sites;

/// <summary>
/// The sites worker's view of Core: the manifest, the bodies and images it may read, and the
/// objects it may write. Every route is lease-bound (the middleware has already proved the exact
/// execution owns a live lease), checks that the job is of the right kind, and checks the state of
/// the build it names.
/// </summary>
/// <remarks>
/// <para>
/// The worker never chooses a key, a bucket or a destination. Core derives every key from the
/// site and build identities and signs a capability for exactly that key, bound to the digest and
/// length the worker declared. Core also writes the bytes of each host manifest, so the worker
/// cannot alter which build a hostname points at.
/// </para>
/// <para>
/// Every route below runs in the lease middleware's transaction and fenced on the job row, so a
/// refusal (any status of 400 or more) rolls back everything the request wrote.
/// </para>
/// </remarks>
internal static class SiteWorkerEndpoints
{
    private const int PageLimit = 200;
    private const int PurgeLimit = 500;
    private const string RefusedCode = SiteWorkerServices.RefusedCode;

    /// <summary>Registers the routes under <c>/internal/worker-executions</c>.</summary>
    internal static void MapWorkerExecutions(IEndpointRouteBuilder group)
    {
        var sites = group.MapGroup("/sites");
        var builds = sites.MapGroup("/builds/{jobId:guid}");
        builds.MapGet(string.Empty, GetManifest);
        builds.MapGet("/pages", GetPages);
        builds.MapGet("/bodies/{itemId:guid}", GetBody);
        builds.MapGet("/files/{fileItemId:guid}", GetFile);
        builds.MapPost("/uploads", PostUploads);
        builds.MapPost("/seal", PostSeal);
        builds.MapPost("/activated", PostActivated);
        sites.MapGet("/activations/{jobId:guid}", GetActivation);
        sites.MapPost("/activations/{jobId:guid}/applied", PostApplied);
        sites.MapGet("/purges/{jobId:guid}/objects", GetPurgeObjects);
        sites.MapPost("/purges/{jobId:guid}/objects/deleted", PostPurgeDeleted);
    }

    private static async Task<IResult> GetManifest(
        Guid jobId, HttpContext context, [FromServices] SiteWorkerServices services)
    {
        var scope = await services.BuildAsync(jobId, context, SiteRules.QueuedBuild).ConfigureAwait(false);
        return scope.Refusal ?? TypedResults.Content(scope.Build!.Header, "application/json");
    }

    private static async Task<IResult> GetPages(
        Guid jobId, int? after, int? limit, HttpContext context, [FromServices] SiteWorkerServices services)
    {
        var scope = await services.BuildAsync(jobId, context, SiteRules.QueuedBuild).ConfigureAwait(false);
        if (scope.Refusal is not null)
        {
            return scope.Refusal;
        }

        var take = Math.Clamp(limit ?? 100, 1, PageLimit);
        var rows = await services.Sites.ListBuildPagesAsync(scope.Build!.Id, Math.Max(after ?? -1, -1), take + 1, context.RequestAborted)
            .ConfigureAwait(false);
        var page = rows.Take(take).Select(ToWorkerPage).ToArray();
        return TypedResults.Ok(new SiteWorkerPageList(page, rows.Count > take ? page[^1].Ordinal : null));
    }

    private static async Task<IResult> GetBody(
        Guid jobId, Guid itemId, HttpContext context, [FromServices] SiteWorkerServices services)
    {
        var scope = await services.BuildAsync(jobId, context, SiteRules.QueuedBuild).ConfigureAwait(false);
        if (scope.Refusal is not null)
        {
            return scope.Refusal;
        }

        var page = await services.Sites.FindBuildPageAsync(scope.Build!.Id, ItemId.From(itemId), context.RequestAborted).ConfigureAwait(false);
        if (page is null || page.DocId is null || page.ContentSeq is null)
        {
            return Problem(context, 404, "sites.body_unavailable", "The page is not in the manifest or has no body.");
        }

        if (!services.Tokens.IsConfigured || !ExportEndpoints.TryCollaborationBaseUri(services.Configuration, out var collaboration))
        {
            return Problem(context, 503, SiteErrors.NotConfiguredCode, "Bodies cannot be read on this deployment.");
        }

        // Pinned to the content position the manifest recorded, so a body edited after the
        // publish request is not part of this build.
        var source = new Uri(
            collaboration,
            $"documents/{itemId:D}/bundles?scope=item&atSeq={page.ContentSeq.Value.ToString(CultureInfo.InvariantCulture)}");
        var bearer = services.Tokens.MintWorkerExecution(
            scope.Context.PrincipalId,
            scope.Context.TenantId,
            jobId,
            itemId,
            scope.Site!.WorkspaceId.Value,
            "item",
            scope.Execution!);
        return TypedResults.Ok(new SiteWorkerBody(
            source, bearer, services.Clock.GetUtcNow().Add(SelfIssuedTokenService.WorkerExecutionLifetime)));
    }

    private static async Task<IResult> GetFile(
        Guid jobId, Guid fileItemId, Guid? source, HttpContext context, [FromServices] SiteWorkerServices services)
    {
        var scope = await services.BuildAsync(jobId, context, SiteRules.QueuedBuild).ConfigureAwait(false);
        if (scope.Refusal is not null)
        {
            return scope.Refusal;
        }

        if (source is null || source == Guid.Empty)
        {
            return Problem(context, 422, SiteErrors.InvalidCode, "Name the page that references the file with ?source=.");
        }

        // Core cannot parse a current body, so the worker reports what it found and Core
        // validates it: the page must be in the manifest, and the image must pass the same rules a
        // property image does. The row is what lets the sealed manifest stay complete.
        if (await services.Sites.FindBuildPageAsync(scope.Build!.Id, ItemId.From(source.Value), context.RequestAborted).ConfigureAwait(false) is null)
        {
            return Problem(context, 409, "sites.source_not_in_manifest", "The page that references this file is not part of the build.");
        }

        // Judged as of the manifest's instant, under the same exclusions and dated collections.
        var candidate = await services.Sites.FindFileAsync(scope.Site!, ItemId.From(fileItemId), scope.Build!.CreatedAt, context.RequestAborted).ConfigureAwait(false);
        if (candidate is null
            // The build is the owner's explicit publication and runs under an execution token, which
            // never holds a workspace unlock: membership is what is checked here, not the password.
            || await services.Membership.RoleIgnoringLockAsync(scope.Site!.WorkspaceId, context.RequestAborted).ConfigureAwait(false) is null
            || !services.Storage.IsConfigured)
        {
            return Problem(context, 404, "sites.file_unavailable", "The image is not available to this site.");
        }

        var recorded = await services.Sites
            .RecordFileAsync(scope.Build, ItemId.From(source.Value), candidate, services.Clock.GetUtcNow(), context.RequestAborted)
            .ConfigureAwait(false);
        if (recorded == SiteFileRecording.BuildClosed)
        {
            return Problem(context, 409, "sites.build_closed", "The build no longer accepts files.");
        }

        var capability = services.Storage.Get(candidate.ObjectKey);
        return TypedResults.Ok(new SiteWorkerFile(
            candidate.FileItemId.Value,
            candidate.FileVersionId,
            candidate.Sha256,
            candidate.MediaType,
            candidate.ByteLength,
            candidate.FileName,
            capability.Url,
            capability.ExpiresAt));
    }

    private static async Task<IResult> PostUploads(
        Guid jobId, SiteUploadRequest request, HttpContext context, [FromServices] SiteWorkerServices services)
    {
        var scope = await services.BuildAsync(jobId, context, SiteRules.QueuedBuild).ConfigureAwait(false);
        if (scope.Refusal is not null)
        {
            return scope.Refusal;
        }

        var entries = request?.Entries;
        if (entries is null || entries.Count is 0 or > SiteRules.MaximumUploadBatch || !services.Signer.IsConfigured)
        {
            return Problem(context, 422, SiteErrors.InvalidCode, "Send 1 to 100 entries.");
        }

        var build = scope.Build!;
        var recorded = (await services.Sites.ListObjectsAsync(build.Id, context.RequestAborted).ConfigureAwait(false))
            .ToDictionary(row => row.Key, StringComparer.Ordinal);
        var count = recorded.Count;
        var bytes = recorded.Values.Sum(row => row.ByteLength);
        var targets = new List<SiteUploadTarget>(entries.Count);
        var now = services.Clock.GetUtcNow();
        foreach (var entry in entries)
        {
            if (!TryKey(scope.Site!.Id, build.Id, entry, out var key))
            {
                return Problem(context, 422, SiteErrors.InvalidCode, "An upload entry has an invalid path, kind, size, digest or media type.");
            }

            if (recorded.TryGetValue(key, out var existing))
            {
                if (existing.Sha256 != entry.Sha256 || existing.ByteLength != entry.ByteLength)
                {
                    return Problem(context, 409, "sites.object_conflict", "That path was already recorded with different content.");
                }
            }
            else
            {
                count++;
                bytes += entry.ByteLength;
                if (count > SiteRules.MaximumObjects || bytes > SiteRules.MaximumBuildBytes)
                {
                    return Problem(context, 422, "sites.build_too_large", "The build exceeds 20,000 objects or 2 GiB.");
                }

                var row = new SiteBuildObject
                {
                    TenantId = scope.Context.TenantId,
                    BuildId = build.Id,
                    Key = key,
                    Sha256 = entry.Sha256,
                    ByteLength = entry.ByteLength,
                    Kind = entry.Kind,
                    CreatedAt = now,
                };
                recorded[key] = row;
                services.Sites.AddObject(row);
            }

            var capability = services.Signer.PutImmutableVerified(key, entry.ByteLength, entry.Sha256);
            targets.Add(new SiteUploadTarget(entry.Path, key, capability.Url, capability.ExpiresAt));
        }

        // An image a retired build still lists may be mid-delete; writing it now could be undone by
        // that purge after this build relies on it. The worker retries once the purge has drained.
        var assets = targets.Select(target => target.Key).Where(key => recorded[key].Kind == SiteRules.AssetObject).ToArray();
        if (await services.Sites.IsAnyAssetPurgingAsync(assets, context.RequestAborted).ConfigureAwait(false))
        {
            return Problem(context, 409, "sites.asset_purging", "An image is being deleted by an earlier purge. Retry after it finishes.");
        }

        await services.Sites.SaveAsync(context.RequestAborted).ConfigureAwait(false);
        return TypedResults.Ok(new SiteUploadResponse(targets));
    }

    private static async Task<IResult> PostSeal(
        Guid jobId, SiteSealRequest request, HttpContext context, [FromServices] SiteWorkerServices services)
    {
        var scope = await services.BuildAsync(jobId, context, SiteRules.QueuedBuild, SiteRules.SealedBuild).ConfigureAwait(false);
        if (scope.Refusal is not null)
        {
            return scope.Refusal;
        }

        var build = scope.Build!;
        var site = scope.Site!;
        if (build.Status == SiteRules.SealedBuild)
        {
            // A retried seal: the host manifests were fixed the first time, so hand out the same
            // bytes with fresh capabilities.
            var stored = await services.Sites.FindActivationByJobAsync(jobId, context.RequestAborted).ConfigureAwait(false);
            return stored is null
                ? Problem(context, 409, RefusedCode, "The sealed build has no activation.")
                : TypedResults.Ok(new SiteSealResponse(Writes(services, stored)));
        }

        if (request is null
            || request.FileCount is < 1 or > SiteRules.MaximumObjects
            || request.TotalBytes is < 0 or > SiteRules.MaximumBuildBytes
            || !SiteRules.IsSha256(request.BuildIndexSha256)
            || request.Loss is null
            || request.Loss.Count > SiteRules.MaximumLossEntries
            || request.Loss.Any(entry => string.IsNullOrWhiteSpace(entry) || entry.Length > 500 || entry.Any(char.IsControl)))
        {
            return Problem(context, 422, SiteErrors.InvalidCode, "The seal request is malformed.");
        }

        var objects = await services.Sites.ListObjectsAsync(build.Id, context.RequestAborted).ConfigureAwait(false);
        var prefix = ObjectStorageKeys.SiteBuildPrefix(site.Id, build.Id);
        var index = objects.SingleOrDefault(row => row.Key == prefix + "_nix/build.json");
        if (objects.Count != request.FileCount
            || objects.Sum(row => row.ByteLength) != request.TotalBytes
            || objects.All(row => row.Key != prefix + "index.html")
            || index is null
            || index.Sha256 != request.BuildIndexSha256)
        {
            return Problem(context, 422, "sites.seal_mismatch", "The recorded objects do not match the seal.");
        }

        var now = services.Clock.GetUtcNow();
        var hostnames = await services.Sites.ListHostnamesAsync([site.Id], context.RequestAborted).ConfigureAwait(false);
        var generation = await services.Sites.NextGenerationAsync(site.Id, context.RequestAborted).ConfigureAwait(false);
        var ops = SiteHostManifests.Puts(site, build.Id, hostnames, generation, now, services.Options.PublicUrl);
        build.Status = SiteRules.SealedBuild;
        build.SealedAt = now;
        build.FileCount = objects.Count;
        build.TotalBytes = request.TotalBytes;
        build.BuildIndexSha256 = request.BuildIndexSha256;
        var queuedLoss = JsonSerializer.Deserialize(build.Loss, SitesJsonContext.Default.StringArray) ?? [];
        build.Loss = JsonSerializer.Serialize(MergeLosses(queuedLoss, request.Loss), SitesJsonContext.Default.StringArray);
        var activation = new SiteActivation
        {
            TenantId = build.TenantId,
            Id = Guid.CreateVersion7(),
            SiteId = site.Id,
            JobId = jobId,
            BuildId = build.Id,
            Reason = SiteRules.PublishActivation,
            Generation = generation,
            Ops = JsonSerializer.Serialize(ops.ToArray(), SitesJsonContext.Default.SiteActivationOpRecordArray),
            CreatedAt = now,
        };
        services.Sites.AddActivation(activation);
        return await services.Sites.TrySaveActivationAsync(context.RequestAborted).ConfigureAwait(false)
            ? TypedResults.Ok(new SiteSealResponse(Writes(services, activation)))
            : Problem(context, 409, SiteErrors.BuildInProgressCode, "Another change of what is live took this generation. Retry the seal.");
    }

    private static string[] MergeLosses(string[] queued, IReadOnlyList<string> reported)
    {
        var total = queued.Length + reported.Count;
        var merged = queued.Concat(reported).Take(SiteRules.MaximumLossEntries).ToList();
        if (total > merged.Count)
        {
            merged[^1] = $"omitted: {total - merged.Count + 1} publishing notes were not listed.";
        }

        return [.. merged];
    }

    private static async Task<IResult> PostActivated(
        Guid jobId, HttpContext context, [FromServices] SiteWorkerServices services)
    {
        var scope = await services.BuildAsync(jobId, context, SiteRules.SealedBuild, SiteRules.LiveBuild).ConfigureAwait(false);
        if (scope.Refusal is not null)
        {
            return scope.Refusal;
        }

        var build = scope.Build!;
        if (build.Status == SiteRules.LiveBuild)
        {
            return TypedResults.NoContent();
        }

        var activation = await services.Sites.FindActivationByJobAsync(jobId, context.RequestAborted).ConfigureAwait(false);
        if (activation is null || activation.BuildId != build.Id)
        {
            return Problem(context, 409, RefusedCode, "The build has no activation.");
        }

        var now = services.Clock.GetUtcNow();
        var purge = await services.Sites
            .ActivateAsync(scope.Site!, build, activation, services.Options.BuildsRetained, now, context.RequestAborted)
            .ConfigureAwait(false);
        if (purge is { } purgeId)
        {
            await QueuePurgeAsync(services, scope.Context, scope.Site!, purgeId, context.RequestAborted).ConfigureAwait(false);
        }

        return TypedResults.NoContent();
    }

    private static async Task<IResult> GetActivation(
        Guid jobId, HttpContext context, [FromServices] SiteWorkerServices services)
    {
        var scope = await services.JobAsync(jobId, context, SiteJobKinds.Activate).ConfigureAwait(false);
        if (scope.Refusal is not null)
        {
            return scope.Refusal;
        }

        var activation = await services.Sites.FindActivationByJobAsync(jobId, context.RequestAborted).ConfigureAwait(false);
        if (activation is null || activation.AppliedAt is not null || !services.Signer.IsConfigured)
        {
            return Problem(context, 409, RefusedCode, "There is nothing to apply for this job.");
        }

        var ops = JsonSerializer.Deserialize(activation.Ops, SitesJsonContext.Default.SiteActivationOpRecordArray) ?? [];
        return TypedResults.Ok(new SiteActivationResponse(
            activation.Id,
            activation.Reason,
            [.. ops.Select(op => ToOp(services, op))],
            activation.SiteId));
    }

    private static async Task<IResult> PostApplied(
        Guid jobId, HttpContext context, [FromServices] SiteWorkerServices services)
    {
        var scope = await services.JobAsync(jobId, context, SiteJobKinds.Activate).ConfigureAwait(false);
        if (scope.Refusal is not null)
        {
            return scope.Refusal;
        }

        if (SiteWorkerServices.TryReadActivationSite(scope.Job!) is not { } siteId)
        {
            return Problem(context, 409, RefusedCode, "The activation job is malformed.");
        }

        await services.Sites.LockSiteAsync(siteId, context.RequestAborted).ConfigureAwait(false);
        var activation = await services.Sites.FindActivationByJobAsync(jobId, context.RequestAborted).ConfigureAwait(false);
        if (activation is null || activation.SiteId != siteId)
        {
            return Problem(context, 409, RefusedCode, "There is nothing to apply for this job.");
        }

        if (activation.AppliedAt is not null)
        {
            return TypedResults.NoContent();
        }

        var site = await services.Sites.FindForUpdateAsync(activation.SiteId, context.RequestAborted).ConfigureAwait(false);
        if (site is null)
        {
            return Problem(context, 409, RefusedCode, "The site no longer exists.");
        }

        var now = services.Clock.GetUtcNow();
        if (activation.Reason == SiteRules.RollbackActivation)
        {
            var target = await services.Sites.FindBuildForUpdateAsync(activation.BuildId, context.RequestAborted).ConfigureAwait(false);
            if (target is null || target.Status != SiteRules.SupersededBuild || target.PurgeId is not null || site.Status != SiteRules.PublishedStatus)
            {
                return Problem(context, 409, RefusedCode, "The rollback target is no longer available.");
            }

            await services.Sites.RollBackAsync(site, target, activation, now, context.RequestAborted).ConfigureAwait(false);
        }
        else if (activation.Reason == SiteRules.UnpublishActivation)
        {
            if (await services.Sites.WithdrawAsync(site, activation, now, context.RequestAborted).ConfigureAwait(false) is { } purgeId)
            {
                await QueuePurgeAsync(services, scope.Context, site, purgeId, context.RequestAborted).ConfigureAwait(false);
            }
        }
        else if (activation.Reason == SiteRules.HostnamesActivation)
        {
            // The live build stays; only which hostnames point at it, and how, changed.
            activation.AppliedAt = now;
            await services.Sites.SaveAsync(context.RequestAborted).ConfigureAwait(false);
        }
        else
        {
            return Problem(context, 409, RefusedCode, "A publish activation is applied through the build job.");
        }

        return TypedResults.NoContent();
    }

    private static async Task<IResult> GetPurgeObjects(
        Guid jobId, string? after, int? limit, HttpContext context, [FromServices] SiteWorkerServices services)
    {
        var scope = await services.JobAsync(jobId, context, SiteJobKinds.Purge).ConfigureAwait(false);
        if (scope.Refusal is not null)
        {
            return scope.Refusal;
        }

        if (!TryPurgeId(scope.Job!, out var purgeId) || !services.Signer.IsConfigured)
        {
            return Problem(context, 409, RefusedCode, "The purge job is malformed.");
        }

        var take = Math.Clamp(limit ?? 200, 1, PurgeLimit);
        var keys = await services.Sites.ListPurgeObjectsAsync(purgeId, after, take, context.RequestAborted).ConfigureAwait(false);
        var objects = keys.Select(key =>
        {
            var capability = services.Signer.Delete(key);
            return new SitePurgeTarget(key, capability.Url, capability.ExpiresAt);
        }).ToArray();
        return TypedResults.Ok(new SitePurgeObjectsResponse(objects, keys.Count == take ? keys[^1] : null));
    }

    private static async Task<IResult> PostPurgeDeleted(
        Guid jobId, SitePurgeDeletedRequest request, HttpContext context, [FromServices] SiteWorkerServices services)
    {
        var scope = await services.JobAsync(jobId, context, SiteJobKinds.Purge).ConfigureAwait(false);
        if (scope.Refusal is not null)
        {
            return scope.Refusal;
        }

        if (!TryPurgeId(scope.Job!, out var purgeId))
        {
            return Problem(context, 409, RefusedCode, "The purge job is malformed.");
        }

        if (request?.Keys is not { Count: > 0 and <= PurgeLimit } keys
            || keys.Any(key => string.IsNullOrEmpty(key) || key.Length > 700 || !key.StartsWith("sites/", StringComparison.Ordinal)))
        {
            return Problem(context, 422, SiteErrors.InvalidCode, "Send 1 to 500 site object keys.");
        }

        var removed = await services.Sites.MarkPurgedAsync(purgeId, keys, context.RequestAborted).ConfigureAwait(false);
        return TypedResults.Ok(new SitePurgeDeletedResponse(removed));
    }

    private static async ValueTask QueuePurgeAsync(
        SiteWorkerServices services, NixSessionContext context, Site site, Guid purgeId, CancellationToken cancellationToken) =>
        _ = await services.Jobs.CreateAsync(
            context.TenantId,
            context.PrincipalId,
            site.WorkspaceId,
            SiteJobKinds.Purge,
            "site.purge:" + purgeId.ToString("D"),
            JsonSerializer.Serialize(new SitePurgeJobPayload(site.Id, purgeId), SitesJsonContext.Default.SitePurgeJobPayload),
            cancellationToken).ConfigureAwait(false);

    private static IReadOnlyList<SiteHostWrite> Writes(SiteWorkerServices services, SiteActivation activation)
    {
        var ops = JsonSerializer.Deserialize(activation.Ops, SitesJsonContext.Default.SiteActivationOpRecordArray) ?? [];
        return [.. ops.Where(op => op.Op == "put").Select(op =>
        {
            var capability = services.Signer.PutHostManifest(op.Key, op.ByteLength, op.Sha256!);
            return new SiteHostWrite(op.Hostname, op.Key, op.Body!, capability.Url, capability.ExpiresAt);
        })];
    }

    private static SiteActivationOp ToOp(SiteWorkerServices services, SiteActivationOpRecord op)
    {
        var capability = op.Op == "put"
            ? services.Signer.PutHostManifest(op.Key, op.ByteLength, op.Sha256!)
            : services.Signer.DeleteHostManifest(op.Key);
        return new SiteActivationOp(
            op.Op, op.Hostname, op.Key, op.Body, capability.Url, capability.ExpiresAt, op.Op == "put" ? null : services.Signer.ReadHostManifest(op.Key).Url);
    }

    /// <summary>
    /// Validates one upload entry and derives its key. A build file is a relative path under the
    /// build prefix with an extension whose media type is fixed; an asset is a raster image named
    /// by its own digest (or a captured diagram, an SVG the worker has re-sanitised), so two builds
    /// that include the same image write the same key.
    /// </summary>
    private static bool TryKey(Guid siteId, Guid buildId, SiteUploadEntry? entry, out string key)
    {
        key = string.Empty;
        if (entry is null
            || entry.Path is not { Length: > 0 and <= 400 }
            || entry.ByteLength is < 0 or > SiteRules.MaximumObjectBytes
            || !SiteRules.IsSha256(entry.Sha256)
            || entry.MediaType is null)
        {
            return false;
        }

        var dot = entry.Path.LastIndexOf('.');
        if (dot < 0 || dot == entry.Path.Length - 1)
        {
            return false;
        }

        var extension = entry.Path[(dot + 1)..];
        if (MediaTypeFor(extension) != entry.MediaType)
        {
            return false;
        }

        try
        {
            if (entry.Kind == SiteRules.AssetObject)
            {
                if (extension is not ("png" or "jpg" or "webp" or "svg" or "pdf" or "txt" or "csv" or "mp4" or "webm")
                    || entry.Path != entry.Sha256 + "." + extension
                    || entry.ByteLength > extension switch
                    {
                        "svg" => SiteRules.MaximumDiagramBytes,
                        "pdf" or "txt" or "csv" => SiteRules.MaximumDownloadBytes,
                        "mp4" or "webm" => SiteRules.MaximumVideoBytes,
                        _ => SiteRules.MaximumImageBytes,
                    })
                {
                    return false;
                }

                key = ObjectStorageKeys.SiteAsset(siteId, entry.Sha256, extension);
                return true;
            }

            if (entry.Kind != SiteRules.BuildObject)
            {
                return false;
            }

            key = ObjectStorageKeys.SiteBuild(siteId, buildId, entry.Path);
            return true;
        }
        catch (ArgumentException)
        {
            return false;
        }
    }

    /// <summary>The fixed media type of each extension a site may contain.</summary>
    internal static string? MediaTypeFor(string extension) => extension switch
    {
        "html" => "text/html",
        "css" => "text/css",
        "js" => "text/javascript",
        "json" => "application/json",
        "xml" => "application/xml",
        "txt" => "text/plain",
        "png" => "image/png",
        "jpg" => "image/jpeg",
        "webp" => "image/webp",
        "svg" => "image/svg+xml",
        "woff2" => "font/woff2",
        "pdf" => "application/pdf",
        "csv" => "text/csv",
        "mp4" => "video/mp4",
        "webm" => "video/webm",
        _ => null,
    };

    private static bool TryPurgeId(WorkerJobRecord job, out Guid purgeId)
    {
        purgeId = Guid.Empty;
        try
        {
            var payload = JsonSerializer.Deserialize(job.Payload, SitesJsonContext.Default.SitePurgeJobPayload);
            if (payload is null || payload.PurgeId == Guid.Empty)
            {
                return false;
            }

            purgeId = payload.PurgeId;
            return true;
        }
        catch (JsonException)
        {
            return false;
        }
    }

    private static SiteWorkerPage ToWorkerPage(SiteBuildPage row) => new(
        row.Ordinal,
        row.ItemId.Value,
        row.ParentItemId?.Value,
        row.Path,
        row.Title,
        row.Type,
        row.Seq.ToString(CultureInfo.InvariantCulture),
        row.ItemCreatedAt,
        row.ItemUpdatedAt,
        Element(row.Properties),
        row.Schema is null ? null : Element(row.Schema),
        row.Views is null ? null : Element(row.Views),
        row.Chart is null ? null : Element(row.Chart),
        row.DocId is { } docId && row.ContentSeq is { } seq ? new SiteContentPosition(docId, seq) : null,
        row.DatedCollectionId?.Value,
        row.PublishedAt,
        JsonSerializer.Deserialize(row.PropertyFiles, SitesJsonContext.Default.SitePropertyFileArray) ?? []);

    private static JsonElement Element(string json)
    {
        using var document = JsonDocument.Parse(json);
        return document.RootElement.Clone();
    }

    private static Microsoft.AspNetCore.Http.HttpResults.ProblemHttpResult Problem(HttpContext context, int status, string code, string detail) =>
        SiteWorkerServices.Problem(context, status, code, detail);
}
