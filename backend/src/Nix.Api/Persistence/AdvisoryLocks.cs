using Microsoft.EntityFrameworkCore;
using Nix.Abstractions;
using Nix.Domain.Items;
using Nix.Domain.Tenancy;
using Nix.Persistence.Sql;

namespace Nix.Persistence;

/// <summary>
/// Every transaction-scoped Postgres advisory lock Core takes from C#, one named method each.
/// </summary>
/// <remarks>
/// A lock is only a lock if every process hashes the same text, and a rolling deploy runs old and
/// new Core (and the collaboration service) side by side, so the key texts in <see cref="AdvisoryLockKeys"/>
/// never change. Each method refuses to run outside an open transaction: a lock taken in autocommit
/// is released before the caller's next statement. Acquisition order is part of the contract:
/// topology before workspace files, file buckets by ascending workspace id, record keys sorted
/// ordinally. Locks inside SQL function bodies live in migrations, not here.
/// </remarks>
public sealed class AdvisoryLocks(NixDbContext database) : IStructuralLock, IHabitLock
{
    /// <summary>Serialises first-run setup; a raw bigint key, "Nix_Setu".</summary>
    public const long SetupKey = 0x4e69_785f_5365_7475;

    /// <inheritdoc />
    public ValueTask AcquireWorkspaceTopologyAsync(WorkspaceId workspaceId, CancellationToken cancellationToken) =>
        LockAsync(AdvisoryLockKeys.WorkspaceTopology(workspaceId.Value), cancellationToken);

    /// <inheritdoc />
    ValueTask IStructuralLock.AcquireAsync(ItemId itemId, CancellationToken cancellationToken) =>
        LockAsync(AdvisoryLockKeys.ItemState(itemId.Value), cancellationToken);

    /// <inheritdoc />
    ValueTask IHabitLock.AcquireAsync(ItemId itemId, CancellationToken cancellationToken) =>
        LockAsync(AdvisoryLockKeys.Habit(itemId.Value), cancellationToken);

    /// <summary>The item-state lock for callers that do not hold the interface.</summary>
    public ValueTask LockItemStateAsync(ItemId itemId, CancellationToken cancellationToken) =>
        LockAsync(AdvisoryLockKeys.ItemState(itemId.Value), cancellationToken);

    /// <summary>Serialises file publication, imports and transfers in one workspace.</summary>
    public ValueTask LockWorkspaceFilesAsync(WorkspaceId workspaceId, CancellationToken cancellationToken) =>
        LockAsync(AdvisoryLockKeys.WorkspaceFiles(workspaceId.Value), cancellationToken);

    /// <summary>Both file buckets of a workspace transfer, lower id first, so two opposite transfers cannot deadlock.</summary>
    public async ValueTask LockWorkspaceTransferAsync(
        WorkspaceId source, WorkspaceId destination, CancellationToken cancellationToken)
    {
        foreach (var workspace in new[] { source, destination }.OrderBy(value => value.Value))
        {
            await LockAsync(AdvisoryLockKeys.WorkspaceFiles(workspace.Value), cancellationToken).ConfigureAwait(false);
        }
    }

    public ValueTask LockRecordScopeAsync(Guid tenantId, Guid scopeId, bool exclusive, CancellationToken cancellationToken) =>
        LockAsync(AdvisoryLockKeys.RecordScope(tenantId, scopeId), cancellationToken, shared: !exclusive);

    /// <summary>One lock per distinct key, in ordinal order so two claimants never wait on each other in a cycle.</summary>
    public async ValueTask LockRecordKeysAsync(
        Guid tenantId, Guid scopeId, IEnumerable<(string Field, string Value)> keys, CancellationToken cancellationToken)
    {
        ArgumentNullException.ThrowIfNull(keys);
        var identities = keys
            .Select(key => AdvisoryLockKeys.RecordKey(tenantId, scopeId, key.Field, key.Value))
            .Distinct(StringComparer.Ordinal)
            .Order(StringComparer.Ordinal);
        foreach (var identity in identities)
        {
            await LockAsync(identity, cancellationToken).ConfigureAwait(false);
        }
    }

    public async ValueTask LockSetupAsync(CancellationToken cancellationToken)
    {
        RequireTransaction();
        await database.Database.ExecuteSqlRawAsync(
            "SELECT pg_advisory_xact_lock(@key);",
            [NixParameter.Int8("key", SetupKey)],
            cancellationToken).ConfigureAwait(false);
    }

