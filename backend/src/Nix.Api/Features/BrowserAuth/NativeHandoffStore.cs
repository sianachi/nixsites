using Npgsql;
using NpgsqlTypes;

namespace Nix.Features.BrowserAuth;

/// <summary>Durable, single-use native sign-in handoffs; only hashes and protected payloads are stored.</summary>
public interface INativeHandoffs
{
    /// <summary>Stores a handoff; false when the bounded table is full.</summary>
    public ValueTask<bool> CreateAsync(string codeHash, string challenge, string payload, DateTimeOffset expiresAt, CancellationToken cancellationToken);

    /// <summary>Atomically removes and returns a handoff, whether or not it has expired; null when unknown or used.</summary>
    public ValueTask<NativeHandoffRecord?> ConsumeAsync(string codeHash, CancellationToken cancellationToken);
}

/// <summary>A consumed handoff row.</summary>
public sealed record NativeHandoffRecord(string Challenge, string Payload, DateTimeOffset ExpiresAt);

/// <summary>Capability-only Postgres I/O for <see cref="INativeHandoffs"/>.</summary>
public sealed class NativeHandoffStore(NpgsqlDataSource dataSource) : INativeHandoffs
{
    /// <inheritdoc />
    public async ValueTask<bool> CreateAsync(string codeHash, string challenge, string payload, DateTimeOffset expiresAt, CancellationToken cancellationToken)
    {
        var connection = await dataSource.OpenConnectionAsync(cancellationToken).ConfigureAwait(false);
        await using (connection.ConfigureAwait(false))
        {
            var command = new NpgsqlCommand("SELECT nix_create_native_handoff(@hash, @challenge, @payload, @expires)", connection);
            await using (command.ConfigureAwait(false))
            {
                command.Parameters.Add(new NpgsqlParameter("hash", NpgsqlDbType.Text) { Value = codeHash });
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
