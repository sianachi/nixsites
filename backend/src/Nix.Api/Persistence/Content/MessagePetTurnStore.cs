using Nix.Abstractions;
using Nix.Persistence.Sql;
using Npgsql;
using static Nix.Persistence.Sql.NixParameter;

namespace Nix.Persistence.Content;

/// <summary>One pet's turn for one message. <paramref name="Status"/> is pending, working, answered, failed, declined or expired.</summary>
public sealed record MessagePetTurnRow(Guid PetId, string Status, string? Reason, DateTimeOffset? ExpiresAt, Guid? TokenId, string? TokenName, string? Memory = null, string? Code = null);

/// <summary>Whether each pet addressed by a message is waiting, running, answered, failed, declined or expired; seen and changed only by the pet's owner.</summary>
public sealed class MessagePetTurnStore(NixSqlExecutor sql, INixSessionContextAccessor session)
{
    /// <summary>How long a turn waits for the owner's approval.</summary>
    public static readonly TimeSpan Wait = TimeSpan.FromDays(7);

    /// <summary>How long a turn may run before a read calls it failed; a turn that ended without recording it would otherwise stay working.</summary>
    public static readonly TimeSpan MaxRunning = TimeSpan.FromMinutes(30);

    private NixSessionContext Caller => session.Current ?? throw new InvalidOperationException("A session is required.");

    /// <summary>Records a turn. A repeat for the same message and pet is ignored.</summary>
    public async Task AddAsync(Guid messageId, Guid petId, string status, string? reason, Guid? tokenId, string? tokenName, CancellationToken cancellationToken)
    {
        var caller = Caller;
        _ = await sql.ExecuteAsync("""
            INSERT INTO message_pet_turn (tenant_id, message_id, pet_id, principal_id, status, reason, token_id, token_name, expires_at, started_at)
            VALUES (@tenant, @message, @pet, @principal, @status, @reason, @token, @name,
                    CASE WHEN @status = 'pending' THEN now() + @wait END, CASE WHEN @status = 'working' THEN now() END)
            ON CONFLICT DO NOTHING
            """,
            [Uuid("tenant", caller.TenantId.Value), Uuid("message", messageId), Uuid("pet", petId), Uuid("principal", caller.PrincipalId.Value),
                Text("status", status), Text("reason", reason), Uuid("token", tokenId), Text("name", tokenName),
                new NpgsqlParameter("wait", NpgsqlTypes.NpgsqlDbType.Interval) { Value = Wait }],
            cancellationToken).ConfigureAwait(false);
    }

    /// <summary>The turns of one message, a waiting one past its time reading as expired.</summary>
    public async Task<IReadOnlyList<MessagePetTurnRow>> ListAsync(Guid messageId, CancellationToken cancellationToken)
    {
        var rows = new List<MessagePetTurnRow>();
        await foreach (var row in sql.QueryAsync<MessagePetTurnRow, Mapper>("""
            SELECT pet_id,
                   CASE WHEN status = 'pending' AND expires_at <= now() THEN 'expired'
                        WHEN status = 'working' AND started_at <= now() - @running THEN 'failed' ELSE status END,
                   CASE WHEN status = 'working' AND started_at <= now() - @running THEN 'The turn did not finish.' ELSE reason END,
                   expires_at, token_id, token_name, memory_text, reason_code
              FROM message_pet_turn WHERE tenant_id = @tenant AND message_id = @message ORDER BY created_at, pet_id
            """, default(Mapper), [Uuid("tenant", Caller.TenantId.Value), Uuid("message", messageId),
                new NpgsqlParameter("running", NpgsqlTypes.NpgsqlDbType.Interval) { Value = MaxRunning }], cancellationToken).ConfigureAwait(false))
        {
            rows.Add(row);
        }

        return rows;
    }

    /// <summary>Takes a waiting, unexpired turn, or one that failed under the retired sharing review (consent is implied now), to start it. Null when there is none.</summary>
    public async Task<MessagePetTurnRow?> ClaimAsync(Guid messageId, Guid petId, CancellationToken cancellationToken) =>
        await OneAsync("""
            UPDATE message_pet_turn SET status = 'working', started_at = now(), reason = NULL, reason_code = NULL
             WHERE tenant_id = @tenant AND message_id = @message AND pet_id = @pet
               AND (status = 'pending' AND expires_at > now() OR status = 'failed' AND reason_code = 'pets.sharing_required')
            RETURNING pet_id, status, reason, expires_at, token_id, token_name, memory_text, reason_code
            """, messageId, petId, cancellationToken).ConfigureAwait(false);

    /// <summary>Declines a waiting turn. Null when there is none.</summary>
    public async Task<MessagePetTurnRow?> DeclineAsync(Guid messageId, Guid petId, CancellationToken cancellationToken) =>
        await OneAsync("""
            UPDATE message_pet_turn SET status = 'declined', reason = 'The owner dismissed it.'
             WHERE tenant_id = @tenant AND message_id = @message AND pet_id = @pet AND status = 'pending' AND expires_at > now()
            RETURNING pet_id, status, reason, expires_at, token_id, token_name, memory_text, reason_code
            """, messageId, petId, cancellationToken).ConfigureAwait(false);

