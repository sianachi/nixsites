namespace Nix.Domain.Primitives;

/// <summary>
/// An expected failure: something a well-formed request can legitimately run into.
/// </summary>
/// <param name="Code">
/// The stable, machine-readable identifier the API surfaces as the <c>code</c> extension of an
/// RFC 9457 problem document, and the frontend switches on.
/// </param>
/// <param name="Message">
/// A human-readable explanation of this occurrence. Never parsed by a client, never localized
/// here, and never the thing a caller branches on.
/// </param>
/// <remarks>
/// <para>
/// The distinction this type enforces is the one the engineering plan draws: expected failures are
/// values, bugs and infrastructure faults are exceptions. "That item does not exist" and "moving a
/// folder into its own child" are outcomes of legitimate requests, so a use case returns them; a
/// closed connection, or a null that should not have been, is not - so it throws.
/// </para>
/// <para>
/// Codes are namespaced by feature (<c>items.not_found</c>) so two features cannot collide, and
/// each is declared where its feature owns it rather than invented at a call site.
/// </para>
/// <para>
/// Named <c>NixError</c> rather than <c>Error</c> because the shorter name collides with a
/// reserved word in other .NET languages, and the analyzers are right that a type nearly every
/// file will reference is the wrong place to be clever about it.
/// </para>
/// </remarks>
public readonly record struct NixError(string Code, string Message)
{
    /// <summary>Per-field reasons, for a refusal that is about named properties.</summary>
    public IReadOnlyList<Nix.Domain.Properties.PropertyViolation>? Violations { get; init; }

    /// <summary>The item a conflict collided with, when the caller may be told.</summary>
    public Guid? ExistingItemId { get; init; }

    /// <summary>The value an uninitialised error would carry. Never returned from a failure.</summary>
    public static NixError None => new(string.Empty, string.Empty);

    /// <summary>Gets a value indicating whether this is a real failure rather than the empty value.</summary>
    public bool IsSet => !string.IsNullOrEmpty(Code);
}
