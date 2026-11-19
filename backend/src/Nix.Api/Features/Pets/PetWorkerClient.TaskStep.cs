using System.Net.ServerSentEvents;
using System.Text;
using System.Text.Json;
using System.Text.Json.Serialization;
using Nix.Domain.Primitives;

namespace Nix.Features.Pets;

internal sealed record PetTaskStepInput(Guid RunId, Guid StepId, Guid WorkspaceId, Guid ItemId, string Goal,
    IReadOnlyList<string> Context, IReadOnlyList<PetTaskCapability> Capabilities, IReadOnlyList<string>? ScopeAbilities = null);

internal sealed record PetTaskCapability(string Name, string Description, JsonElement? InputSchema = null);

internal sealed record PetTaskStep(string Kind, string? Text, string? Capability, JsonElement? Arguments, string? Scope = null);

internal sealed record PetTaskStepContext(Guid TaskId, IReadOnlyList<string> Observations,
    [property: JsonIgnore(Condition = JsonIgnoreCondition.WhenWritingNull)] IReadOnlyList<string>? ScopeAbilities);

[JsonSourceGenerationOptions(PropertyNamingPolicy = JsonKnownNamingPolicy.CamelCase)]
[JsonSerializable(typeof(IReadOnlyList<PetTaskCapability>), TypeInfoPropertyName = "Capabilities")]
[JsonSerializable(typeof(PetTaskStepContext))]
internal sealed partial class PetTaskStepJsonContext : JsonSerializerContext;

/// <summary>An in-memory credential and proposal context handed to the companion after authorization.</summary>
internal sealed class PreparedPetTaskStep(PetInlineWorkerRequest request, HashSet<string> capabilities, HashSet<string>? scopeAbilities)
{
    internal PetInlineWorkerRequest Request { get; } = request;
    internal bool AllowsScopeRequests => scopeAbilities is not null;
    internal bool Offers(string name) => capabilities.Contains(name);
    internal bool OffersScopeAbility(string name) => scopeAbilities?.Contains(name) == true;
}

public sealed partial class PetWorkerClient
{
    private const int MaxTaskGoalBytes = 8_000;
    private const int MaxTaskCapabilitiesBytes = 65_536;
    private const int MaxTaskContextBytes = 32_000;
    private const int MaxTaskStepOutputBytes = 24_000;
    private const int MaxScopeRequestTextLength = 1_600;

    internal async Task<Result<PreparedPetTaskStep>> PrepareTaskStepAsync(PetProfile pet, PetTaskStepInput input, CancellationToken token)
    {
        if (input.RunId == Guid.Empty || input.StepId == Guid.Empty || input.WorkspaceId == Guid.Empty || input.ItemId == Guid.Empty
            || string.IsNullOrWhiteSpace(input.Goal) || Encoding.UTF8.GetByteCount(input.Goal) > MaxTaskGoalBytes
            || input.Context.Count > 64 || input.Context.Any(value => value.Length > MaxTaskContextBytes)
            || input.Context.Sum(value => value.Length) > MaxTaskContextBytes
            || input.Capabilities.Count > 128 || input.ScopeAbilities is { Count: > 128 })
        {
            return Result.Failure<PreparedPetTaskStep>(InvalidTaskInput());
        }

        var offered = new HashSet<string>(StringComparer.Ordinal);
        var capabilityCharacters = 0;
        foreach (var capability in input.Capabilities)
        {
            if (!IsTaskAbilityName(capability.Name)
                || capability.Description.Length is < 1 or > 2_000
                || capability.InputSchema is { ValueKind: not JsonValueKind.Object }
                || !offered.Add(capability.Name))
            {
                return Result.Failure<PreparedPetTaskStep>(InvalidTaskInput());
            }

            capabilityCharacters += capability.Name.Length + capability.Description.Length + (capability.InputSchema?.GetRawText().Length ?? 0);
            if (capabilityCharacters > MaxTaskCapabilitiesBytes)
            {
                return Result.Failure<PreparedPetTaskStep>(InvalidTaskInput());
            }
        }

        var scopeAbilities = input.ScopeAbilities?.ToHashSet(StringComparer.Ordinal);
        if (input.ScopeAbilities is { } requestedAbilities && scopeAbilities is { } names
            && (names.Count != requestedAbilities.Count || names.Any(name => !IsTaskAbilityName(name))))
        {
            return Result.Failure<PreparedPetTaskStep>(InvalidTaskInput());
        }

        var capabilities = JsonSerializer.Serialize(input.Capabilities, PetTaskStepJsonContext.Default.Capabilities);
        var context = JsonSerializer.Serialize(new PetTaskStepContext(input.ItemId, input.Context, input.ScopeAbilities),
            PetTaskStepJsonContext.Default.PetTaskStepContext);
        if (Encoding.UTF8.GetByteCount(capabilities) > MaxTaskCapabilitiesBytes || Encoding.UTF8.GetByteCount(context) > MaxTaskContextBytes)
        {
            return Result.Failure<PreparedPetTaskStep>(InvalidTaskInput());
        }

        var request = new PetInlineRequest(input.WorkspaceId, input.ItemId, input.StepId, "custom", capabilities, input.Goal, context);
        var prepared = await PrepareToolFreeTurnAsync(request, pet, "plan_task_step", token).ConfigureAwait(false);
        return prepared.IsFailure
            ? Result.Failure<PreparedPetTaskStep>(prepared.Error)
            : Result.Success(new PreparedPetTaskStep(prepared.Value, offered, scopeAbilities));
    }

