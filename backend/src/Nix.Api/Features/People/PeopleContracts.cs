using System.Text.Json.Serialization;

namespace Nix.Features.People;

/// <summary>One local account on the People page.</summary>
public sealed record PersonResponse(
    Guid Id,
    string Email,
    string Name,
    string Status,
    bool IsAdmin,
    bool HasPassword,
    int PasskeyCount,
    bool TotpEnabled,
    DateTimeOffset CreatedAt);

/// <summary>The accounts of the caller's organization.</summary>
public sealed record PeopleListResponse(IReadOnlyList<PersonResponse> People);

/// <summary>Adds a person; they set their own password or passkey through the link that comes back.</summary>
public sealed record AddPersonRequest(string? Email, string? Name);

/// <summary>The acting administrator's current password; omitted when they have none and signed in under 15 minutes ago.</summary>
public sealed record ResetLinkRequest(string? CurrentPassword);

/// <summary>A one-time link and when it stops working. The URL is the only place the secret appears.</summary>
public sealed record PersonLinkResponse(Uri Url, DateTimeOffset ExpiresAt);

/// <summary>The new person and their setup link.</summary>
public sealed record AddPersonResponse(PersonResponse Person, PersonLinkResponse Link);

/// <summary>Source-generated JSON metadata for the People endpoints.</summary>
[JsonSerializable(typeof(PeopleListResponse))]
[JsonSerializable(typeof(AddPersonRequest))]
[JsonSerializable(typeof(ResetLinkRequest))]
[JsonSerializable(typeof(AddPersonResponse))]
[JsonSerializable(typeof(PersonLinkResponse))]
public sealed partial class PeopleJsonContext : JsonSerializerContext;
