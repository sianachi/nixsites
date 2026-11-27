using System.Globalization;
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

    /// <summary>
    /// Whether every character of a memory is one the owner can see in Settings: no controls, line
    /// or paragraph separators, format characters (bidi overrides, zero-width, tag characters),
    /// private-use or lone surrogates, any of which could carry text the model reads and the owner
    /// does not.
    /// </summary>
    public static bool IsVisibleText(string text)
    {
        ArgumentNullException.ThrowIfNull(text);
        foreach (var rune in text.EnumerateRunes())
        {
            if (Rune.GetUnicodeCategory(rune) is UnicodeCategory.Control or UnicodeCategory.Format
                or UnicodeCategory.LineSeparator or UnicodeCategory.ParagraphSeparator
                or UnicodeCategory.PrivateUse or UnicodeCategory.Surrogate or UnicodeCategory.OtherNotAssigned)
            {
                return false;
            }
        }

        return !text.Contains(Rune.ReplacementChar.ToString(), StringComparison.Ordinal);
    }

    /// <summary>Gets the initial disabled configuration.</summary>
    public static PetSettings Empty => new(false, null, []);

    /// <summary>The most companions one person may keep.</summary>
    public const int MaxPets = 5;

    /// <summary>Stored settings as every reader sees them: a retired appearance replaced.</summary>
    public static PetSettings ForRead(PetSettings settings)
    {
        ArgumentNullException.ThrowIfNull(settings);
        return NormalizeRetiredAppearance(settings)!;
    }

    /// <summary>Replaces a retired appearance while keeping each companion's identity and preferences.</summary>
    public static PetSettings? NormalizeRetiredAppearance(PetSettings? settings)
    {
        if (settings?.Profiles is not { } profiles || !profiles.Any(profile => profile is { Appearance: "eye-of-ra" or "demiurge" }))
        {
            return settings;
        }

        // A companion still carrying the retired design's own name takes Owl's.
        return settings with
        {
            Profiles = [.. profiles.Select(profile => profile is { Appearance: "eye-of-ra" or "demiurge" }
                ? profile with { Appearance = "owl", Name = profile.Name == (profile.Appearance == "eye-of-ra" ? "Eye of Ra" : "Demiurge") ? "Owl" : profile.Name }
                : profile)],
        };
    }

    /// <summary>Refuses unknown presets, invalid active references, duplicate identities, and unbounded text.</summary>
    public static bool IsValid(PetSettings? settings)
    {
        if (settings is null || settings.Profiles is null || settings.Profiles.Count > MaxPets)
        {
            return false;
        }

        var ids = new HashSet<Guid>();
        foreach (var profile in settings.Profiles)
        {
            if (profile is null || profile.Id == Guid.Empty || !ids.Add(profile.Id)
                || string.IsNullOrWhiteSpace(profile.Name) || profile.Name.Length > 80
                || profile.Appearance is not ("owl" or "cat" or "fox"
                    or "octopus" or "axolotl" or "moth" or "pangolin" or "phoenix-chick" or "mushroom-sprite"
                    or "origami-crane" or "jumping-spider" or "lantern-spirit" or "hermit-crab" or "kirin-fawn"
                    or "gecko" or "pocket-whale" or "crystal-golem" or "fruit-bat" or "dust-bunny")
                || profile.Instructions is null || profile.Instructions.Length > 2000
                || !PetProviders.IsValid(profile.Provider)
                || profile.Model is null || profile.Model.Length > 160 || profile.Model.Any(char.IsControl))
            {
                return false;
            }
        }

        var memoryIds = new HashSet<Guid>();
        foreach (var memory in settings.Memories ?? [])
        {
            if (memory is null || memory.Id == Guid.Empty || !memoryIds.Add(memory.Id)
                || string.IsNullOrWhiteSpace(memory.Text) || memory.Text.Length > MaxMemoryLength
                || !IsVisibleText(memory.Text)
                || memory.Source is { } source && (source.Kind is not ("conversation" or "message") || source.Id == Guid.Empty
                    || source.Title is not { Length: <= 100 } || source.Author is not { Length: > 0 and <= 100 }
                    || !IsVisibleText(source.Title) || !IsVisibleText(source.Author)))
            {
                return false;
            }
        }

        if (settings.MonthlyBudgetUsd is { } budget && (budget <= 0 || budget > 100_000 || decimal.Round(budget, 2) != budget))
        {
            return false;
        }

        return memoryIds.Count <= MaxMemories
            && settings.MemoryMode is PetMemoryModes.Off or PetMemoryModes.Ask or PetMemoryModes.Always
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
        if (row is null)
        {
            return new(0, PetSettingsValidation.Empty);
        }

        var settings = JsonSerializer.Deserialize(row.SettingsJson, PetJsonContext.Default.PetSettings)
            ?? throw new InvalidOperationException("Stored pet settings are invalid.");
        return new(row.Revision, PetSettingsValidation.ForRead(settings));
    }
}

