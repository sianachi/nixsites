using System.Collections.Concurrent;

namespace Nix.Features.Comments;

/// <summary>
/// Bounds how many <c>comments/watch</c> long-polls one principal, and this process as a whole,
/// can hold open. Each holds a pooled connection and an open unit of work for up to twenty
/// seconds, so the bounds mirror <c>NotificationWatchGate</c>: at most 2 per principal, 40 per
/// process. Per process: with several Core replicas a principal can hold two per replica.
/// </summary>
public sealed class CommentWatchGate
{
    /// <summary>The most watches one principal may hold open at the same time.</summary>
    public const int MaxConcurrent = 2;

    /// <summary>The most watches this process may hold open across every principal.</summary>
    public const int MaxConcurrentPerProcess = 40;

    private readonly ConcurrentDictionary<Guid, int> active = new();
    private int total;

    /// <summary>Claims a slot for this principal. Returns <see langword="false"/> when none is free.</summary>
    public bool TryEnter(Guid principalId)
    {
        if (Interlocked.Increment(ref total) > MaxConcurrentPerProcess)
        {
            Interlocked.Decrement(ref total);
            return false;
        }

        while (true)
        {
            var current = active.GetOrAdd(principalId, 0);
            if (current >= MaxConcurrent)
            {
                Interlocked.Decrement(ref total);
                return false;
            }

            if (active.TryUpdate(principalId, current + 1, current))
            {
                return true;
            }
        }
    }

    /// <summary>Releases the slot claimed by a matching <see cref="TryEnter"/>.</summary>
    public void Exit(Guid principalId)
    {
        while (true)
        {
            if (!active.TryGetValue(principalId, out var current) || current <= 0)
            {
                return;
            }

            var released = current == 1
                ? active.TryRemove(new KeyValuePair<Guid, int>(principalId, current))
                : active.TryUpdate(principalId, current - 1, current);
            if (released)
            {
                Interlocked.Decrement(ref total);
                return;
            }
        }
    }
}
