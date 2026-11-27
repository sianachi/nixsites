using System.Text.Json;
using System.Text.Json.Nodes;
using Nix.Abstractions;
using Nix.Domain.Identity;
using Nix.Domain.Items;
using Nix.Domain.Primitives;
using Nix.Features.Items;
using Nix.Features.Pets;
using Nix.Features.Workspaces;
using Nix.Messaging;
using Nix.Persistence.Content;
using Nix.Persistence.Workspaces;

namespace Nix.Features.Messages;

/// <summary>Posts messages and lists who they can address.</summary>
public sealed class MessageHandler(
    IVisibleItems visible,
    IIdentityDirectory identities,
    IPersonalAccessTokens accessTokens,
    INixSessionContextAccessor session,
    AccessTokenSessionContext scope,
    CredentialSessionContext credential,
    NixDispatcher dispatcher,
    MessagePetRunner pets,
    IItemLocks itemLocks,
    IWorkspaceLocks workspaceLocks,
    WorkspaceAdministrationStore workspaces,
    MessagePetTurnStore turns,
    PetUsageService usage)
    : ICommandHandler<PostMessage, PostedMessage>, IQueryHandler<GetMessageDirectory, Result<MessageDirectoryResponse>>
{
    private const int DirectoryLimit = 100;

    /// <summary>The most pet turns one token may start in a day.</summary>
    public const int TokenTurnsPerDay = 50;

    private static NixError NotFound => new("items.not_found", "No such item is visible.");

    private static NixError Invalid(string detail) => new("messages.invalid", detail);

    /// <inheritdoc />
    public async ValueTask<Result<PostedMessage>> HandleAsync(PostMessage command, CancellationToken cancellationToken)
    {
        ArgumentNullException.ThrowIfNull(command);
        var request = command.Request;
        var text = request.Text?.Trim();
        var to = request.To?.DistinctBy(address => (address.Id, address.Kind)).ToArray() ?? [];
        if (string.IsNullOrEmpty(text) || text.Length > MessageItem.MaxTextLength)
        {
            return Result.Failure<PostedMessage>(Invalid($"A message is 1 to {MessageItem.MaxTextLength:N0} characters."));
        }

        if (to.Length > MessageItem.MaxRecipients || to.Any(address => address.Kind is not ("person" or "pet") || address.Id == Guid.Empty))
        {
            return Result.Failure<PostedMessage>(Invalid($"Address at most {MessageItem.MaxRecipients} people or pets, each as person or pet."));
        }

        // A pet-turn credential is an agent working for the person, not the person writing.
        if (scope.IsPetTurn)
        {
            return Result.Failure<PostedMessage>(new NixError("messages.interactive_only", "Pets cannot post messages."));
        }

        // A token may address a pet only with the pets:send scope; the workspace switch decides what happens next.
        var petIds = to.Where(address => address.Kind == "pet").Select(address => address.Id).ToArray();
        var agent = !scope.IsInteractive;
        if (petIds.Length > 0 && agent && !(scope.IsTokenSession && scope.MayPetSend))
        {
            return Result.Failure<PostedMessage>(scope.IsTokenSession
                ? new NixError("messages.pets_scope_required", "Addressing a pet needs a token with the pets:send scope.")
                : new NixError("messages.pets_interactive_only", "Only the app or a token with the pets:send scope can address a pet."));
        }

        var context = session.Current ?? throw new InvalidOperationException("No session context; the pipeline must establish one.");
        var found = await visible.FindAsync(command.ParentId, ItemAccess.Write, cancellationToken).ConfigureAwait(false);
        if (found.IsFailure)
        {
            return Result.Failure<PostedMessage>(found.Error);
        }

        var parent = found.Value;
        if (petIds.Length > 0 && await PetRefusal(parent, cancellationToken).ConfigureAwait(false) is { } refusal)
        {
            return Result.Failure<PostedMessage>(refusal);
        }

        var author = await identities.FindPrincipalByIdAsync(context.TenantId, context.PrincipalId, cancellationToken).ConfigureAwait(false);
        string? via = null;
        if (scope.IsTokenSession && credential.CredentialId is { } tokenId)
        {
            via = (await accessTokens.FindOwnAsync(PersonalAccessTokenId.From(tokenId), cancellationToken).ConfigureAwait(false))?.Name;
        }

        var recipients = await ResolveAsync(parent.WorkspaceId, to, cancellationToken).ConfigureAwait(false);
        if (recipients.IsFailure)
        {
            return Result.Failure<PostedMessage>(recipients.Error);
        }

        // Who starts at once: the app's pets, or an agent's under policy "on"; "ask" holds them for their owner.
        var policy = petIds.Length > 0 && agent
            ? await workspaces.ReadAgentsAddressPetsAsync(parent.WorkspaceId, cancellationToken).ConfigureAwait(false)
            : "on";
        var agentToken = agent ? credential.CredentialId : null;
        if (petIds.Length > 0 && policy == "on")
        {
            if (agentToken is { } limited && await turns.StartedByTokenAsync(limited, cancellationToken).ConfigureAwait(false) + petIds.Length > TokenTurnsPerDay)
            {
                return Result.Failure<PostedMessage>(new NixError("messages.pet_turn_limit", $"A token may start {TokenTurnsPerDay} pet turns a day. Try again later."));
            }

            var budget = await usage.RequireAsync(cancellationToken).ConfigureAwait(false);
            if (budget.IsFailure)
            {
                return Result.Failure<PostedMessage>(budget.Error);
            }
        }

        var posted = await Post(parent, text, new MessageAuthor(context.PrincipalId.Value, "person", author?.DisplayName ?? "Someone", via), recipients.Value, cancellationToken).ConfigureAwait(false);
        if (posted.IsFailure)
        {
            return Result.Failure<PostedMessage>(posted.Error);
        }

        if (petIds.Length == 0)
        {
            return Result.Success(new PostedMessage(posted.Value, [], null));
        }

        var (status, reason) = policy switch
        {
            "on" => ("working", null),
            "ask" => ("pending", null),
            _ => ("declined", "Agents may not address pets in this workspace."),
        };
        foreach (var petId in petIds)
        {
            await turns.AddAsync(posted.Value.Id.Value, petId, status, reason, agentToken, via, cancellationToken).ConfigureAwait(false);
        }

        if (status == "working")
        {
            pets.Launch(context, posted.Value.Id.Value, petIds, agent ? new(PetUsageSources.Token(via), agentToken) : null);
        }

        return Result.Success(new PostedMessage(posted.Value, await StatesAsync(posted.Value.Id.Value, cancellationToken).ConfigureAwait(false),
            await usage.BudgetAsync(cancellationToken).ConfigureAwait(false)));
    }

    /// <summary>Where each pet a message addressed stands. Only the pets' owner sees any.</summary>
    public async Task<Result<MessagePetStatesResponse>> PetStates(ItemId messageId, CancellationToken cancellationToken)
    {
        if ((await visible.FindAsync(messageId, ItemAccess.Read, cancellationToken).ConfigureAwait(false)).IsFailure)
        {
            return Result.Failure<MessagePetStatesResponse>(NotFound);
        }

        return Result.Success(new MessagePetStatesResponse(await StatesAsync(messageId.Value, cancellationToken).ConfigureAwait(false)));
    }

    /// <summary>The owner approves (starts the turn) or dismisses a pet's waiting turn. Only the app can.</summary>
    public async Task<Result<MessagePetState>> Decide(ItemId messageId, Guid petId, bool approve, CancellationToken cancellationToken)
    {
        if (!scope.IsInteractive)
        {
            return Result.Failure<MessagePetState>(new NixError("messages.interactive_only", "Only the app can approve or dismiss a pet's turn."));
        }

        if (approve && await usage.RequireAsync(cancellationToken).ConfigureAwait(false) is { IsFailure: true } exhausted)
        {
            return Result.Failure<MessagePetState>(exhausted.Error);
        }

        var row = approve
            ? await turns.ClaimAsync(messageId.Value, petId, cancellationToken).ConfigureAwait(false)
            : await turns.DeclineAsync(messageId.Value, petId, cancellationToken).ConfigureAwait(false);
        if (row is null)
        {
            return Result.Failure<MessagePetState>(new NixError("messages.no_waiting_turn", "No pet is waiting on that message, or the wait has run out."));
        }

        if (approve && row.TokenId is not null
            && await visible.FindAsync(messageId, ItemAccess.Read, cancellationToken).ConfigureAwait(false) is { IsSuccess: true } found
            && await workspaces.ReadAgentsAddressPetsAsync(found.Value.WorkspaceId, cancellationToken).ConfigureAwait(false) == "off")
        {
            // The switch was turned off while the turn waited.
            const string reason = "Agents may not address pets in this workspace.";
            await turns.FinishAsync(messageId.Value, petId, "declined", reason, cancellationToken).ConfigureAwait(false);
            return Result.Failure<MessagePetState>(new NixError("messages.agents_off", reason));
        }

        if (approve)
        {
            pets.Launch(session.Current ?? throw new InvalidOperationException("No session context."), messageId.Value, [petId], new(row.TokenName is null ? PetUsageSources.App : PetUsageSources.Token(row.TokenName), row.TokenId));
        }

        return Result.Success((await StatesAsync(messageId.Value, cancellationToken).ConfigureAwait(false)).First(state => state.PetId == petId));
    }

    private async Task<IReadOnlyList<MessagePetState>> StatesAsync(Guid messageId, CancellationToken cancellationToken)
    {
        var rows = await turns.ListAsync(messageId, cancellationToken).ConfigureAwait(false);
        if (rows.Count == 0)
        {
            return [];
        }

        var profiles = (await dispatcher.QueryAsync<GetPetSettings, PetSettingsResponse>(new(), cancellationToken).ConfigureAwait(false)).Settings.Profiles;
        return [.. rows.Select(row => new MessagePetState(row.PetId, profiles.FirstOrDefault(pet => pet.Id == row.PetId)?.Name ?? "A pet that was removed", row.Status, row.Reason, row.ExpiresAt))];
    }

    // The turn runs later as the poster with no workspace unlock, so refuse here, where the person is looking.
    private async Task<NixError?> PetRefusal(Item parent, CancellationToken cancellationToken)
    {
        if ((await workspaceLocks.GetStateAsync(parent.WorkspaceId, cancellationToken).ConfigureAwait(false)).PasswordProtected)
        {
            return new NixError("messages.workspace_protected", "Pets are not available in a password-protected workspace. Remove the workspace password to use them.");
        }

        return ItemSettings.Read(parent.Settings).WithholdFromPets
            || (await itemLocks.LockedAmongAsync([parent.Id], cancellationToken).ConfigureAwait(false)).Contains(parent.Id)
            ? new NixError("messages.pet_unavailable", "This item is withheld from pets or locked.")
            : null;
    }

    /// <summary>
    /// Writes one message item. The poster's own author record is built by the caller; this is also
    /// the path a pet's reply takes.
    /// </summary>
    public async Task<Result<Item>> Post(Item parent, string text, MessageAuthor author, IReadOnlyList<MessageRecipient> to, CancellationToken cancellationToken)
    {
        ArgumentNullException.ThrowIfNull(parent);
        ArgumentNullException.ThrowIfNull(text);
        var body = new JsonObject
        {
            ["text"] = text,
            ["author"] = JsonSerializer.SerializeToNode(author, MessageJson.Default.Options),
            ["to"] = JsonSerializer.SerializeToNode(to, MessageJson.Default.Options),
        };
        var line = text.ReplaceLineEndings(" ");
        return await dispatcher.SendAsync<CreateItem, Item>(
            new CreateItem(parent.WorkspaceId, MessageItem.Type, line.Length > 80 ? line[..80] : line, parent.Id,
                new JsonObject { [MessageItem.Key] = body.ToJsonString() })
            { MessageWrite = true },
            cancellationToken).ConfigureAwait(false);
    }

    /// <inheritdoc />
    public async ValueTask<Result<MessageDirectoryResponse>> HandleAsync(GetMessageDirectory query, CancellationToken cancellationToken)
    {
        ArgumentNullException.ThrowIfNull(query);
        var found = await visible.FindAsync(query.ItemId, ItemAccess.Write, cancellationToken).ConfigureAwait(false);
        if (found.IsFailure)
        {
            return Result.Failure<MessageDirectoryResponse>(NotFound);
        }

        var search = query.Search?.Trim();
        var list = new List<MessageAddressee>();
        if (scope.IsInteractive)
        {
            var settings = await dispatcher.QueryAsync<GetPetSettings, PetSettingsResponse>(new(), cancellationToken).ConfigureAwait(false);
            list.AddRange(settings.Settings.Profiles
                .Where(pet => string.IsNullOrEmpty(search) || pet.Name.Contains(search, StringComparison.OrdinalIgnoreCase))
                .Select(pet => new MessageAddressee(pet.Id, pet.Name, "pet")));
        }

        var people = await dispatcher.QueryAsync<ListWorkspaceAssignablePrincipals, IReadOnlyList<Nix.Persistence.Workspaces.WorkspacePrincipalSnapshot>>(
            new(found.Value.WorkspaceId, string.IsNullOrEmpty(search) ? null : search, null, DirectoryLimit), cancellationToken).ConfigureAwait(false);
        list.AddRange(people.Where(person => person.Kind == "user").Select(person => new MessageAddressee(person.PrincipalId.Value, person.DisplayName, "person")));
        return Result.Success(new MessageDirectoryResponse(list));
    }

    private async Task<Result<IReadOnlyList<MessageRecipient>>> ResolveAsync(
        Nix.Domain.Tenancy.WorkspaceId workspaceId, MessageAddress[] to, CancellationToken cancellationToken)
    {
        var recipients = new List<MessageRecipient>(to.Length);
        var peopleIds = to.Where(address => address.Kind == "person").Select(address => address.Id).ToArray();
        if (peopleIds.Length > 0)
        {
            // Only people who can read the workspace: anyone else would get a notice they could not open.
            var people = await dispatcher.QueryAsync<ListWorkspaceAssignablePrincipals, IReadOnlyList<Nix.Persistence.Workspaces.WorkspacePrincipalSnapshot>>(
                new(workspaceId, null, null, peopleIds.Length, peopleIds), cancellationToken).ConfigureAwait(false);
            var known = people.Where(person => person.Kind == "user").ToDictionary(person => person.PrincipalId.Value);
            foreach (var id in peopleIds)
            {
                if (!known.TryGetValue(id, out var person))
                {
                    return Result.Failure<IReadOnlyList<MessageRecipient>>(Invalid("Someone you addressed cannot read this item."));
                }

                recipients.Add(new MessageRecipient(id, "person", person.DisplayName));
            }
        }

        var petIds = to.Where(address => address.Kind == "pet").Select(address => address.Id).ToArray();
        if (petIds.Length > 0)
        {
            var settings = await dispatcher.QueryAsync<GetPetSettings, PetSettingsResponse>(new(), cancellationToken).ConfigureAwait(false);
            foreach (var id in petIds)
            {
                // Only the poster's own pets; another person's pet gets the same answer as a missing one.
                if (settings.Settings.Profiles.FirstOrDefault(pet => pet.Id == id) is not { } pet)
                {
                    return Result.Failure<IReadOnlyList<MessageRecipient>>(Invalid("You can only address your own pets."));
                }

                recipients.Add(new MessageRecipient(id, "pet", pet.Name));
            }
        }

        // Keep the poster's order: pets answer in the order they were listed.
        var order = to.Select((address, index) => (address.Id, index)).ToDictionary(pair => pair.Id, pair => pair.index);
        return Result.Success<IReadOnlyList<MessageRecipient>>(recipients.OrderBy(recipient => order[recipient.Id]).ToArray());
    }
}
