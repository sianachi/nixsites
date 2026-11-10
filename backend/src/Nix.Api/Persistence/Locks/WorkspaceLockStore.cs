using Nix.Abstractions;
using Nix.Domain.Tenancy;
using Nix.Persistence.Sql;
using Nix.Persistence.Sql.Statements;
using Npgsql;
using NpgsqlTypes;

namespace Nix.Persistence.Locks;

/// <summary>
/// Reads and writes workspace passwords and grants inside the current unit of work.
/// </summary>
/// <remarks>
/// The tenant, principal and credential all come from the request's own contexts; none is a
/// parameter, so no caller can check a lock as, or issue a grant to, somebody else.
/// </remarks>
public sealed class WorkspaceLockStore(
    NixSqlExecutor sql,
    INixSessionContextAccessor session,
    CredentialSessionContext credential,
    TimeProvider clock)
    : IWorkspaceLocks
{
    private NixSessionContext Session => session.Current
        ?? throw new InvalidOperationException("No session context has been established for this unit of work.");

    /// <inheritdoc />
    public async ValueTask<WorkspaceLockState> GetStateAsync(WorkspaceId workspaceId, CancellationToken cancellationToken)
    {
        var states = await GetStatesAsync([workspaceId], cancellationToken).ConfigureAwait(false);
        return states.TryGetValue(workspaceId, out var state) ? state : new WorkspaceLockState(false, null);
    }

    /// <inheritdoc />
    public async ValueTask<IReadOnlyDictionary<WorkspaceId, WorkspaceLockState>> GetStatesAsync(
        IReadOnlyList<WorkspaceId> workspaceIds,
        CancellationToken cancellationToken)
    {
        ArgumentNullException.ThrowIfNull(workspaceIds);

        var states = new Dictionary<WorkspaceId, WorkspaceLockState>();
        if (workspaceIds.Count == 0)
        {
            return states;
        }

        var rows = sql.QueryAsync<(WorkspaceId, DateTimeOffset?), StateMapper>(
            WorkspaceLockSql.States,
            default,
            [
                Tenant(),
                new NpgsqlParameter("workspace_ids", NpgsqlDbType.Array | NpgsqlDbType.Uuid)
                {
                    Value = workspaceIds.Select(id => id.Value).ToArray(),
                },
                Credential(),
                Now(),
            ],
            cancellationToken);
        await foreach (var (id, until) in rows.WithCancellation(cancellationToken).ConfigureAwait(false))
        {
            states[id] = new WorkspaceLockState(true, until);
        }

        return states;
    }

    /// <inheritdoc />
    public ValueTask<string?> FindVerifierAsync(WorkspaceId workspaceId, CancellationToken cancellationToken) =>
        sql.ScalarOrDefaultAsync<string>(WorkspaceLockSql.Verifier, [Tenant(), Workspace(workspaceId)], cancellationToken);

    /// <inheritdoc />
    public ValueTask<string?> FindJoinVerifierAsync(WorkspaceId workspaceId, CancellationToken cancellationToken) =>
        sql.ScalarOrDefaultAsync<string>(WorkspaceLockSql.JoinVerifier, [Tenant(), Workspace(workspaceId)], cancellationToken);

    /// <inheritdoc />
    public async ValueTask<bool> LockAsync(WorkspaceId workspaceId, string verifier, CancellationToken cancellationToken)
    {
        ArgumentException.ThrowIfNullOrEmpty(verifier);
        return await sql.ExecuteAsync(
            WorkspaceLockSql.Lock,
            [Tenant(), Workspace(workspaceId), Verifier(verifier), Principal(), Now()],
            cancellationToken).ConfigureAwait(false) > 0;
    }

    /// <inheritdoc />
    public async ValueTask<bool> ChangeVerifierAsync(
        WorkspaceId workspaceId,
        string expected,
        string verifier,
        CancellationToken cancellationToken)
    {
        ArgumentException.ThrowIfNullOrEmpty(expected);
        ArgumentException.ThrowIfNullOrEmpty(verifier);

        var changed = await sql.ExecuteAsync(
            WorkspaceLockSql.ChangeVerifier,
            [
                Tenant(),
                Workspace(workspaceId),
                Verifier(verifier),
                new NpgsqlParameter("expected_hash", NpgsqlDbType.Text) { Value = expected },
                Principal(),
                Now(),
            ],
            cancellationToken).ConfigureAwait(false);
        if (changed == 0)
        {
            return false;
        }

        await sql.ExecuteAsync(WorkspaceLockSql.RevokeAll, [Tenant(), Workspace(workspaceId)], cancellationToken)
            .ConfigureAwait(false);
        return true;
    }

    /// <inheritdoc />
    public async ValueTask<bool> RemoveAsync(WorkspaceId workspaceId, string expected, CancellationToken cancellationToken)
    {
        ArgumentException.ThrowIfNullOrEmpty(expected);
        return await sql.ExecuteAsync(
            WorkspaceLockSql.Remove,
            [Tenant(), Workspace(workspaceId), new NpgsqlParameter("expected_hash", NpgsqlDbType.Text) { Value = expected }],
            cancellationToken).ConfigureAwait(false) > 0;
    }

    /// <inheritdoc />
    public async ValueTask<bool> GrantAsync(
        WorkspaceId workspaceId,
        string verifier,
        DateTimeOffset expiresAt,
        CancellationToken cancellationToken)
    {
        ArgumentException.ThrowIfNullOrEmpty(verifier);
        if (credential.CredentialId is null)
        {
            throw new InvalidOperationException("This request authenticated with a credential that cannot hold an unlock.");
        }

        await sql.ExecuteAsync(
            WorkspaceLockSql.Grant,
            [
                Tenant(),
                Workspace(workspaceId),
                Credential(),
                Principal(),
                Verifier(verifier),
                new NpgsqlParameter("expires_at", NpgsqlDbType.TimestampTz) { Value = expiresAt },
                Now(),
            ],
            cancellationToken).ConfigureAwait(false);

        return await sql.ScalarOrDefaultAsync<bool>(
            WorkspaceLockSql.HoldsGrant,
            [Tenant(), Workspace(workspaceId), Credential(), Now()],
            cancellationToken).ConfigureAwait(false);
    }

    /// <inheritdoc />
    public async ValueTask RevokeAsync(WorkspaceId workspaceId, CancellationToken cancellationToken)
    {
        if (credential.CredentialId is null)
        {
            return;
        }

        await sql.ExecuteAsync(
            WorkspaceLockSql.Revoke,
            [Tenant(), Workspace(workspaceId), Credential()],
            cancellationToken).ConfigureAwait(false);
    }

    /// <inheritdoc />
    public async ValueTask<bool> JoinAsync(WorkspaceId workspaceId, string verifier, CancellationToken cancellationToken)
    {
        ArgumentException.ThrowIfNullOrEmpty(verifier);
        return await sql.ScalarOrDefaultAsync<bool>(
            WorkspaceLockSql.Join,
            [Tenant(), Workspace(workspaceId), Verifier(verifier), Principal(), Now()],
            cancellationToken).ConfigureAwait(false);
    }

    /// <inheritdoc />
    public async ValueTask AuditAsync(WorkspaceId workspaceId, string action, CancellationToken cancellationToken) =>
        await sql.ExecuteAsync(
            WorkspaceLockSql.Audit,
            [
                Tenant(),
                Workspace(workspaceId),
                Principal(),
                new NpgsqlParameter("audit_action", NpgsqlDbType.Text) { Value = action },
                Now(),
            ],
            cancellationToken).ConfigureAwait(false);

    private NpgsqlParameter Tenant() => new("tenant_id", NpgsqlDbType.Uuid) { Value = Session.TenantId.Value };

    private NpgsqlParameter Principal() => new("principal_id", NpgsqlDbType.Uuid) { Value = Session.PrincipalId.Value };

    private NpgsqlParameter Credential() =>
        new("credential_id", NpgsqlDbType.Uuid) { Value = credential.CredentialId is { } id ? id : DBNull.Value };

    private NpgsqlParameter Now() => new("now", NpgsqlDbType.TimestampTz) { Value = clock.GetUtcNow() };

    private static NpgsqlParameter Workspace(WorkspaceId id) => new("workspace_id", NpgsqlDbType.Uuid) { Value = id.Value };

    private static NpgsqlParameter Verifier(string verifier) => new("password_hash", NpgsqlDbType.Text) { Value = verifier };

    private readonly struct StateMapper : INixRowMapper<(WorkspaceId, DateTimeOffset?)>
    {
        /// <inheritdoc />
        public (WorkspaceId, DateTimeOffset?) Map(NpgsqlDataReader reader)
        {
            ArgumentNullException.ThrowIfNull(reader);
            return (
                WorkspaceId.From(reader.GetGuid(0)),
                reader.IsDBNull(1) ? null : reader.GetFieldValue<DateTimeOffset>(1));
        }
    }
}
