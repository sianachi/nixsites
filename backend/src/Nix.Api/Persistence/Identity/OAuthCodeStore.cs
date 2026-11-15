using Nix.Abstractions;
using Npgsql;
using NpgsqlTypes;

namespace Nix.Persistence.Identity;

/// <summary>Capability-only Postgres I/O for <see cref="IOAuthCodes"/>.</summary>
public sealed class OAuthCodeStore(NpgsqlDataSource dataSource) : IOAuthCodes
{
    /// <inheritdoc />
    public async ValueTask<bool> CreateAsync(OAuthCodeRecord record, CancellationToken cancellationToken)
    {
        ArgumentNullException.ThrowIfNull(record);
        var connection = await dataSource.OpenConnectionAsync(cancellationToken).ConfigureAwait(false);
        await using (connection.ConfigureAwait(false))
        {
            var command = new NpgsqlCommand(
                "SELECT nix_create_oauth_code(@hash, @tenant, @principal, @client, @redirect, @challenge, @scopes, @resource, @expires)",
                connection);
            await using (command.ConfigureAwait(false))
            {
                command.Parameters.Add(new NpgsqlParameter("hash", NpgsqlDbType.Text) { Value = record.CodeHash });
                command.Parameters.Add(new NpgsqlParameter("tenant", NpgsqlDbType.Uuid) { Value = record.TenantId });
                command.Parameters.Add(new NpgsqlParameter("principal", NpgsqlDbType.Uuid) { Value = record.PrincipalId });
                command.Parameters.Add(new NpgsqlParameter("client", NpgsqlDbType.Text) { Value = record.ClientId });
                command.Parameters.Add(new NpgsqlParameter("redirect", NpgsqlDbType.Text) { Value = record.RedirectUri });
                command.Parameters.Add(new NpgsqlParameter("challenge", NpgsqlDbType.Text) { Value = record.Challenge });
                command.Parameters.Add(new NpgsqlParameter("scopes", NpgsqlDbType.Text) { Value = record.Scopes });
                command.Parameters.Add(new NpgsqlParameter("resource", NpgsqlDbType.Text) { Value = (object?)record.Resource ?? DBNull.Value });
                command.Parameters.Add(new NpgsqlParameter("expires", NpgsqlDbType.TimestampTz) { Value = record.ExpiresAt.UtcDateTime });
                return await command.ExecuteScalarAsync(cancellationToken).ConfigureAwait(false) is true;
            }
        }
    }

    /// <inheritdoc />
    public async ValueTask<OAuthCodeRecord?> ConsumeAsync(string codeHash, CancellationToken cancellationToken)
    {
        var connection = await dataSource.OpenConnectionAsync(cancellationToken).ConfigureAwait(false);
        await using (connection.ConfigureAwait(false))
        {
            var command = new NpgsqlCommand("SELECT * FROM nix_consume_oauth_code(@hash)", connection);
            await using (command.ConfigureAwait(false))
            {
                command.Parameters.Add(new NpgsqlParameter("hash", NpgsqlDbType.Text) { Value = codeHash });
                var reader = await command.ExecuteReaderAsync(cancellationToken).ConfigureAwait(false);
                await using (reader.ConfigureAwait(false))
                {
                    return await reader.ReadAsync(cancellationToken).ConfigureAwait(false)
                        ? new OAuthCodeRecord(
                            codeHash,
                            reader.GetGuid(0),
                            reader.GetGuid(1),
                            reader.GetString(2),
                            reader.GetString(3),
                            reader.GetString(4),
                            reader.GetString(5),
                            await reader.IsDBNullAsync(6, cancellationToken).ConfigureAwait(false) ? null : reader.GetString(6),
                            await reader.GetFieldValueAsync<DateTimeOffset>(7, cancellationToken).ConfigureAwait(false))
                        : null;
                }
            }
        }
    }
}
