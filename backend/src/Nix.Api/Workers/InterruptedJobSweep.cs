using Microsoft.Extensions.Logging.Abstractions;
using Microsoft.Extensions.Options;
using Nix.Abstractions.Workers;
using Nix.Workers.Queue;

namespace Nix.Workers;

/// <summary>
/// At startup, fails the jobs this instance was running when it last died: every <c>running</c>
/// row of a hosted, non-resumable family whose lease owner carries this instance's prefix. Queued
/// rows, delayed retries and a replica's live leases are left alone. Runs before the hosts start
/// leasing so a re-lease cannot race it.
/// </summary>
/// <remarks>
/// Exports and previews become <c>failed</c> with <c>interrupted_by_restart</c>, which the UI
/// already shows as "failed, try again". Interrupted imports also need their staged tree removed;
/// <see cref="IInterruptedJobCleanup"/> implementations do that per kind.
/// </remarks>
public sealed class InterruptedJobSweep(
    IWorkerDispatchStore dispatch,
    IOptions<WorkerOptions> options,
    IEnumerable<IWorkerJobHandler> handlers,
    IEnumerable<IInterruptedJobCleanup> cleanups,
    ILogger<InterruptedJobSweep>? logger = null) : IHostedService
{
    /// <summary>The error code an interrupted job carries.</summary>
    public const string ErrorCode = "interrupted_by_restart";

    private static readonly string[] Resumable = ["notify.push", "object.cleanup"];
    private readonly ILogger<InterruptedJobSweep> logger = logger ?? NullLogger<InterruptedJobSweep>.Instance;

    public async Task StartAsync(CancellationToken cancellationToken)
    {
        var kinds = options.Value.HostedFamilies(handlers)
            .SelectMany(JobFamilies.KindsOf)
            .Where(kind => !Resumable.Contains(kind, StringComparer.Ordinal))
            .ToArray();
        if (kinds.Length == 0)
        {
            return;
        }
        var interrupted = await dispatch.InterruptJobsAsync(WorkerJobHost.OwnerPrefix(options.Value), kinds, ErrorCode, cancellationToken)
            .ConfigureAwait(false);
        foreach (var job in interrupted)
        {
            InterruptedJobSweepLog.Interrupted(logger, job.Id, job.Kind);
            foreach (var cleanup in cleanups.Where(candidate => candidate.Kinds.Contains(job.Kind, StringComparer.Ordinal)))
            {
                try
                {
                    await cleanup.CleanUpAsync(job, cancellationToken).ConfigureAwait(false);
                }
#pragma warning disable CA1031 // Justification: one import's cleanup failing must not stop the host from starting; the reaper and retention cover the rest.
                catch (Exception exception)
                {
                    InterruptedJobSweepLog.CleanupFailed(logger, job.Id, job.Kind, exception);
                }
#pragma warning restore CA1031
            }
        }
    }

    public Task StopAsync(CancellationToken cancellationToken) => Task.CompletedTask;
}

/// <summary>Removes what an interrupted job of some kinds left behind (a staged import tree, for one).</summary>
public interface IInterruptedJobCleanup
{
    public IReadOnlyList<string> Kinds { get; }

    public Task CleanUpAsync(DispatchedWorkerJob job, CancellationToken cancellationToken);
}

internal static partial class InterruptedJobSweepLog
{
    [LoggerMessage(5420, LogLevel.Warning, "Job {JobId} ({Kind}) was interrupted by a restart and is now failed")]
    internal static partial void Interrupted(ILogger logger, Guid jobId, string kind);

    [LoggerMessage(5421, LogLevel.Error, "Cleanup after interrupted job {JobId} ({Kind}) failed")]
    internal static partial void CleanupFailed(ILogger logger, Guid jobId, string kind, Exception exception);
}
