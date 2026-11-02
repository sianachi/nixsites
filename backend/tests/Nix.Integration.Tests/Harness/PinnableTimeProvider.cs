namespace Nix.Integration.Tests.Harness;

/// <summary>
/// The persistence host's clock: the system clock until a test pins it, so a replay can create
/// items "at" a fixture's time. Per host, never static, so a pin cannot leak into another suite.
/// </summary>
internal sealed class PinnableTimeProvider : TimeProvider
{
    private DateTimeOffset? _pinned;

    /// <summary>Makes <see cref="GetUtcNow"/> answer <paramref name="at"/> until <see cref="Unpin"/>.</summary>
    /// <param name="at">The instant.</param>
    public void Pin(DateTimeOffset at) => _pinned = at;

    /// <summary>Returns to the system clock.</summary>
    public void Unpin() => _pinned = null;

    /// <inheritdoc />
    public override DateTimeOffset GetUtcNow() => _pinned ?? base.GetUtcNow();
}
