using System.Text.Json;
using System.Text.Json.Serialization;
using Microsoft.EntityFrameworkCore;
using Nix.Abstractions.Workers;
using Nix.Domain.Identity;
using Nix.Domain.Tenancy;
using Nix.Domain.Workers;

namespace Nix.Persistence.Workers;

public sealed class WorkerStore(NixDbContext database, Nix.Workers.Queue.IJobQueue? queue = null) : IWorkerJobStore
{
    public async ValueTask<WorkerJobRecord> CreateAsync(
        TenantId tenantId,
        PrincipalId actorId,
        WorkspaceId? workspaceId,
        string kind,
        string idempotencyKey,
        string payload,
        CancellationToken cancellationToken)
    {
        ArgumentNullException.ThrowIfNull(kind);
        ArgumentNullException.ThrowIfNull(idempotencyKey);
        ArgumentNullException.ThrowIfNull(payload);
        await database.Database.ExecuteSqlInterpolatedAsync(
            $"SELECT pg_advisory_xact_lock(hashtextextended({$"worker-job-key:{tenantId.Value:N}:{actorId.Value:N}:{idempotencyKey}"}, 0))",
            cancellationToken).ConfigureAwait(false);
        var existing = await database.WorkerJobs.AsNoTracking()
            .SingleOrDefaultAsync(job => job.TenantId == tenantId && job.ActorId == actorId && job.IdempotencyKey == idempotencyKey, cancellationToken)
            .ConfigureAwait(false);
        if (existing is not null)
        {
            if (existing.WorkspaceId != workspaceId
                || !string.Equals(existing.Kind, kind, StringComparison.Ordinal)
                || !PayloadEquivalent(kind, existing.Payload, payload))
            {
                throw new WorkerJobIdempotencyConflictException();
            }
            return ToRecord(existing);
        }
        var now = DateTimeOffset.UtcNow;
        var job = new WorkerJob
        {
            Id = WorkerJobId.Create(),
            TenantId = tenantId,
            WorkspaceId = workspaceId,
            ActorId = actorId,
            Kind = kind,
            IdempotencyKey = idempotencyKey,
            Payload = payload,
            Status = "queued",
            CreatedAt = now,
            UpdatedAt = now,
        };
        database.WorkerJobs.Add(job);
        // The host of this kind is woken by a hint once the row is visible; site.* kinds are
        // polled by the sites worker, so their hint is a no-op.
        queue?.Hint(kind);
        await database.SaveChangesAsync(cancellationToken).ConfigureAwait(false);
        return ToRecord(job);
    }

    public async ValueTask<WorkerJobRecord?> GetAsync(TenantId tenantId, PrincipalId actorId, Guid jobId, CancellationToken cancellationToken)
    {
        var job = await database.WorkerJobs.AsNoTracking()
            .SingleOrDefaultAsync(item => item.TenantId == tenantId && item.ActorId == actorId && item.Id == WorkerJobId.From(jobId), cancellationToken)
            .ConfigureAwait(false);
        return job is null ? null : ToRecord(job);
    }

    public async ValueTask<bool> CancelAsync(TenantId tenantId, PrincipalId actorId, Guid jobId, CancellationToken cancellationToken)
    {
        var matching = database.WorkerJobs.Where(candidate =>
                candidate.TenantId == tenantId
                && candidate.ActorId == actorId
                && candidate.Id == WorkerJobId.From(jobId));
        var now = DateTimeOffset.UtcNow;
        var changed = await matching
            .Where(candidate => candidate.Status == "queued" || candidate.Status == "running")
            .ExecuteUpdateAsync(setters => setters
                .SetProperty(candidate => candidate.Status, "cancelled")
                .SetProperty(candidate => candidate.CancellationRequested, true)
                .SetProperty(candidate => candidate.Result, (string?)null)
                .SetProperty(candidate => candidate.ErrorCode, "job_cancelled")
                .SetProperty(candidate => candidate.ErrorDetail, "The job was cancelled.")
                .SetProperty(candidate => candidate.LeaseOwner, (string?)null)
                .SetProperty(candidate => candidate.LeaseUntil, (DateTimeOffset?)null)
                .SetProperty(candidate => candidate.CompletedAt, now)
                .SetProperty(candidate => candidate.UpdatedAt, now), cancellationToken)
            .ConfigureAwait(false);
        return changed != 0
            || await matching.AsNoTracking().AnyAsync(cancellationToken).ConfigureAwait(false);
    }

    public async ValueTask<IReadOnlyList<WorkerJobRecord>> LeaseAsync(TenantId tenantId, string owner, string? kind, int limit, int leaseSeconds, CancellationToken cancellationToken)
    {
        var now = DateTimeOffset.UtcNow;
        var leaseUntil = now.AddSeconds(leaseSeconds);
        await database.WorkerJobs
            .Where(job => job.TenantId == tenantId
                && job.Status == "running"
                && !job.CancellationRequested
                && job.Attempts >= 5
                && (job.LeaseUntil == null || job.LeaseUntil <= now))
            .ExecuteUpdateAsync(setters => setters
                .SetProperty(job => job.Status, "failed")
                .SetProperty(job => job.Result, (string?)null)
                .SetProperty(job => job.ErrorCode, "worker_attempts_exhausted")
                .SetProperty(job => job.ErrorDetail, "The worker exhausted its five execution attempts without reporting a terminal result.")
                .SetProperty(job => job.LeaseOwner, (string?)null)
                .SetProperty(job => job.LeaseUntil, (DateTimeOffset?)null)
                .SetProperty(job => job.CompletedAt, now)
                .SetProperty(job => job.UpdatedAt, now), cancellationToken)
            .ConfigureAwait(false);
        var query = database.WorkerJobs.Where(job => job.TenantId == tenantId
            && job.Attempts < 5
            && (job.Status == "queued" || (job.Status == "running" && job.LeaseUntil < now))
            && !job.CancellationRequested);
        if (!string.IsNullOrWhiteSpace(kind))
        {
            query = query.Where(job => job.Kind == kind);
        }
        var jobs = await query.OrderBy(job => job.CreatedAt).Take(limit).ToListAsync(cancellationToken).ConfigureAwait(false);
        foreach (var job in jobs)
        {
            job.Status = "running";
            job.Attempts++;
            job.LeaseOwner = owner;
            job.LeaseUntil = leaseUntil;
            job.StartedAt ??= now;
            job.UpdatedAt = now;
        }
        await database.SaveChangesAsync(cancellationToken).ConfigureAwait(false);
        return jobs.Select(ToRecord).ToArray();
    }

