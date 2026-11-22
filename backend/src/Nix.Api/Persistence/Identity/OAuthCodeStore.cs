using Nix.Abstractions;
using Nix.Persistence.Sql;
using Npgsql;

namespace Nix.Persistence.Identity;

/// <summary>Capability-only Postgres I/O for <see cref="IOAuthCodes"/>.</summary>
public sealed class OAuthCodeStore(NpgsqlDataSource dataSource) : IOAuthCodes
{
    private readonly PooledSql _db = new(dataSource);

    /// <inheritdoc />
    public async ValueTask<bool> CreateAsync(OAuthCodeRecord record, CancellationToken cancellationToken)
    {
        ArgumentNullException.ThrowIfNull(record);
        return await _db.ScalarAsync<bool>(
            "SELECT nix_create_oauth_code(@hash, @tenant, @principal, @client, @redirect, @challenge, @scopes, @resource, @expires)",
            cancellationToken,
            NixParameter.Text("hash", record.CodeHash),
            NixParameter.Uuid("tenant", record.TenantId),
            NixParameter.Uuid("principal", record.PrincipalId),
            NixParameter.Text("client", record.ClientId),
            NixParameter.Text("redirect", record.RedirectUri),
            NixParameter.Text("challenge", record.Challenge),
            NixParameter.Text("scopes", record.Scopes),
            NixParameter.Text("resource", record.Resource),
            NixParameter.Instant("expires", record.ExpiresAt)).ConfigureAwait(false) is true;
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
            NixParameter.Text("hash", codeHash)).ConfigureAwait(false)).FirstOrDefault();
}
