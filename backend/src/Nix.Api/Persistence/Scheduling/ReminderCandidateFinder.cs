using Nix.Abstractions.Scheduling;
using Nix.Domain.Identity;
using Nix.Domain.Tenancy;
using Npgsql;
using NpgsqlTypes;

namespace Nix.Persistence.Scheduling;

/// <summary>
/// Calls the SECURITY DEFINER functions in <c>ReminderSourceSecuritySql</c> directly against
/// the connection pool - no <see cref="NixDbContext"/> session context, same reasoning as
/// <see cref="ScheduledTriggerLeaseStore"/>: FORCE ROW LEVEL SECURITY binds even a table owner, and
/// these functions cross every tenant only because they are owned by the migrator role.
/// </summary>
public sealed class ReminderCandidateFinder(NpgsqlDataSource dataSource) : IReminderCandidateFinder
{
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
        if (limit is < 1 or > 500)
        {
            throw new ArgumentOutOfRangeException(nameof(limit));
        }

        var results = new List<ExplicitReminderCandidate>(limit);
        var command = dataSource.CreateCommand(
            "SELECT * FROM nix_find_explicit_reminder_candidates(@from, @to, @limit, @after_at, @after_id)");
        await using (command.ConfigureAwait(false))
        {
            command.Parameters.Add(new NpgsqlParameter<DateTimeOffset>("from", NpgsqlDbType.TimestampTz) { TypedValue = from });
            command.Parameters.Add(new NpgsqlParameter<DateTimeOffset>("to", NpgsqlDbType.TimestampTz) { TypedValue = until });
            command.Parameters.Add(new NpgsqlParameter<int>("limit", NpgsqlDbType.Integer) { TypedValue = limit });
            command.Parameters.Add(new NpgsqlParameter<DateTimeOffset>("after_at", NpgsqlDbType.TimestampTz) { TypedValue = afterInstant });
            command.Parameters.Add(new NpgsqlParameter<Guid>("after_id", NpgsqlDbType.Uuid) { TypedValue = afterId });
            var reader = await command.ExecuteReaderAsync(cancellationToken).ConfigureAwait(false);
            await using (reader.ConfigureAwait(false))
            {
                while (await reader.ReadAsync(cancellationToken).ConfigureAwait(false))
                {
                    results.Add(new ExplicitReminderCandidate(
                        TenantId.From(reader.GetGuid(0)),
                        reader.GetGuid(1),
                        WorkspaceId.From(reader.GetGuid(2)),
                        PrincipalId.From(reader.GetGuid(3)),
                        await reader.GetFieldValueAsync<DateTimeOffset>(4, cancellationToken).ConfigureAwait(false)));
                }
            }
        }
        return results;
    }

    public async Task<IReadOnlyList<ExpiryCandidate>> FindExpiringAsync(
        DateTimeOffset until,
        int limit,
        DateTimeOffset afterInstant,
        Guid afterId,
        CancellationToken cancellationToken)
    {
        if (limit is < 1 or > 500)
        {
            throw new ArgumentOutOfRangeException(nameof(limit));
        }

        var results = new List<ExpiryCandidate>(limit);
        var command = dataSource.CreateCommand(
            "SELECT * FROM nix_find_expiry_candidates(@to, @limit, @after_at, @after_id)");
        await using (command.ConfigureAwait(false))
        {
            command.Parameters.Add(new NpgsqlParameter<DateTimeOffset>("to", NpgsqlDbType.TimestampTz) { TypedValue = until });
            command.Parameters.Add(new NpgsqlParameter<int>("limit", NpgsqlDbType.Integer) { TypedValue = limit });
            command.Parameters.Add(new NpgsqlParameter<DateTimeOffset>("after_at", NpgsqlDbType.TimestampTz) { TypedValue = afterInstant });
            command.Parameters.Add(new NpgsqlParameter<Guid>("after_id", NpgsqlDbType.Uuid) { TypedValue = afterId });
            var reader = await command.ExecuteReaderAsync(cancellationToken).ConfigureAwait(false);
            await using (reader.ConfigureAwait(false))
            {
                while (await reader.ReadAsync(cancellationToken).ConfigureAwait(false))
                {
                    results.Add(new ExpiryCandidate(
                        TenantId.From(reader.GetGuid(0)),
                        reader.GetGuid(1),
                        WorkspaceId.From(reader.GetGuid(2)),
                        PrincipalId.From(reader.GetGuid(3)),
                        await reader.GetFieldValueAsync<DateTimeOffset>(4, cancellationToken).ConfigureAwait(false)));
                }
            }
        }
        return results;
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
        if (limit is < 1 or > 500)
        {
            throw new ArgumentOutOfRangeException(nameof(limit));
        }

        var results = new List<DueReminderCandidate>(limit);
        var command = dataSource.CreateCommand(
            "SELECT * FROM nix_find_due_reminder_candidates(@from, @to, @limit, @after_day, @after_id)");
        await using (command.ConfigureAwait(false))
        {
            command.Parameters.Add(new NpgsqlParameter<DateOnly>("from", NpgsqlDbType.Date) { TypedValue = from });
            command.Parameters.Add(new NpgsqlParameter<DateOnly>("to", NpgsqlDbType.Date) { TypedValue = until });
            command.Parameters.Add(new NpgsqlParameter<int>("limit", NpgsqlDbType.Integer) { TypedValue = limit });
            command.Parameters.Add(new NpgsqlParameter<string>("after_day", NpgsqlDbType.Text) { TypedValue = afterDayText });
            command.Parameters.Add(new NpgsqlParameter<Guid>("after_id", NpgsqlDbType.Uuid) { TypedValue = afterId });
            var reader = await command.ExecuteReaderAsync(cancellationToken).ConfigureAwait(false);
            await using (reader.ConfigureAwait(false))
            {
                while (await reader.ReadAsync(cancellationToken).ConfigureAwait(false))
                {
                    var dueDay = await reader.IsDBNullAsync(5, cancellationToken).ConfigureAwait(false)
                        ? (DateOnly?)null
                        : await reader.GetFieldValueAsync<DateOnly>(5, cancellationToken).ConfigureAwait(false);
                    results.Add(new DueReminderCandidate(
                        TenantId.From(reader.GetGuid(0)),
                        reader.GetGuid(1),
                        WorkspaceId.From(reader.GetGuid(2)),
                        PrincipalId.From(reader.GetGuid(3)),
                        reader.GetString(4),
                        dueDay));
                }
            }
        }
        return results;
    }

    public async Task<IReadOnlyList<RecurringDueReminderCandidate>> FindRecurringDueAsync(
        DateOnly from,
        DateOnly until,
        int limit,
        Guid afterId,
        CancellationToken cancellationToken)
    {
        if (limit is < 1 or > 500)
        {
            throw new ArgumentOutOfRangeException(nameof(limit));
        }

        var results = new List<RecurringDueReminderCandidate>(limit);
        var command = dataSource.CreateCommand(
            "SELECT * FROM nix_find_recurring_due_reminder_candidates(@from, @to, @limit, @after_id)");
        await using (command.ConfigureAwait(false))
        {
            command.Parameters.Add(new NpgsqlParameter<DateOnly>("from", NpgsqlDbType.Date) { TypedValue = from });
            command.Parameters.Add(new NpgsqlParameter<DateOnly>("to", NpgsqlDbType.Date) { TypedValue = until });
            command.Parameters.Add(new NpgsqlParameter<int>("limit", NpgsqlDbType.Integer) { TypedValue = limit });
            command.Parameters.Add(new NpgsqlParameter<Guid>("after_id", NpgsqlDbType.Uuid) { TypedValue = afterId });
            var reader = await command.ExecuteReaderAsync(cancellationToken).ConfigureAwait(false);
            await using (reader.ConfigureAwait(false))
            {
                while (await reader.ReadAsync(cancellationToken).ConfigureAwait(false))
                {
                    var anchorDay = await reader.IsDBNullAsync(4, cancellationToken).ConfigureAwait(false)
                        ? (DateOnly?)null
                        : await reader.GetFieldValueAsync<DateOnly>(4, cancellationToken).ConfigureAwait(false);
                    results.Add(new RecurringDueReminderCandidate(
                        TenantId.From(reader.GetGuid(0)),
                        reader.GetGuid(1),
                        WorkspaceId.From(reader.GetGuid(2)),
                        PrincipalId.From(reader.GetGuid(3)),
                        anchorDay,
                        reader.GetString(5)));
                }
            }
        }
        return results;
    }

    public async Task<IReadOnlyList<HabitReminderCandidate>> FindHabitsAsync(
        int limit, Guid afterId, CancellationToken cancellationToken)
    {
        if (limit is < 1 or > 500)
        {
            throw new ArgumentOutOfRangeException(nameof(limit));
        }

        var results = new List<HabitReminderCandidate>(limit);
        var command = dataSource.CreateCommand("SELECT * FROM nix_find_habit_reminder_candidates(@limit, @after_id)");
        await using (command.ConfigureAwait(false))
        {
            command.Parameters.Add(new NpgsqlParameter<int>("limit", NpgsqlDbType.Integer) { TypedValue = limit });
            command.Parameters.Add(new NpgsqlParameter<Guid>("after_id", NpgsqlDbType.Uuid) { TypedValue = afterId });
            var reader = await command.ExecuteReaderAsync(cancellationToken).ConfigureAwait(false);
            await using (reader.ConfigureAwait(false))
            {
                while (await reader.ReadAsync(cancellationToken).ConfigureAwait(false))
                {
                    results.Add(new HabitReminderCandidate(
                        TenantId.From(reader.GetGuid(0)),
                        reader.GetGuid(1),
                        WorkspaceId.From(reader.GetGuid(2)),
                        PrincipalId.From(reader.GetGuid(3)),
                        reader.GetString(4)));
                }
            }
        }
        return results;
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
            await ReadPreferencesAsync(batch, results, cancellationToken).ConfigureAwait(false);
        }
        return results;
    }

    private async Task ReadPreferencesAsync(
        ReminderRecipient[] batch, List<ReminderPreferences> results, CancellationToken cancellationToken)
    {
        var command = dataSource.CreateCommand("SELECT * FROM nix_reminder_preferences_for(@tenant_ids, @principal_ids)");
        await using (command.ConfigureAwait(false))
        {
            command.Parameters.Add(new NpgsqlParameter<Guid[]>("tenant_ids", NpgsqlDbType.Array | NpgsqlDbType.Uuid)
            {
                TypedValue = batch.Select(recipient => recipient.TenantId.Value).ToArray(),
            });
            command.Parameters.Add(new NpgsqlParameter<Guid[]>("principal_ids", NpgsqlDbType.Array | NpgsqlDbType.Uuid)
            {
                TypedValue = batch.Select(recipient => recipient.PrincipalId.Value).ToArray(),
            });
            var reader = await command.ExecuteReaderAsync(cancellationToken).ConfigureAwait(false);
            await using (reader.ConfigureAwait(false))
            {
                while (await reader.ReadAsync(cancellationToken).ConfigureAwait(false))
                {
                    var quietStart = await reader.IsDBNullAsync(3, cancellationToken).ConfigureAwait(false)
                        ? (TimeOnly?)null
                        : await reader.GetFieldValueAsync<TimeOnly>(3, cancellationToken).ConfigureAwait(false);
                    var quietEnd = await reader.IsDBNullAsync(4, cancellationToken).ConfigureAwait(false)
                        ? (TimeOnly?)null
                        : await reader.GetFieldValueAsync<TimeOnly>(4, cancellationToken).ConfigureAwait(false);
                    results.Add(new ReminderPreferences(
                        TenantId.From(reader.GetGuid(0)),
                        PrincipalId.From(reader.GetGuid(1)),
                        reader.GetString(2),
                        quietStart,
                        quietEnd,
                        await reader.GetFieldValueAsync<TimeOnly>(5, cancellationToken).ConfigureAwait(false),
                        reader.GetBoolean(6),
                        reader.GetBoolean(7),
                        await reader.GetFieldValueAsync<Guid[]>(8, cancellationToken).ConfigureAwait(false)));
                }
            }
        }
    }
}
