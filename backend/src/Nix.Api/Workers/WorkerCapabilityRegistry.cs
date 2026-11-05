using Nix.Abstractions.Workers;

namespace Nix.Workers;

/// <summary>Process-local projection of unexpired worker advertisements.</summary>
public sealed class WorkerCapabilityRegistry : IWorkerCapabilityRegistry
{
    private const int MaximumAdvertisements = 1024;
    private readonly Lock _sync = new();
    private readonly Dictionary<string, WorkerCapabilityAdvertisement> _advertisements =
        new(StringComparer.Ordinal);

    public void Replace(WorkerCapabilityAdvertisement advertisement)
    {
        ArgumentNullException.ThrowIfNull(advertisement);
        lock (_sync)
        {
            if (_advertisements.TryGetValue(advertisement.InstanceId, out var current))
            {
                if (advertisement.OccurredAt >= current.OccurredAt)
                {
                    _advertisements[advertisement.InstanceId] = advertisement;
                }
                return;
            }

            if (_advertisements.Count >= MaximumAdvertisements)
            {
                foreach (var expired in _advertisements
                    .Where(pair => pair.Value.ExpiresAt <= advertisement.OccurredAt)
                    .Select(pair => pair.Key)
                    .ToArray())
                {
                    _advertisements.Remove(expired);
                }
            }
            if (_advertisements.Count >= MaximumAdvertisements)
            {
                var oldest = _advertisements.MinBy(pair => pair.Value.ExpiresAt);
                _advertisements.Remove(oldest.Key);
            }
            _advertisements.Add(advertisement.InstanceId, advertisement);
        }
    }

    public IReadOnlyList<ExportFormatCapability> ExportFormats(DateTimeOffset now)
    {
        lock (_sync)
        {
            var live = new List<WorkerCapabilityAdvertisement>();
            foreach (var pair in _advertisements.ToArray())
            {
                var advertisement = pair.Value;
                if (advertisement.ExpiresAt <= now)
                {
                    _advertisements.Remove(pair.Key);
                    continue;
                }
                if (!string.Equals(advertisement.Role, "export", StringComparison.Ordinal))
                {
                    continue;
                }
                live.Add(advertisement);
            }
            if (live.Count == 0)
            {
                return [];
            }

            // Every replica consumes the same export queue. Advertising a union would let RabbitMQ
            // deliver a format to a replica that cannot execute it, so availability is deliberately
            // the equivalent intersection of the live consumer group.
            var candidates = live[0].ExportFormats.ToDictionary(format => format.Format, StringComparer.Ordinal);
            foreach (var advertisement in live.Skip(1))
            {
                foreach (var key in candidates.Keys.ToArray())
                {
                    if (!advertisement.ExportFormats.Any(candidate => Equivalent(candidates[key], candidate)))
                    {
                        candidates.Remove(key);
                    }
                }
            }
            return candidates
                .OrderBy(pair => pair.Key, StringComparer.Ordinal)
                .Select(pair => pair.Value)
                .ToArray();
        }
    }

    private static bool Equivalent(ExportFormatCapability left, ExportFormatCapability right) =>
        string.Equals(left.Format, right.Format, StringComparison.Ordinal)
        && string.Equals(left.Label, right.Label, StringComparison.Ordinal)
        && string.Equals(left.Extension, right.Extension, StringComparison.Ordinal)
        && string.Equals(left.MediaType, right.MediaType, StringComparison.Ordinal)
        && left.Lossless == right.Lossless
        && left.DeclaredLoss.SequenceEqual(right.DeclaredLoss, StringComparer.Ordinal);
}
