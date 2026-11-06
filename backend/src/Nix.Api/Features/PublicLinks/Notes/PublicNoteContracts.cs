using System.Text.Json.Serialization;

namespace Nix.Features.PublicLinks.Notes;

/// <summary>The link a collaboration call is about. Core re-verifies every field against the live link row.</summary>
public sealed record PublicNoteScope(Guid TenantId, Guid PrincipalId, Guid WorkspaceId, Guid ItemId);

/// <summary>The files a note body names: attachments and item references (<c>Blocks</c>) and inline images.</summary>
internal sealed record PublicNoteFilesRequest(
    Guid TenantId,
    Guid PrincipalId,
    Guid WorkspaceId,
    Guid ItemId,
    IReadOnlyList<Guid> Blocks,
    IReadOnlyList<Guid> Images);

/// <summary>Core's answer to an authorize call. It is only ever a read.</summary>
public sealed record PublicNoteGrant(Guid ItemId, Guid WorkspaceId, string Permission, string BodyKind, string Title);

/// <summary>One file as an anonymous reader may meet it: <c>servable</c>, <c>withheld</c> or <c>hidden</c>.</summary>
internal sealed record PublicFileVerdictResponse(Guid Id, string Disposition, string? Name, string? MediaType);

internal sealed record PublicNoteFilesResponse(
    IReadOnlyList<PublicFileVerdictResponse> Blocks,
    IReadOnlyList<PublicFileVerdictResponse> Images);

/// <summary>What collaboration renders for a public note.</summary>
internal sealed record CollabPublicNote(
    string Title,
    string Html,
    IReadOnlyList<Guid> ServableFileIds,
    IReadOnlyList<CollabWithheldFile> WithheldFiles);

internal sealed record CollabWithheldFile(Guid FileItemId, string Name);

[JsonSourceGenerationOptions(PropertyNamingPolicy = JsonKnownNamingPolicy.CamelCase)]
[JsonSerializable(typeof(PublicNoteScope))]
[JsonSerializable(typeof(PublicNoteFilesRequest))]
[JsonSerializable(typeof(PublicNoteGrant))]
[JsonSerializable(typeof(PublicNoteFilesResponse))]
[JsonSerializable(typeof(CollabPublicNote))]
internal sealed partial class PublicNotesJsonContext : JsonSerializerContext;
