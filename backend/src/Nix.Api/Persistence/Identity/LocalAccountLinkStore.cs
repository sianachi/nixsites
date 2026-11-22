using Nix.Abstractions;
using Nix.Domain.Identity;
using Nix.Domain.Tenancy;
using Nix.Persistence.Sql;
using Npgsql;

namespace Nix.Persistence.Identity;

/// <summary>Postgres storage for one-time links and pending challenges.</summary>
public sealed class LocalAccountLinkStore(NpgsqlDataSource dataSource) : ILocalAccountLinks, ILocalChallenges
{
    private const string LinkColumns = "id, principal_id, tenant_id, purpose, email, display_name";
    private const string ChallengeColumns = "id, kind, principal_id, tenant_id, state, return_to, native, attempts";

    private readonly PooledSql _db = new(dataSource);

    /// <inheritdoc />
    public async ValueTask<bool> CreateAsync(
        PrincipalId principalId,
        LocalLinkPurpose purpose,
        string tokenHash,
        DateTimeOffset expiresAt,
        PrincipalId? createdBy,
        CancellationToken cancellationToken) =>
        await _db.ScalarAsync<bool>(
            "SELECT nix_local_create_link(@id, @principal, @purpose, @hash, @expires, @by)",
            cancellationToken,
            NixParameter.Uuid("id", Guid.CreateVersion7()),
            NixParameter.Uuid("principal", principalId.Value),
            NixParameter.Text("purpose", purpose == LocalLinkPurpose.Setup ? "setup" : "reset"),
            NixParameter.Text("hash", tokenHash),
            NixParameter.Instant("expires", expiresAt),
            NixParameter.Uuid("by", createdBy?.Value)).ConfigureAwait(false) ?? false;

    /// <inheritdoc />
    public async ValueTask<LocalLinkRecord?> FindAsync(string tokenHash, CancellationToken cancellationToken) =>
        (await _db.RowsAsync(
            $"SELECT {LinkColumns} FROM nix_local_find_link(@hash)",
            ReadLink,
            cancellationToken,
            NixParameter.Text("hash", tokenHash)).ConfigureAwait(false)).FirstOrDefault();

    /// <inheritdoc />
    public async ValueTask<LocalLinkRecord?> ConsumeAsync(string tokenHash, CancellationToken cancellationToken) =>
        (await _db.RowsAsync(
            $"SELECT {LinkColumns} FROM nix_local_consume_link(@hash)",
            ReadLink,
            cancellationToken,
            NixParameter.Text("hash", tokenHash)).ConfigureAwait(false)).FirstOrDefault();

    /// <inheritdoc />
    public async ValueTask<bool> CreateAsync(
        Guid id,
        LocalChallengeKind kind,
        PrincipalId? principalId,
        string? state,
        string? returnTo,
        string? native,
        DateTimeOffset expiresAt,
        CancellationToken cancellationToken) =>
        await _db.ScalarAsync<bool>(
            "SELECT nix_local_create_challenge(@id, @kind, @principal, @state, @return, @native, @expires)",
            cancellationToken,
            NixParameter.Uuid("id", id),
            NixParameter.Text("kind", KindName(kind)),
            NixParameter.Uuid("principal", principalId?.Value),
            NixParameter.Text("state", state),
            NixParameter.Text("return", returnTo),
            NixParameter.Text("native", native),
            NixParameter.Instant("expires", expiresAt)).ConfigureAwait(false) ?? false;

    /// <inheritdoc />
    public async ValueTask<LocalChallenge?> GetAsync(Guid id, LocalChallengeKind kind, CancellationToken cancellationToken) =>
        (await _db.RowsAsync(
            $"SELECT {ChallengeColumns} FROM nix_local_get_challenge(@id, @kind)",
            ReadChallenge,
            cancellationToken,
            NixParameter.Uuid("id", id),
            NixParameter.Text("kind", KindName(kind))).ConfigureAwait(false)).FirstOrDefault();

    /// <inheritdoc />
    public async ValueTask<int> BumpAsync(Guid id, CancellationToken cancellationToken) =>
        await _db.ScalarAsync<int>(
            "SELECT nix_local_bump_challenge(@id)",
            cancellationToken,
            NixParameter.Uuid("id", id)).ConfigureAwait(false) ?? 0;

    /// <inheritdoc />
    public async ValueTask<bool> SetStateAsync(Guid id, string state, CancellationToken cancellationToken) =>
        await _db.ScalarAsync<bool>(
            "SELECT nix_local_set_challenge_state(@id, @state)",
            cancellationToken,
            NixParameter.Uuid("id", id),
            NixParameter.Text("state", state)).ConfigureAwait(false) ?? false;

    /// <inheritdoc />
    public async ValueTask<LocalChallenge?> TakeAsync(Guid id, LocalChallengeKind kind, CancellationToken cancellationToken) =>
        (await _db.RowsAsync(
            $"SELECT {ChallengeColumns} FROM nix_local_take_challenge(@id, @kind)",
            ReadChallenge,
            cancellationToken,
            NixParameter.Uuid("id", id),
            NixParameter.Text("kind", KindName(kind))).ConfigureAwait(false)).FirstOrDefault();

    private static string KindName(LocalChallengeKind kind) => kind switch
    {
        LocalChallengeKind.SecondStep => "second_step",
        LocalChallengeKind.PasskeySignIn => "passkey_sign_in",
        LocalChallengeKind.LinkPasskey => "link_passkey",
        _ => "add_passkey",
    };

    private static LocalChallengeKind ParseKind(string name) => name switch
    {
        "second_step" => LocalChallengeKind.SecondStep,
        "passkey_sign_in" => LocalChallengeKind.PasskeySignIn,
        "link_passkey" => LocalChallengeKind.LinkPasskey,
        _ => LocalChallengeKind.AddPasskey,
    };

    private static LocalLinkRecord ReadLink(NpgsqlDataReader reader) => new(
        reader.GetGuid(0),
        PrincipalId.From(reader.GetGuid(1)),
        TenantId.From(reader.GetGuid(2)),
        reader.GetString(3) == "setup" ? LocalLinkPurpose.Setup : LocalLinkPurpose.Reset,
        reader.IsDBNull(4) ? null : reader.GetString(4),
        reader.GetString(5));

    private static LocalChallenge ReadChallenge(NpgsqlDataReader reader) => new(
        reader.GetGuid(0),
        ParseKind(reader.GetString(1)),
        reader.IsDBNull(2) ? null : PrincipalId.From(reader.GetGuid(2)),
        reader.IsDBNull(3) ? null : TenantId.From(reader.GetGuid(3)),
        reader.IsDBNull(4) ? null : reader.GetString(4),
        reader.IsDBNull(5) ? null : reader.GetString(5),
        reader.IsDBNull(6) ? null : reader.GetString(6),
        reader.GetInt32(7));
}
