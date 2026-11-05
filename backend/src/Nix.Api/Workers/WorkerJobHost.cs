using System.Threading.Channels;
using Microsoft.Extensions.Logging.Abstractions;
using Microsoft.Extensions.Options;
using Nix.Abstractions.Workers;
using Nix.Workers.Queue;

namespace Nix.Workers;

/// <summary>
/// The loop that used to be the Go <c>brokerjob</c> runner for one role: waits for a hint or the
/// sweep interval, leases rows of its kinds with <c>nix_lease_worker_jobs</c>, runs each under a
/// renewing lease, and applies the outcome with <c>nix_apply_worker_result</c>.
/// </summary>
/// <remarks>
/// Leasing is claiming: the row is <c>running</c> with this owner until the handler finishes or
/// the lease lapses. Nothing is held only in memory, so a crash loses at most the work in flight,
/// which the next lease (or the startup sweep, per kind) deals with.
/// </remarks>
public sealed class WorkerJobHost(
    string family,
    InProcessJobQueue queue,
    IWorkerDispatchStore dispatch,
    IEnumerable<IWorkerJobHandler> handlers,
    IOptions<WorkerOptions> options,
    TimeProvider clock,
    ILogger<WorkerJobHost>? logger = null) : BackgroundService
{
    private const int HintRetries = 8;
    private static readonly TimeSpan HintRetryDelay = TimeSpan.FromMilliseconds(250);
    private static readonly TimeSpan FailureDelay = TimeSpan.FromSeconds(5);

    private readonly ILogger<WorkerJobHost> _logger = logger ?? NullLogger<WorkerJobHost>.Instance;
    private readonly Dictionary<string, IWorkerJobHandler> _byKind = handlers
        .SelectMany(handler => handler.Kinds.Select(kind => (kind, handler)))
        .Where(pair => JobFamilies.Of(pair.kind) == family)
        .ToDictionary(pair => pair.kind, pair => pair.handler, StringComparer.Ordinal);

    /// <summary>The stable prefix every execution id of this instance starts with; the startup sweep matches on it.</summary>
    public static string OwnerPrefix(WorkerOptions options)
    {
        ArgumentNullException.ThrowIfNull(options);
        // A colon would let instance "a" own "a:b"'s leases in the startup sweep's prefix match.
        if (string.IsNullOrWhiteSpace(options.InstanceId) || options.InstanceId.Contains(':', StringComparison.Ordinal))
        {
            throw new InvalidOperationException("Nix:Workers:InstanceId must be non-empty and contain no ':'.");
        }
        return $"nix-api:{options.InstanceId}:";
    }

    /// <summary>The family this host serves.</summary>
    public string Family { get; } = family;

    protected override async Task ExecuteAsync(CancellationToken stoppingToken)
    {
        if (_byKind.Count == 0)
        {
            WorkerJobHostLog.NoHandlers(_logger, Family);
            return;
        }
        var reader = queue.Reader(Family);
        var concurrency = options.Value.Concurrency.TryGetValue(Family, out var configured) ? Math.Clamp(configured, 1, 32) : 1;
        using var slots = new SemaphoreSlim(concurrency, concurrency);
        var running = new HashSet<Task>();
        while (!stoppingToken.IsCancellationRequested)
        {
            try
            {
                var hinted = await WaitForHintAsync(reader, stoppingToken).ConfigureAwait(false);
                // A hint can arrive before the row's transaction commits; look again a few times.
                var attempts = hinted ? HintRetries : 1;
                for (var attempt = 0; attempt < attempts && !stoppingToken.IsCancellationRequested; attempt++)
                {
                    running.RemoveWhere(task => task.IsCompleted);
                    if (await LeaseOnceAsync(slots, running, stoppingToken).ConfigureAwait(false) > 0)
                    {
                        break;
                    }
                    if (attempt + 1 < attempts)
                    {
                        await Task.Delay(HintRetryDelay, clock, stoppingToken).ConfigureAwait(false);
                    }
                }
            }
            catch (OperationCanceledException) when (stoppingToken.IsCancellationRequested)
            {
                break;
            }
#pragma warning disable CA1031 // Justification: the loop is durable and must survive any transient database failure.
            catch (Exception exception)
            {
                WorkerJobHostLog.LoopFailed(_logger, Family, exception);
                try
                {
                    await Task.Delay(FailureDelay, clock, stoppingToken).ConfigureAwait(false);
                }
                catch (OperationCanceledException)
                {
                    break;
                }
            }
#pragma warning restore CA1031
        }

        // Graceful stop: running jobs get the host's shutdown budget; whatever is still unfinished
        // loses its lease and follows its kind's restart rule.
        await Task.WhenAll(running).ConfigureAwait(false);
    }

    /// <summary>Leases as many rows as free slots allow, one lease call per kind, and starts them.</summary>
    private async Task<int> LeaseOnceAsync(SemaphoreSlim slots, HashSet<Task> running, CancellationToken stoppingToken)
    {
        var leased = 0;
        foreach (var kind in _byKind.Keys)
        {
            // Lease only what a free slot can start now: a leased row nobody runs just lapses.
            var free = slots.CurrentCount;
            if (free == 0)
            {
                break;
            }
            var executionId = $"{OwnerPrefix(options.Value)}{Family}:{Guid.NewGuid():N}";
            var jobs = await dispatch.LeaseJobsAsync(kind, executionId, Math.Min(free, 100), options.Value.LeaseSeconds, stoppingToken)
                .ConfigureAwait(false);
            foreach (var job in jobs)
            {
                await slots.WaitAsync(stoppingToken).ConfigureAwait(false);
                running.Add(RunAsync(new WorkerExecution(job, executionId), slots, stoppingToken));
                leased++;
            }
        }
        return leased;
    }

    private async Task<bool> WaitForHintAsync(ChannelReader<bool> reader, CancellationToken stoppingToken)
    {
        using var timeout = CancellationTokenSource.CreateLinkedTokenSource(stoppingToken);
        timeout.CancelAfter(TimeSpan.FromSeconds(Math.Max(1, options.Value.SweepSeconds)));
        try
        {
            if (!await reader.WaitToReadAsync(timeout.Token).ConfigureAwait(false))
            {
                return false;
            }
            while (reader.TryRead(out _))
            {
            }
            return true;
        }
        catch (OperationCanceledException) when (!stoppingToken.IsCancellationRequested)
        {
            return false;
        }
    }

    /// <summary>Runs one leased job to its applied result; exposed so tests can drive a host without the loop.</summary>
    public async Task RunAsync(WorkerExecution execution, SemaphoreSlim? slot, CancellationToken stoppingToken)
    {
        ArgumentNullException.ThrowIfNull(execution);
        var job = execution.Job;
        try
        {
            string? result = null;
            WorkerJobException? failure = null;
            using var lost = CancellationTokenSource.CreateLinkedTokenSource(stoppingToken);
#pragma warning disable CA2025 // Justification: the finally block below awaits the renew task before the source is disposed.
            var renewing = RenewAsync(execution, lost, stoppingToken);
#pragma warning restore CA2025
            try
            {
                result = await _byKind[job.Kind].HandleAsync(execution, lost.Token).ConfigureAwait(false);
            }
            catch (WorkerJobException exception)
            {
                failure = exception;
            }
            catch (OperationCanceledException) when (lost.IsCancellationRequested && !stoppingToken.IsCancellationRequested)
            {
                // Lease lost or cancellation requested: the row already says so; nothing to apply.
                WorkerJobHostLog.LeaseLost(_logger, job.Id, job.Kind);
                return;
            }
            catch (OperationCanceledException) when (stoppingToken.IsCancellationRequested)
            {
                failure = WorkerJobException.Retry("worker_shutdown", "The worker stopped before the job finished.");
            }
#pragma warning disable CA1031 // Justification: an unexpected handler fault is a retryable job failure, never a host crash.
            catch (Exception exception)
            {
                WorkerJobHostLog.HandlerFaulted(_logger, job.Id, job.Kind, exception);
                failure = WorkerJobException.Retry("worker_faulted", exception.GetType().Name);
            }
#pragma warning restore CA1031
            finally
            {
                await lost.CancelAsync().ConfigureAwait(false);
                await renewing.ConfigureAwait(false);
            }

            var application = await dispatch.ApplyResultAsync(
                job.Id,
                execution.ExecutionId,
                failure is null,
                failure?.Retryable ?? false,
                failure is null ? result : null,
                failure?.Code,
                failure?.Message,
                CancellationToken.None).ConfigureAwait(false);
            if (application.RequiresExportCleanup
                && !await dispatch.ScheduleExportCleanupAsync(job.Id, CancellationToken.None).ConfigureAwait(false))
            {
                WorkerJobHostLog.CleanupNotScheduled(_logger, job.Id);
            }
            WorkerJobHostLog.Applied(_logger, job.Id, job.Kind, application.Outcome.ToString());
        }
        finally
        {
            slot?.Release();
        }
    }

    private async Task RenewAsync(WorkerExecution execution, CancellationTokenSource lost, CancellationToken stoppingToken)
    {
        var interval = TimeSpan.FromSeconds(Math.Max(1, options.Value.RenewSeconds));
        try
        {
            while (!lost.IsCancellationRequested)
            {
                await Task.Delay(interval, clock, lost.Token).ConfigureAwait(false);
                var state = await dispatch.GetJobStateAsync(execution.Job.Id, execution.ExecutionId, stoppingToken).ConfigureAwait(false);
                if (state is null || !state.LeaseOwned || state.CancellationRequested
                    || !await dispatch.RenewJobAsync(execution.Job.Id, execution.ExecutionId, options.Value.LeaseSeconds, stoppingToken).ConfigureAwait(false))
                {
                    await lost.CancelAsync().ConfigureAwait(false);
                    return;
                }
            }
        }
        catch (OperationCanceledException)
        {
            // The handler finished, or the host is stopping.
        }
#pragma warning disable CA1031 // Justification: a lease that cannot be confirmed is a lost lease; the handler must stop rather than outlive it.
        catch (Exception exception)
        {
            WorkerJobHostLog.RenewFailed(_logger, execution.Job.Id, exception);
            await lost.CancelAsync().ConfigureAwait(false);
        }
#pragma warning restore CA1031
    }
}

