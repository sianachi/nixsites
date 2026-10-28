using System.Text.Json.Serialization;
using Nix.Features.Search;

namespace Nix.Serialization;

/// <summary>
/// The search feature's JSON contract, source-generated.
/// </summary>
/// <remarks>
/// One context per feature rather than one for the API, for the reason spelled out in
/// <see cref="ItemsJsonContext"/>: a single registration point is a merge conflict on every goal
/// in flight, and they are the boring kind that get resolved carelessly.
/// </remarks>
[JsonSourceGenerationOptions(PropertyNamingPolicy = JsonKnownNamingPolicy.CamelCase)]
[JsonSerializable(typeof(SearchResponse))]
[JsonSerializable(typeof(ReferencesResponse))]
[JsonSerializable(typeof(BacklinksResponse))]
[JsonSerializable(typeof(PassagesResponse))]
[JsonSerializable(typeof(RelatedItemsResponse))]
[JsonSerializable(typeof(MentionsRequest))]
[JsonSerializable(typeof(MentionsResponse))]
internal sealed partial class SearchJsonContext : JsonSerializerContext;
