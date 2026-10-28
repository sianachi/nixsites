using System.Data;
using System.Diagnostics.CodeAnalysis;
using System.Runtime.CompilerServices;
using Microsoft.EntityFrameworkCore;
using Microsoft.EntityFrameworkCore.Storage;
using Npgsql;

namespace Nix.Persistence.Sql;

/// <summary>
/// Runs the hand-written SQL - closure maintenance, permission predicates, search - on the same
/// connection and transaction as <see cref="NixDbContext"/>.
/// </summary>
/// <remarks>
/// <para>
/// <b>Why it borrows the context's connection instead of opening its own.</b> The tenant scope is
/// published with <c>SET LOCAL</c>, which is transaction-local. Hand-written SQL on a second
/// connection would be a second session with no session context at all, and the row-level
/// security policies would answer it with nothing - or, on a table someone had not yet protected,
/// with everything. Sharing EF's transaction means the SQL below runs under exactly the tenant
/// the interceptor established, with no second mechanism to keep in step.
/// </para>
/// <para>
/// <b>Where the SQL itself lives.</b> Under <c>Persistence/Sql/Statements</c>, one static class
/// per area, each statement a <c>const string</c> with a comment naming the indexes it depends
/// on. Never inline at the call site, never assembled from fragments at runtime, never
/// interpolated: values are bound as <see cref="NpgsqlParameter"/> without exception. New
/// statements touching <c>item_closure</c>, <c>acl_entry</c>, or <c>item_search</c> arrive with
/// <c>EXPLAIN</c> output in the pull request.
/// </para>
/// <para>
/// <b>Memory posture.</b> Readers are opened with <see cref="CommandBehavior.SequentialAccess"/>
/// and results are yielded row by row as <see cref="IAsyncEnumerable{T}"/> - no result list is
/// built unless a caller asks for one. Binary columns are streamed through
/// <see cref="OpenColumnStreamAsync"/>; nothing here returns a <c>byte[]</c>.
/// </para>
/// </remarks>
public sealed class NixSqlExecutor(NixDbContext dbContext)
{
    /// <summary>
    /// Streams the rows of <paramref name="sql"/>, mapping each with <paramref name="mapper"/>.
    /// </summary>
    /// <typeparam name="TRow">The mapped row type.</typeparam>
    /// <typeparam name="TMapper">
    /// The mapper type. Pass a <see langword="struct"/> mapper on hot paths so the call is
    /// devirtualised and nothing is allocated per row.
    /// </typeparam>
    /// <param name="sql">A statement from <c>Persistence/Sql/Statements</c>.</param>
    /// <param name="mapper">Maps the current row.</param>
    /// <param name="parameters">Values bound to the statement, or <see langword="null"/>.</param>
    /// <param name="cancellationToken">Cancels the query and the enumeration.</param>
    /// <returns>The rows, produced as the server sends them.</returns>
    public async IAsyncEnumerable<TRow> QueryAsync<TRow, TMapper>(
        string sql,
        TMapper mapper,
        NpgsqlParameter[]? parameters = null,
        [EnumeratorCancellation] CancellationToken cancellationToken = default)
        where TMapper : INixRowMapper<TRow>
    {
        ArgumentException.ThrowIfNullOrWhiteSpace(sql);

        var command = await CreateCommandAsync(sql, parameters, cancellationToken).ConfigureAwait(false);
        await using (command.ConfigureAwait(false))
        {
            var reader = await command
                .ExecuteReaderAsync(
                    CommandBehavior.SequentialAccess | CommandBehavior.SingleResult,
                    cancellationToken)
                .ConfigureAwait(false);

            await using (reader.ConfigureAwait(false))
            {
                while (await reader.ReadAsync(cancellationToken).ConfigureAwait(false))
                {
                    yield return mapper.Map(reader);
                }
            }
        }
    }

    /// <summary>
    /// Reads the first column of the first row, or <see langword="default"/> when the statement
    /// returns no row or a null.
    /// </summary>
    /// <typeparam name="TValue">The column's CLR type.</typeparam>
    /// <param name="sql">A statement from <c>Persistence/Sql/Statements</c>.</param>
    /// <param name="parameters">Values bound to the statement, or <see langword="null"/>.</param>
    /// <param name="cancellationToken">Cancels the query.</param>
    /// <returns>The value, or <see langword="default"/>.</returns>
    /// <remarks>
    /// Uses a reader rather than <c>ExecuteScalar</c> so value types are not boxed on the way out.
    /// </remarks>
    public async ValueTask<TValue?> ScalarOrDefaultAsync<TValue>(
        string sql,
        NpgsqlParameter[]? parameters = null,
        CancellationToken cancellationToken = default)
    {
        ArgumentException.ThrowIfNullOrWhiteSpace(sql);

        var command = await CreateCommandAsync(sql, parameters, cancellationToken).ConfigureAwait(false);
        await using (command.ConfigureAwait(false))
        {
            var reader = await command
                .ExecuteReaderAsync(
                    CommandBehavior.SequentialAccess | CommandBehavior.SingleRow,
                    cancellationToken)
                .ConfigureAwait(false);

            await using (reader.ConfigureAwait(false))
            {
                if (!await reader.ReadAsync(cancellationToken).ConfigureAwait(false))
                {
                    return default;
                }

                if (await reader.IsDBNullAsync(0, cancellationToken).ConfigureAwait(false))
                {
                    return default;
                }

                return await reader.GetFieldValueAsync<TValue>(0, cancellationToken).ConfigureAwait(false);
            }
        }
    }

