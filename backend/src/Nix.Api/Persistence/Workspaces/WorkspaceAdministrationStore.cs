using Nix.Abstractions;
using Nix.Domain.Identity;
using Nix.Domain.Provisioning;
using Nix.Domain.Tenancy;
using Nix.Persistence.ObjectStorage;
using Nix.Persistence.Sql;
using Nix.Persistence.Sql.Statements;
using Npgsql;
using NpgsqlTypes;

namespace Nix.Persistence.Workspaces;

/// <summary>One permission-filtered workspace row with server-decided capabilities.</summary>
public sealed record WorkspaceSnapshot(
    WorkspaceId Id,
    string Name,
    int VersionRetentionDays,
    long StorageQuotaBytes,
    DateTimeOffset CreatedAt,
    PrincipalId? PersonalOwnerPrincipalId,
    bool CanRename,
    bool CanManageMembers,
    bool CanLeave,
    bool CanUseDailyNotes,
    Guid? PendingInvitationId,
    string LifecycleState,
    DateTimeOffset? ArchivedAt,
    bool MembershipLocked,
    bool Collaboration);

/// <summary>One active human with server-decided workspace invitation eligibility.</summary>
public sealed record WorkspaceInviteeSnapshot(
    PrincipalId PrincipalId,
    string DisplayName,
    string? Email,
    bool CanInvite,
    string? CannotInviteReason);

/// <summary>One principal or group workspace grant with server-decided mutation capabilities.</summary>
public sealed record WorkspaceMemberSnapshot(
    string SubjectType,
    Guid SubjectId,
    string DisplayName,
    string? Email,
    string Role,
    DateTimeOffset GrantedAt,
    bool CanChangeRole,
    bool CanRemove,
    IReadOnlyList<string> AssignableRoles);

/// <summary>One durable invitation-history row.</summary>
public sealed record WorkspaceInvitationSnapshot(
    Guid InvitationId,
    string EmailNormalized,
    PrincipalId? TargetPrincipalId,
    string Role,
    string Status,
    PrincipalId InvitedByPrincipalId,
    DateTimeOffset InvitedAt,
    DateTimeOffset? AcceptedAt,
    PrincipalId? AcceptedByPrincipalId,
    DateTimeOffset? RevokedAt);

/// <summary>Outcome of one locked invitation state transition.</summary>
public sealed record WorkspaceInvitationMutationResult(
    string Outcome,
    WorkspaceInvitationSnapshot? Invitation);

/// <summary>What opening a dated daily note did.</summary>
/// <param name="Outcome">Whether the note was opened, and if not why.</param>
/// <param name="ItemId">The note's identifier when it was opened.</param>
/// <param name="Created">True only when this call inserted the note.</param>
public sealed record DailyNoteOpening(DailyNoteOutcome Outcome, Guid ItemId = default, bool Created = false)
{
    /// <summary>The caller cannot write the workspace, or it does not exist.</summary>
    public static DailyNoteOpening NotAuthorized { get; } = new(DailyNoteOutcome.NotAuthorized);

    /// <summary>Daily notes are switched off for the workspace.</summary>
    public static DailyNoteOpening Disabled { get; } = new(DailyNoteOutcome.Disabled);

    /// <summary>The Daily notes root, or a folder that should hold the note, is trashed.</summary>
    public static DailyNoteOpening RootUnavailable { get; } = new(DailyNoteOutcome.RootUnavailable);

    /// <summary>The day's note, or a folder above it, is in Trash.</summary>
    public static DailyNoteOpening InTrash { get; } = new(DailyNoteOutcome.InTrash);

    /// <summary>The day's note sits under a lock the caller has not opened.</summary>
    public static DailyNoteOpening Locked { get; } = new(DailyNoteOutcome.Locked);

    /// <summary>The day's note could not be opened or created for any other reason.</summary>
    public static DailyNoteOpening Unavailable { get; } = new(DailyNoteOutcome.Unavailable);
}

/// <summary>The result classes of opening a daily note.</summary>
public enum DailyNoteOutcome
{
    /// <summary>The note exists, created now or earlier.</summary>
    Opened,

    /// <summary>The caller cannot write the workspace, or it does not exist.</summary>
    NotAuthorized,

    /// <summary>Daily notes are switched off for the workspace.</summary>
    Disabled,

    /// <summary>The Daily notes root, or a folder that should hold the note, is trashed.</summary>
    RootUnavailable,

    /// <summary>The day's note, or a folder above it, is in Trash.</summary>
    InTrash,

    /// <summary>The day's note sits under a lock the caller has not opened.</summary>
    Locked,

    /// <summary>
    /// The day's note could not be opened or created for any other reason, such as every
    /// generation of its identifier being retired.
    /// </summary>
    Unavailable,
}

