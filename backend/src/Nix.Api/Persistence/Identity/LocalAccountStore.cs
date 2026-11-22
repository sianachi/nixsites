using Nix.Abstractions;
using Nix.Authentication;
using Nix.Domain.Identity;
using Nix.Domain.Tenancy;
using Nix.Persistence.Sql;
using Npgsql;
using NpgsqlTypes;

namespace Nix.Persistence.Identity;

/// <summary>Postgres storage for local accounts, over the <c>nix_local_*</c> functions.</summary>
public sealed class LocalAccountStore(
    NpgsqlDataSource dataSource,
    NixSqlExecutor sql,
    PersonalWorkspaceProvisioner provisioner,
    SelfIssuedTokenService tokens) : ILocalAccounts
{
    private const string Columns = "principal_id, tenant_id, email, display_name, status, password_hash, password_changed_at, paused_until, totp_enabled, passkey_count, security_key_count";

    private readonly PooledSql _db = new(dataSource);

    /// <inheritdoc />
    public async ValueTask<bool> AnyAsync(CancellationToken cancellationToken) =>
        await _db.ScalarAsync<bool>("SELECT nix_local_any_account()", cancellationToken).ConfigureAwait(false) ?? false;

    /// <inheritdoc />
    public async ValueTask<LocalAccountRecord?> FindByEmailAsync(string normalizedEmail, CancellationToken cancellationToken)
    {
        ArgumentException.ThrowIfNullOrWhiteSpace(normalizedEmail);
        var rows = await _db.RowsAsync(
            $"SELECT {Columns} FROM nix_local_find_account(@email, NULL::uuid)",
            Read,
            cancellationToken,
            NixParameter.Text("email", normalizedEmail)).ConfigureAwait(false);
        return rows.FirstOrDefault();
    }

    /// <inheritdoc />
    public async ValueTask<LocalAccountRecord?> FindByPrincipalAsync(PrincipalId principalId, CancellationToken cancellationToken)
    {
        var rows = await _db.RowsAsync(
            $"SELECT {Columns} FROM nix_local_find_account(NULL::text, @principal)",
            Read,
            cancellationToken,
            NixParameter.Uuid("principal", principalId.Value)).ConfigureAwait(false);
        return rows.FirstOrDefault();
    }

    /// <inheritdoc />
    public async ValueTask<AuthenticatedPrincipal?> CreateAsync(
        TenantId tenantId,
        string normalizedEmail,
        string displayName,
        string? passwordHash,
        CancellationToken cancellationToken)
    {
        ArgumentException.ThrowIfNullOrWhiteSpace(normalizedEmail);
        ArgumentException.ThrowIfNullOrWhiteSpace(displayName);

        // A fresh GUID as the subject; the issuer is Core itself, so the deterministic id derivation still applies.
        var principal = await provisioner.ProvisionAsync(
            tenantId,
            tokens.Issuer,
            Guid.CreateVersion7().ToString("D"),
            new UserInfoProfile(displayName.Trim(), normalizedEmail, EmailVerified: true),
            cancellationToken).ConfigureAwait(false);
        var created = await sql.ScalarAsync<bool>(
            "SELECT nix_local_create_account(@principal, @email, @hash)",
            [
                NixParameter.Uuid("principal", principal.Id.Value),
                NixParameter.Text("email", normalizedEmail),
                NixParameter.Text("hash", passwordHash),
            ],
            cancellationToken).ConfigureAwait(false) ?? false;
        return created ? principal : null;
    }

    /// <inheritdoc />
    public async ValueTask<bool> SetPasswordAsync(PrincipalId principalId, string? hash, bool changed, CancellationToken cancellationToken) =>
        await _db.ScalarAsync<bool>(
            "SELECT nix_local_set_password(@principal, @hash, @changed)",
            cancellationToken,
            NixParameter.Uuid("principal", principalId.Value),
            NixParameter.Text("hash", hash),
            new NpgsqlParameter("changed", NpgsqlDbType.Boolean) { Value = changed }).ConfigureAwait(false) ?? false;

    /// <inheritdoc />
    public async ValueTask<DateTimeOffset?> RegisterFailureAsync(PrincipalId principalId, CancellationToken cancellationToken)
    {
        var rows = await _db.RowsAsync(
            "SELECT nix_local_register_failure(@principal)",
            static reader => reader.IsDBNull(0) ? (DateTimeOffset?)null : new DateTimeOffset(reader.GetDateTime(0), TimeSpan.Zero),
            cancellationToken,
            NixParameter.Uuid("principal", principalId.Value)).ConfigureAwait(false);
        return rows.FirstOrDefault();
    }

    /// <inheritdoc />
    public async ValueTask ClearFailuresAsync(PrincipalId principalId, CancellationToken cancellationToken) =>
        _ = await _db.RowsAsync(
            "SELECT nix_local_clear_failures(@principal)",
            static _ => 0,
            cancellationToken,
            NixParameter.Uuid("principal", principalId.Value)).ConfigureAwait(false);

    /// <inheritdoc />
    public async ValueTask<int> RevokeSessionsAsync(PrincipalId principalId, BrowserSessionId? except, CancellationToken cancellationToken) =>
        await _db.ScalarAsync<int>(
            "SELECT nix_local_revoke_sessions(@principal, @except)",
            cancellationToken,
            NixParameter.Uuid("principal", principalId.Value),
            NixParameter.Uuid("except", except?.Value)).ConfigureAwait(false) ?? 0;

    /// <inheritdoc />
    public async ValueTask<TenantId?> SetupTenantAsync(CancellationToken cancellationToken) =>
        await _db.ScalarAsync<Guid>("SELECT nix_local_setup_tenant()", cancellationToken).ConfigureAwait(false) is { } id
            ? TenantId.From(id)
            : null;

    /// <inheritdoc />
    public async ValueTask<LocalSessionFacts?> FindSessionAsync(BrowserSessionId sessionId, CancellationToken cancellationToken) =>
        (await _db.RowsAsync(
            "SELECT is_cli, created_at FROM nix_local_session(@session)",
            static reader => new LocalSessionFacts(reader.GetBoolean(0), new DateTimeOffset(reader.GetDateTime(1), TimeSpan.Zero)),
            cancellationToken,
            NixParameter.Uuid("session", sessionId.Value)).ConfigureAwait(false)).FirstOrDefault();

    /// <inheritdoc />
    public async ValueTask<LocalHashMix> HashMixAsync(CancellationToken cancellationToken) =>
        (await _db.RowsAsync(
            "SELECT total, bcrypt, bcrypt_cost FROM nix_local_hash_mix()",
            static reader => new LocalHashMix(reader.GetInt32(0), reader.GetInt32(1), reader.GetInt32(2)),
            cancellationToken).ConfigureAwait(false)).FirstOrDefault();

    private static LocalAccountRecord Read(NpgsqlDataReader reader) => new(
        PrincipalId.From(reader.GetGuid(0)),
        TenantId.From(reader.GetGuid(1)),
        reader.IsDBNull(2) ? string.Empty : reader.GetString(2),
        reader.GetString(3),
        reader.GetString(4) switch
        {
            "active" => PrincipalStatus.Active,
            "suspended" => PrincipalStatus.Suspended,
            _ => PrincipalStatus.Deprovisioned,
        },
        reader.IsDBNull(5) ? null : reader.GetString(5),
        Instant(reader, 6),
        Instant(reader, 7),
        reader.GetBoolean(8),
        reader.GetInt32(9),
        reader.GetInt32(10));

    private static DateTimeOffset? Instant(NpgsqlDataReader reader, int ordinal) =>
        reader.IsDBNull(ordinal) ? null : new DateTimeOffset(reader.GetDateTime(ordinal), TimeSpan.Zero);
}
