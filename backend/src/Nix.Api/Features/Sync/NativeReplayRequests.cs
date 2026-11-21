using System.Collections.Immutable;
using System.Globalization;
using System.Text.Json;
using System.Text.Json.Nodes;
using System.Text.Json.Serialization.Metadata;
using System.Text.RegularExpressions;
using Nix.Domain.Items;
using Nix.Domain.Primitives;
using Nix.Domain.Views;
using Nix.Features.Habits;
using Nix.Features.Items;
using Nix.Features.Properties;
using Nix.Features.Recurrence;
using Nix.Features.Views;
using Nix.Messaging;
using Nix.Serialization;

namespace Nix.Features.Sync;

/// <summary>
/// The ordinary writes a device may queue as a "request" replay: habit check-ins, recurrence
/// completions, item protection, views and schema. This is an allowlist, not a proxy: the method
/// and path must match one of the routes below exactly, the path's item must be the operation's own
/// item, and the body is read into that route's typed request. Each route then dispatches the same
/// command its HTTP endpoint does, so the command's own permission and lock checks decide.
/// </summary>
/// <remarks>
/// Protection, views and schema carry what the device saw before the edit (the protection flags, the
/// views version, the schema document), and the command refuses the write when the stored value
/// differs, so a delayed write cannot undo someone else's change.
/// </remarks>
internal static partial class NativeReplayRequests
{
    /// <summary>Applies one allowed request as the signed-in caller; its result carries the item written.</summary>
    internal delegate ValueTask<Result<ItemId>> Apply(NixDispatcher dispatcher, CancellationToken cancellationToken);

    /// <summary>An allowed request. <paramref name="HumanOnly"/> routes are refused for pet turn credentials, as the direct route is.</summary>
    internal sealed record Route(Apply Apply, bool HumanOnly = false);

    // Unknown and miscased members are refused, so a queued write is exactly what the device checked.
    private static readonly JsonSerializerOptions Strict = new(StructureJsonContext.Default.Options)
    {
        UnmappedMemberHandling = System.Text.Json.Serialization.JsonUnmappedMemberHandling.Disallow,
        PropertyNameCaseInsensitive = false,
    };

    [GeneratedRegex("^/api/v1/items/(?<id>[0-9a-fA-F-]{36})/habit/check-ins/(?<day>[0-9]{4}-[0-9]{2}-[0-9]{2})\\z")]
    private static partial Regex CheckInPath();

    [GeneratedRegex("^/api/v1/items/(?<id>[0-9a-fA-F-]{36})/recurrence/completions\\z")]
    private static partial Regex CompletionPath();

    [GeneratedRegex("^/api/v1/items/(?<id>[0-9a-fA-F-]{36})/(?<part>protection|views|schema)\\z")]
    private static partial Regex StructurePath();

    /// <summary>The route a request names, or null when it is not on the allowlist or its body is not that route's.</summary>
    internal static Route? Match(Guid itemId, string method, string path, JsonElement? body)
    {
        var id = ItemId.From(itemId);
        var checkIn = CheckInPath().Match(path);
        if (checkIn.Success)
        {
            if (!Guid.TryParse(checkIn.Groups["id"].Value, out var named) || named != itemId
                || !DateOnly.TryParseExact(checkIn.Groups["day"].Value, "yyyy-MM-dd", CultureInfo.InvariantCulture, DateTimeStyles.None, out var day))
            {
                return null;
            }
            if (method == "PUT" && Read(body, HabitsJsonContext.Default.HabitCheckInRequest, "completed", "quantity") is { } request)
            {
                return new Route(async (dispatcher, token) => Written(id,
                    await dispatcher.SendAsync<SetHabitCheckIn, HabitCheckInResponse>(new SetHabitCheckIn(id, day, request), token).ConfigureAwait(false)));
            }
            if (method == "DELETE" && body is null or { ValueKind: JsonValueKind.Null })
            {
                return new Route(async (dispatcher, token) =>
                    await dispatcher.SendAsync<UndoHabitCheckIn, ItemId>(new UndoHabitCheckIn(id, day), token).ConfigureAwait(false));
            }
            return null;
        }

        var completion = CompletionPath().Match(path);
        if (completion.Success && method == "POST"
            && Guid.TryParse(completion.Groups["id"].Value, out var completed) && completed == itemId
            && Read(body, RecurrenceJsonContext.Default.CompleteOccurrenceRequest, "occurredOn") is { OccurredOn: { } text }
            && RecurrenceMapping.TryDay(text, out var occurredOn))
        {
            return new Route(async (dispatcher, token) => Written(id,
                await dispatcher.SendAsync<CompleteRecurrenceOccurrence, Item>(new CompleteRecurrenceOccurrence(id, occurredOn), token).ConfigureAwait(false)));
        }

        var structure = StructurePath().Match(path);
        if (structure.Success && method == "PUT" && body is { ValueKind: JsonValueKind.Object } document
            && Guid.TryParse(structure.Groups["id"].Value, out var structured) && structured == itemId)
        {
            return structure.Groups["part"].Value switch
            {
                "protection" => Protection(id, document),
                "views" => Views(id, document),
                _ => Schema(id, document),
            };
        }
        return null;
    }

