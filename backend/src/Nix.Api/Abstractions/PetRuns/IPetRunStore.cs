using System.Text.Json;
using Nix.Domain.Identity;
using Nix.Domain.Items;
using Nix.Domain.Tenancy;

namespace Nix.Abstractions.PetRuns;

/// <summary>The immutable scope and current durable checkpoint of one pet run.</summary>
public sealed record PetRunRecord(
    Guid Id,
    ItemId ItemId,
    WorkspaceId WorkspaceId,
    TenantId TenantId,
    PrincipalId ActorId,
    string Brief,
    IReadOnlyList<Guid> SourceItemIds,
    bool WorkspaceScope,
    IReadOnlyList<string> Abilities,
    string Status,
    long Revision,
    JsonElement State,
    DateTimeOffset CreatedAt,
    DateTimeOffset UpdatedAt,
    IReadOnlyList<Guid>? ReadOnlySourceItemIds = null,
    bool? IncludeTargetText = null);

/// <summary>Persists actor-scoped runs and guarded checkpoint transitions within the current unit of work.</summary>
public interface IPetRunStore
{
    public Task<bool> CreateAsync(PetRunRecord run, CancellationToken cancellationToken);
    public Task<PetRunRecord?> GetAsync(Guid id, CancellationToken cancellationToken);
    public Task<IReadOnlyList<PetRunRecord>> ListAsync(WorkspaceId workspaceId, ItemId? itemId, CancellationToken cancellationToken);
    public Task<bool> UpdateAsync(PetRunRecord checkpoint, long expectedRevision, CancellationToken cancellationToken);
}
