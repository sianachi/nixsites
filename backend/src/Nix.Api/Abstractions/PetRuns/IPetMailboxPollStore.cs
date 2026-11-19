using Nix.Domain.Automations;

namespace Nix.Abstractions.PetRuns;

internal sealed record PetMailboxCursor(string Cursor, string? PageToken, bool Baselined);

internal interface IPetMailboxPollStore
{
    public Task<PetMailboxCursor?> ReadAsync(Guid ruleId, PollPetMailboxAction watch, CancellationToken cancellationToken);

    public Task<int> SaveAsync(Guid ruleId, PollPetMailboxAction watch, PetMailboxCursor cursor, CancellationToken cancellationToken);

    public Task<bool> MarkSeenAsync(Guid ruleId, PollPetMailboxAction watch, string messageId, CancellationToken cancellationToken);
}
