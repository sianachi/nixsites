using Nix.Abstractions.Scheduling;
using Nix.Domain.Identity;
using Nix.Domain.Tenancy;
using Nix.Persistence.Sql;
using Npgsql;
using static Nix.Persistence.Sql.NixParameter;

namespace Nix.Persistence.Scheduling;

/// <summary>
/// Calls the SECURITY DEFINER functions in <c>ReminderSourceSecuritySql</c> directly against
/// the connection pool - no <see cref="NixDbContext"/> session context, same reasoning as
/// <see cref="ScheduledTriggerLeaseStore"/>: FORCE ROW LEVEL SECURITY binds even a table owner, and
/// these functions cross every tenant only because they are owned by the migrator role.
/// </summary>
public sealed class ReminderCandidateFinder(NpgsqlDataSource dataSource) : IReminderCandidateFinder
{
    private readonly PooledSql _db = new(dataSource);

    // nix_reminder_preferences_for refuses more than 500 recipients per call.
    private const int PreferencesBatchSize = 500;

    public async Task<IReadOnlyList<ExplicitReminderCandidate>> FindExplicitAsync(
        DateTimeOffset from,
        DateTimeOffset until,
        int limit,
        DateTimeOffset afterInstant,
        Guid afterId,
        CancellationToken cancellationToken)
    {
        CheckLimit(limit);
        return await _db.RowsAsync(
            "SELECT * FROM nix_find_explicit_reminder_candidates(@from, @to, @limit, @after_at, @after_id)",
            static reader => new ExplicitReminderCandidate(
                TenantId.From(reader.GetGuid(0)),
                reader.GetGuid(1),
                WorkspaceId.From(reader.GetGuid(2)),
                PrincipalId.From(reader.GetGuid(3)),
                reader.GetFieldValue<DateTimeOffset>(4)),
            cancellationToken,
            Timestamp("from", from),
            Timestamp("to", until),
            Integer("limit", limit),
            Timestamp("after_at", afterInstant),
            Uuid("after_id", afterId)).ConfigureAwait(false);
    }

    public async Task<IReadOnlyList<ExpiryCandidate>> FindExpiringAsync(
        DateTimeOffset until,
        int limit,
        DateTimeOffset afterInstant,
        Guid afterId,
        CancellationToken cancellationToken)
    {
        CheckLimit(limit);
        return await _db.RowsAsync(
            "SELECT * FROM nix_find_expiry_candidates(@to, @limit, @after_at, @after_id)",
            static reader => new ExpiryCandidate(
                TenantId.From(reader.GetGuid(0)),
                reader.GetGuid(1),
                WorkspaceId.From(reader.GetGuid(2)),
                PrincipalId.From(reader.GetGuid(3)),
                reader.GetFieldValue<DateTimeOffset>(4)),
            cancellationToken,
            Timestamp("to", until),
            Integer("limit", limit),
            Timestamp("after_at", afterInstant),
            Uuid("after_id", afterId)).ConfigureAwait(false);
    }

    public async Task<IReadOnlyList<DueReminderCandidate>> FindDueAsync(
        DateOnly from,
        DateOnly until,
        int limit,
        string afterDayText,
        Guid afterId,
        CancellationToken cancellationToken)
    {
        ArgumentNullException.ThrowIfNull(afterDayText);
        CheckLimit(limit);
        return await _db.RowsAsync(
            "SELECT * FROM nix_find_due_reminder_candidates(@from, @to, @limit, @after_day, @after_id)",
            static reader => new DueReminderCandidate(
                TenantId.From(reader.GetGuid(0)),
                reader.GetGuid(1),
                WorkspaceId.From(reader.GetGuid(2)),
                PrincipalId.From(reader.GetGuid(3)),
                reader.GetString(4),
                reader.IsDBNull(5) ? null : reader.GetFieldValue<DateOnly>(5)),
            cancellationToken,
            Date("from", from),
            Date("to", until),
            Integer("limit", limit),
            Text("after_day", afterDayText),
            Uuid("after_id", afterId)).ConfigureAwait(false);
    }

    public async Task<IReadOnlyList<RecurringDueReminderCandidate>> FindRecurringDueAsync(
        DateOnly from,
        DateOnly until,
        int limit,
        Guid afterId,
        CancellationToken cancellationToken)
    {
        CheckLimit(limit);
        return await _db.RowsAsync(
            "SELECT * FROM nix_find_recurring_due_reminder_candidates(@from, @to, @limit, @after_id)",
            static reader => new RecurringDueReminderCandidate(
                TenantId.From(reader.GetGuid(0)),
                reader.GetGuid(1),
                WorkspaceId.From(reader.GetGuid(2)),
                PrincipalId.From(reader.GetGuid(3)),
                reader.IsDBNull(4) ? null : reader.GetFieldValue<DateOnly>(4),
                reader.GetString(5)),
            cancellationToken,
            Date("from", from),
            Date("to", until),
            Integer("limit", limit),
            Uuid("after_id", afterId)).ConfigureAwait(false);
    }

    public async Task<IReadOnlyList<HabitReminderCandidate>> FindHabitsAsync(
        int limit, Guid afterId, CancellationToken cancellationToken)
    {
        CheckLimit(limit);
        return await _db.RowsAsync(
            "SELECT * FROM nix_find_habit_reminder_candidates(@limit, @after_id)",
            static reader => new HabitReminderCandidate(
                TenantId.From(reader.GetGuid(0)),
                reader.GetGuid(1),
                WorkspaceId.From(reader.GetGuid(2)),
                PrincipalId.From(reader.GetGuid(3)),
                reader.GetString(4)),
            cancellationToken,
            Integer("limit", limit),
            Uuid("after_id", afterId)).ConfigureAwait(false);
    }

    public async Task<IReadOnlyList<ReminderPreferences>> PreferencesForAsync(
        IReadOnlyCollection<ReminderRecipient> recipients, CancellationToken cancellationToken)
    {
        ArgumentNullException.ThrowIfNull(recipients);
        if (recipients.Count == 0)
        {
            return [];
        }

        var results = new List<ReminderPreferences>(recipients.Count);
        foreach (var batch in recipients.Distinct().Chunk(PreferencesBatchSize))
        {
            results.AddRange(await _db.RowsAsync(
                "SELECT * FROM nix_reminder_preferences_for(@tenant_ids, @principal_ids)",
                static reader => new ReminderPreferences(
                    TenantId.From(reader.GetGuid(0)),
                    PrincipalId.From(reader.GetGuid(1)),
                    reader.GetString(2),
                    reader.IsDBNull(3) ? null : reader.GetFieldValue<TimeOnly>(3),
                    reader.IsDBNull(4) ? null : reader.GetFieldValue<TimeOnly>(4),
                    reader.GetFieldValue<TimeOnly>(5),
                    reader.GetBoolean(6),
                    reader.GetBoolean(7),
                    reader.GetFieldValue<Guid[]>(8)),
                cancellationToken,
                UuidArray("tenant_ids", batch.Select(recipient => recipient.TenantId.Value).ToArray()),
                UuidArray("principal_ids", batch.Select(recipient => recipient.PrincipalId.Value).ToArray())).ConfigureAwait(false));
        }
        return results;
    }

    private static void CheckLimit(int limit)
    {
        if (limit is < 1 or > 500)
        {
            throw new ArgumentOutOfRangeException(nameof(limit));
        }
    }
}
