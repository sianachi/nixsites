using System.Text.Json.Serialization;
using Nix.Contracts;
using Nix.Features.Items;

namespace Nix.Serialization;

/// <summary>
/// The items feature's JSON contract, source-generated.
/// </summary>
/// <remarks>
/// One context per feature rather than one for the API, and <c>Program</c> chains them all onto
/// the serializer's resolver chain. The generated output is equivalent either way; what changes is
/// that adding a response type touches a file inside one feature instead of a file every feature
/// shares. With several goals in flight at once, a single registration point is a merge conflict
/// on every one of them - and they are the boring kind that get resolved carelessly.
/// </remarks>
[JsonSourceGenerationOptions(PropertyNamingPolicy = JsonKnownNamingPolicy.CamelCase)]
[JsonSerializable(typeof(ItemResponse))]
[JsonSerializable(typeof(ItemMoveWorkspacePage))]
[JsonSerializable(typeof(CursorPage<ItemResponse>))]
[JsonSerializable(typeof(CreateItemRequest))]
[JsonSerializable(typeof(UpdateItemRequest))]
[JsonSerializable(typeof(MoveItemRequest))]
[JsonSerializable(typeof(SetItemProtectionRequest))]
[JsonSerializable(typeof(SetItemSettingsRequest))]
[JsonSerializable(typeof(ItemBodyResponse))]
[JsonSerializable(typeof(ItemBodyWriteResponse))]
[JsonSerializable(typeof(ItemBodyLoss))]
[JsonSerializable(typeof(ItemBodyMarkdownChanges))]
[JsonSerializable(typeof(IReadOnlyList<ItemBodyLoss>))]
[JsonSerializable(typeof(WriteItemBodyRequest))]
internal sealed partial class ItemsJsonContext : JsonSerializerContext;
