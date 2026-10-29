using System.Collections.Concurrent;

namespace Nix.Features.Notifications;

/// <summary>
/// Bounds how many <c>notifications/watch</c> long-polls one principal, and this process as a
/// whole, can hold open at once.
/// </summary>
/// <remarks>
/// The watch route is deliberately outside the writes rate limiter (it is a read, and must never
/// queue behind one), and every watch holds a pooled database connection and an open
/// unit-of-work transaction for up to twenty seconds (the gate runs inside the endpoint, after
/// the unit of work has begun). Two bounds keep that from exhausting the pool: at most two per
/// principal, and at most <see cref="MaxConcurrentPerProcess"/> across every principal, well under
/// the default connection pool of one hundred. Both are per process: with several Core replicas a
/// principal can hold two per replica (recorded in ADR-0051).
/// </remarks>
public class NotificationWatchGate
{
    /// <summary>The most watches one principal may hold open at the same time.</summary>
    public const int MaxConcurrent = 2;

    /// <summary>The most watches this process may hold open across every principal.</summary>
    public const int MaxConcurrentPerProcess = 40;

    private readonly ConcurrentDictionary<Guid, int> active = new();

    // One cell, so a gate built to share the process total counts into the same cell.
    private readonly int[] total;

    /// <summary>Creates a gate with its own process total.</summary>
    public NotificationWatchGate() => total = new int[1];

    /// <summary>Creates a gate whose per-principal counts are its own but whose process total is shared with <paramref name="shareTotalWith"/>.</summary>
    protected NotificationWatchGate(NotificationWatchGate shareTotalWith) => total = (shareTotalWith ?? throw new ArgumentNullException(nameof(shareTotalWith))).total;

    /// <summary>Claims a slot for this principal. Returns <see langword="false"/> when none is free.</summary>
    public bool TryEnter(Guid principalId)
    {
        if (Interlocked.Increment(ref total[0]) > MaxConcurrentPerProcess)
        {
            Interlocked.Decrement(ref total[0]);
            return false;
        }

        while (true)
        {
            var current = active.GetOrAdd(principalId, 0);
            if (current >= MaxConcurrent)
            {
                Interlocked.Decrement(ref total[0]);
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
                Interlocked.Decrement(ref total[0]);
                return;
            }
        }
    }
}
