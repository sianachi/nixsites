using System.Threading.Channels;

namespace Nix.Workers.Queue;

/// <summary>
/// One bounded channel per family holding at most one pending hint. A second hint while one is
/// pending is dropped, which loses nothing: the host that drains the hint leases every row it can.
/// </summary>
[System.Diagnostics.CodeAnalysis.SuppressMessage("Naming", "CA1711:Identifiers should not have incorrect suffix", Justification = "It is the job queue seam a distributed transport replaces; the name is the design's.")]
public sealed class InProcessJobQueue(IReadOnlySet<string> hostedFamilies) : IJobQueue
{
    private readonly Dictionary<string, Channel<bool>> channels = JobFamilies.All.ToDictionary(
        family => family,
        _ => Channel.CreateBounded<bool>(new BoundedChannelOptions(1)
        {
            FullMode = BoundedChannelFullMode.DropWrite,
            SingleReader = true,
        }),
        StringComparer.Ordinal);

    /// <summary>The families a host in this process serves.</summary>
    public IReadOnlySet<string> HostedFamilies { get; } = hostedFamilies;

    /// <inheritdoc />
    public bool Hint(string kind)
    {
        if (JobFamilies.Of(kind) is not { } family || !HostedFamilies.Contains(family))
        {
            return false;
        }
        channels[family].Writer.TryWrite(true);
        return true;
    }

    /// <summary>The reader a family's host waits on.</summary>
    public ChannelReader<bool> Reader(string family) => channels[family].Reader;
}
