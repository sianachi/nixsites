using Nix.Abstractions;
using Nix.Domain.Identity;
using Nix.Domain.Tenancy;
using Npgsql;

namespace Nix.Persistence.Identity;

/// <summary>Postgres storage for one-time links and pending challenges.</summary>
public sealed class LocalAccountLinkStore(NpgsqlDataSource dataSource) : ILocalAccountLinks, ILocalChallenges
{
    private const string LinkColumns = "id, principal_id, tenant_id, purpose, email, display_name";
    private const string ChallengeColumns = "id, kind, principal_id, tenant_id, state, return_to, native, attempts";

    private readonly LocalSignInDb _db = new(dataSource);

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
            LocalSignInDb.Uuid("id", Guid.CreateVersion7()),
            LocalSignInDb.Uuid("principal", principalId.Value),
            LocalSignInDb.Text("purpose", purpose == LocalLinkPurpose.Setup ? "setup" : "reset"),
            LocalSignInDb.Text("hash", tokenHash),
            LocalSignInDb.Instant("expires", expiresAt),
            LocalSignInDb.Uuid("by", createdBy?.Value)).ConfigureAwait(false);

    /// <inheritdoc />
    public async ValueTask<LocalLinkRecord?> FindAsync(string tokenHash, CancellationToken cancellationToken) =>
        (await _db.RowsAsync(
            $"SELECT {LinkColumns} FROM nix_local_find_link(@hash)",
            ReadLink,
            cancellationToken,
            LocalSignInDb.Text("hash", tokenHash)).ConfigureAwait(false)).FirstOrDefault();

    /// <inheritdoc />
    public async ValueTask<LocalLinkRecord?> ConsumeAsync(string tokenHash, CancellationToken cancellationToken) =>
        (await _db.RowsAsync(
            $"SELECT {LinkColumns} FROM nix_local_consume_link(@hash)",
            ReadLink,
            cancellationToken,
            LocalSignInDb.Text("hash", tokenHash)).ConfigureAwait(false)).FirstOrDefault();

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
            LocalSignInDb.Uuid("id", id),
            LocalSignInDb.Text("kind", KindName(kind)),
            LocalSignInDb.Uuid("principal", principalId?.Value),
            LocalSignInDb.Text("state", state),
            LocalSignInDb.Text("return", returnTo),
            LocalSignInDb.Text("native", native),
            LocalSignInDb.Instant("expires", expiresAt)).ConfigureAwait(false);

    /// <inheritdoc />
    public async ValueTask<LocalChallenge?> GetAsync(Guid id, LocalChallengeKind kind, CancellationToken cancellationToken) =>
        (await _db.RowsAsync(
            $"SELECT {ChallengeColumns} FROM nix_local_get_challenge(@id, @kind)",
            ReadChallenge,
            cancellationToken,
            LocalSignInDb.Uuid("id", id),
            LocalSignInDb.Text("kind", KindName(kind))).ConfigureAwait(false)).FirstOrDefault();

    /// <inheritdoc />
    public async ValueTask<int> BumpAsync(Guid id, CancellationToken cancellationToken) =>
        await _db.ScalarAsync<int>(
            "SELECT nix_local_bump_challenge(@id)",
            cancellationToken,
            LocalSignInDb.Uuid("id", id)).ConfigureAwait(false);

    /// <inheritdoc />
    public async ValueTask<bool> SetStateAsync(Guid id, string state, CancellationToken cancellationToken) =>
        await _db.ScalarAsync<bool>(
            "SELECT nix_local_set_challenge_state(@id, @state)",
            cancellationToken,
            LocalSignInDb.Uuid("id", id),
            LocalSignInDb.Text("state", state)).ConfigureAwait(false);

    /// <inheritdoc />
    public async ValueTask<LocalChallenge?> TakeAsync(Guid id, LocalChallengeKind kind, CancellationToken cancellationToken) =>
        (await _db.RowsAsync(
            $"SELECT {ChallengeColumns} FROM nix_local_take_challenge(@id, @kind)",
            ReadChallenge,
            cancellationToken,
            LocalSignInDb.Uuid("id", id),
            LocalSignInDb.Text("kind", KindName(kind))).ConfigureAwait(false)).FirstOrDefault();

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
