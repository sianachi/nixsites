using Nix.Domain.Identity;
using Nix.Domain.Tenancy;

namespace Nix.Abstractions;

/// <summary>One finished pet turn: tokens and an estimated cost.</summary>
/// <param name="CostUsd">The estimate in USD, or <see langword="null"/> when the provider sent no price.</param>
public sealed record PetUsageRow(Guid PetId, Guid? WorkspaceId, string Provider, string Model, string Source,
    long InputTokens, long CacheReadTokens, long CacheWriteTokens, long OutputTokens, decimal? CostUsd,
    DateTimeOffset StartedAt, int DurationMs);

/// <summary>Totals for one key (a day, pet, model or source) or for a whole window.</summary>
public sealed record PetUsageGroup(string Key, int Turns, long InputTokens, long CacheReadTokens,
    long CacheWriteTokens, long OutputTokens, decimal CostUsd);

/// <summary>What a person's pets spent, read and written only as that person.</summary>
public interface IPetUsageStore
{
    /// <summary>Stores one row for the session's person.</summary>
    public Task RecordAsync(PetUsageRow row, CancellationToken cancellationToken);

    /// <summary>Totals over [<paramref name="from"/>, <paramref name="until"/>) by <paramref name="by"/>: day (in <paramref name="timeZone"/>), pet, model or source.</summary>
    public Task<IReadOnlyList<PetUsageGroup>> GroupAsync(TenantId tenantId, PrincipalId principalId, string by,
        DateTimeOffset from, DateTimeOffset until, string timeZone, CancellationToken cancellationToken);

    /// <summary>The estimated cost in USD over [<paramref name="from"/>, <paramref name="until"/>).</summary>
    public Task<decimal> SpentAsync(TenantId tenantId, PrincipalId principalId, DateTimeOffset from, DateTimeOffset until,
        CancellationToken cancellationToken);
}