    public ValueTask LockDailyNoteAsync(Guid rootId, CancellationToken cancellationToken) =>
        LockAsync(AdvisoryLockKeys.DailyNote(rootId), cancellationToken);

    public ValueTask LockItemCreationAsync(Guid tenantId, Guid principalId, Guid key, CancellationToken cancellationToken) =>
        LockAsync(AdvisoryLockKeys.ItemCreation(tenantId, principalId, key), cancellationToken);

    public ValueTask LockNativeReplayAsync(Guid tenantId, Guid principalId, Guid operationId, CancellationToken cancellationToken) =>
        LockAsync(AdvisoryLockKeys.NativeReplay(tenantId, principalId, operationId), cancellationToken);

    public ValueTask LockSiteTunnelConfigAsync(CancellationToken cancellationToken) =>
        LockAsync(AdvisoryLockKeys.SiteTunnelConfig, cancellationToken);

    public ValueTask LockSiteCreationAsync(Guid tenantId, CancellationToken cancellationToken) =>
        LockAsync(AdvisoryLockKeys.SiteCreation(tenantId), cancellationToken);

    public ValueTask LockAutomationQuotaAsync(Guid tenantId, Guid ownerId, Guid workspaceId, CancellationToken cancellationToken) =>
        LockAsync(AdvisoryLockKeys.AutomationQuota(tenantId, ownerId, workspaceId), cancellationToken);

    public ValueTask LockDocumentImportAsync(Guid tenantId, Guid importId, CancellationToken cancellationToken) =>
        LockAsync(AdvisoryLockKeys.DocumentImport(tenantId, importId), cancellationToken);

    public ValueTask LockDocumentImportKeyAsync(Guid tenantId, Guid principalId, string idempotencyKey, CancellationToken cancellationToken) =>
        LockAsync(AdvisoryLockKeys.DocumentImportKey(tenantId, principalId, idempotencyKey), cancellationToken);

    public ValueTask LockFileUploadAsync(Guid tenantId, Guid uploadId, CancellationToken cancellationToken) =>
        LockAsync(AdvisoryLockKeys.FileUpload(tenantId, uploadId), cancellationToken);

    public ValueTask LockFileUploadKeyAsync(Guid tenantId, Guid principalId, string idempotencyKey, CancellationToken cancellationToken) =>
        LockAsync(AdvisoryLockKeys.FileUploadKey(tenantId, principalId, idempotencyKey), cancellationToken);

    public ValueTask LockPushSubscriptionAsync(Guid tenantId, Guid principalId, CancellationToken cancellationToken) =>
        LockAsync(AdvisoryLockKeys.PushSubscription(tenantId, principalId), cancellationToken);

    public ValueTask LockWorkerJobKeyAsync(Guid tenantId, Guid actorId, string idempotencyKey, CancellationToken cancellationToken) =>
        LockAsync(AdvisoryLockKeys.WorkerJobKey(tenantId, actorId, idempotencyKey), cancellationToken);

    public ValueTask LockTemplateWorkspaceAsync(Guid tenantId, Guid workspaceId, CancellationToken cancellationToken) =>
        LockAsync(AdvisoryLockKeys.TemplateWorkspace(tenantId, workspaceId), cancellationToken);

    public ValueTask LockTemplateStagesAsync(Guid tenantId, CancellationToken cancellationToken) =>
        LockAsync(AdvisoryLockKeys.TemplateStages(tenantId), cancellationToken);

    public ValueTask LockTemplateAsync(Guid tenantId, Guid templateId, CancellationToken cancellationToken) =>
        LockAsync(AdvisoryLockKeys.Template(tenantId, templateId), cancellationToken);

    public ValueTask LockTemplateApplicationAsync(Guid tenantId, Guid templateId, Guid targetItemId, CancellationToken cancellationToken) =>
        LockAsync(AdvisoryLockKeys.TemplateApplication(tenantId, templateId, targetItemId), cancellationToken);

    public ValueTask LockTemplateIdempotencyAsync(Guid tenantId, Guid principalId, string idempotencyKey, CancellationToken cancellationToken) =>
        LockAsync(AdvisoryLockKeys.TemplateIdempotency(tenantId, principalId, idempotencyKey), cancellationToken);

