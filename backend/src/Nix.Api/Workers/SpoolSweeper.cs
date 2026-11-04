using Microsoft.Extensions.Logging.Abstractions;
using Microsoft.Extensions.Options;
using Nix.Workers.Transfer;

namespace Nix.Workers;

/// <summary>Removes spool files older than a day every hour; a job that died mid-copy never leaks its source for good.</summary>
public sealed class SpoolSweeper(IOptions<WorkerOptions> options, TimeProvider clock, ILogger<SpoolSweeper>? logger = null) : BackgroundService
{
    private static readonly TimeSpan Interval = TimeSpan.FromHours(1);
    private static readonly TimeSpan MaximumAge = TimeSpan.FromHours(24);
    private readonly ILogger<SpoolSweeper> logger = logger ?? NullLogger<SpoolSweeper>.Instance;

    protected override async Task ExecuteAsync(CancellationToken stoppingToken)
    {
        while (!stoppingToken.IsCancellationRequested)
        {
            try
            {
                WorkSpool.Sweep(options.Value.SpoolDirectory, clock.GetUtcNow(), MaximumAge);
            }
            catch (Exception exception) when (exception is IOException or UnauthorizedAccessException)
            {
                SpoolSweeperLog.SweepFailed(logger, exception);
            }
            try
            {
                await Task.Delay(Interval, clock, stoppingToken).ConfigureAwait(false);
            }
            catch (OperationCanceledException)
            {
                return;
            }
        }
    }
}

internal static partial class SpoolSweeperLog
{
    [LoggerMessage(5440, LogLevel.Warning, "Spool sweep failed")]
    internal static partial void SweepFailed(ILogger logger, Exception exception);
}
