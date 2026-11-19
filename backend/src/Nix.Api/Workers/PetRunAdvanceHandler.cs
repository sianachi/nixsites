using Nix.Features.PetRuns;
using Nix.Workers.Queue;

namespace Nix.Workers;

/// <summary>Advances a pet job through Core's durable checkpoints.</summary>
internal sealed class PetRunAdvanceHandler(IServiceScopeFactory scopes) : IWorkerJobHandler
{
    public IReadOnlyList<string> Kinds { get; } = [JobFamilies.PetAdvance];

    public async Task<string?> HandleAsync(WorkerExecution job, CancellationToken cancellationToken)
    {
        var scope = scopes.CreateAsyncScope();
        await using var lease = scope.ConfigureAwait(false);
        return await scope.ServiceProvider.GetRequiredService<PetRunService>().AdvanceAsync(job, cancellationToken).ConfigureAwait(false);
    }
}
