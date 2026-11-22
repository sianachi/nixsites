using Nix.Abstractions;
using Npgsql;

namespace Nix.Persistence.Identity;

/// <summary>Capability-only Postgres I/O for <see cref="IOAuthCodes"/>.</summary>
public sealed class OAuthCodeStore(NpgsqlDataSource dataSource) : IOAuthCodes
{
    private readonly LocalSignInDb _db = new(dataSource);

    /// <inheritdoc />
    public async ValueTask<bool> CreateAsync(OAuthCodeRecord record, CancellationToken cancellationToken)
    {
        ArgumentNullException.ThrowIfNull(record);
        return await _db.ScalarAsync<bool>(
            "SELECT nix_create_oauth_code(@hash, @tenant, @principal, @client, @redirect, @challenge, @scopes, @resource, @expires)",
            cancellationToken,
            LocalSignInDb.Text("hash", record.CodeHash),
            LocalSignInDb.Uuid("tenant", record.TenantId),
            LocalSignInDb.Uuid("principal", record.PrincipalId),
            LocalSignInDb.Text("client", record.ClientId),
            LocalSignInDb.Text("redirect", record.RedirectUri),
            LocalSignInDb.Text("challenge", record.Challenge),
            LocalSignInDb.Text("scopes", record.Scopes),
            LocalSignInDb.Text("resource", record.Resource),
            LocalSignInDb.Instant("expires", record.ExpiresAt)).ConfigureAwait(false) is true;
    }

    /// <inheritdoc />
    public async ValueTask<OAuthCodeRecord?> ConsumeAsync(string codeHash, CancellationToken cancellationToken) =>
        (await _db.RowsAsync(
            "SELECT * FROM nix_consume_oauth_code(@hash)",
            reader => new OAuthCodeRecord(
                codeHash,
                reader.GetGuid(0),
                reader.GetGuid(1),
                reader.GetString(2),
                reader.GetString(3),
                reader.GetString(4),
                reader.GetString(5),
                reader.IsDBNull(6) ? null : reader.GetString(6),
                reader.GetFieldValue<DateTimeOffset>(7)),
            cancellationToken,
            LocalSignInDb.Text("hash", codeHash)).ConfigureAwait(false)).FirstOrDefault();
}