    /// <summary>
    /// Executes a statement that returns no rows.
    /// </summary>
    /// <param name="sql">A statement from <c>Persistence/Sql/Statements</c>.</param>
    /// <param name="parameters">Values bound to the statement, or <see langword="null"/>.</param>
    /// <param name="cancellationToken">Cancels the statement.</param>
    /// <returns>The number of rows affected.</returns>
    public async ValueTask<int> ExecuteAsync(
        string sql,
        NpgsqlParameter[]? parameters = null,
        CancellationToken cancellationToken = default)
    {
        ArgumentException.ThrowIfNullOrWhiteSpace(sql);

        var command = await CreateCommandAsync(sql, parameters, cancellationToken).ConfigureAwait(false);
        await using (command.ConfigureAwait(false))
        {
            return await command.ExecuteNonQueryAsync(cancellationToken).ConfigureAwait(false);
        }
    }

    /// <summary>
    /// Opens a stream over one binary column of the first row.
    /// </summary>
    /// <param name="sql">
    /// A statement from <c>Persistence/Sql/Statements</c> projecting the binary column last, so
    /// sequential access reaches it after every other column has been read.
    /// </param>
    /// <param name="columnOrdinal">The zero-based index of the binary column.</param>
    /// <param name="parameters">Values bound to the statement, or <see langword="null"/>.</param>
    /// <param name="cancellationToken">Cancels the query.</param>
    /// <returns>
    /// The open stream and the resources behind it, or <see langword="null"/> when the statement
    /// returned no row. The caller disposes.
    /// </returns>
    /// <remarks>
    /// This is the only sanctioned way to read a <c>bytea</c> column. Copy it into whatever sink
    /// needs it - a response body, a hash, a pooled buffer - without ever holding the payload.
    /// </remarks>
    public async ValueTask<NixBinaryColumn?> OpenColumnStreamAsync(
        string sql,
        int columnOrdinal,
        NpgsqlParameter[]? parameters = null,
        CancellationToken cancellationToken = default)
    {
        ArgumentException.ThrowIfNullOrWhiteSpace(sql);
        ArgumentOutOfRangeException.ThrowIfNegative(columnOrdinal);

        var command = await CreateCommandAsync(sql, parameters, cancellationToken).ConfigureAwait(false);
        NpgsqlDataReader? reader = null;

        // Ownership of the command and the reader transfers to NixBinaryColumn on success only;
        // on any other path this method disposes both, so a failed open never leaks a busy reader
        // onto the shared transaction.
        var ownershipTransferred = false;
        try
        {
            reader = await command
                .ExecuteReaderAsync(
                    CommandBehavior.SequentialAccess | CommandBehavior.SingleRow,
                    cancellationToken)
                .ConfigureAwait(false);

            if (!await reader.ReadAsync(cancellationToken).ConfigureAwait(false))
            {
                return null;
            }

            var value = await reader.GetStreamAsync(columnOrdinal, cancellationToken).ConfigureAwait(false);
            ownershipTransferred = true;
            return new NixBinaryColumn(command, reader, value);
        }
        finally
        {
            if (!ownershipTransferred)
            {
                if (reader is not null)
                {
                    await reader.DisposeAsync().ConfigureAwait(false);
                }

                await command.DisposeAsync().ConfigureAwait(false);
            }
        }
    }

#pragma warning disable CA2100 // Review SQL queries for security vulnerabilities
    // Justification: this is the single execution path for hand-written SQL, and the analyzer
    // cannot see through the indirection to the call sites. The convention it cannot verify is
    // stated on the type and enforced in review: statement text is a const string in
    // Persistence/Sql/Statements, and every value is bound as an NpgsqlParameter. No caller
    // concatenates or interpolates.
    private async ValueTask<NpgsqlCommand> CreateCommandAsync(
        string sql,
        NpgsqlParameter[]? parameters,
        CancellationToken cancellationToken)
    {
        var connection = await GetOpenConnectionAsync(cancellationToken).ConfigureAwait(false);
        var transaction = RequireTransaction();

        var command = new NpgsqlCommand(sql, connection, transaction);
        if (parameters is not null)
        {
            foreach (var parameter in parameters)
            {
                command.Parameters.Add(parameter);
            }
        }

        return command;
    }
#pragma warning restore CA2100

    [SuppressMessage(
        "Reliability",
        "CA2000:Dispose objects before losing scope",
        Justification = "The connection is owned by the DbContext, which disposes it with the scope.")]
    private async ValueTask<NpgsqlConnection> GetOpenConnectionAsync(CancellationToken cancellationToken)
    {
        if (dbContext.Database.GetDbConnection() is not NpgsqlConnection connection)
        {
            throw new InvalidOperationException(
                "Hand-written SQL requires the Npgsql provider. The context is configured with a " +
                "different provider, so the connection cannot be shared.");
        }

        if (connection.State != ConnectionState.Open)
        {
            await dbContext.Database.OpenConnectionAsync(cancellationToken).ConfigureAwait(false);
        }

        return connection;
    }

    private NpgsqlTransaction RequireTransaction()
    {
        var current = dbContext.Database.CurrentTransaction
            ?? throw new InvalidOperationException(
                "Refusing to run hand-written SQL outside a transaction. The RLS session context " +
                "is published with SET LOCAL and exists only inside one, so this statement would " +
                "be evaluated with no tenant. Open a transaction on the context first and run " +
                "the SQL inside it.");

        if (current.GetDbTransaction() is not NpgsqlTransaction transaction)
        {
            throw new InvalidOperationException(
                "The context's current transaction is not an Npgsql transaction; hand-written " +
                "SQL cannot enlist in it.");
        }

        return transaction;
    }
}
