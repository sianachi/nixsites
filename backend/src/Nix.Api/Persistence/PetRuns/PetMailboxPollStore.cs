using System.Diagnostics.CodeAnalysis;
using System.Security.Cryptography;
using System.Text;
using Microsoft.EntityFrameworkCore;
using Nix.Abstractions.PetRuns;
using Nix.Domain.Automations;

namespace Nix.Persistence.PetRuns;

[SuppressMessage("Performance", "CA1812", Justification = "Created by ASP.NET Core dependency injection.")]
internal sealed class PetMailboxPollStore(NixDbContext database) : IPetMailboxPollStore
{
    public Task<PetMailboxCursor?> ReadAsync(Guid ruleId, PollPetMailboxAction watch, CancellationToken cancellationToken) =>
        database.Database.SqlQuery<PetMailboxCursor>($"""
            SELECT cursor AS "Cursor", page_token AS "PageToken", baselined AS "Baselined"
              FROM pet_mailbox_cursor
             WHERE rule_id = {ruleId} AND connection_id = {watch.ConnectionId}
               AND connection_revision = {watch.ConnectionRevision}
            """).SingleOrDefaultAsync(cancellationToken);

    public Task<int> SaveAsync(
        Guid ruleId, PollPetMailboxAction watch, PetMailboxCursor cursor, CancellationToken cancellationToken) =>
        database.Database.ExecuteSqlInterpolatedAsync($"""
            INSERT INTO pet_mailbox_cursor (rule_id, connection_id, connection_revision, cursor, page_token, baselined)
            VALUES ({ruleId}, {watch.ConnectionId}, {watch.ConnectionRevision}, {cursor.Cursor}, {cursor.PageToken}, {cursor.Baselined})
            ON CONFLICT (rule_id, connection_id, connection_revision)
            DO UPDATE SET cursor = excluded.cursor, page_token = excluded.page_token, baselined = excluded.baselined
            """, cancellationToken);

    public async Task<bool> MarkSeenAsync(
        Guid ruleId, PollPetMailboxAction watch, string messageId, CancellationToken cancellationToken) =>
        await database.Database.ExecuteSqlInterpolatedAsync($"""
            INSERT INTO pet_mailbox_seen (rule_id, connection_id, connection_revision, message_hash)
            VALUES ({ruleId}, {watch.ConnectionId}, {watch.ConnectionRevision}, {SHA256.HashData(Encoding.UTF8.GetBytes(messageId))})
            ON CONFLICT DO NOTHING
            """, cancellationToken).ConfigureAwait(false) == 1;
}
