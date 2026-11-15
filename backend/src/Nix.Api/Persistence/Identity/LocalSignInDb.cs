using Npgsql;
using NpgsqlTypes;

namespace Nix.Persistence.Identity;

/// <summary>
/// Calls the <c>nix_local_*</c> security-definer functions on their own short connection. They run before a
/// tenant is known (an email, a link token, a credential id), so like the identity directory they sit
/// outside the unit of work; each statement is a constant and every value is bound.
/// </summary>
internal sealed class LocalSignInDb(NpgsqlDataSource dataSource)
{
    internal static NpgsqlParameter Uuid(string name, Guid? value) =>
        new(name, NpgsqlDbType.Uuid) { Value = value is { } v ? v : DBNull.Value };

    internal static NpgsqlParameter Text(string name, string? value) =>
        new(name, NpgsqlDbType.Text) { Value = value is null ? DBNull.Value : value };

    internal static NpgsqlParameter Bytes(string name, ReadOnlyMemory<byte> value) =>
        new(name, NpgsqlDbType.Bytea) { Value = value.ToArray() };

    internal static NpgsqlParameter Int8(string name, long value) =>
        new(name, NpgsqlDbType.Bigint) { Value = value };

    internal static NpgsqlParameter Instant(string name, DateTimeOffset value) =>
        new(name, NpgsqlDbType.TimestampTz) { Value = value.UtcDateTime };

    /// <summary>Runs a statement and returns the first column of the first row, or default.</summary>
    internal async ValueTask<T?> ScalarAsync<T>(string sql, CancellationToken cancellationToken, params NpgsqlParameter[] parameters)
    {
        var rows = await RowsAsync(sql, static reader => reader.IsDBNull(0) ? default : reader.GetFieldValue<T>(0), cancellationToken, parameters)
            .ConfigureAwait(false);
        return rows.Count == 0 ? default : rows[0];
    }

    /// <summary>Runs a statement and maps every row.</summary>
    internal async ValueTask<List<T>> RowsAsync<T>(
        string sql,
        Func<NpgsqlDataReader, T> map,
        CancellationToken cancellationToken,
        params NpgsqlParameter[] parameters)
    {
        var connection = await dataSource.OpenConnectionAsync(cancellationToken).ConfigureAwait(false);
        await using (connection.ConfigureAwait(false))
        {
#pragma warning disable CA2100 // Review SQL queries for security vulnerabilities
            // Justification: every caller passes a constant statement; the values are bound.
            var command = new NpgsqlCommand(sql, connection);
#pragma warning restore CA2100
            await using (command.ConfigureAwait(false))
            {
                command.Parameters.AddRange(parameters);
                var reader = await command.ExecuteReaderAsync(cancellationToken).ConfigureAwait(false);
                await using (reader.ConfigureAwait(false))
                {
                    var rows = new List<T>();
                    while (await reader.ReadAsync(cancellationToken).ConfigureAwait(false))
                    {
                        rows.Add(map(reader));
                    }

                    return rows;
                }
            }
        }
    }
}
