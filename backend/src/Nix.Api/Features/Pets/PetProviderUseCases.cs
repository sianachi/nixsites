using Nix.Abstractions;
using Nix.Domain.Pets;
using Nix.Domain.Primitives;
using Nix.Messaging;

namespace Nix.Features.Pets;

/// <summary>The providers a pet may use and the key rules each has.</summary>
public static class PetProviders
{
    /// <summary>The Codex app-server signed in with the owner's ChatGPT account; no key.</summary>
    public const string ChatGpt = "chatgpt";

    /// <summary>Anthropic's Messages API with the owner's key.</summary>
    public const string Anthropic = "anthropic";

    /// <summary>OpenRouter's OpenAI-compatible API with the owner's key.</summary>
    public const string OpenRouter = "openrouter";

    /// <summary>OpenAI's API with the owner's key (not the ChatGPT sign-in).</summary>
    public const string OpenAi = "openai";

    /// <summary>The providers that take an API key.</summary>
    public static readonly IReadOnlyList<string> Keyed = [Anthropic, OpenRouter, OpenAi];

    /// <summary>Whether a provider name is one this build knows.</summary>
    public static bool IsValid(string? provider) => provider is ChatGpt or Anthropic or OpenRouter or OpenAi;

    /// <summary>Whether a provider needs a stored key.</summary>
    public static bool NeedsKey(string? provider) => provider is Anthropic or OpenRouter or OpenAi;

    /// <summary>A plausible key shape: printable, bounded, no whitespace. Core never calls the provider itself.</summary>
    public static bool IsPlausibleKey(string? key) =>
        key is { Length: >= 20 and <= 512 } && key.All(character => character > ' ' && character < 127);
}

/// <summary>One stored key as the owner may see it: which provider, a hint, when it was saved.</summary>
public sealed record PetProviderKeyResponse(string Provider, string KeyHint, DateTimeOffset SavedAt);

/// <summary>Every provider with whether a key is stored.</summary>
public sealed record PetProvidersResponse(IReadOnlyList<PetProviderKeyResponse> Keys);

/// <summary>Saves (replaces) the owner's key for a provider.</summary>
public sealed record SavePetProviderKeyRequest(string Key);

/// <summary>Reads the owner's stored provider keys, hints only.</summary>
public sealed record ListPetProviderKeys : IQuery<PetProvidersResponse>;

/// <summary>Stores or replaces one provider key.</summary>
public sealed record SavePetProviderKey(string Provider, string Key) : ICommand<PetProviderKeyResponse>;

/// <summary>Forgets one provider key.</summary>
public sealed record RemovePetProviderKey(string Provider) : ICommand<bool>;

/// <summary>Reads only the session owner's keys, never the keys themselves.</summary>
public sealed class ListPetProviderKeysHandler(IPetProviderCredentialStore store, INixSessionContextAccessor session)
    : IQueryHandler<ListPetProviderKeys, PetProvidersResponse>
{
    /// <inheritdoc />
    public async ValueTask<PetProvidersResponse> HandleAsync(ListPetProviderKeys query, CancellationToken cancellationToken)
    {
        var context = session.Current ?? throw new InvalidOperationException("A session is required.");
        var rows = await store.ListAsync(context.TenantId, context.PrincipalId, cancellationToken).ConfigureAwait(false);
        return new([.. rows.Select(row => new PetProviderKeyResponse(row.Provider, row.KeyHint, row.SavedAt))]);
    }
}

/// <summary>Protects and stores a key; the plaintext never leaves this handler.</summary>
public sealed class SavePetProviderKeyHandler(IPetProviderCredentialStore store, PetProviderKeyProtector protector, INixSessionContextAccessor session)
    : ICommandHandler<SavePetProviderKey, PetProviderKeyResponse>
{
    /// <inheritdoc />
    public async ValueTask<Result<PetProviderKeyResponse>> HandleAsync(SavePetProviderKey command, CancellationToken cancellationToken)
    {
        ArgumentNullException.ThrowIfNull(command);
        if (!PetProviders.NeedsKey(command.Provider))
        {
            return Result.Failure<PetProviderKeyResponse>(new NixError("pets.unknown_provider", "Choose Anthropic, OpenRouter or OpenAI."));
        }

        var key = command.Key.Trim();
        if (!PetProviders.IsPlausibleKey(key))
        {
            return Result.Failure<PetProviderKeyResponse>(new NixError("pets.invalid_key", "Paste the whole API key, with no spaces."));
        }

        var context = session.Current ?? throw new InvalidOperationException("A session is required.");
        var credential = new PetProviderCredential
        {
            TenantId = context.TenantId,
            PrincipalId = context.PrincipalId,
            Provider = command.Provider,
            ProtectedKey = protector.Protect(key),
            KeyHint = key[^4..],
            SavedAt = DateTimeOffset.UtcNow,
        };
        await store.SaveAsync(credential, cancellationToken).ConfigureAwait(false);
        return Result.Success(new PetProviderKeyResponse(credential.Provider, credential.KeyHint, credential.SavedAt));
    }
}

/// <summary>Forgets a key; every later turn for that provider refuses until a new one is saved.</summary>
public sealed class RemovePetProviderKeyHandler(IPetProviderCredentialStore store, INixSessionContextAccessor session)
    : ICommandHandler<RemovePetProviderKey, bool>
{
    /// <inheritdoc />
    public async ValueTask<Result<bool>> HandleAsync(RemovePetProviderKey command, CancellationToken cancellationToken)
    {
        ArgumentNullException.ThrowIfNull(command);
        if (!PetProviders.NeedsKey(command.Provider))
        {
            return Result.Failure<bool>(new NixError("pets.unknown_provider", "Choose Anthropic, OpenRouter or OpenAI."));
        }

        var context = session.Current ?? throw new InvalidOperationException("A session is required.");
        return Result.Success(await store.RemoveAsync(context.TenantId, context.PrincipalId, command.Provider, cancellationToken).ConfigureAwait(false));
    }
}
