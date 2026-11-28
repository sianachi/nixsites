using Nix.Abstractions;
using Nix.Persistence.Sql;
using Npgsql;
using static Nix.Persistence.Sql.NixParameter;

namespace Nix.Persistence.Content;

/// <summary>One unread message waiting in an agent token's inbox.</summary>
public sealed record MessageInboxRow(Guid MessageId);

/// <summary>The inbox of each agent token and the count of what each token posts; seen and changed only by the token's owner.</summary>
public sealed class MessageAgentStore(NixSqlExecutor sql, INixSessionContextAccessor session)
{
    /// <summary>The most messages one token may post in a day.</summary>
    public const int TokenPostsPerDay = 500;

    private NixSessionContext Caller => session.Current ?? throw new InvalidOperationException("A session is required.");

    /// <summary>Puts a message in an agent's inbox. A repeat is ignored.</summary>
    public async Task AddInboxAsync(Guid messageId, Guid tokenId, CancellationToken cancellationToken) =>
        _ = await sql.ExecuteAsync("""
            INSERT INTO message_agent_inbox (tenant_id, message_id, token_id, principal_id)
            VALUES (@tenant, @message, @token, @principal) ON CONFLICT DO NOTHING
            """,
            [Uuid("tenant", Caller.TenantId.Value), Uuid("message", messageId), Uuid("token", tokenId), Uuid("principal", Caller.PrincipalId.Value)],
            cancellationToken).ConfigureAwait(false);

    /// <summary>The token's unread messages, newest first, after <paramref name="after"/> when given.</summary>
    public async Task<IReadOnlyList<MessageInboxRow>> UnreadAsync(Guid tokenId, Guid? after, int limit, CancellationToken cancellationToken)
    {
        var rows = new List<MessageInboxRow>();
        await foreach (var row in sql.QueryAsync<MessageInboxRow, Mapper>("""
            SELECT message_id FROM message_agent_inbox
             WHERE tenant_id = @tenant AND token_id = @token AND read_at IS NULL AND (@after::uuid IS NULL OR message_id < @after::uuid)
             ORDER BY message_id DESC LIMIT @limit
            """, default(Mapper),
            [Uuid("tenant", Caller.TenantId.Value), Uuid("token", tokenId), Uuid("after", after), Integer("limit", limit)], cancellationToken).ConfigureAwait(false))
        {
            rows.Add(row);
        }

        return rows;
    }

    /// <summary>Marks these messages read for the token; returns how many were unread.</summary>
    public async Task<int> MarkReadAsync(Guid tokenId, Guid[] messageIds, CancellationToken cancellationToken) =>
        await sql.ExecuteAsync("""
            UPDATE message_agent_inbox SET read_at = now()
             WHERE tenant_id = @tenant AND token_id = @token AND message_id = ANY(@messages) AND read_at IS NULL
            """, [Uuid("tenant", Caller.TenantId.Value), Uuid("token", tokenId), UuidArray("messages", messageIds)], cancellationToken).ConfigureAwait(false);

    /// <summary>
    /// How many messages this token posted in the last day. Holds the token's lock until the transaction ends, so a
    /// caller that checks the cap and then records its post cannot race another request of the same token.
    /// </summary>
    public async Task<int> PostedByTokenAsync(Guid tokenId, CancellationToken cancellationToken)
    {
        // A separate statement: the count must read after the lock is held.
        _ = await sql.ExecuteAsync("SELECT pg_advisory_xact_lock(hashtextextended('message-token-posts:' || @token::text, 0))",
            [Uuid("token", tokenId)], cancellationToken).ConfigureAwait(false);
        return await sql.ScalarAsync<int>("""
            SELECT count(*)::int FROM message_token_post
             WHERE tenant_id = @tenant AND token_id = @token AND created_at > now() - interval '1 day'
            """, [Uuid("tenant", Caller.TenantId.Value), Uuid("token", tokenId)], cancellationToken).ConfigureAwait(false) ?? 0;
    }

    /// <summary>Records that a token posted a message.</summary>
    public async Task RecordPostAsync(Guid messageId, Guid tokenId, CancellationToken cancellationToken) =>
        _ = await sql.ExecuteAsync("""
            INSERT INTO message_token_post (tenant_id, message_id, token_id, principal_id)
            VALUES (@tenant, @message, @token, @principal) ON CONFLICT DO NOTHING
            """,
            [Uuid("tenant", Caller.TenantId.Value), Uuid("message", messageId), Uuid("token", tokenId), Uuid("principal", Caller.PrincipalId.Value)],
            cancellationToken).ConfigureAwait(false);

    private readonly struct Mapper : INixRowMapper<MessageInboxRow>
    {
        public MessageInboxRow Map(NpgsqlDataReader reader) => new(reader.GetGuid(0));
    }
}
