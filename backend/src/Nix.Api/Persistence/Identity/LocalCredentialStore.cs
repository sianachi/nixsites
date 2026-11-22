using Microsoft.AspNetCore.DataProtection;
using Nix.Abstractions;
using Nix.Domain.Identity;
using Nix.Domain.Tenancy;
using Nix.Persistence.Sql;
using Npgsql;

namespace Nix.Persistence.Identity;

/// <summary>Postgres storage for passkeys and authenticator secrets. Secrets are encrypted with data protection.</summary>
public sealed class LocalCredentialStore(NpgsqlDataSource dataSource, IDataProtectionProvider dataProtection) : ILocalCredentials
{
    private readonly PooledSql _db = new(dataSource);
    private readonly IDataProtector _totp = dataProtection.CreateProtector("Nix.Auth.Totp.v1");

    /// <inheritdoc />
    public async ValueTask<LocalPasskeyOwner?> FindPasskeyAsync(byte[] credentialId, CancellationToken cancellationToken)
    {
        ArgumentNullException.ThrowIfNull(credentialId);
        var rows = await _db.RowsAsync(
            "SELECT id, principal_id, tenant_id, public_key, sign_count, rp_id, kind, status, display_name FROM nix_local_find_passkey(@id)",
            static reader => new LocalPasskeyOwner(
                reader.GetGuid(0),
                PrincipalId.From(reader.GetGuid(1)),
                TenantId.From(reader.GetGuid(2)),
                reader.GetFieldValue<byte[]>(3),
                reader.GetInt64(4),
                reader.GetString(5),
                Kind(reader.GetString(6)),
                reader.GetString(7) switch
                {
                    "active" => PrincipalStatus.Active,
                    "suspended" => PrincipalStatus.Suspended,
                    _ => PrincipalStatus.Deprovisioned,
                },
                reader.GetString(8)),
            cancellationToken,
            NixParameter.Bytes("id", credentialId)).ConfigureAwait(false);
        return rows.FirstOrDefault();
    }

    /// <inheritdoc />
    public async ValueTask<IReadOnlyList<LocalPasskeyRecord>> ListPasskeysAsync(PrincipalId principalId, CancellationToken cancellationToken) =>
        await _db.RowsAsync(
            "SELECT id, credential_id, public_key, sign_count, aaguid, transports, rp_id, kind, name, created_at, last_used_at FROM nix_local_list_passkeys(@principal)",
            static reader => new LocalPasskeyRecord(
                reader.GetGuid(0),
                reader.GetFieldValue<byte[]>(1),
                reader.GetFieldValue<byte[]>(2),
                reader.GetInt64(3),
                reader.IsDBNull(4) ? null : reader.GetGuid(4),
                reader.GetFieldValue<string[]>(5),
                reader.GetString(6),
                Kind(reader.GetString(7)),
                reader.GetString(8),
                new DateTimeOffset(reader.GetDateTime(9), TimeSpan.Zero),
                reader.IsDBNull(10) ? null : new DateTimeOffset(reader.GetDateTime(10), TimeSpan.Zero)),
            cancellationToken,
            NixParameter.Uuid("principal", principalId.Value)).ConfigureAwait(false);

    /// <inheritdoc />
    public async ValueTask<bool> AddPasskeyAsync(PrincipalId principalId, LocalPasskeyRecord passkey, CancellationToken cancellationToken)
    {
        ArgumentNullException.ThrowIfNull(passkey);
        return await _db.ScalarAsync<bool>(
            "SELECT nix_local_add_passkey(@id, @principal, @credential, @key, @count, @aaguid, @transports, @rp, @kind, @name)",
            cancellationToken,
            NixParameter.Uuid("id", passkey.Id),
            NixParameter.Uuid("principal", principalId.Value),
            NixParameter.Bytes("credential", passkey.CredentialId),
            NixParameter.Bytes("key", passkey.PublicKey),
            NixParameter.Int8("count", passkey.SignCount),
            NixParameter.Uuid("aaguid", passkey.Aaguid),
            NixParameter.TextArray("transports", passkey.Transports.ToArray()),
            NixParameter.Text("rp", passkey.RpId),
            NixParameter.Text("kind", passkey.Kind == LocalPasskeyKind.Passkey ? "passkey" : "security_key"),
            NixParameter.Text("name", passkey.Name)).ConfigureAwait(false) ?? false;
    }

