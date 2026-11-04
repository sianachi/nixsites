namespace Nix.Workers.Queue;

/// <summary>
/// Wakes the in-process worker for a job family. A hint, never the record: the durable job row
/// is what gets leased, and a lost hint costs at most one sweep interval.
/// </summary>
/// <remarks>
/// The seam a distributed transport would replace: an implementation that forwards hints to
/// other instances changes nothing in the job handlers, which only ever see leased rows.
/// </remarks>
[System.Diagnostics.CodeAnalysis.SuppressMessage("Naming", "CA1711:Identifiers should not have incorrect suffix", Justification = "It is the job queue seam a distributed transport replaces; the name is the design's.")]
public interface IJobQueue
{
    /// <summary>
    /// Signals that a job of <paramref name="kind"/> may be waiting in the database. Returns
    /// whether a host in this process runs that kind; when it does not, the caller still has to
    /// announce the job to the external worker.
    /// </summary>
    public bool Hint(string kind);
}
