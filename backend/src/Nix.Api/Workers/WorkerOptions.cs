using Nix.Workers.Queue;

namespace Nix.Workers;

/// <summary>Deployment configuration for the in-process workers, bound to <c>Nix:Workers</c>.</summary>
public sealed class WorkerOptions
{
    /// <summary>Configuration section.</summary>
    public const string SectionName = "Nix:Workers";

    /// <summary>
    /// Identifies this instance across restarts, so the startup sweep recognises the leases it
    /// held before it died and never touches a replica's. Defaults to the machine name, which a
    /// container keeps between restarts.
    /// </summary>
    public string InstanceId { get; set; } = Environment.MachineName;

    /// <summary>
    /// The job families this process hosts; empty means every family with a registered handler.
    /// Kinds of other families keep being announced to the external worker (RabbitMQ) until
    /// their port lands.
    /// </summary>
    public IList<string> Families { get; } = [];

    /// <summary>The families that actually run here: the configured ones, or all with a handler.</summary>
    public IReadOnlySet<string> HostedFamilies(IEnumerable<IWorkerJobHandler> handlers)
    {
        ArgumentNullException.ThrowIfNull(handlers);
        var withHandlers = handlers.SelectMany(handler => handler.Kinds).Select(JobFamilies.Of).OfType<string>().ToHashSet(StringComparer.Ordinal);
        return Families.Count == 0 ? withHandlers : withHandlers.Intersect(Families, StringComparer.Ordinal).ToHashSet(StringComparer.Ordinal);
    }

    /// <summary>How many jobs of one family run at once.</summary>
    public IDictionary<string, int> Concurrency { get; } = new Dictionary<string, int>(StringComparer.Ordinal)
    {
        [JobFamilies.Notify] = 2,
        [JobFamilies.Calendar] = 2,
        [JobFamilies.Export] = 2,
        [JobFamilies.Import] = 2,
    };

    /// <summary>Lease length per claim; renewed while the handler runs.</summary>
    public int LeaseSeconds { get; set; } = 60;

    /// <summary>How often a running job renews its lease.</summary>
    public int RenewSeconds { get; set; } = 15;

    /// <summary>How long a host waits for a hint before leasing on its own.</summary>
    public int SweepSeconds { get; set; } = 5;

    /// <summary>Timeout for one loopback or provider request.</summary>
    public int RequestTimeoutSeconds { get; set; } = 60;

    /// <summary>The largest export source, import source or export output in bytes.</summary>
    public long MaxInputBytes { get; set; } = 100L << 20;

    /// <summary>The longest line of a bundle stream and the byte budget of one projected note.</summary>
    public int MaxLineBytes { get; set; } = 4 << 20;

    /// <summary>The most items one export or import may carry.</summary>
    public int MaxRecords { get; set; } = 100_000;

    /// <summary>Where spool files go; the temp directory when unset.</summary>
    public string? SpoolDirectory { get; set; }
}

/// <summary>Web push self-identification, bound to <c>Nix:Push</c>. The public key alone already lived here.</summary>
public sealed class PushOptions
{
    /// <summary>Configuration section.</summary>
    public const string SectionName = "Nix:Push";

    /// <summary>The VAPID public key browsers subscribe with (base64url).</summary>
    public string? VapidPublicKey { get; set; }

    /// <summary>The raw 32-byte VAPID private scalar, base64url. Required to send.</summary>
    public string? VapidPrivateKey { get; set; }

    /// <summary>A <c>mailto:</c> or <c>https:</c> contact for the push services.</summary>
    public string? VapidSubject { get; set; }
}