    public async ValueTask<bool> CompleteAsync(TenantId tenantId, Guid jobId, bool succeeded, string? result, string? errorCode, string? errorDetail, CancellationToken cancellationToken)
    {
        var now = DateTimeOffset.UtcNow;
        var matching = database.WorkerJobs.Where(job => job.TenantId == tenantId
            && job.Id == WorkerJobId.From(jobId));
        var changed = await matching
            .Where(job => job.Status == "running" && !job.CancellationRequested)
            .ExecuteUpdateAsync(setters => setters
                .SetProperty(job => job.Status, succeeded ? "completed" : "failed")
                .SetProperty(job => job.Result, succeeded ? result : null)
                .SetProperty(job => job.ErrorCode, succeeded ? null : errorCode)
                .SetProperty(job => job.ErrorDetail, succeeded ? null : errorDetail)
                .SetProperty(job => job.LeaseOwner, (string?)null)
                .SetProperty(job => job.LeaseUntil, (DateTimeOffset?)null)
                .SetProperty(job => job.CompletedAt, now)
                .SetProperty(job => job.UpdatedAt, now), cancellationToken)
            .ConfigureAwait(false);
        return changed != 0
            || await matching.AsNoTracking()
                .AnyAsync(job => !job.CancellationRequested
                    && (job.Status == "completed" || job.Status == "failed"), cancellationToken)
                .ConfigureAwait(false);
    }

    private static WorkerJobRecord ToRecord(WorkerJob job) => new(job.Id.Value, job.Kind, job.Status, job.Payload, job.Result, job.ErrorCode, job.ErrorDetail, job.Attempts, job.CancellationRequested, job.CreatedAt, job.CompletedAt, job.WorkspaceId);

    private static bool PayloadEquivalent(string kind, string left, string right)
    {
        try
        {
            if (kind == ObjectCleanupJobs.Kind)
            {
                var existing = JsonSerializer.Deserialize(
                    left,
                    ObjectCleanupJsonContext.Default.ObjectCleanupJobPayload);
                var requested = JsonSerializer.Deserialize(
                    right,
                    ObjectCleanupJsonContext.Default.ObjectCleanupJobPayload);
                return existing is not null
                    && requested is not null
                    && existing.OwnerKind == requested.OwnerKind
                    && existing.OwnerId == requested.OwnerId
                    && existing.ObjectKeys.SequenceEqual(requested.ObjectKeys, StringComparer.Ordinal);
            }
            if (kind.StartsWith("export.", StringComparison.Ordinal))
            {
                using var existing = JsonDocument.Parse(left, new JsonDocumentOptions { MaxDepth = 16 });
                using var requested = JsonDocument.Parse(right, new JsonDocumentOptions { MaxDepth = 16 });
                return TryReadExportIdentity(existing.RootElement, out var existingIdentity)
                    && TryReadExportIdentity(requested.RootElement, out var requestedIdentity)
                    && existingIdentity == requestedIdentity;
            }
            using var leftDocument = JsonDocument.Parse(left, new JsonDocumentOptions { MaxDepth = 16 });
            using var rightDocument = JsonDocument.Parse(right, new JsonDocumentOptions { MaxDepth = 16 });
            return JsonElement.DeepEquals(leftDocument.RootElement, rightDocument.RootElement);
        }
        catch (JsonException)
        {
            return string.Equals(left, right, StringComparison.Ordinal);
        }
    }

    private static bool TryReadExportIdentity(
        JsonElement payload,
        out (Guid ItemId, Guid WorkspaceId, string Format, string Scope, bool IncludeComments, string PageSize) identity)
    {
        identity = default;
        if (payload.ValueKind != JsonValueKind.Object
            || !payload.TryGetProperty("itemId", out var item)
            || !item.TryGetGuid(out var itemId)
            || itemId == Guid.Empty
            || !payload.TryGetProperty("workspaceId", out var workspace)
            || !workspace.TryGetGuid(out var workspaceId)
            || workspaceId == Guid.Empty
            || !payload.TryGetProperty("format", out var format)
            || format.ValueKind != JsonValueKind.String
            || !payload.TryGetProperty("scope", out var scope)
            || scope.ValueKind != JsonValueKind.String)
        {
            return false;
        }

        // Absent means false (older payloads), so a retry that flips the flag is a different request.
        var includeComments = payload.TryGetProperty("includeComments", out var comments) && comments.ValueKind == JsonValueKind.True;
        var pageSize = payload.TryGetProperty("pageSize", out var size) && size.ValueKind == JsonValueKind.String ? size.GetString()! : "a4";
        identity = (itemId, workspaceId, format.GetString()!, scope.GetString()!, includeComments, pageSize);
        return true;
    }
}