    /// <summary>The flags as the device saw them (`base`, both required) and the flags it wants; nothing else.</summary>
    private static Route? Protection(ItemId id, JsonElement body)
    {
        if (!OnlyMembers(body, "noDelete", "noChildren", "base")
            || !Flag(body, "noDelete", out var noDelete) || !Flag(body, "noChildren", out var noChildren)
            || !body.TryGetProperty("base", out var seen) || seen.ValueKind != JsonValueKind.Object
            || !OnlyMembers(seen, "noDelete", "noChildren")
            || !seen.TryGetProperty("noDelete", out var seenDelete) || seenDelete.ValueKind is not (JsonValueKind.True or JsonValueKind.False)
            || !seen.TryGetProperty("noChildren", out var seenChildren) || seenChildren.ValueKind is not (JsonValueKind.True or JsonValueKind.False))
        {
            return null;
        }

        var expected = new ProtectionBase(seenDelete.GetBoolean(), seenChildren.GetBoolean());
        return new Route(async (dispatcher, token) => Written(id,
            await dispatcher.SendAsync<SetItemProtection, Item>(new SetItemProtection(id, noDelete, noChildren, null, expected), token).ConfigureAwait(false)),
            HumanOnly: true);
    }

    /// <summary>The views as the direct route takes them, with the version the device saw required.</summary>
    private static Route? Views(ItemId id, JsonElement body)
    {
        SetViewsRequest? request;
        try
        {
            request = body.Deserialize((JsonTypeInfo<SetViewsRequest>)Strict.GetTypeInfo(typeof(SetViewsRequest)));
        }
        catch (JsonException)
        {
            return null;
        }
        if (request is not { Views: not null, ExpectedVersion: { Length: > 0 } version }
            || !ViewMapping.TryToDomain(request, out var views, out _))
        {
            return null;
        }

        return new Route(async (dispatcher, token) => Written(id,
            await dispatcher.SendAsync<SetContainerViews, ImmutableArray<ViewDefinition>>(
                new SetContainerViews(id, views, request.Default, request.HideDocument, version), token).ConfigureAwait(false)));
    }

    /// <summary>The schema as the direct route takes it, plus the schema document (`base`) the device edited from.</summary>
    private static Route? Schema(ItemId id, JsonElement body)
    {
        try
        {
            if (JsonNode.Parse(body.GetRawText()) is not JsonObject edited
                || !edited.Remove("base", out var seenNode) || seenNode is not JsonObject seenDocument)
            {
                return null;
            }
            var info = (JsonTypeInfo<SetSchemaRequest>)Strict.GetTypeInfo(typeof(SetSchemaRequest));
            if (edited.Deserialize(info) is not { Properties: not null } request
                || seenDocument.Deserialize(info) is not { Properties: not null } seen
                || !PropertyMapping.TryToDomain(request, out var schema, out _)
                || !PropertyMapping.TryToDomain(seen, out var seenSchema, out _))
            {
                return null;
            }

            return new Route(async (dispatcher, token) => Written(id,
                await dispatcher.SendAsync<SetItemSchema, Nix.Domain.Properties.PropertySchema>(
                    new SetItemSchema(id, schema, new SchemaBase(seenSchema)), token).ConfigureAwait(false)));
        }
        catch (JsonException)
        {
            return null;
        }
    }

    private static bool OnlyMembers(JsonElement element, params string[] members) =>
        element.EnumerateObject().All(property => members.Contains(property.Name, StringComparer.Ordinal));

    /// <summary>An optional flag: absent or null is "unchanged", a boolean is itself, anything else is refused.</summary>
    private static bool Flag(JsonElement body, string name, out bool? value)
    {
        value = null;
        if (!body.TryGetProperty(name, out var element) || element.ValueKind == JsonValueKind.Null)
        {
            return true;
        }
        if (element.ValueKind is not (JsonValueKind.True or JsonValueKind.False))
        {
            return false;
        }
        value = element.GetBoolean();
        return true;
    }

    /// <summary>
    /// Reads a body into the route's request. Unlike the direct route it refuses a member the request
    /// does not have, and a miscased one: a queued write is exactly what was validated on the device.
    /// </summary>
    private static T? Read<T>(JsonElement? body, JsonTypeInfo<T> info, params string[] members)
        where T : class
    {
        if (body is not { ValueKind: JsonValueKind.Object } element || !OnlyMembers(element, members))
        {
            return null;
        }
        try
        {
            return element.Deserialize(info);
        }
        catch (JsonException)
        {
            return null;
        }
    }

    private static Result<ItemId> Written<T>(ItemId itemId, Result<T> result) =>
        result.IsSuccess ? Result.Success(itemId) : Result.Failure<ItemId>(result.Error);
}
