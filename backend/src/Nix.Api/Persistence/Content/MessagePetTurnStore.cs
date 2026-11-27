using Nix.Abstractions;
using Nix.Persistence.Sql;
using Npgsql;
using static Nix.Persistence.Sql.NixParameter;

namespace Nix.Persistence.Content;

/// <summary>One pet's turn for one message. <paramref name="Status"/> is pending, working, answered, failed, declined or expired.</summary>
public sealed record MessagePetTurnRow(Guid PetId, string Status, string? Reason, DateTimeOffset? ExpiresAt, Guid? TokenId, string? TokenName);

/// <summary>Whether each pet addressed by a message is waiting, running, answered, failed, declined or expired; seen and changed only by the pet's owner.</summary>
public sealed class MessagePetTurnStore(NixSqlExecutor sql, INixSessionContextAccessor session)
{
    /// <summary>How long a turn waits for the owner's approval.</summary>
    public static readonly TimeSpan Wait = TimeSpan.FromDays(7);

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
            SELECT pet_id, CASE WHEN status = 'pending' AND expires_at <= now() THEN 'expired' ELSE status END,
                   reason, expires_at, token_id, token_name
              FROM message_pet_turn WHERE tenant_id = @tenant AND message_id = @message ORDER BY created_at, pet_id
            """, default(Mapper), [Uuid("tenant", Caller.TenantId.Value), Uuid("message", messageId)], cancellationToken).ConfigureAwait(false))
        {
            rows.Add(row);
        }

        return rows;
    }

    /// <summary>Takes a waiting, unexpired turn to start it. Null when there is none.</summary>
    public async Task<MessagePetTurnRow?> ClaimAsync(Guid messageId, Guid petId, CancellationToken cancellationToken) =>
        await OneAsync("""
            UPDATE message_pet_turn SET status = 'working', started_at = now()
             WHERE tenant_id = @tenant AND message_id = @message AND pet_id = @pet AND status = 'pending' AND expires_at > now()
            RETURNING pet_id, status, reason, expires_at, token_id, token_name
            """, messageId, petId, cancellationToken).ConfigureAwait(false);

    /// <summary>Declines a waiting turn. Null when there is none.</summary>
    public async Task<MessagePetTurnRow?> DeclineAsync(Guid messageId, Guid petId, CancellationToken cancellationToken) =>
        await OneAsync("""
            UPDATE message_pet_turn SET status = 'declined', reason = 'The owner dismissed it.'
             WHERE tenant_id = @tenant AND message_id = @message AND pet_id = @pet AND status = 'pending' AND expires_at > now()
            RETURNING pet_id, status, reason, expires_at, token_id, token_name
            """, messageId, petId, cancellationToken).ConfigureAwait(false);

    /// <summary>Records how a running turn ended.</summary>
    public async Task FinishAsync(Guid messageId, Guid petId, string status, string? reason, CancellationToken cancellationToken) =>
        _ = await sql.ExecuteAsync("""
            UPDATE message_pet_turn SET status = @status, reason = @reason
             WHERE tenant_id = @tenant AND message_id = @message AND pet_id = @pet AND status = 'working'
            """,
            [Uuid("tenant", Caller.TenantId.Value), Uuid("message", messageId), Uuid("pet", petId), Text("status", status),
                Text("reason", reason is { Length: > 500 } ? reason[..500] : reason)],
            cancellationToken).ConfigureAwait(false);

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

    private async Task<MessagePetTurnRow?> OneAsync(string statement, Guid messageId, Guid petId, CancellationToken cancellationToken)
    {
        await foreach (var row in sql.QueryAsync<MessagePetTurnRow, Mapper>(statement, default(Mapper),
            [Uuid("tenant", Caller.TenantId.Value), Uuid("message", messageId), Uuid("pet", petId)], cancellationToken).ConfigureAwait(false))
        {
            return row;
        }

        return null;
    }

    private readonly struct Mapper : INixRowMapper<MessagePetTurnRow>
    {
        public MessagePetTurnRow Map(NpgsqlDataReader reader) => new(
            reader.GetGuid(0), reader.GetString(1), reader.IsDBNull(2) ? null : reader.GetString(2),
            reader.IsDBNull(3) ? null : reader.GetFieldValue<DateTimeOffset>(3),
            reader.IsDBNull(4) ? null : reader.GetGuid(4), reader.IsDBNull(5) ? null : reader.GetString(5));
    }
}