internal static partial class WorkerJobHostLog
{
    [LoggerMessage(5400, LogLevel.Warning, "Worker family {Family} has no handlers and will not run")]
    internal static partial void NoHandlers(ILogger logger, string family);

    [LoggerMessage(5401, LogLevel.Error, "Worker family {Family} loop failed and will retry")]
    internal static partial void LoopFailed(ILogger logger, string family, Exception exception);

    [LoggerMessage(5402, LogLevel.Warning, "Job {JobId} ({Kind}) lost its lease or was cancelled")]
    internal static partial void LeaseLost(ILogger logger, Guid jobId, string kind);

    [LoggerMessage(5403, LogLevel.Error, "Job {JobId} ({Kind}) handler faulted")]
    internal static partial void HandlerFaulted(ILogger logger, Guid jobId, string kind, Exception exception);

    [LoggerMessage(5404, LogLevel.Error, "Completed export {JobId} could not schedule its cleanup")]
    internal static partial void CleanupNotScheduled(ILogger logger, Guid jobId);

    [LoggerMessage(5405, LogLevel.Information, "Job {JobId} ({Kind}) applied: {Outcome}")]
    internal static partial void Applied(ILogger logger, Guid jobId, string kind, string outcome);

    [LoggerMessage(5406, LogLevel.Warning, "Job {JobId} could not renew its lease and stops")]
    internal static partial void RenewFailed(ILogger logger, Guid jobId, Exception exception);
}
