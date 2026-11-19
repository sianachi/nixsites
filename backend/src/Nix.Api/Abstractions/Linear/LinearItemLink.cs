using Nix.Domain.Items;
using Nix.Domain.Tenancy;

namespace Nix.Abstractions.Linear;

/// <summary>An owner's exact linked issue and the last status observed in Linear.</summary>
public sealed record LinearItemLink(
    ItemId ItemId, WorkspaceId WorkspaceId, Guid ConnectionId, Guid ConnectionRevision, Guid Revision,
    Guid IssueId, string Identifier, Uri Url, Guid StatusId, string Status, DateTimeOffset RemoteUpdatedAt,
    DateTimeOffset CheckedAt, Guid BaselineStatusId, string? BaselineLocalStatus)
{
    /// <summary>Compares changes on each side against the same reviewed baseline.</summary>
    public LinearStatusChange Compare(string? localStatus) =>
        (StatusId != BaselineStatusId, !string.Equals(localStatus, BaselineLocalStatus, StringComparison.Ordinal)) switch
        {
            (true, true) => LinearStatusChange.Conflict,
            (true, false) => LinearStatusChange.Remote,
            (false, true) => LinearStatusChange.Local,
            _ => LinearStatusChange.None,
        };
}

/// <summary>The side or sides on which status changed since linking or adopting a baseline.</summary>
public enum LinearStatusChange
{
    /// <summary>Both sides still match the baseline.</summary>
    None,
    /// <summary>Only Linear changed.</summary>
    Remote,
    /// <summary>Only Nix changed.</summary>
    Local,
    /// <summary>Both sides changed.</summary>
    Conflict,
}
