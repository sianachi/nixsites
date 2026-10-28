using Nix.Abstractions;
using Nix.Domain.Items;
using Nix.Persistence.Sql;
using Nix.Persistence.Sql.Statements;
using Npgsql;
using NpgsqlTypes;

namespace Nix.Persistence.Locks;

/// <summary>
/// Reads and writes item locks and grants inside the current unit of work.
/// </summary>
/// <remarks>
/// The tenant, principal and credential all come from the request's own contexts. None is a
/// parameter, so no caller can check a lock as, or issue a grant to, somebody else.
/// </remarks>
public sealed class ItemLockStore(
    NixSqlExecutor sql,
    INixSessionContextAccessor session,
    CredentialSessionContext credential,
    TimeProvider clock)
    : IItemLocks
{
    private readonly INixSessionContextAccessor _session = session;
    private readonly CredentialSessionContext _credential = credential;

    private NixSessionContext Session => _session.Current
        ?? throw new InvalidOperationException(
            "No session context has been established for this unit of work. A lock is checked for "
            + "a specific credential in a specific tenant; there is no anonymous path.");

    /// <inheritdoc />
    public async ValueTask<ItemLockState> GetStateAsync(ItemId itemId, CancellationToken cancellationToken)
    {
        var rows = sql.QueryAsync<ItemLockState, StateMapper>(
            ItemLockSql.State,
            default,
            [TenantParameter(), ItemParameter(itemId), CredentialParameter(), NowParameter()],
            cancellationToken);

        await foreach (var row in rows.WithCancellation(cancellationToken).ConfigureAwait(false))
        {
            return row;
        }

        // The statement aggregates without grouping, so it always yields exactly one row.
        throw new InvalidOperationException("The lock state statement returned no row.");
    }

    /// <inheritdoc />
    public async ValueTask<bool> MayReadBodyAsync(ItemId itemId, CancellationToken cancellationToken) =>
        await sql.ScalarOrDefaultAsync<bool>(
            ItemLockSql.MayReadBody,
            [TenantParameter(), ItemParameter(itemId), CredentialParameter(), NowParameter()],
            cancellationToken).ConfigureAwait(false);

    /// <inheritdoc />
    public async ValueTask<bool> AnyInSubtreeAsync(ItemId itemId, CancellationToken cancellationToken) =>
        await sql.ScalarOrDefaultAsync<bool>(
            ItemLockSql.AnyInSubtree,
            [TenantParameter(), ItemParameter(itemId)],
            cancellationToken).ConfigureAwait(false);

    /// <inheritdoc />
    public async ValueTask<IReadOnlySet<ItemId>> LockedAmongAsync(
        IReadOnlyList<ItemId> itemIds,
        CancellationToken cancellationToken)
    {
        ArgumentNullException.ThrowIfNull(itemIds);

        var locked = new HashSet<ItemId>();
        if (itemIds.Count == 0)
        {
            return locked;
        }

        var identifiers = new Guid[itemIds.Count];
        for (var index = 0; index < itemIds.Count; index++)
        {
            identifiers[index] = itemIds[index].Value;
        }

        var rows = sql.QueryAsync<Guid, IdentifierMapper>(
            ItemLockSql.LockedAmong,
            default,
            [
                TenantParameter(),
                new NpgsqlParameter("item_ids", NpgsqlDbType.Array | NpgsqlDbType.Uuid) { Value = identifiers },
            ],
            cancellationToken);
        await foreach (var row in rows.WithCancellation(cancellationToken).ConfigureAwait(false))
        {
            locked.Add(ItemId.From(row));
        }

        return locked;
    }

    /// <inheritdoc />
    public ValueTask<string?> FindVerifierAsync(ItemId itemId, CancellationToken cancellationToken) =>
        sql.ScalarOrDefaultAsync<string>(
            ItemLockSql.Verifier,
            [TenantParameter(), ItemParameter(itemId)],
            cancellationToken);

    /// <inheritdoc />
    public async ValueTask<bool> LockAsync(ItemId itemId, string verifier, CancellationToken cancellationToken)
    {
        ArgumentException.ThrowIfNullOrEmpty(verifier);

        var written = await sql.ExecuteAsync(
            ItemLockSql.Lock,
            [
                TenantParameter(),
                ItemParameter(itemId),
                VerifierParameter(verifier),
                PrincipalParameter(),
                NowParameter(),
            ],
            cancellationToken).ConfigureAwait(false);

        return written > 0;
    }

    /// <inheritdoc />
    public async ValueTask<bool> ChangeVerifierAsync(
        ItemId itemId,
        string expected,
        string verifier,
        CancellationToken cancellationToken)
    {
        ArgumentException.ThrowIfNullOrEmpty(expected);
        ArgumentException.ThrowIfNullOrEmpty(verifier);

        var changed = await sql.ExecuteAsync(
            ItemLockSql.ChangeVerifier,
            [
                TenantParameter(),
                ItemParameter(itemId),
                VerifierParameter(verifier),
                new NpgsqlParameter("expected_hash", NpgsqlDbType.Text) { Value = expected },
                PrincipalParameter(),
                NowParameter(),
            ],
            cancellationToken).ConfigureAwait(false);

        if (changed == 0)
        {
            return false;
        }

        await sql.ExecuteAsync(
            ItemLockSql.RevokeAll,
            [TenantParameter(), ItemParameter(itemId)],
            cancellationToken).ConfigureAwait(false);

        return true;
    }

    /// <inheritdoc />
    public async ValueTask<bool> RemoveAsync(ItemId itemId, string expected, CancellationToken cancellationToken)
    {
        ArgumentException.ThrowIfNullOrEmpty(expected);

        var removed = await sql.ExecuteAsync(
            ItemLockSql.Remove,
            [TenantParameter(), ItemParameter(itemId), new NpgsqlParameter("expected_hash", NpgsqlDbType.Text) { Value = expected }],
            cancellationToken).ConfigureAwait(false);

        return removed > 0;
    }

    /// <inheritdoc />
    public async ValueTask<bool> GrantAsync(
        ItemId itemId,
        string verifier,
        DateTimeOffset expiresAt,
        CancellationToken cancellationToken)
    {
        ArgumentException.ThrowIfNullOrEmpty(verifier);

        var credential = _credential.CredentialId
            ?? throw new InvalidOperationException(
                "This request authenticated with a credential that cannot hold an unlock.");

        // Two statements in one command: the sweep's count is included in the total, so the
        // grant's own outcome is read back rather than inferred from it.
        await sql.ExecuteAsync(
            ItemLockSql.Grant,
            [
                TenantParameter(),
                ItemParameter(itemId),
                new NpgsqlParameter("credential_id", NpgsqlDbType.Uuid) { Value = credential },
                PrincipalParameter(),
                VerifierParameter(verifier),
                new NpgsqlParameter("expires_at", NpgsqlDbType.TimestampTz) { Value = expiresAt },
                NowParameter(),
            ],
            cancellationToken).ConfigureAwait(false);

        return await sql.ScalarOrDefaultAsync<bool>(
            ItemLockSql.HoldsGrant,
            [TenantParameter(), ItemParameter(itemId), CredentialParameter(), NowParameter()],
            cancellationToken).ConfigureAwait(false);
    }

    /// <inheritdoc />
    public async ValueTask<bool> IsLockedAsync(ItemId itemId, CancellationToken cancellationToken) =>
        await FindVerifierAsync(itemId, cancellationToken).ConfigureAwait(false) is not null;

    /// <inheritdoc />
    public async ValueTask RevokeAsync(ItemId itemId, CancellationToken cancellationToken)
    {
        if (_credential.CredentialId is null)
        {
            // Nothing to revoke: a credential that cannot hold a grant never received one.
            return;
        }

        await sql.ExecuteAsync(
            ItemLockSql.Revoke,
            [TenantParameter(), ItemParameter(itemId), CredentialParameter()],
            cancellationToken).ConfigureAwait(false);
    }

    private NpgsqlParameter TenantParameter() =>
        new("tenant_id", NpgsqlDbType.Uuid) { Value = Session.TenantId.Value };

    private NpgsqlParameter PrincipalParameter() =>
        new("principal_id", NpgsqlDbType.Uuid) { Value = Session.PrincipalId.Value };

    private NpgsqlParameter CredentialParameter() =>
        new("credential_id", NpgsqlDbType.Uuid)
        {
            Value = _credential.CredentialId is { } credential ? credential : DBNull.Value,
        };

    private NpgsqlParameter NowParameter() =>
        new("now", NpgsqlDbType.TimestampTz) { Value = clock.GetUtcNow() };

    private static NpgsqlParameter ItemParameter(ItemId itemId) =>
        new("item_id", NpgsqlDbType.Uuid) { Value = itemId.Value };

    private static NpgsqlParameter VerifierParameter(string verifier) =>
        new("password_hash", NpgsqlDbType.Text) { Value = verifier };

    /// <summary>Reads the one identifier column a statement projects.</summary>
    private readonly struct IdentifierMapper : INixRowMapper<Guid>
    {
        /// <inheritdoc />
        public Guid Map(NpgsqlDataReader reader)
        {
            ArgumentNullException.ThrowIfNull(reader);
            return reader.GetGuid(0);
        }
    }

    /// <summary>Reads the four columns the state statement projects.</summary>
    private readonly struct StateMapper : INixRowMapper<ItemLockState>
    {
        /// <inheritdoc />
        public ItemLockState Map(NpgsqlDataReader reader)
        {
            ArgumentNullException.ThrowIfNull(reader);

            var locked = reader.GetBoolean(0);
            DateTimeOffset? unlockedUntil = reader.IsDBNull(1)
                ? null
                : reader.GetFieldValue<DateTimeOffset>(1);

            ItemId? lockItemId = reader.IsDBNull(2) ? null : ItemId.From(reader.GetGuid(2));
            var selfLocked = reader.GetBoolean(3);

            return new ItemLockState(locked, unlockedUntil, lockItemId, selfLocked);
        }
    }
}
