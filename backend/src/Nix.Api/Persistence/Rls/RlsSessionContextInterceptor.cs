using System.Data.Common;
using Microsoft.EntityFrameworkCore.Diagnostics;
using Nix.Abstractions;

namespace Nix.Persistence.Rls;

/// <summary>
/// Publishes the current <see cref="NixSessionContext"/> to Postgres the moment a transaction
/// begins, so every statement inside that transaction is evaluated by the row-level security
/// policies under the right tenant.
/// </summary>
/// <remarks>
/// <para>
/// Transaction begin is the only correct hook. Earlier (connection open) would put the context on
/// the physical connection, which is shared; later (per command) would leave a window in which a
/// statement runs with no tenant. <c>SET LOCAL</c> also has no effect outside a transaction, so
/// the hook and the mechanism are the same choice.
/// </para>
/// <para>
/// Both entry points are covered: <c>TransactionStarted</c> for transactions EF begins, and
/// <c>TransactionUsed</c> for a transaction handed to EF via <c>UseTransaction</c>. Missing the
/// second would let a caller run an entire unit of work with no session context, which RLS reads
/// as "no tenant" and answers with zero rows - a silent, confusing failure rather than a loud one.
/// </para>
/// <para>
/// If no context has been established, this throws. Running unscoped is never the safer default:
/// the policies would either return nothing or, if a future policy is written permissively,
/// everything.
/// </para>
/// </remarks>
public sealed class RlsSessionContextInterceptor(
    INixSessionContextAccessor sessionContextAccessor)
    : DbTransactionInterceptor
{
    /// <inheritdoc />
    public override DbTransaction TransactionStarted(
        DbConnection connection,
        TransactionEndEventData eventData,
        DbTransaction result)
    {
        Publish(connection, result);
        return base.TransactionStarted(connection, eventData, result);
    }

    /// <inheritdoc />
    public override async ValueTask<DbTransaction> TransactionStartedAsync(
        DbConnection connection,
        TransactionEndEventData eventData,
        DbTransaction result,
        CancellationToken cancellationToken = default)
    {
        await PublishAsync(connection, result, cancellationToken).ConfigureAwait(false);
        return await base.TransactionStartedAsync(connection, eventData, result, cancellationToken)
            .ConfigureAwait(false);
    }

    /// <inheritdoc />
    public override DbTransaction TransactionUsed(
        DbConnection connection,
        TransactionEventData eventData,
        DbTransaction result)
    {
        Publish(connection, result);
        return base.TransactionUsed(connection, eventData, result);
    }

    /// <inheritdoc />
    public override async ValueTask<DbTransaction> TransactionUsedAsync(
        DbConnection connection,
        TransactionEventData eventData,
        DbTransaction result,
        CancellationToken cancellationToken = default)
    {
        await PublishAsync(connection, result, cancellationToken).ConfigureAwait(false);
        return await base.TransactionUsedAsync(connection, eventData, result, cancellationToken)
            .ConfigureAwait(false);
    }

    private string BuildGuardedCommandText()
    {
        var context = sessionContextAccessor.Current
            ?? throw new InvalidOperationException(
                "No RLS session context has been established for this scope. Every unit of work " +
                "is tenant-scoped; there is no unscoped path. Set the context from the validated " +
                "token (HTTP) or from the claimed job row (background worker) before opening a " +
                "transaction.");

        var commandText = RlsSessionCommand.Build(context);

        // Belt and braces: Build only ever emits SET LOCAL, and this re-checks the exact text
        // about to be sent. The guard lives on the execution path so no refactor can route
        // around it.
        RlsSessionCommand.AssertOnlySetLocal(commandText);
        return commandText;
    }

    private void Publish(DbConnection connection, DbTransaction transaction)
    {
        ArgumentNullException.ThrowIfNull(connection);
        ArgumentNullException.ThrowIfNull(transaction);

        using var command = CreateSessionCommand(connection, transaction);
        command.ExecuteNonQuery();
    }

    private async ValueTask PublishAsync(
        DbConnection connection,
        DbTransaction transaction,
        CancellationToken cancellationToken)
    {
        ArgumentNullException.ThrowIfNull(connection);
        ArgumentNullException.ThrowIfNull(transaction);

        var command = CreateSessionCommand(connection, transaction);
        await using (command.ConfigureAwait(false))
        {
            await command.ExecuteNonQueryAsync(cancellationToken).ConfigureAwait(false);
        }
    }

#pragma warning disable CA2100 // Review SQL queries for security vulnerabilities
    // Justification: SET LOCAL cannot take parameters. The text comes from RlsSessionCommand,
    // which renders only Guid values in "D" format and rejects any character outside the UUID
    // alphabet, so no caller-controlled string can reach the statement. See RlsSessionCommand.
    private DbCommand CreateSessionCommand(DbConnection connection, DbTransaction transaction)
    {
        var command = connection.CreateCommand();
        command.Transaction = transaction;
        command.CommandText = BuildGuardedCommandText();
        return command;
    }
#pragma warning restore CA2100
}
