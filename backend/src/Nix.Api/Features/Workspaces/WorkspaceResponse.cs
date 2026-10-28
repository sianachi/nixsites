namespace Nix.Features.Workspaces;

/// <summary>
/// A workspace as the API presents it.
/// </summary>
/// <param name="Id">The workspace's identifier.</param>
/// <param name="Name">Its display name.</param>
/// <param name="VersionRetentionDays">How long non-pinned version history is kept.</param>
/// <param name="StorageQuotaBytes">The workspace's storage ceiling.</param>
/// <param name="CreatedAt">When it was created.</param>
/// <remarks>
/// No <c>tenantId</c>. The tenant is not a client concern: every request is already scoped to one
/// by the session, a client can never address another, and putting it in the payload would invite
/// the frontend to filter on it - which is the beginning of computing permissions on the client.
/// </remarks>
internal sealed record WorkspaceResponse(
    Guid Id,
    string Name,
    int VersionRetentionDays,
    long StorageQuotaBytes,
    DateTimeOffset CreatedAt,
    string Kind,
    bool CanRename,
    bool CanManageMembers,
    bool CanLeave,
    bool CanUseDailyNotes,
    Guid? PendingInvitationId,
    string LifecycleState,
    DateTimeOffset? ArchivedAt,
    bool MembershipLocked,
    bool Collaboration);

/// <summary>A request to create a shared workspace.</summary>
internal sealed record CreateWorkspaceRequest(string Name);

/// <summary>A request to rename a workspace.</summary>
internal sealed record RenameWorkspaceRequest(string Name);

/// <summary>A request to change who may join a workspace and how its files are edited. A null field is left as it is.</summary>
/// <param name="MembershipLocked">Whether the workspace is closed to new members.</param>
/// <param name="Collaboration">Whether several people may edit a file at once.</param>
internal sealed record SetWorkspaceSharingRequest(bool? MembershipLocked, bool? Collaboration);

/// <summary>The canonical dated note opened for a workspace day.</summary>
/// <param name="ItemId">The note's identifier.</param>
/// <param name="Created">True only for the request that inserted the note.</param>
internal sealed record DailyNoteResponse(Guid ItemId, bool Created);

/// <summary>A workspace's daily-note settings, as read and as replaced.</summary>
/// <param name="Enabled">Whether daily notes are available in the workspace.</param>
/// <param name="Folders">One of <c>flat</c>, <c>by-year</c>, <c>by-month</c>.</param>
/// <param name="TitleFormat">One of <c>iso</c>, <c>long</c>, <c>weekday-long</c>.</param>
/// <param name="Template">Markdown a client inserts into a new note, at most 4000 characters.</param>
/// <param name="RolloverHour">The hour, 0 to 6, a client treats as the start of a day.</param>
/// <param name="ShowOnCalendar">Whether a client shows daily notes on the calendar.</param>
internal sealed record DailyNoteSettingsResponse(
    bool Enabled,
    string Folders,
    string TitleFormat,
    string Template,
    int RolloverHour,
    bool ShowOnCalendar);

/// <summary>A request to replace a workspace's daily-note settings.</summary>
/// <param name="Enabled">Whether daily notes are available in the workspace.</param>
/// <param name="Folders">One of <c>flat</c>, <c>by-year</c>, <c>by-month</c>.</param>
/// <param name="TitleFormat">One of <c>iso</c>, <c>long</c>, <c>weekday-long</c>.</param>
/// <param name="Template">Markdown a client inserts into a new note, at most 4000 characters.</param>
/// <param name="RolloverHour">The hour, 0 to 6, a client treats as the start of a day.</param>
/// <param name="ShowOnCalendar">Whether a client shows daily notes on the calendar.</param>
internal sealed record SaveDailyNoteSettingsRequest(
    bool Enabled,
    string Folders,
    string TitleFormat,
    string? Template,
    int RolloverHour,
    bool ShowOnCalendar);
