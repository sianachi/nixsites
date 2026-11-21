using System.Globalization;
using System.Text.Json;
using System.Text.Json.Serialization.Metadata;
using System.Text.RegularExpressions;
using Nix.Domain.Items;
using Nix.Domain.Primitives;
using Nix.Features.Habits;
using Nix.Features.Recurrence;
using Nix.Messaging;
using Nix.Serialization;

namespace Nix.Features.Sync;

/// <summary>
/// The ordinary writes a device may queue as a "request" replay: habit check-ins and recurrence
/// completions, which are not plain item operations. This is an allowlist, not a proxy: the method
/// and path must match one of the routes below exactly, the path's item must be the operation's own
/// item, and the body is read into that route's typed request. Each route then dispatches the same
/// command its HTTP endpoint does, so the command's own permission and lock checks decide.
/// </summary>
internal static partial class NativeReplayRequests
{
    /// <summary>Applies one allowed request as the signed-in caller; its result carries the item written.</summary>
    internal delegate ValueTask<Result<ItemId>> Apply(NixDispatcher dispatcher, CancellationToken cancellationToken);

    [GeneratedRegex("^/api/v1/items/(?<id>[0-9a-fA-F-]{36})/habit/check-ins/(?<day>[0-9]{4}-[0-9]{2}-[0-9]{2})$")]
    private static partial Regex CheckInPath();

    [GeneratedRegex("^/api/v1/items/(?<id>[0-9a-fA-F-]{36})/recurrence/completions$")]
    private static partial Regex CompletionPath();

    /// <summary>The route a request names, or null when it is not on the allowlist or its body is not that route's.</summary>
    internal static Apply? Match(Guid itemId, string method, string path, JsonElement? body)
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
            if (method == "PUT" && Read(body, HabitsJsonContext.Default.HabitCheckInRequest) is { } request)
            {
                return async (dispatcher, token) => Written(id,
                    await dispatcher.SendAsync<SetHabitCheckIn, HabitCheckInResponse>(new SetHabitCheckIn(id, day, request), token).ConfigureAwait(false));
            }
            if (method == "DELETE" && body is null or { ValueKind: JsonValueKind.Null })
            {
                return async (dispatcher, token) =>
                    await dispatcher.SendAsync<UndoHabitCheckIn, ItemId>(new UndoHabitCheckIn(id, day), token).ConfigureAwait(false);
            }
            return null;
        }

        var completion = CompletionPath().Match(path);
        if (completion.Success && method == "POST"
            && Guid.TryParse(completion.Groups["id"].Value, out var completed) && completed == itemId
            && Read(body, RecurrenceJsonContext.Default.CompleteOccurrenceRequest) is { OccurredOn: { } text }
            && RecurrenceMapping.TryDay(text, out var occurredOn))
        {
            return async (dispatcher, token) => Written(id,
                await dispatcher.SendAsync<CompleteRecurrenceOccurrence, Item>(new CompleteRecurrenceOccurrence(id, occurredOn), token).ConfigureAwait(false));
        }
        return null;
    }

    private static T? Read<T>(JsonElement? body, JsonTypeInfo<T> info)
        where T : class
    {
        if (body is not { ValueKind: JsonValueKind.Object } element)
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
