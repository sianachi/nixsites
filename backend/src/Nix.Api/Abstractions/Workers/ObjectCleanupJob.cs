using System.Text.Json;
using System.Text.Json.Serialization;
using Nix.Domain.Identity;
using Nix.Domain.Tenancy;

namespace Nix.Abstractions.Workers;

public sealed record ObjectCleanupJobPayload(
    string OwnerKind,
    Guid OwnerId,
    DateTimeOffset NotBefore,
    IReadOnlyList<string> ObjectKeys);

public static class ObjectCleanupJobs
{
    public const string Kind = "object.cleanup";
    private const int MaximumKeysPerJob = 10_002;
    private const int MaximumKeysPerCleanup = 1_010_002;

    public static ValueTask<WorkerJobRecord> QueueAsync(
        IWorkerJobStore jobs,
        TenantId tenantId,
        PrincipalId actorId,
        WorkspaceId workspaceId,
        string ownerKind,
        Guid ownerId,
        DateTimeOffset notBefore,
        IEnumerable<string> objectKeys,
        CancellationToken cancellationToken)
    {
        ArgumentNullException.ThrowIfNull(jobs);
        ArgumentException.ThrowIfNullOrWhiteSpace(ownerKind);
        ArgumentNullException.ThrowIfNull(objectKeys);
        var keys = objectKeys.Distinct(StringComparer.Ordinal).Order(StringComparer.Ordinal).ToArray();
        if (keys.Length > MaximumKeysPerJob || keys.Any(key => string.IsNullOrWhiteSpace(key) || key.Length > 1024))
        {
            throw new ArgumentException("Object cleanup targets are invalid.", nameof(objectKeys));
        }
        return CreateAsync(jobs, tenantId, actorId, workspaceId, ownerKind, ownerId, notBefore, keys, string.Empty, cancellationToken);
    }

    /// <summary>Queues large cleanup sets as deterministic, bounded worker jobs.</summary>
    public static async ValueTask<IReadOnlyList<WorkerJobRecord>> QueueBatchedAsync(
        IWorkerJobStore jobs,
        TenantId tenantId,
        PrincipalId actorId,
        WorkspaceId workspaceId,
        string ownerKind,
        Guid ownerId,
        DateTimeOffset notBefore,
        IEnumerable<string> objectKeys,
        CancellationToken cancellationToken)
    {
        ArgumentNullException.ThrowIfNull(jobs);
        ArgumentException.ThrowIfNullOrWhiteSpace(ownerKind);
        ArgumentNullException.ThrowIfNull(objectKeys);
        var keys = objectKeys.Distinct(StringComparer.Ordinal).Order(StringComparer.Ordinal).ToArray();
        if (keys.Length > MaximumKeysPerCleanup
            || keys.Any(key => string.IsNullOrWhiteSpace(key) || key.Length > 1024))
        {
            throw new ArgumentException("Object cleanup targets are invalid.", nameof(objectKeys));
        }

        if (keys.Length <= MaximumKeysPerJob)
        {
            return [await QueueAsync(jobs, tenantId, actorId, workspaceId, ownerKind, ownerId,
                notBefore, keys, cancellationToken).ConfigureAwait(false)];
        }

        var records = new List<WorkerJobRecord>((keys.Length + MaximumKeysPerJob - 1) / MaximumKeysPerJob);
        for (var offset = 0; offset < keys.Length; offset += MaximumKeysPerJob)
        {
            var batch = keys.Skip(offset).Take(MaximumKeysPerJob).ToArray();
            var batchNumber = offset / MaximumKeysPerJob;
            var batchHash = Convert.ToHexStringLower(
                System.Security.Cryptography.SHA256.HashData(System.Text.Encoding.UTF8.GetBytes(string.Join('\n', batch))))[..16];
            records.Add(await CreateAsync(
                jobs, tenantId, actorId, workspaceId, ownerKind, ownerId, notBefore, batch,
                $":batch:{batchNumber:D4}:{batchHash}", cancellationToken).ConfigureAwait(false));
        }

        return records;
    }

    private static ValueTask<WorkerJobRecord> CreateAsync(
        IWorkerJobStore jobs,
        TenantId tenantId,
        PrincipalId actorId,
        WorkspaceId workspaceId,
        string ownerKind,
        Guid ownerId,
        DateTimeOffset notBefore,
        string[] keys,
        string batchSuffix,
        CancellationToken cancellationToken) =>
        jobs.CreateAsync(
            tenantId,
            actorId,
            workspaceId,
            Kind,
            $"object.cleanup:{ownerKind}:{ownerId:D}{batchSuffix}",
            JsonSerializer.Serialize(
                new ObjectCleanupJobPayload(ownerKind, ownerId, notBefore, keys),
                ObjectCleanupJsonContext.Default.ObjectCleanupJobPayload),
            cancellationToken);
}

[JsonSourceGenerationOptions(PropertyNamingPolicy = JsonKnownNamingPolicy.CamelCase)]
[JsonSerializable(typeof(ObjectCleanupJobPayload))]
public sealed partial class ObjectCleanupJsonContext : JsonSerializerContext;