/// <summary>Persists preferences using a compare-and-swap revision.</summary>
public sealed class SavePetSettingsHandler(IPetPreferencesStore store, INixSessionContextAccessor session, AccessTokenSessionContext scope) : ICommandHandler<SavePetSettings, PetSettingsResponse>
{
    /// <inheritdoc />
    public async ValueTask<Result<PetSettingsResponse>> HandleAsync(SavePetSettings command, CancellationToken cancellationToken)
    {
        ArgumentNullException.ThrowIfNull(command);
        var settings = PetSettingsValidation.NormalizeRetiredAppearance(command.Settings);
        if (settings is null || command.ExpectedRevision < 0 || command.ExpectedRevision >= 9007199254740991 || !PetSettingsValidation.IsValid(settings))
        {
            return Result.Failure<PetSettingsResponse>(new NixError("pets.invalid_settings", "Check the companions' names and settings (at most 5), then save again."));
        }

        var context = session.Current ?? throw new InvalidOperationException("A session is required.");
        if (settings.Memories is null)
        {
            // A client built before memory existed sends none; keeping the stored ones stops its
            // first save from erasing them. The compare-and-swap below still pins the revision read.
            var row = await store.FindAsync(context.TenantId, context.PrincipalId, cancellationToken).ConfigureAwait(false);
            var stored = row is null ? null : JsonSerializer.Deserialize(row.SettingsJson, PetJsonContext.Default.PetSettings);
            settings = settings with { Memories = stored?.Memories };
        }

        if (!scope.IsInteractive && !scope.IsPetTurn && settings.Memories?.Any(memory => memory.Source is not null) == true)
        {
            // Where a memory was learned is the app's or a pet's word; a token keeps only what is already stored, unchanged.
            var row = await store.FindAsync(context.TenantId, context.PrincipalId, cancellationToken).ConfigureAwait(false);
            var stored = (row is null ? null : JsonSerializer.Deserialize(row.SettingsJson, PetJsonContext.Default.PetSettings))?.Memories ?? [];
            settings = settings with
            {
                Memories = [.. settings.Memories.Select(memory => memory.Source is null || stored.Any(old => old.Id == memory.Id && old.Text == memory.Text && old.Source == memory.Source)
                    ? memory : memory with { Source = null })],
            };
        }

        var revision = command.ExpectedRevision + 1;
        var saved = await store.SaveAsync(new PetPreferences
        {
            TenantId = context.TenantId,
            PrincipalId = context.PrincipalId,
            SettingsJson = JsonSerializer.Serialize(settings, PetJsonContext.Default.PetSettings),
            Revision = revision,
        }, command.ExpectedRevision, cancellationToken).ConfigureAwait(false);
        return saved ? Result.Success(new PetSettingsResponse(revision, settings))
            : Result.Failure<PetSettingsResponse>(new NixError("pets.settings_conflict", "Pet settings changed on another device. Reload before saving."));
    }
}
