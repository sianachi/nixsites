using Nix.Abstractions;
using Nix.Domain.Identity;
using Nix.Domain.Items;
using Nix.Domain.Tenancy;
using Nix.Persistence.Sql;
using Nix.Persistence.Sql.Statements;
using Npgsql;
using NpgsqlTypes;

namespace Nix.Persistence.Recurrence;

/// <summary>
/// The recurrence write path over Postgres: sets, reads, and idempotently advances one item's
/// recurrence rule.
/// </summary>
/// <remarks>
/// <para>
/// The tenant and the acting principal both come from the unit of work's session context, never
/// from a caller-supplied parameter - <see cref="IRecurrenceStore"/> carries no actor argument
/// because there is no path to this store that runs on behalf of anyone else. Every statement
/// additionally binds <c>@tenant_id</c> even though row-level security already scopes the table:
/// see <see cref="RecurrenceSql.SetRecurrence"/> for why the assertion stands beside the policy
/// rather than instead of it.
/// </para>
/// <para>
/// <b>Completion's ambiguity is resolved here, not in the statement.</b>
/// <see cref="RecurrenceSql.CompleteOccurrence"/> can only report rows affected, and zero rows is
/// three different facts at once. <see cref="CompleteOccurrenceAsync"/> tells them apart with one
/// more read inside the same transaction, so the caller never has to guess which of "already
/// done", "not recurring", or "gone" a silent no-op meant.
/// </para>
/// </remarks>
public sealed class RecurrenceStore(
    NixSqlExecutor sql,
    INixSessionContextAccessor session)
    : IRecurrenceStore
{
    private readonly INixSessionContextAccessor _session = session;

    private TenantId Tenant => (_session.Current
        ?? throw new InvalidOperationException(
            "No session context has been established for this unit of work. Recurring items are "
            + "written on behalf of a specific principal in a specific tenant; there is no "
            + "anonymous path."))
        .TenantId;

    private PrincipalId Actor => (_session.Current
        ?? throw new InvalidOperationException(
            "No session context has been established for this unit of work. Recurring items are "
            + "written on behalf of a specific principal in a specific tenant; there is no "
            + "anonymous path."))
        .PrincipalId;

    /// <inheritdoc />
    public async ValueTask<RecurrenceWriteOutcome> SetRuleAsync(
        ItemId itemId,
        string? ruleJson,
        CancellationToken cancellationToken)
    {
        var rows = await sql.ExecuteAsync(
            RecurrenceSql.SetRecurrence,
            [
                Uuid("tenant_id", Tenant.Value),
                Uuid("item_id", itemId.Value),
                NullableText("recurrence", ruleJson),
                Uuid("actor", Actor.Value),
            ],
            cancellationToken).ConfigureAwait(false);

        return rows == 1 ? RecurrenceWriteOutcome.Written : RecurrenceWriteOutcome.ItemNotFound;
    }

    /// <inheritdoc />
    public async ValueTask<string?> ReadRuleAsync(ItemId itemId, CancellationToken cancellationToken)
    {
        var (_, recurrence) = await ReadRowAsync(itemId, cancellationToken).ConfigureAwait(false);
        return recurrence;
    }

    /// <inheritdoc />
    public async ValueTask<OccurrenceCompletionOutcome> CompleteOccurrenceAsync(
        ItemId itemId,
        string ruleJson,
        CancellationToken cancellationToken)
    {
        ArgumentNullException.ThrowIfNull(ruleJson);

        var rows = await sql.ExecuteAsync(
            RecurrenceSql.CompleteOccurrence,
            [
                Uuid("tenant_id", Tenant.Value),
                Uuid("item_id", itemId.Value),
                Text("recurrence", ruleJson),
                Uuid("actor", Actor.Value),
            ],
            cancellationToken).ConfigureAwait(false);

        if (rows == 1)
        {
            return OccurrenceCompletionOutcome.Completed;
        }

        // Zero rows is ambiguous by construction - see RecurrenceSql.CompleteOccurrence - so the
        // three outcomes it cannot tell apart are resolved with one more read, inside the same
        // transaction the update above just ran in.
        var (found, recurrence) = await ReadRowAsync(itemId, cancellationToken).ConfigureAwait(false);
        if (!found)
        {
            return OccurrenceCompletionOutcome.ItemNotFound;
        }

        return recurrence is not null
            ? OccurrenceCompletionOutcome.AlreadyComplete
            : OccurrenceCompletionOutcome.NotRecurring;
    }

    /// <summary>
    /// Reads one item's recurrence row, distinguishing "no such row" from "a row with no rule" -
    /// a distinction <see cref="NixSqlExecutor"/>'s <c>ScalarOrDefaultAsync</c> cannot make on its
    /// own, since both come back as <see langword="null"/>.
    /// </summary>
    /// <param name="itemId">The item to read.</param>
    /// <param name="cancellationToken">Cancels the read.</param>
    /// <returns>Whether a qualifying row exists, and its rule text if it does.</returns>
    private async ValueTask<(bool Found, string? Recurrence)> ReadRowAsync(
        ItemId itemId,
        CancellationToken cancellationToken)
    {
        var rows = sql.QueryAsync<string?, NullableTextMapper>(
            RecurrenceSql.ReadRecurrence,
            default,
            [
                Uuid("tenant_id", Tenant.Value),
                Uuid("item_id", itemId.Value),
            ],
            cancellationToken);

        await foreach (var row in rows.WithCancellation(cancellationToken).ConfigureAwait(false))
        {
            return (true, row);
        }

        return (false, null);
    }

    private static NpgsqlParameter Uuid(string name, Guid value) =>
        new(name, NpgsqlDbType.Uuid) { Value = value };

    private static NpgsqlParameter Text(string name, string value) =>
        new(name, NpgsqlDbType.Text) { Value = value };

    private static NpgsqlParameter NullableText(string name, string? value) =>
        new(name, NpgsqlDbType.Text) { Value = value is null ? DBNull.Value : value };

    /// <summary>Reads a single nullable text column.</summary>
    private readonly struct NullableTextMapper : INixRowMapper<string?>
    {
        /// <inheritdoc />
        public string? Map(NpgsqlDataReader reader)
        {
            ArgumentNullException.ThrowIfNull(reader);
            return reader.IsDBNull(0) ? null : reader.GetString(0);
        }
    }
}
