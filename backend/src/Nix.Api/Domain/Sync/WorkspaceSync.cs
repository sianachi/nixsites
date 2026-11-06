using System.Text.Json.Nodes;

namespace Nix.Domain.Sync;

/// <summary>Current authorized metadata. A password lock always excludes persistent body and file data.</summary>
public sealed record NativeItemSnapshot(
    Guid Id,
    Guid WorkspaceId,
    string Revision,
    Guid? ParentId,
    string Type,
    string Title,
    long Seq,
    string LifecycleState,
    JsonObject Properties,
    JsonObject? Schema,
    JsonObject? Views,
    JsonObject? Recurrence,
    bool NoDelete,
    bool NoChildren,
    string? ManagedBy,
    DateTimeOffset CreatedAt,
    DateTimeOffset? UpdatedAt,
    bool CanWrite,
    bool Locked,
    bool CanPersistBody,
    DateTimeOffset? MetadataExpiresAt,
    Guid? BodyDocId,
    string? BodyHeadSeq,
    NativeFileSnapshot? File);

/// <summary>The shown version's metadata (latest approved, else current), without an object key or capability.</summary>
public sealed record NativeFileSnapshot(Guid VersionId, string FileName, string MediaType, long ByteLength, string Sha256, string State = "draft");

/// <summary>A paged enumeration with a feed boundary captured before the first page.</summary>
public sealed record WorkspaceSyncSnapshot(
    string Boundary, Guid? NextCursor, bool Complete, IReadOnlyList<NativeItemSnapshot> Items, DateTimeOffset ServerTime, bool Resync = false);

/// <summary>A committed change page. Resync requires a complete new enumeration.</summary>
public sealed record WorkspaceSyncChanges(
    string Cursor, bool HasMore, bool Resync, IReadOnlyList<NativeItemSnapshot> Items, DateTimeOffset ServerTime);

/// <summary>A generic removal of an identifier supplied by the device, revealing no existence or refusal cause.</summary>
public sealed record NativeRemovedItem(Guid ItemId, string Reason);

/// <summary>Current authorized copies and generic removals for only the requested identifiers.</summary>
public sealed record WorkspaceSyncReconciliation(
    IReadOnlyList<NativeItemSnapshot> Items, IReadOnlyList<NativeRemovedItem> Removed, DateTimeOffset ServerTime);
