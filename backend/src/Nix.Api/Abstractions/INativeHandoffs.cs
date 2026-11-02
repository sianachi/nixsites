namespace Nix.Abstractions;

/// <summary>Durable, single-use native sign-in handoffs; only hashes and protected payloads are stored.</summary>
public interface INativeHandoffs
{
    /// <summary>Stores a handoff; false when the bounded table or the principal's live quota is full.</summary>
    public ValueTask<bool> CreateAsync(string codeHash, Guid principalId, string challenge, string payload, DateTimeOffset expiresAt, CancellationToken cancellationToken);

    /// <summary>Atomically removes and returns a handoff, whether or not it has expired; null when unknown or used.</summary>
    public ValueTask<NativeHandoffRecord?> ConsumeAsync(string codeHash, CancellationToken cancellationToken);
}

/// <summary>A consumed handoff row.</summary>
public sealed record NativeHandoffRecord(string Challenge, string Payload, DateTimeOffset ExpiresAt);
