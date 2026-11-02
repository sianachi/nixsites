using Nix.Abstractions;
using Npgsql;
using NpgsqlTypes;

namespace Nix.Persistence.Identity;

/// <summary>Capability-only Postgres I/O for <see cref="INativeHandoffs"/>.</summary>
public sealed class NativeHandoffStore(NpgsqlDataSource dataSource) : INativeHandoffs
{
    /// <inheritdoc />
    public async ValueTask<bool> CreateAsync(string codeHash, Guid principalId, string challenge, string payload, DateTimeOffset expiresAt, CancellationToken cancellationToken)
    {
        var connection = await dataSource.OpenConnectionAsync(cancellationToken).ConfigureAwait(false);
        await using (connection.ConfigureAwait(false))
        {
            var command = new NpgsqlCommand("SELECT nix_create_native_handoff(@hash, @principal, @challenge, @payload, @expires)", connection);
            await using (command.ConfigureAwait(false))
            {
                command.Parameters.Add(new NpgsqlParameter("hash", NpgsqlDbType.Text) { Value = codeHash });
                command.Parameters.Add(new NpgsqlParameter("principal", NpgsqlDbType.Uuid) { Value = principalId });
                command.Parameters.Add(new NpgsqlParameter("challenge", NpgsqlDbType.Text) { Value = challenge });
                command.Parameters.Add(new NpgsqlParameter("payload", NpgsqlDbType.Text) { Value = payload });
                command.Parameters.Add(new NpgsqlParameter("expires", NpgsqlDbType.TimestampTz) { Value = expiresAt.UtcDateTime });
                return await command.ExecuteScalarAsync(cancellationToken).ConfigureAwait(false) is true;
            }
        }
    }

    /// <inheritdoc />
    public async ValueTask<NativeHandoffRecord?> ConsumeAsync(string codeHash, CancellationToken cancellationToken)
    {
        var connection = await dataSource.OpenConnectionAsync(cancellationToken).ConfigureAwait(false);
        await using (connection.ConfigureAwait(false))
        {
            var command = new NpgsqlCommand("SELECT * FROM nix_consume_native_handoff(@hash)", connection);
            await using (command.ConfigureAwait(false))
            {
                command.Parameters.Add(new NpgsqlParameter("hash", NpgsqlDbType.Text) { Value = codeHash });
                var reader = await command.ExecuteReaderAsync(cancellationToken).ConfigureAwait(false);
                await using (reader.ConfigureAwait(false))
                {
                    return await reader.ReadAsync(cancellationToken).ConfigureAwait(false)
                        ? new NativeHandoffRecord(
                            reader.GetString(0),
                            reader.GetString(1),
                            await reader.GetFieldValueAsync<DateTimeOffset>(2, cancellationToken).ConfigureAwait(false))
                        : null;
                }
            }
        }
    }
}