    /// <summary>Records how a running turn ended, and a fact the pet wants remembered that waits for the owner.</summary>
    public async Task FinishAsync(Guid messageId, Guid petId, string status, string? reason, CancellationToken cancellationToken, string? memory = null, string? code = null) =>
        _ = await sql.ExecuteAsync("""
            UPDATE message_pet_turn SET status = @status, reason = @reason, memory_text = @memory, reason_code = @code
             WHERE tenant_id = @tenant AND message_id = @message AND pet_id = @pet AND status = 'working'
            """,
            [Uuid("tenant", Caller.TenantId.Value), Uuid("message", messageId), Uuid("pet", petId), Text("status", status),
                Text("reason", reason is { Length: > 500 } ? reason[..500] : reason), Text("memory", memory), Text("code", code)],
            cancellationToken).ConfigureAwait(false);

    /// <summary>Takes the fact waiting on a turn, so it is approved or dismissed once. Null when nothing waits.</summary>
    public async Task<string?> TakeMemoryAsync(Guid messageId, Guid petId, CancellationToken cancellationToken)
    {
        await foreach (var text in sql.QueryAsync<string, TextMapper>("""
            UPDATE message_pet_turn turn SET memory_text = NULL
              FROM (SELECT memory_text AS held FROM message_pet_turn
                     WHERE tenant_id = @tenant AND message_id = @message AND pet_id = @pet AND memory_text IS NOT NULL FOR UPDATE) waiting
             WHERE turn.tenant_id = @tenant AND turn.message_id = @message AND turn.pet_id = @pet
            RETURNING waiting.held
            """, default(TextMapper), [Uuid("tenant", Caller.TenantId.Value), Uuid("message", messageId), Uuid("pet", petId)], cancellationToken).ConfigureAwait(false))
        {
            return text;
        }

        return null;
    }

    /// <summary>
    /// How many turns this token's messages started in the last day. Holds the token's lock until the transaction
    /// ends, so a caller that checks the cap and then adds its turns cannot race another request of the same token.
    /// </summary>
    public async Task<int> StartedByTokenAsync(Guid tokenId, CancellationToken cancellationToken)
    {
        // A separate statement: the count must read after the lock is held.
        _ = await sql.ExecuteAsync("SELECT pg_advisory_xact_lock(hashtextextended('message-pet-turns:' || @token::text, 0))",
            [Uuid("token", tokenId)], cancellationToken).ConfigureAwait(false);
        return await sql.ScalarAsync<int>("""
            SELECT count(*)::int FROM message_pet_turn
             WHERE tenant_id = @tenant AND token_id = @token AND started_at > now() - interval '1 day'
            """, [Uuid("tenant", Caller.TenantId.Value), Uuid("token", tokenId)], cancellationToken).ConfigureAwait(false) ?? 0;
    }

    /// <summary>Takes a lock for one thread until the transaction ends, so two chains in it count and add their turns one after the other.</summary>
    public async Task LockThreadAsync(Guid threadRootId, CancellationToken cancellationToken) =>
        _ = await sql.ExecuteAsync("SELECT pg_advisory_xact_lock(hashtextextended('message-pet-thread:' || @thread::text, 0))",
            [Uuid("thread", threadRootId)], cancellationToken).ConfigureAwait(false);

    /// <summary>How many turns have started (running or finished) on these messages.</summary>
    public async Task<int> StartedOnAsync(Guid[] messageIds, CancellationToken cancellationToken) =>
        await sql.ScalarAsync<int>("""
            SELECT count(*)::int FROM message_pet_turn
             WHERE tenant_id = @tenant AND message_id = ANY(@messages) AND started_at IS NOT NULL
            """, [Uuid("tenant", Caller.TenantId.Value), UuidArray("messages", messageIds)], cancellationToken).ConfigureAwait(false) ?? 0;

    private async Task<MessagePetTurnRow?> OneAsync(string statement, Guid messageId, Guid petId, CancellationToken cancellationToken)
    {
        await foreach (var row in sql.QueryAsync<MessagePetTurnRow, Mapper>(statement, default(Mapper),
            [Uuid("tenant", Caller.TenantId.Value), Uuid("message", messageId), Uuid("pet", petId)], cancellationToken).ConfigureAwait(false))
        {
            return row;
        }

        return null;
    }

    private readonly struct TextMapper : INixRowMapper<string>
    {
        public string Map(NpgsqlDataReader reader) => reader.GetString(0);
    }

    private readonly struct Mapper : INixRowMapper<MessagePetTurnRow>
    {
        public MessagePetTurnRow Map(NpgsqlDataReader reader) => new(
            reader.GetGuid(0), reader.GetString(1), reader.IsDBNull(2) ? null : reader.GetString(2),
            reader.IsDBNull(3) ? null : reader.GetFieldValue<DateTimeOffset>(3),
            reader.IsDBNull(4) ? null : reader.GetGuid(4), reader.IsDBNull(5) ? null : reader.GetString(5),
            reader.IsDBNull(6) ? null : reader.GetString(6), reader.IsDBNull(7) ? null : reader.GetString(7));
    }
}