    internal async Task<Result<PetTaskStep>> PlanTaskStepAsync(PreparedPetTaskStep prepared, CancellationToken token)
    {
        using var deadline = CancellationTokenSource.CreateLinkedTokenSource(token);
        deadline.CancelAfter(TimeSpan.FromSeconds(75));
        try
        {
            var opened = await OpenToolFreeTurnAsync(prepared.Request, deadline.Token).ConfigureAwait(false);
            if (opened.IsFailure)
            {
                return Result.Failure<PetTaskStep>(opened.Error);
            }

            using var response = opened.Value;
            var body = await response.Content.ReadAsStreamAsync(deadline.Token).ConfigureAwait(false);
            // The inline stream sends deltas and a final copy of the text in JSON.
            var bounded = new CappedStream(body, 512 * 1024);
            await using var boundedLease = bounded.ConfigureAwait(false);
            await foreach (var entry in SseParser.Create(bounded).EnumerateAsync(deadline.Token).ConfigureAwait(false))
            {
                if (entry.EventType == "error")
                {
                    return Result.Failure<PetTaskStep>(TaskStepUnavailable());
                }

                if (entry.EventType == "done")
                {
                    using var payload = JsonDocument.Parse(entry.Data, new JsonDocumentOptions { AllowDuplicateProperties = false });
                    if (payload.RootElement.ValueKind == JsonValueKind.Object
                        && payload.RootElement.TryGetProperty("text", out var text) && text.ValueKind == JsonValueKind.String
                        && ParseTaskStep(text.GetString() ?? "", prepared) is { } step)
                    {
                        return Result.Success(step);
                    }

                    return Result.Failure<PetTaskStep>(InvalidTaskStep());
                }
            }
        }
        catch (JsonException)
        {
            return Result.Failure<PetTaskStep>(InvalidTaskStep());
        }
        catch (Exception error) when (error is HttpRequestException or IOException or StreamCapExceededException
            || error is OperationCanceledException && !token.IsCancellationRequested)
        {
            return Result.Failure<PetTaskStep>(TaskStepUnavailable());
        }

        return Result.Failure<PetTaskStep>(TaskStepUnavailable());
    }

    private static PetTaskStep? ParseTaskStep(string output, PreparedPetTaskStep prepared)
    {
        if (Encoding.UTF8.GetByteCount(output) > MaxTaskStepOutputBytes)
        {
            return null;
        }

        using var json = JsonDocument.Parse(output, new JsonDocumentOptions { MaxDepth = 24, AllowDuplicateProperties = false });
        var root = json.RootElement;
        if (root.ValueKind != JsonValueKind.Object || !root.TryGetProperty("kind", out var kindField)
            || kindField.ValueKind != JsonValueKind.String)
        {
            return null;
        }

        var kind = kindField.GetString();
        var members = root.EnumerateObject().Count();
        if ((kind is "question" or "complete") && members == 2 && root.TryGetProperty("text", out var field)
            && field.ValueKind == JsonValueKind.String && field.GetString() is { } text && !string.IsNullOrWhiteSpace(text))
        {
            return new PetTaskStep(kind, text, null, null);
        }

        if (kind == "action" && members == 3 && root.TryGetProperty("capability", out var nameField)
            && nameField.ValueKind == JsonValueKind.String && nameField.GetString() is { } name && prepared.Offers(name)
            && root.TryGetProperty("arguments", out var arguments) && arguments.ValueKind == JsonValueKind.Object)
        {
            return new PetTaskStep(kind, null, name, arguments.Clone());
        }

        if (kind == "scope" && prepared.AllowsScopeRequests && root.TryGetProperty("scope", out var scopeField)
            && scopeField.ValueKind == JsonValueKind.String && root.TryGetProperty("text", out var reasonField)
            && reasonField.ValueKind == JsonValueKind.String && reasonField.GetString() is { Length: <= MaxScopeRequestTextLength } reason
            && !string.IsNullOrWhiteSpace(reason))
        {
            if (scopeField.GetString() == "source" && members == 3)
            {
                return new PetTaskStep(kind, reason, null, null, "source");
            }

            if (scopeField.GetString() == "ability" && members == 4 && root.TryGetProperty("ability", out var abilityField)
                && abilityField.ValueKind == JsonValueKind.String && abilityField.GetString() is { } ability
                && prepared.OffersScopeAbility(ability))
            {
                return new PetTaskStep(kind, reason, ability, null, "ability");
            }
        }

        return null;
    }

    private static bool IsTaskAbilityName(string? name) =>
        name is { Length: >= 1 and <= 100 } && char.IsAsciiLetter(name[0])
        && name.All(character => char.IsAsciiLetterOrDigit(character) || character is '_' or '.' or '-');

    private static NixError InvalidTaskInput() => new("pets.task_context_invalid", "The pet job context was invalid or too large.");

    private static NixError InvalidTaskStep() => new("pets.task_step_invalid", "The pet returned a step that could not be used.");

    private static NixError TaskStepUnavailable() => new("pets.task_step_unavailable", "The companion could not complete this planning step.");
}