/// <summary>Database operations for workspace administration.</summary>
public sealed partial class WorkspaceAdministrationStore(
    NixSqlExecutor sql,
    INixSessionContextAccessor session,
    CredentialSessionContext credential)
{
    private static readonly string[] PresetKeys = ["seed.kanban", "seed.calendar", "seed.list"];

    private readonly NixSqlExecutor _sql = sql;
    private readonly INixSessionContextAccessor _session = session;
    private readonly CredentialSessionContext _credential = credential;

    private NixSessionContext Session => _session.Current
        ?? throw new InvalidOperationException("No session context was established for workspace administration.");

    /// <summary>Lists reachable workspaces without materializing unreachable tenant rows.</summary>
    public async ValueTask<IReadOnlyList<WorkspaceSnapshot>> ListAsync(
        DateTimeOffset? afterCreatedAt,
        WorkspaceId? afterId,
        int limit,
        CancellationToken cancellationToken)
    {
        var context = Session;
        var rows = new List<WorkspaceSnapshot>(limit);
        var query = _sql.QueryAsync<WorkspaceSnapshot, WorkspaceMapper>(
            WorkspaceAdministrationSql.List,
            default,
            [
                Uuid("tenant_id", context.TenantId.Value),
                Uuid("principal_id", context.PrincipalId.Value),
                TimestampOrNull("after_created_at", afterCreatedAt),
                UuidOrNull("after_id", afterId?.Value),
                Integer("limit", limit),
            ],
            cancellationToken);

        await foreach (var row in query.ConfigureAwait(false))
        {
            rows.Add(row);
        }

        return rows;
    }

    /// <summary>Gets one reachable workspace, returning null for absent and inaccessible alike.</summary>
    public async ValueTask<WorkspaceSnapshot?> FindAsync(
        WorkspaceId workspaceId,
        CancellationToken cancellationToken)
    {
        var context = Session;
        var query = _sql.QueryAsync<WorkspaceSnapshot, WorkspaceMapper>(
            WorkspaceAdministrationSql.Detail,
            default,
            [
                Uuid("tenant_id", context.TenantId.Value),
                Uuid("principal_id", context.PrincipalId.Value),
                Uuid("workspace_id", workspaceId.Value),
            ],
            cancellationToken);

        await foreach (var row in query.ConfigureAwait(false))
        {
            return row;
        }

        return null;
    }

    /// <summary>Creates a shared workspace and direct owner membership for an active human.</summary>
    public async ValueTask<bool> CreateAsync(
        WorkspaceId workspaceId,
        string name,
        DateTimeOffset now,
        CancellationToken cancellationToken)
    {
        var context = Session;
        return await _sql.ScalarOrDefaultAsync<bool>(
            WorkspaceAdministrationSql.Create,
            [
                Uuid("tenant_id", context.TenantId.Value),
                Uuid("principal_id", context.PrincipalId.Value),
                Uuid("workspace_id", workspaceId.Value),
                Text("name", name),
                Timestamp("now", now),
            ],
            cancellationToken).ConfigureAwait(false);
    }

    /// <summary>Creates the shipped template catalog and hidden roots for one new workspace.</summary>
    public async ValueTask SeedPresetsAsync(
        WorkspaceId workspaceId,
        DateTimeOffset now,
        CancellationToken cancellationToken)
    {
        var context = Session;
        var parameters = new List<NpgsqlParameter>
        {
            Uuid("tenant_id", context.TenantId.Value),
            Uuid("principal_id", context.PrincipalId.Value),
            Uuid("workspace_id", workspaceId.Value),
            Timestamp("now", now),
        };

        foreach (var key in PresetKeys)
        {
            var prefix = key[5..];
            parameters.Add(Uuid(
                $"{prefix}_template_id",
                DeterministicProvisioningId.PresetObject(workspaceId, key, "template")));
            parameters.Add(Uuid(
                $"{prefix}_root_id",
                DeterministicProvisioningId.PresetObject(workspaceId, key, "root")));
            parameters.Add(Uuid(
                $"{prefix}_source_id",
                DeterministicProvisioningId.PresetObject(workspaceId, key, "source-root")));
        }

        await _sql.ExecuteAsync(ProvisioningSql.SeedPresets, [.. parameters], cancellationToken)
            .ConfigureAwait(false);
    }

    /// <summary>Renames a reachable workspace when the caller can administer it.</summary>
    public async ValueTask<bool> SetSharingAsync(
        WorkspaceId workspaceId,
        bool? membershipLocked,
        bool? collaboration,
        CancellationToken cancellationToken)
    {
        var context = Session;
        var result = await _sql.ScalarOrDefaultAsync<Guid>(
            WorkspaceAdministrationSql.SetSharing,
            [
                Uuid("tenant_id", context.TenantId.Value),
                Uuid("principal_id", context.PrincipalId.Value),
                Uuid("workspace_id", workspaceId.Value),
                new NpgsqlParameter("membership_locked", NpgsqlDbType.Boolean) { Value = membershipLocked is { } locked ? locked : DBNull.Value },
                new NpgsqlParameter("collaboration", NpgsqlDbType.Boolean) { Value = collaboration is { } on ? on : DBNull.Value },
            ],
            cancellationToken).ConfigureAwait(false);
        return result != Guid.Empty;
    }

    public async ValueTask<bool> RenameAsync(
        WorkspaceId workspaceId,
        string name,
        CancellationToken cancellationToken)
    {
        var context = Session;
        var result = await _sql.ScalarOrDefaultAsync<Guid>(
            WorkspaceAdministrationSql.Rename,
            [
                Uuid("tenant_id", context.TenantId.Value),
                Uuid("principal_id", context.PrincipalId.Value),
                Uuid("workspace_id", workspaceId.Value),
                Text("name", name),
            ],
            cancellationToken).ConfigureAwait(false);
        return result != Guid.Empty;
    }

    /// <summary>Archives an owner- or tenant-admin-managed workspace without changing its grants.</summary>
    public async ValueTask<bool> ArchiveAsync(
        WorkspaceId workspaceId,
        DateTimeOffset now,
        CancellationToken cancellationToken)
    {
        var context = Session;
        var id = await _sql.ScalarOrDefaultAsync<Guid>(WorkspaceAdministrationSql.Archive,
            [Uuid("tenant_id", context.TenantId.Value), Uuid("principal_id", context.PrincipalId.Value),
             Uuid("workspace_id", workspaceId.Value), Timestamp("now", now)], cancellationToken)
            .ConfigureAwait(false);
        return id != Guid.Empty;
    }

    /// <summary>Restores an archived workspace to ordinary use.</summary>
    public async ValueTask<bool> RestoreAsync(
        WorkspaceId workspaceId,
        CancellationToken cancellationToken)
    {
        var context = Session;
        var id = await _sql.ScalarOrDefaultAsync<Guid>(WorkspaceAdministrationSql.Restore,
            [Uuid("tenant_id", context.TenantId.Value), Uuid("principal_id", context.PrincipalId.Value),
             Uuid("workspace_id", workspaceId.Value)], cancellationToken).ConfigureAwait(false);
        return id != Guid.Empty;
    }

    /// <summary>Starts the irreversible purge only after an authorized archive.</summary>
    public async ValueTask<bool> BeginPurgeAsync(
        WorkspaceId workspaceId,
        CancellationToken cancellationToken)
    {
        var context = Session;
        var id = await _sql.ScalarOrDefaultAsync<Guid>(WorkspaceAdministrationSql.BeginPurge,
            [Uuid("tenant_id", context.TenantId.Value), Uuid("principal_id", context.PrincipalId.Value),
             Uuid("workspace_id", workspaceId.Value)], cancellationToken).ConfigureAwait(false);
        return id != Guid.Empty;
    }

    /// <summary>Lists private workspace-owned objects after its purge has been authorized.</summary>
    public async ValueTask<IReadOnlyList<string>> ListPurgeObjectKeysAsync(
        WorkspaceId workspaceId,
        CancellationToken cancellationToken)
    {
        var context = Session;
        var keys = new List<string>();
        var query = _sql.QueryAsync<string, ObjectKeyMapper>(WorkspaceAdministrationSql.PurgeObjectKeys,
            default,
            [Uuid("tenant_id", context.TenantId.Value), Uuid("principal_id", context.PrincipalId.Value),
             Uuid("workspace_id", workspaceId.Value)], cancellationToken);
        await foreach (var key in query.ConfigureAwait(false))
        {
            keys.Add(key);

            // A version's thumbnail goes with it. The derived key is added for every version rather
            // than only those that have one: deleting an absent object is not an error, and the
            // listing then needs no second statement or copy of the derivation.
            if (ObjectStorageKeys.TryFileThumbnail(key, out var thumbnailKey))
            {
                keys.Add(thumbnailKey);
            }
        }
        return keys;
    }

    /// <summary>Removes the workspace row after its lease-bound object cleanup has completed.</summary>
    public async ValueTask<bool> FinalizePurgeAsync(
        WorkspaceId workspaceId,
        Guid jobId,
        CancellationToken cancellationToken)
    {
        var context = Session;
        await _sql.ExecuteAsync(WorkspaceAdministrationSql.DeletePurgingWorkspaceSites,
            [Uuid("tenant_id", context.TenantId.Value), Uuid("workspace_id", workspaceId.Value),
             Uuid("job_id", jobId)], cancellationToken).ConfigureAwait(false);
        var id = await _sql.ScalarOrDefaultAsync<Guid>(WorkspaceAdministrationSql.FinalizePurge,
            [Uuid("tenant_id", context.TenantId.Value), Uuid("workspace_id", workspaceId.Value),
             Uuid("job_id", jobId)], cancellationToken).ConfigureAwait(false);
        return id != Guid.Empty;
    }

    /// <summary>Lists principal and group grants visible to a workspace member or administrator.</summary>
    public async ValueTask<IReadOnlyList<WorkspaceMemberSnapshot>> ListMembersAsync(
        WorkspaceId workspaceId,
        DateTimeOffset? afterGrantedAt,
        string? afterSubjectType,
        Guid? afterId,
        int limit,
        CancellationToken cancellationToken)
    {
        var context = Session;
        var rows = new List<WorkspaceMemberSnapshot>(limit);
        var query = _sql.QueryAsync<WorkspaceMemberSnapshot, MemberMapper>(
            WorkspaceAdministrationSql.Members,
            default,
            [
                Uuid("tenant_id", context.TenantId.Value), Uuid("principal_id", context.PrincipalId.Value),
                Uuid("workspace_id", workspaceId.Value), TimestampOrNull("after_granted_at", afterGrantedAt),
                TextOrNull("after_subject_type", afterSubjectType), UuidOrNull("after_id", afterId),
                UuidOrNull("target_principal_id", null),
                Integer("limit", limit),
            ], cancellationToken);
        await foreach (var row in query.ConfigureAwait(false))
        {
            rows.Add(row);
        }
        return rows;
    }

    /// <summary>Lists active humans with invitation eligibility for the people dropdown.</summary>
    public async ValueTask<IReadOnlyList<WorkspaceInviteeSnapshot>> ListInviteesAsync(
        WorkspaceId workspaceId,
        PrincipalId? afterId,
        int limit,
        CancellationToken cancellationToken,
        string? search = null)
    {
        var context = Session;
        var rows = new List<WorkspaceInviteeSnapshot>(limit);
        var query = _sql.QueryAsync<WorkspaceInviteeSnapshot, InviteeMapper>(
            WorkspaceAdministrationSql.Invitees,
            default,
            [
                Uuid("tenant_id", context.TenantId.Value),
                Uuid("principal_id", context.PrincipalId.Value),
                Uuid("workspace_id", workspaceId.Value),
                UuidOrNull("after_id", afterId?.Value),
                Integer("limit", limit),
                TextOrNull("query", search),
            ],
            cancellationToken);
        await foreach (var row in query.ConfigureAwait(false))
        {
            rows.Add(row);
        }
        return rows;
    }

    /// <summary>Reads one direct principal member without scanning a page.</summary>
    public async ValueTask<WorkspaceMemberSnapshot?> FindPrincipalMemberAsync(
        WorkspaceId workspaceId,
        PrincipalId principalId,
        CancellationToken cancellationToken)
    {
        var context = Session;
        var query = _sql.QueryAsync<WorkspaceMemberSnapshot, MemberMapper>(
            WorkspaceAdministrationSql.Members,
            default,
            [
                Uuid("tenant_id", context.TenantId.Value),
                Uuid("principal_id", context.PrincipalId.Value),
                Uuid("workspace_id", workspaceId.Value),
                TimestampOrNull("after_granted_at", null),
                TextOrNull("after_subject_type", null),
                UuidOrNull("after_id", null),
                Uuid("target_principal_id", principalId.Value),
                Integer("limit", 1),
            ],
            cancellationToken);
        await foreach (var row in query.ConfigureAwait(false))
        {
            return row;
        }

        return null;
    }

    /// <summary>Lists durable invitation history for an administering caller.</summary>
    public async ValueTask<IReadOnlyList<WorkspaceInvitationSnapshot>> ListInvitationsAsync(
        WorkspaceId workspaceId,
        DateTimeOffset? afterInvitedAt,
        Guid? afterId,
        int limit,
        CancellationToken cancellationToken)
    {
        var context = Session;
        var rows = new List<WorkspaceInvitationSnapshot>(limit);
        var query = _sql.QueryAsync<WorkspaceInvitationSnapshot, InvitationMapper>(
            WorkspaceAdministrationSql.Invitations,
            default,
            [
                Uuid("tenant_id", context.TenantId.Value), Uuid("principal_id", context.PrincipalId.Value),
                Uuid("workspace_id", workspaceId.Value), TimestampOrNull("after_invited_at", afterInvitedAt),
                UuidOrNull("after_id", afterId), Integer("limit", limit),
            ], cancellationToken);
        await foreach (var row in query.ConfigureAwait(false))
        {
            rows.Add(row);
        }
        return rows;
    }

    /// <summary>Reads one authorized invitation for stable absent-versus-state outcomes.</summary>
    public async ValueTask<WorkspaceInvitationSnapshot?> FindInvitationAsync(
        WorkspaceId workspaceId,
        Guid invitationId,
        CancellationToken cancellationToken)
    {
        var context = Session;
        var query = _sql.QueryAsync<WorkspaceInvitationSnapshot, InvitationMapper>(
            WorkspaceAdministrationSql.InvitationById,
            default,
            [
                Uuid("tenant_id", context.TenantId.Value), Uuid("principal_id", context.PrincipalId.Value),
                Uuid("workspace_id", workspaceId.Value), Uuid("invitation_id", invitationId),
            ], cancellationToken);
        await foreach (var row in query.ConfigureAwait(false))
        {
            return row;
        }

        return null;
    }

    /// <summary>Offers one provisioned human a pending invitation; access starts only when they accept.</summary>
    public async ValueTask<WorkspaceInvitationMutationResult> CreateInvitationAsync(
        WorkspaceId workspaceId,
        Guid invitationId,
        PrincipalId targetPrincipalId,
        string role,
        DateTimeOffset now,
        CancellationToken cancellationToken)
    {
        var context = Session;
        var query = _sql.QueryAsync<WorkspaceInvitationMutationResult, InvitationMutationMapper>(
            WorkspaceAdministrationSql.CreateInvitation, default,
            [
                Uuid("tenant_id", context.TenantId.Value), Uuid("principal_id", context.PrincipalId.Value),
                Uuid("workspace_id", workspaceId.Value), Uuid("invitation_id", invitationId),
                Uuid("target_principal_id", targetPrincipalId.Value), Text("role", role), Timestamp("now", now),
            ], cancellationToken);
        await foreach (var row in query.ConfigureAwait(false))
        {
            return row;
        }

        throw new InvalidOperationException("The invitation mutation did not report an outcome.");
    }

    /// <summary>Accepts the caller's pending invitation and makes its offered role durable.</summary>
    public async ValueTask<bool> AcceptInvitationAsync(
        WorkspaceId workspaceId,
        Guid invitationId,
        DateTimeOffset now,
        CancellationToken cancellationToken)
    {
        var context = Session;
        var id = await _sql.ScalarOrDefaultAsync<Guid>(
            WorkspaceAdministrationSql.AcceptInvitation,
            [Uuid("tenant_id", context.TenantId.Value), Uuid("principal_id", context.PrincipalId.Value),
             Uuid("workspace_id", workspaceId.Value), Uuid("invitation_id", invitationId), Timestamp("now", now)],
            cancellationToken).ConfigureAwait(false);
        return id != Guid.Empty;
    }

    /// <summary>Declines the caller's pending invitation.</summary>
    public async ValueTask<bool> DeclineInvitationAsync(
        WorkspaceId workspaceId,
        Guid invitationId,
        DateTimeOffset now,
        CancellationToken cancellationToken)
    {
        var context = Session;
        var id = await _sql.ScalarOrDefaultAsync<Guid>(
            WorkspaceAdministrationSql.DeclineInvitation,
            [Uuid("tenant_id", context.TenantId.Value), Uuid("principal_id", context.PrincipalId.Value),
             Uuid("workspace_id", workspaceId.Value), Uuid("invitation_id", invitationId), Timestamp("now", now)],
            cancellationToken).ConfigureAwait(false);
        return id != Guid.Empty;
    }

    /// <summary>Revokes a pending invitation, retaining its row.</summary>
    public ValueTask<int> RevokeInvitationAsync(
        WorkspaceId workspaceId,
        Guid invitationId,
        DateTimeOffset now,
        CancellationToken cancellationToken)
    {
        var context = Session;
        return _sql.ExecuteAsync(WorkspaceAdministrationSql.RevokeInvitation,
            [Uuid("tenant_id", context.TenantId.Value), Uuid("principal_id", context.PrincipalId.Value),
             Uuid("workspace_id", workspaceId.Value), Uuid("invitation_id", invitationId), Timestamp("now", now)],
            cancellationToken);
    }

    /// <summary>Changes a direct member role if every ownership invariant remains true.</summary>
    public async ValueTask<bool> ChangeMemberRoleAsync(
        WorkspaceId workspaceId,
        PrincipalId target,
        string role,
        DateTimeOffset now,
        CancellationToken cancellationToken)
    {
        var context = Session;
        var id = await _sql.ScalarOrDefaultAsync<Guid>(WorkspaceAdministrationSql.ChangeMemberRole,
            [Uuid("tenant_id", context.TenantId.Value), Uuid("principal_id", context.PrincipalId.Value),
             Uuid("workspace_id", workspaceId.Value), Uuid("target_principal_id", target.Value),
             Text("role", role), Timestamp("now", now)], cancellationToken).ConfigureAwait(false);
        return id != Guid.Empty;
    }

    /// <summary>Removes a direct member or lets the caller leave, preserving recoverable ownership.</summary>
    public async ValueTask<bool> RemoveMemberAsync(
        WorkspaceId workspaceId,
        PrincipalId target,
        bool self,
        CancellationToken cancellationToken)
    {
        var context = Session;
        var id = await _sql.ScalarOrDefaultAsync<Guid>(WorkspaceAdministrationSql.RemoveMember,
            [Uuid("tenant_id", context.TenantId.Value), Uuid("principal_id", context.PrincipalId.Value),
             Uuid("workspace_id", workspaceId.Value), Uuid("target_principal_id", target.Value),
             Boolean("self", self)], cancellationToken).ConfigureAwait(false);
        return id != Guid.Empty;
    }

    /// <summary>Converts an owned personal workspace to shared and assigns a replacement owner.</summary>
    public async ValueTask<bool> RecoverAsync(
        WorkspaceId workspaceId,
        PrincipalId replacement,
        DateTimeOffset now,
        CancellationToken cancellationToken)
    {
        var context = Session;
        var id = await _sql.ScalarOrDefaultAsync<Guid>(WorkspaceAdministrationSql.Recover,
            [Uuid("tenant_id", context.TenantId.Value), Uuid("principal_id", context.PrincipalId.Value),
             Uuid("workspace_id", workspaceId.Value), Uuid("target_principal_id", replacement.Value),
             Timestamp("now", now)], cancellationToken).ConfigureAwait(false);
        return id != Guid.Empty;
    }

    /// <summary>
    /// Reads a workspace's effective daily-note settings, with defaults applied, for a caller who
    /// can see the workspace.
    /// </summary>
    /// <returns>The settings, or null when the workspace is not visible to the caller.</returns>
    public async ValueTask<DailyNoteSettings?> ReadDailyNoteSettingsAsync(
        WorkspaceId workspaceId,
        CancellationToken cancellationToken)
    {
        var context = Session;
        var rows = _sql.QueryAsync<DailyNoteSettings, DailyNoteSettingsMapper>(
            WorkspaceAdministrationSql.ReadDailyNoteSettings,
            default,
            [
                Uuid("tenant_id", context.TenantId.Value),
                Uuid("principal_id", context.PrincipalId.Value),
                Uuid("workspace_id", workspaceId.Value),
            ],
            cancellationToken);

        await foreach (var row in rows.ConfigureAwait(false))
        {
            return row;
        }

        return null;
    }

    /// <summary>
    /// Replaces a workspace's daily-note settings when the caller may administer the workspace.
    /// </summary>
    /// <returns>False when the workspace is not visible or the caller may not change it.</returns>
    public async ValueTask<bool> SaveDailyNoteSettingsAsync(
        WorkspaceId workspaceId,
        DailyNoteSettings settings,
        CancellationToken cancellationToken)
    {
        ArgumentNullException.ThrowIfNull(settings);
        var context = Session;
        var result = await _sql.ScalarOrDefaultAsync<Guid>(
            WorkspaceAdministrationSql.SaveDailyNoteSettings,
            [
                Uuid("tenant_id", context.TenantId.Value),
                Uuid("principal_id", context.PrincipalId.Value),
                Uuid("workspace_id", workspaceId.Value),
                Text("settings", settings.Write()),
            ],
            cancellationToken).ConfigureAwait(false);
        return result != Guid.Empty;
    }

    /// <summary>
    /// Idempotently opens the deterministic dated note for a day, creating the Daily notes root and
    /// any folder the workspace's settings call for, all in the request's transaction.
    /// </summary>
    /// <remarks>
    /// <para>
    /// An existing note is returned where it is. Folders and the root are created only for a note
    /// that does not exist yet, so reopening an old note after the settings changed files nothing new.
    /// </para>
    /// <para>
    /// <paramref name="candidateIds"/> are the day's identifiers in generation order. The note opened
    /// is the one in the first slot that is not retired - see
    /// <see cref="WorkspaceAdministrationSql.DailyNoteContext"/> - so a purged day gets a fresh note
    /// under the next generation, and every open of that day finds the same one. The advisory lock
    /// serializes opens in the workspace, so two concurrent opens choose the same slot and the
    /// second finds the note the first inserted.
    /// </para>
    /// </remarks>
    public async ValueTask<DailyNoteOpening> OpenDailyNoteAsync(
        WorkspaceId workspaceId,
        Guid rootId,
        Guid[] candidateIds,
        DateOnly day,
        string date,
        DateTimeOffset now,
        CancellationToken cancellationToken)
    {
        ArgumentNullException.ThrowIfNull(candidateIds);
        var context = Session;
        await _sql.ExecuteAsync(
            WorkspaceAdministrationSql.LockDailyNote,
            [Uuid("item_id", rootId)],
            cancellationToken).ConfigureAwait(false);

        DailyNoteContextRow? found = null;
        var contextRows = _sql.QueryAsync<DailyNoteContextRow, DailyNoteContextMapper>(
            WorkspaceAdministrationSql.DailyNoteContext,
            default,
            [
                Uuid("tenant_id", context.TenantId.Value), Uuid("principal_id", context.PrincipalId.Value),
                UuidOrNull("credential_id", _credential.CredentialId),
                Uuid("workspace_id", workspaceId.Value),
                new NpgsqlParameter("candidate_ids", NpgsqlDbType.Array | NpgsqlDbType.Uuid) { Value = candidateIds },
            ],
            cancellationToken);
        await foreach (var row in contextRows.ConfigureAwait(false))
        {
            found = row;
        }

        if (found is not { } known)
        {
            return DailyNoteOpening.NotAuthorized;
        }

        var settings = DailyNoteSettings.Read(known.SettingsJson, known.Personal);
        if (!settings.Enabled)
        {
            return DailyNoteOpening.Disabled;
        }

        if (known.SlotId is not { } itemId)
        {
            return DailyNoteOpening.Unavailable;
        }

        // An existing note is opened where it is; the parent below matters only when creating one.
        // `rootId` stays the advisory lock key whichever root generation is in use.
        Guid parentId = rootId;
        if (!known.NoteExists)
        {
            Guid? containerParent = null;
            var containers = new List<(Guid[] Candidates, string Title)>
            {
                (DeterministicProvisioningId.DailyNotesRootGenerations(workspaceId), "Daily notes"),
            };
            foreach (var key in settings.FolderKeys(day))
            {
                containers.Add((DeterministicProvisioningId.DailyNotesFolderGenerations(workspaceId, key), key));
            }

            foreach (var (candidates, title) in containers)
            {
                var containerId = await ContainerSlotAsync(workspaceId, candidates, containerParent, cancellationToken)
                    .ConfigureAwait(false);
                if (containerId is not { } chosen
                    || !await EnsureContainerAsync(workspaceId, chosen, containerParent, title, now, cancellationToken)
                        .ConfigureAwait(false))
                {
                    return DailyNoteOpening.RootUnavailable;
                }

                containerParent = chosen;
                parentId = chosen;
            }
        }

        DailyNoteOpening? opened = null;
        var noteRows = _sql.QueryAsync<DailyNoteOpening, DailyNoteOpenedMapper>(
            WorkspaceAdministrationSql.OpenDailyNote,
            default,
            [
                Uuid("tenant_id", context.TenantId.Value), Uuid("principal_id", context.PrincipalId.Value),
                UuidOrNull("credential_id", _credential.CredentialId),
                Uuid("workspace_id", workspaceId.Value), Uuid("parent_id", parentId), Uuid("item_id", itemId),
                Text("title", settings.FormatTitle(day)), Text("date", date), Timestamp("now", now),
            ],
            cancellationToken);
        await foreach (var row in noteRows.ConfigureAwait(false))
        {
            opened = row;
        }

        if (opened is not null)
        {
            return opened;
        }

        return known.NoteExists
            ? await ExplainDailyNoteBlockAsync(workspaceId, itemId, now, cancellationToken).ConfigureAwait(false)
            : DailyNoteOpening.Unavailable;
    }

    private async ValueTask<DailyNoteOpening> ExplainDailyNoteBlockAsync(
        WorkspaceId workspaceId,
        Guid itemId,
        DateTimeOffset now,
        CancellationToken cancellationToken)
    {
        var context = Session;
        string? blocker = null;
        var rows = _sql.QueryAsync<string, ObjectKeyMapper>(
            WorkspaceAdministrationSql.DailyNoteBlocker,
            default,
            [
                Uuid("tenant_id", context.TenantId.Value), Uuid("principal_id", context.PrincipalId.Value),
                UuidOrNull("credential_id", _credential.CredentialId),
                Uuid("workspace_id", workspaceId.Value), Uuid("item_id", itemId), Timestamp("now", now),
            ],
            cancellationToken);
        await foreach (var row in rows.ConfigureAwait(false))
        {
            blocker = row;
        }

        return blocker switch
        {
            "trash" => DailyNoteOpening.InTrash,
            "locked" => DailyNoteOpening.Locked,
            _ => DailyNoteOpening.Unavailable,
        };
    }

    private async ValueTask<Guid?> ContainerSlotAsync(
        WorkspaceId workspaceId,
        Guid[] candidateIds,
        Guid? parentId,
        CancellationToken cancellationToken)
    {
        var context = Session;
        Guid? slot = null;
        var rows = _sql.QueryAsync<Guid, GuidMapper>(
            WorkspaceAdministrationSql.DailyNoteContainerSlot,
            default,
            [
                Uuid("tenant_id", context.TenantId.Value), Uuid("principal_id", context.PrincipalId.Value),
                Uuid("workspace_id", workspaceId.Value), UuidOrNull("parent_id", parentId),
                new NpgsqlParameter("candidate_ids", NpgsqlDbType.Array | NpgsqlDbType.Uuid) { Value = candidateIds },
            ],
            cancellationToken);
        await foreach (var row in rows.ConfigureAwait(false))
        {
            slot = row;
        }

        return slot;
    }

    private async ValueTask<bool> EnsureContainerAsync(
        WorkspaceId workspaceId,
        Guid itemId,
        Guid? parentId,
        string title,
        DateTimeOffset now,
        CancellationToken cancellationToken)
    {
        var context = Session;
        string? state = null;
        var rows = _sql.QueryAsync<string, ObjectKeyMapper>(
            WorkspaceAdministrationSql.EnsureDailyNoteContainer,
            default,
            [
                Uuid("tenant_id", context.TenantId.Value), Uuid("principal_id", context.PrincipalId.Value),
                UuidOrNull("credential_id", _credential.CredentialId),
                Uuid("workspace_id", workspaceId.Value), Uuid("item_id", itemId),
                UuidOrNull("parent_id", parentId), Text("title", title), Timestamp("now", now),
            ],
            cancellationToken);
        await foreach (var row in rows.ConfigureAwait(false))
        {
            state = row;
        }

        return state == "active";
    }

    private static NpgsqlParameter Uuid(string name, Guid value) =>
        new(name, NpgsqlDbType.Uuid) { Value = value };
    private static NpgsqlParameter UuidOrNull(string name, Guid? value) =>
        new(name, NpgsqlDbType.Uuid) { Value = value is { } actual ? actual : DBNull.Value };
    private static NpgsqlParameter Text(string name, string value) =>
        new(name, NpgsqlDbType.Text) { Value = value };
    private static NpgsqlParameter TextOrNull(string name, string? value) =>
        new(name, NpgsqlDbType.Text) { Value = value is null ? DBNull.Value : value };
    private static NpgsqlParameter Integer(string name, int value) =>
        new(name, NpgsqlDbType.Integer) { Value = value };
    private static NpgsqlParameter Boolean(string name, bool value) =>
        new(name, NpgsqlDbType.Boolean) { Value = value };
    private static NpgsqlParameter Timestamp(string name, DateTimeOffset value) =>
        new(name, NpgsqlDbType.TimestampTz) { Value = value };
    private static NpgsqlParameter TimestampOrNull(string name, DateTimeOffset? value) =>
        new(name, NpgsqlDbType.TimestampTz) { Value = value is { } actual ? actual : DBNull.Value };

    private readonly struct WorkspaceMapper : INixRowMapper<WorkspaceSnapshot>
    {
        public WorkspaceSnapshot Map(NpgsqlDataReader reader) => new(
            WorkspaceId.From(reader.GetGuid(0)), reader.GetString(1), reader.GetInt32(2),
            reader.GetInt64(3), reader.GetFieldValue<DateTimeOffset>(4),
            reader.IsDBNull(5) ? null : PrincipalId.From(reader.GetGuid(5)),
            reader.GetBoolean(6), reader.GetBoolean(7), reader.GetBoolean(8),
            reader.GetBoolean(9), reader.IsDBNull(10) ? null : reader.GetGuid(10),
            reader.GetString(11), reader.IsDBNull(12) ? null : reader.GetFieldValue<DateTimeOffset>(12),
            reader.GetBoolean(13), reader.GetBoolean(14));
    }

    private readonly record struct DailyNoteContextRow(
        string? SettingsJson, bool Personal, Guid? SlotId, bool NoteExists);

    private readonly struct DailyNoteContextMapper : INixRowMapper<DailyNoteContextRow>
    {
        public DailyNoteContextRow Map(NpgsqlDataReader reader) => new(
            reader.IsDBNull(0) ? null : reader.GetString(0), reader.GetBoolean(1),
            reader.IsDBNull(2) ? null : reader.GetGuid(2), !reader.IsDBNull(3) && reader.GetBoolean(3));
    }

    private readonly struct DailyNoteSettingsMapper : INixRowMapper<DailyNoteSettings>
    {
        public DailyNoteSettings Map(NpgsqlDataReader reader) =>
            DailyNoteSettings.Read(reader.IsDBNull(0) ? null : reader.GetString(0), reader.GetBoolean(1));
    }

    private readonly struct DailyNoteOpenedMapper : INixRowMapper<DailyNoteOpening>
    {
        public DailyNoteOpening Map(NpgsqlDataReader reader) =>
            new(DailyNoteOutcome.Opened, reader.GetGuid(0), reader.GetBoolean(1));
    }

    private readonly struct ObjectKeyMapper : INixRowMapper<string>
    {
        public string Map(NpgsqlDataReader reader) => reader.GetString(0);
    }

    private readonly struct GuidMapper : INixRowMapper<Guid>
    {
        public Guid Map(NpgsqlDataReader reader) => reader.GetGuid(0);
    }

    private readonly struct MemberMapper : INixRowMapper<WorkspaceMemberSnapshot>
    {
        public WorkspaceMemberSnapshot Map(NpgsqlDataReader reader) => new(
            reader.GetString(0), reader.GetGuid(1), reader.GetString(2),
            reader.IsDBNull(3) ? null : reader.GetString(3), reader.GetString(4),
            reader.GetFieldValue<DateTimeOffset>(5), reader.GetBoolean(6), reader.GetBoolean(7),
            reader.GetFieldValue<string[]>(8));
    }

    private readonly struct InviteeMapper : INixRowMapper<WorkspaceInviteeSnapshot>
    {
        public WorkspaceInviteeSnapshot Map(NpgsqlDataReader reader) => new(
            PrincipalId.From(reader.GetGuid(0)), reader.GetString(1),
            reader.IsDBNull(2) ? null : reader.GetString(2), reader.GetBoolean(3),
            reader.IsDBNull(4) ? null : reader.GetString(4));
    }

    private readonly struct InvitationMapper : INixRowMapper<WorkspaceInvitationSnapshot>
    {
        public WorkspaceInvitationSnapshot Map(NpgsqlDataReader reader) => new(
            reader.GetGuid(0), reader.GetString(1),
            reader.IsDBNull(2) ? null : PrincipalId.From(reader.GetGuid(2)), reader.GetString(3), reader.GetString(4),
            PrincipalId.From(reader.GetGuid(5)), reader.GetFieldValue<DateTimeOffset>(6),
            reader.IsDBNull(7) ? null : reader.GetFieldValue<DateTimeOffset>(7),
            reader.IsDBNull(8) ? null : PrincipalId.From(reader.GetGuid(8)),
            reader.IsDBNull(9) ? null : reader.GetFieldValue<DateTimeOffset>(9));
    }

    private readonly struct InvitationMutationMapper : INixRowMapper<WorkspaceInvitationMutationResult>
    {
        public WorkspaceInvitationMutationResult Map(NpgsqlDataReader reader)
        {
            var outcome = reader.GetString(0);
            if (reader.IsDBNull(1))
            {
                return new WorkspaceInvitationMutationResult(outcome, null);
            }

            return new WorkspaceInvitationMutationResult(
                outcome,
                new WorkspaceInvitationSnapshot(
                    reader.GetGuid(1), reader.GetString(2),
                    reader.IsDBNull(3) ? null : PrincipalId.From(reader.GetGuid(3)), reader.GetString(4), reader.GetString(5),
                    PrincipalId.From(reader.GetGuid(6)), reader.GetFieldValue<DateTimeOffset>(7),
                    reader.IsDBNull(8) ? null : reader.GetFieldValue<DateTimeOffset>(8),
                    reader.IsDBNull(9) ? null : PrincipalId.From(reader.GetGuid(9)),
                    reader.IsDBNull(10) ? null : reader.GetFieldValue<DateTimeOffset>(10)));
        }
    }
}