    private void RequireTransaction()
    {
        if (database.Database.CurrentTransaction is null)
        {
            throw new InvalidOperationException("Advisory locks require an active Core transaction.");
        }
    }

    private async ValueTask LockAsync(string identity, CancellationToken cancellationToken, bool shared = false)
    {
        RequireTransaction();
        await database.Database.ExecuteSqlRawAsync(
            shared
                ? "SELECT pg_advisory_xact_lock_shared(hashtextextended(@identity, 0));"
                : "SELECT pg_advisory_xact_lock(hashtextextended(@identity, 0));",
            [NixParameter.Text("identity", identity)],
            cancellationToken).ConfigureAwait(false);
    }
}

/// <summary>The key texts, pinned by a unit test. <c>finance-*</c> keeps the name of the feature that first used it.</summary>
public static class AdvisoryLockKeys
{
    /// <summary>Shared with apps/collab (updates.ts, documents/sync.ts), which locks the same text in shared mode.</summary>
    public static string WorkspaceTopology(Guid workspaceId) => $"finance-workspace:{workspaceId:D}";

    public static string ItemState(Guid itemId) => $"finance:{itemId:D}";

    public static string Habit(Guid itemId) => $"habit:{itemId:D}";

    /// <summary>Bare workspace id: file publication, imports, template file copies and workspace transfers share it.</summary>
    public static string WorkspaceFiles(Guid workspaceId) => workspaceId.ToString();

    public static string RecordScope(Guid tenantId, Guid scopeId) => $"record-scope:{tenantId:D}:{scopeId:D}";

    public static string RecordKey(Guid tenantId, Guid scopeId, string field, string value) =>
        $"record-key:{tenantId:D}:{scopeId:D}:{field}:{value}";

    /// <summary>Bare item id of the daily-note root.</summary>
    public static string DailyNote(Guid rootId) => rootId.ToString();

    public static string ItemCreation(Guid tenantId, Guid principalId, Guid key) =>
        $"item-create:{tenantId:D}:{principalId:D}:{key:D}";

    public static string NativeReplay(Guid tenantId, Guid principalId, Guid operationId) =>
        $"native-replay:{tenantId:D}:{principalId:D}:{operationId:D}";

    public const string SiteTunnelConfig = "site.tunnel_config";

    public static string SiteCreation(Guid tenantId) => $"site.create:{tenantId:D}";

    public static string AutomationQuota(Guid tenantId, Guid ownerId, Guid workspaceId) =>
        $"nix.automation_rule.quota:{tenantId:D}:{ownerId:D}:{workspaceId:D}";

    public static string DocumentImport(Guid tenantId, Guid importId) => $"document-import:{tenantId:N}:{importId:N}";

    public static string DocumentImportKey(Guid tenantId, Guid principalId, string idempotencyKey) =>
        $"document-import-key:{tenantId:N}:{principalId:N}:{idempotencyKey}";

    public static string FileUpload(Guid tenantId, Guid uploadId) => $"file-upload:{tenantId:N}:{uploadId:N}";

    public static string FileUploadKey(Guid tenantId, Guid principalId, string idempotencyKey) =>
        $"file-upload-key:{tenantId:N}:{principalId:N}:{idempotencyKey}";

    public static string PushSubscription(Guid tenantId, Guid principalId) => $"push_subscription:{tenantId:D}:{principalId:D}";

    public static string WorkerJobKey(Guid tenantId, Guid actorId, string idempotencyKey) =>
        $"worker-job-key:{tenantId:N}:{actorId:N}:{idempotencyKey}";

    public static string TemplateWorkspace(Guid tenantId, Guid workspaceId) => $"template-workspace:{tenantId:N}:{workspaceId:N}";

    public static string TemplateStages(Guid tenantId) => $"template-stages:{tenantId:N}";

    public static string Template(Guid tenantId, Guid templateId) => $"template:{tenantId:N}:{templateId:N}";

    public static string TemplateApplication(Guid tenantId, Guid templateId, Guid targetItemId) =>
        $"template-application:{tenantId:N}:{templateId:N}:{targetItemId:N}";

    public static string TemplateIdempotency(Guid tenantId, Guid principalId, string idempotencyKey) =>
        $"template-idempotency:{tenantId:N}:{principalId:N}:{idempotencyKey}";
}
