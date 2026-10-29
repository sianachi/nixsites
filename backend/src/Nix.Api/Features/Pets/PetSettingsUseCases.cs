using System.Text;
using System.Text.Json;
using Nix.Abstractions;
using Nix.Domain.Content;
using Nix.Domain.Primitives;
using Nix.Messaging;

namespace Nix.Features.Pets;

/// <summary>Reads the caller's companion configurations.</summary>
public sealed record GetPetSettings : IQuery<PetSettingsResponse>;

/// <summary>Replaces the caller's companion configurations.</summary>
public sealed record SavePetSettings(long ExpectedRevision, PetSettings Settings) : ICommand<PetSettingsResponse>;

/// <summary>Validates settings without interpreting instructions as executable configuration.</summary>
public static class PetSettingsValidation
{
    /// <summary>The most memories the settings hold.</summary>
    public const int MaxMemories = 50;

    /// <summary>The longest memory, in UTF-16 units.</summary>
    public const int MaxMemoryLength = 280;

    /// <summary>Gets the initial disabled configuration.</summary>
    public static PetSettings Empty => new(false, null, "system", []);

    /// <summary>Refuses unknown presets, invalid active references, duplicate identities, and unbounded text.</summary>
    public static bool IsValid(PetSettings? settings)
    {
        if (settings is null || settings.Profiles is null || settings.Profiles.Count > 12
            || settings.Motion is not ("system" or "reduced" or "full"))
        {
            return false;
        }

        var ids = new HashSet<Guid>();
        foreach (var profile in settings.Profiles)
        {
            if (profile is null || profile.Id == Guid.Empty || !ids.Add(profile.Id)
                || string.IsNullOrWhiteSpace(profile.Name) || profile.Name.Length > 80
                || profile.Appearance is not ("owl" or "cat" or "fox" or "eye-of-ra" or "demiurge")
                || profile.Personality is not ("calm" or "playful" or "encouraging" or "concise")
                || profile.ResponseLength is not ("concise" or "balanced" or "detailed")
                || profile.Instructions is null || profile.Instructions.Length > 2000
                || !PetProviders.IsValid(profile.Provider))
            {
                return false;
            }
        }

        var memoryIds = new HashSet<Guid>();
        foreach (var memory in settings.Memories ?? [])
        {
            if (memory is null || memory.Id == Guid.Empty || !memoryIds.Add(memory.Id)
                || string.IsNullOrWhiteSpace(memory.Text) || memory.Text.Length > MaxMemoryLength
                || memory.Text.Any(char.IsControl))
            {
                return false;
            }
        }

        return memoryIds.Count <= MaxMemories
            && (!settings.Enabled || settings.ActivePetId is not null)
            && (settings.ActivePetId is null || ids.Contains(settings.ActivePetId.Value))
            && Encoding.UTF8.GetByteCount(JsonSerializer.Serialize(settings, PetJsonContext.Default.PetSettings)) <= 60000;
    }
}

/// <summary>Reads only the session owner's settings.</summary>
public sealed class GetPetSettingsHandler(IPetPreferencesStore store, INixSessionContextAccessor session) : IQueryHandler<GetPetSettings, PetSettingsResponse>
{
    /// <inheritdoc />
    public async ValueTask<PetSettingsResponse> HandleAsync(GetPetSettings query, CancellationToken cancellationToken)
    {
        var context = session.Current ?? throw new InvalidOperationException("A session is required.");
        var row = await store.FindAsync(context.TenantId, context.PrincipalId, cancellationToken).ConfigureAwait(false);
        return row is null ? new(0, PetSettingsValidation.Empty) : new(row.Revision,
            JsonSerializer.Deserialize(row.SettingsJson, PetJsonContext.Default.PetSettings)
                ?? throw new InvalidOperationException("Stored pet settings are invalid."));
    }
}

/// <summary>Persists preferences using a compare-and-swap revision.</summary>
public sealed class SavePetSettingsHandler(IPetPreferencesStore store, INixSessionContextAccessor session) : ICommandHandler<SavePetSettings, PetSettingsResponse>
{
    /// <inheritdoc />
    public async ValueTask<Result<PetSettingsResponse>> HandleAsync(SavePetSettings command, CancellationToken cancellationToken)
    {
        ArgumentNullException.ThrowIfNull(command);
        if (command.ExpectedRevision < 0 || command.ExpectedRevision >= 9007199254740991 || !PetSettingsValidation.IsValid(command.Settings))
        {
            return Result.Failure<PetSettingsResponse>(new NixError("pets.invalid_settings", "Check the pet names, presets, and active pet, then save again."));
        }

        var context = session.Current ?? throw new InvalidOperationException("A session is required.");
        var revision = command.ExpectedRevision + 1;
        var saved = await store.SaveAsync(new PetPreferences
        {
            TenantId = context.TenantId,
            PrincipalId = context.PrincipalId,
            SettingsJson = JsonSerializer.Serialize(command.Settings, PetJsonContext.Default.PetSettings),
            Revision = revision,
        }, command.ExpectedRevision, cancellationToken).ConfigureAwait(false);
        return saved ? Result.Success(new PetSettingsResponse(revision, command.Settings))
            : Result.Failure<PetSettingsResponse>(new NixError("pets.settings_conflict", "Pet settings changed on another device. Reload before saving."));
    }
}