    /// <inheritdoc />
    public async ValueTask TouchPasskeyAsync(Guid id, long signCount, CancellationToken cancellationToken) =>
        _ = await _db.RowsAsync(
            "SELECT nix_local_touch_passkey(@id, @count)",
            static _ => 0,
            cancellationToken,
            NixParameter.Uuid("id", id),
            NixParameter.Int8("count", signCount)).ConfigureAwait(false);

    /// <inheritdoc />
    public async ValueTask<bool> RenamePasskeyAsync(PrincipalId principalId, Guid id, string name, CancellationToken cancellationToken) =>
        await _db.ScalarAsync<bool>(
            "SELECT nix_local_rename_passkey(@principal, @id, @name)",
            cancellationToken,
            NixParameter.Uuid("principal", principalId.Value),
            NixParameter.Uuid("id", id),
            NixParameter.Text("name", name)).ConfigureAwait(false) ?? false;

    /// <inheritdoc />
    public async ValueTask<bool> RemovePasskeyAsync(PrincipalId principalId, Guid id, CancellationToken cancellationToken) =>
        await _db.ScalarAsync<bool>(
            "SELECT nix_local_remove_passkey(@principal, @id)",
            cancellationToken,
            NixParameter.Uuid("principal", principalId.Value),
            NixParameter.Uuid("id", id)).ConfigureAwait(false) ?? false;

    /// <inheritdoc />
    public async ValueTask<LocalTotpRecord?> GetTotpAsync(PrincipalId principalId, CancellationToken cancellationToken)
    {
        var rows = await _db.RowsAsync(
            "SELECT secret, confirmed_at, last_used_step FROM nix_local_get_totp(@principal)",
            reader => new LocalTotpRecord(
                Convert.FromBase64String(_totp.Unprotect(reader.GetString(0))),
                reader.IsDBNull(1) ? null : new DateTimeOffset(reader.GetDateTime(1), TimeSpan.Zero),
                reader.IsDBNull(2) ? null : reader.GetInt64(2)),
            cancellationToken,
            NixParameter.Uuid("principal", principalId.Value)).ConfigureAwait(false);
        return rows.FirstOrDefault();
    }

    /// <inheritdoc />
    public async ValueTask<bool> SetPendingTotpAsync(PrincipalId principalId, byte[] secret, CancellationToken cancellationToken)
    {
        ArgumentNullException.ThrowIfNull(secret);
        return await _db.ScalarAsync<bool>(
            "SELECT nix_local_set_totp(@principal, @secret)",
            cancellationToken,
            NixParameter.Uuid("principal", principalId.Value),
            NixParameter.Text("secret", _totp.Protect(Convert.ToBase64String(secret)))).ConfigureAwait(false) ?? false;
    }

    /// <inheritdoc />
    public async ValueTask<bool> ConfirmTotpAsync(PrincipalId principalId, long timeStep, CancellationToken cancellationToken) =>
        await _db.ScalarAsync<bool>(
            "SELECT nix_local_confirm_totp(@principal, @step)",
            cancellationToken,
            NixParameter.Uuid("principal", principalId.Value),
            NixParameter.Int8("step", timeStep)).ConfigureAwait(false) ?? false;

    /// <inheritdoc />
    public async ValueTask<bool> UseTotpStepAsync(PrincipalId principalId, long timeStep, CancellationToken cancellationToken) =>
        await _db.ScalarAsync<bool>(
            "SELECT nix_local_use_totp_step(@principal, @step)",
            cancellationToken,
            NixParameter.Uuid("principal", principalId.Value),
            NixParameter.Int8("step", timeStep)).ConfigureAwait(false) ?? false;

    /// <inheritdoc />
    public async ValueTask<bool> RemoveTotpAsync(PrincipalId principalId, CancellationToken cancellationToken) =>
        await _db.ScalarAsync<bool>(
            "SELECT nix_local_remove_totp(@principal)",
            cancellationToken,
            NixParameter.Uuid("principal", principalId.Value)).ConfigureAwait(false) ?? false;

    private static LocalPasskeyKind Kind(string value) =>
        value == "security_key" ? LocalPasskeyKind.SecurityKey : LocalPasskeyKind.Passkey;
}
