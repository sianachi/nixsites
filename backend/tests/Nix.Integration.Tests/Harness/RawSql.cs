using Npgsql;

namespace Nix.Integration.Tests.Harness;

/// <summary>
/// Raw Npgsql helpers for assertions that must deliberately sit outside the application's
/// execution path - reading a session setting after the transaction that set it, or issuing the
/// plain <c>SET</c> the production code refuses to emit.
/// </summary>
internal static class RawSql
{
#pragma warning disable CA2100 // Review SQL queries for security vulnerabilities
    // Justification: test-only helpers. Callers pass const statement text from this assembly;
    // where a value varies it is a Guid rendered by the caller, never external input.
    private static NpgsqlCommand Create(NpgsqlConnection connection, NpgsqlTransaction? transaction, string sql) =>
        new(sql, connection, transaction);
#pragma warning restore CA2100

    /// <summary>Renders a Guid as a SQL uuid literal, for statements built from fixture ids.</summary>
    public static string Literal(Guid value) => $"'{value:D}'::uuid";

    /// <summary>Executes a statement.</summary>
    /// <param name="connection">An open connection.</param>
    /// <param name="transaction">The enclosing transaction, or <see langword="null"/>.</param>
    /// <param name="sql">The statement.</param>
    /// <param name="commandTimeoutSeconds">Optional bounded allowance for bulk fixture setup.</param>
    /// <returns>Rows affected.</returns>
    public static async Task<int> ExecuteAsync(
        NpgsqlConnection connection,
        NpgsqlTransaction? transaction,
        string sql,
        int? commandTimeoutSeconds = null)
    {
        var command = Create(connection, transaction, sql);
        if (commandTimeoutSeconds is { } timeout)
        {
            command.CommandTimeout = timeout;
        }
        await using (command.ConfigureAwait(false))
        {
            return await command.ExecuteNonQueryAsync();
        }
    }

    /// <summary>Reads the first column of the first row as text, or null.</summary>
    /// <param name="connection">An open connection.</param>
    /// <param name="transaction">The enclosing transaction, or <see langword="null"/>.</param>
    /// <param name="sql">The statement.</param>
    /// <returns>The value, or <see langword="null"/>.</returns>
    public static async Task<string?> TextAsync(
        NpgsqlConnection connection,
        NpgsqlTransaction? transaction,
        string sql)
    {
        var command = Create(connection, transaction, sql);
        await using (command.ConfigureAwait(false))
        {
            var value = await command.ExecuteScalarAsync();
            return value is null or DBNull ? null : (string)value;
        }
    }

    /// <summary>Reads the first column of the first row as a boolean, or null.</summary>
    /// <param name="connection">An open connection.</param>
    /// <param name="sql">The statement.</param>
    /// <returns>The value, or <see langword="null"/>.</returns>
    public static async Task<bool?> BooleanAsync(NpgsqlConnection connection, string sql)
    {
        var command = Create(connection, transaction: null, sql);
        await using (command.ConfigureAwait(false))
        {
            var value = await command.ExecuteScalarAsync();
            return value is null or DBNull ? null : (bool)value;
        }
    }

    /// <summary>Reads a single text column into a list.</summary>
    /// <param name="connection">An open connection.</param>
    /// <param name="sql">The statement.</param>
    /// <returns>The values, in the statement's order.</returns>
    public static async Task<IReadOnlyList<string>> TextListAsync(NpgsqlConnection connection, string sql)
    {
        var values = new List<string>();

        var command = Create(connection, transaction: null, sql);
        await using (command.ConfigureAwait(false))
        {
            var reader = await command.ExecuteReaderAsync();
            await using (reader.ConfigureAwait(false))
            {
                while (await reader.ReadAsync())
                {
                    values.Add(reader.GetString(0));
                }
            }
        }

        return values;
    }

    /// <summary>Counts rows, inside a transaction when one is supplied.</summary>
    /// <param name="connection">An open connection.</param>
    /// <param name="transaction">The enclosing transaction, or <see langword="null"/>.</param>
    /// <param name="sql">A statement whose first column is a count.</param>
    /// <returns>The count.</returns>
    public static async Task<long> CountAsync(
        NpgsqlConnection connection,
        NpgsqlTransaction? transaction,
        string sql)
    {
        var command = Create(connection, transaction, sql);
        await using (command.ConfigureAwait(false))
        {
            return (long)(await command.ExecuteScalarAsync())!;
        }
    }

    /// <summary>Reads a single uuid column into a list, inside a transaction when one is supplied.</summary>
    /// <param name="connection">An open connection.</param>
    /// <param name="transaction">The enclosing transaction, or <see langword="null"/>.</param>
    /// <param name="sql">The statement.</param>
    /// <returns>The values, in the statement's order.</returns>
    public static async Task<IReadOnlyList<Guid>> GuidListAsync(
        NpgsqlConnection connection,
        NpgsqlTransaction? transaction,
        string sql)
    {
        var values = new List<Guid>();

        var command = Create(connection, transaction, sql);
        await using (command.ConfigureAwait(false))
        {
            var reader = await command.ExecuteReaderAsync();
            await using (reader.ConfigureAwait(false))
            {
                while (await reader.ReadAsync())
                {
                    values.Add(reader.GetGuid(0));
                }
            }
        }

        return values;
    }

    /// <summary>Reads this session's backend process id, identifying the physical connection.</summary>
    /// <param name="connection">An open connection.</param>
    /// <param name="transaction">The enclosing transaction, or <see langword="null"/>.</param>
    /// <returns>The backend process id.</returns>
    public static async Task<int> BackendProcessIdAsync(
        NpgsqlConnection connection,
        NpgsqlTransaction? transaction = null)
    {
        var command = Create(connection, transaction, "SELECT pg_backend_pid()");
        await using (command.ConfigureAwait(false))
        {
            return (int)(await command.ExecuteScalarAsync())!;
        }
    }
}
