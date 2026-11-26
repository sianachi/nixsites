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
    IWorkspaceLocks workspaceLocks)
    : ICommandHandler<PostMessage, Item>, IQueryHandler<GetMessageDirectory, Result<MessageDirectoryResponse>>
{
    private const int DirectoryLimit = 100;

    private static NixError NotFound => new("items.not_found", "No such item is visible.");

    private static NixError Invalid(string detail) => new("messages.invalid", detail);

    /// <inheritdoc />
    public async ValueTask<Result<Item>> HandleAsync(PostMessage command, CancellationToken cancellationToken)
    {
        ArgumentNullException.ThrowIfNull(command);
        var request = command.Request;
        var text = request.Text?.Trim();
        var to = request.To?.DistinctBy(address => (address.Id, address.Kind)).ToArray() ?? [];
        if (string.IsNullOrEmpty(text) || text.Length > MessageItem.MaxTextLength)
        {
            return Result.Failure<Item>(Invalid($"A message is 1 to {MessageItem.MaxTextLength:N0} characters."));
        }

        if (to.Length > MessageItem.MaxRecipients || to.Any(address => address.Kind is not ("person" or "pet") || address.Id == Guid.Empty))
        {
            return Result.Failure<Item>(Invalid($"Address at most {MessageItem.MaxRecipients} people or pets, each as person or pet."));
        }

        // A pet-turn credential is an agent working for the person, not the person writing.
        if (scope.IsPetTurn)
        {
            return Result.Failure<Item>(new NixError("messages.interactive_only", "Pets cannot post messages."));
        }

        // Part B opens this for tokens that hold pets:send under the workspace's agent policy.
        var petIds = to.Where(address => address.Kind == "pet").Select(address => address.Id).ToArray();
        if (petIds.Length > 0 && !scope.IsInteractive)
        {
            return Result.Failure<Item>(new NixError("messages.pets_interactive_only", "Only the app can address a pet for now."));
        }

        var context = session.Current ?? throw new InvalidOperationException("No session context; the pipeline must establish one.");
        var found = await visible.FindAsync(command.ParentId, ItemAccess.Write, cancellationToken).ConfigureAwait(false);
        if (found.IsFailure)
        {
            return Result.Failure<Item>(found.Error);
        }

        var parent = found.Value;
        if (petIds.Length > 0 && await PetRefusal(parent, cancellationToken).ConfigureAwait(false) is { } refusal)
        {
            return Result.Failure<Item>(refusal);
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
            return Result.Failure<Item>(recipients.Error);
        }

        var result = await Post(parent, text, new MessageAuthor(context.PrincipalId.Value, "person", author?.DisplayName ?? "Someone", via), recipients.Value, cancellationToken).ConfigureAwait(false);
        if (result.IsSuccess && petIds.Length > 0)
        {
            pets.Launch(context, result.Value.Id.Value, petIds);
        }

        return result;
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
