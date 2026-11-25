using System.Diagnostics.CodeAnalysis;
using System.Globalization;
using System.Text.Json;
using Nix.Abstractions;
using Nix.Abstractions.Automations;
using Nix.Abstractions.PetRuns;
using Nix.Domain.Automations;
using Nix.Domain.Items;
using Nix.Domain.Primitives;
using Nix.Features.Items;
using Nix.Messaging;

namespace Nix.Features.PetRuns;

internal sealed record StartPetRoutine(PetRoutineBinding Binding) : ICommand<PetRunResponse>;

internal static class PetRoutineServices
{
    internal static void AddPetRoutines(this IServiceCollection services)
    {
        services.AddScoped<IPetRunRoutineAuthorization, PetRoutinePolicy>();
        services.AddScoped<ICommandHandler<StartPetRoutine, PetRunResponse>, StartPetRoutineHandler>();
        services.AddScoped<IPetRunCapability, PetTaskRenameCapability>();
    }
}

[SuppressMessage("Performance", "CA1812", Justification = "Created by ASP.NET Core dependency injection.")]
internal sealed class StartPetRoutineHandler(
    IAutomationRuleStore rules, IItemTree items, IPermissionResolver permissions,
    INixSessionContextAccessor session, PetRunService runs) : ICommandHandler<StartPetRoutine, PetRunResponse>
{
    public async ValueTask<Result<PetRunResponse>> HandleAsync(StartPetRoutine command, CancellationToken cancellationToken)
    {
        var rule = await rules.GetForUpdateAsync(command.Binding.RuleId, cancellationToken).ConfigureAwait(false);
        if (!PetRoutinePolicy.TryRead(rule, command.Binding, out var routine)
            || session.Current is not { } caller || rule.OwnerPrincipalId != caller.PrincipalId || rule.TenantId != caller.TenantId
            || rule.ScopeItemId is not { } taskId
            || !await permissions.CanWriteWorkspaceAsync(rule.WorkspaceId, cancellationToken).ConfigureAwait(false)
            || await items.FindAsync(taskId, cancellationToken).ConfigureAwait(false) is not { Type: "note" } task
            || task.WorkspaceId != rule.WorkspaceId)
        {
            return Result.Failure<PetRunResponse>(new NixError("pet_runs.routine_unavailable", "This scheduled pet job is no longer available."));
        }

        return await runs.StartRoutineAsync(taskId,
            new StartPetRunRequest(routine.Brief, routine.SourceItemIds, Abilities: routine.Abilities, IncludeTargetText: routine.IncludeTargetText),
            command.Binding, cancellationToken).ConfigureAwait(false);
    }
}

[SuppressMessage("Performance", "CA1812", Justification = "Created by ASP.NET Core dependency injection.")]
internal sealed class PetRoutinePolicy(IAutomationRuleStore rules, IStructuralLock topology) : IPetRunRoutineAuthorization
{
    public async Task<bool> AllowsAsync(
        PetRoutineBinding binding, PetRunRecord run, string capability, PetRunEffect effect, CancellationToken cancellationToken)
    {
        if (run.WorkspaceScope || capability != PetTaskRenameCapability.Id)
        {
            return false;
        }

        await topology.AcquireWorkspaceTopologyAsync(run.WorkspaceId, cancellationToken).ConfigureAwait(false);
        var rule = await rules.GetForUpdateAsync(binding.RuleId, cancellationToken).ConfigureAwait(false);
        return TryRead(rule, binding, out var routine)
            && rule.TenantId == run.TenantId && rule.OwnerPrincipalId == run.ActorId && rule.WorkspaceId == run.WorkspaceId
            && rule.ScopeItemId == run.ItemId && routine.Abilities.Contains(capability, StringComparer.Ordinal)
            && routine.AutoRename is { } rename
            && effect.Parameters.GetProperty("itemId").GetGuid() == run.ItemId?.Value
            && effect.Parameters.GetProperty("from").GetString() == rename.From
            && effect.Parameters.GetProperty("to").GetString() == rename.To;
    }

    internal static bool TryRead([NotNullWhen(true)] AutomationRule? rule, PetRoutineBinding binding, [NotNullWhen(true)] out StartPetRunAction? routine)
    {
        routine = null;
        if (rule is not { Enabled: true, TriggerType: "schedule" } || rule.Revision != binding.Revision || rule.Id != binding.RuleId
            || AutomationActionJson.ReadStored(rule.Actions) is not [{ } action] || action is not StartPetRunAction start)
        {
            return false;
        }

        routine = start;
        return true;
    }
}

[SuppressMessage("Performance", "CA1812", Justification = "Created by ASP.NET Core dependency injection.")]
internal sealed class PetTaskRenameCapability(
    IItemTree items, IPermissionResolver permissions, IItemLocks locks, IStructuralLock topology,
    INativeReplayStore revisions, IWorkspaceSync sync, NixDispatcher dispatcher) : IPetRunCapability
{
    internal const string Id = "task.rename";

    private static readonly JsonElement Schema = JsonSerializer.SerializeToElement(new
    {
        type = "object",
        properties = new { title = new { type = "string", minLength = 1, maxLength = AutomationActionJson.MaximumItemTitle } },
        required = new[] { "title" },
        additionalProperties = false,
    });

    public string Name => Id;
    public string Description => "Rename the assigned Nix task. Supply only the exact new title in title.";
    public JsonElement? InputSchema => Schema;
    public bool Atomic => true;
    public bool Reversible => true;
    public bool RoutineEligible(PetRunEffect effect) => true;

    public async Task<Result<PetRunEffect>> PreviewAsync(PetRunRecord run, JsonElement args, CancellationToken cancellationToken)
    {
        if (args.ValueKind != JsonValueKind.Object || args.EnumerateObject().Count() != 1
            || !args.TryGetProperty("title", out var field) || field.ValueKind != JsonValueKind.String
            || field.GetString() is not { } title || !AutomationActionJson.ValidPetTitle(title))
        {
            return Result.Failure<PetRunEffect>(new NixError("pet_runs.invalid_rename", "Supply the exact new task title."));
        }

        var task = await ReadAsync(run, cancellationToken).ConfigureAwait(false);
        if (task is not { } current || !AutomationActionJson.ValidPetTitle(current.Title) || current.Title == title)
        {
            return Result.Failure<PetRunEffect>(Conflict());
        }

        return Result.Success(new PetRunEffect("Rename the task", JsonSerializer.SerializeToElement(new
        {
            itemId = run.ItemId?.Value,
            from = current.Title,
            to = title,
            revision = current.Revision,
        })));
    }

    public Task<Result<string>> ApplyAsync(PetRunRecord run, Guid actionId, PetRunEffect effect, CancellationToken cancellationToken) =>
        RenameAsync(run, effect, effect.Parameters.GetProperty("revision").GetInt64(), "from", "to", cancellationToken);

    public Task<Result<string>> UndoAsync(
        PetRunRecord run, Guid actionId, PetRunEffect effect, string receipt, CancellationToken cancellationToken) =>
        long.TryParse(receipt, NumberStyles.None, CultureInfo.InvariantCulture, out var appliedRevision)
            ? RenameAsync(run, effect, appliedRevision, "to", "from", cancellationToken)
            : Task.FromResult(Result.Failure<string>(Conflict()));

    public async Task<string?> RevisionObservationAsync(PetRunRecord run, PetRunEffect effect, CancellationToken cancellationToken) =>
        effect.Parameters.GetProperty("itemId").GetGuid() == run.ItemId?.Value
        && await ReadAsync(run, cancellationToken).ConfigureAwait(false) is not null
            ? effect.Parameters.GetProperty("to").GetString()
            : null;

    private async Task<Result<string>> RenameAsync(
        PetRunRecord run, PetRunEffect effect, long revision, string fromKey, string toKey, CancellationToken cancellationToken)
    {
        var parameters = effect.Parameters;
        if (run.ItemId is not { } anchor || parameters.GetProperty("itemId").GetGuid() != anchor.Value
            || await ReadAsync(run, cancellationToken).ConfigureAwait(false) is not { } current
            || current.Revision != revision || current.Title != parameters.GetProperty(fromKey).GetString())
        {
            return Result.Failure<string>(Conflict());
        }

        var title = parameters.GetProperty(toKey).GetString()!;
        var renamed = await dispatcher.SendAsync<RenameItem, Item>(new RenameItem(anchor, title), cancellationToken).ConfigureAwait(false);
        if (renamed.IsFailure)
        {
            return Result.Failure<string>(renamed.Error);
        }

        await sync.PublishPendingAsync(cancellationToken).ConfigureAwait(false);
        var written = await revisions.LockItemRevisionAsync(run.WorkspaceId, anchor, cancellationToken).ConfigureAwait(false);
        if (written is not { } newRevision || newRevision <= revision || ItemProperties.ReadTitle(renamed.Value.Properties) != title)
        {
            throw new InvalidOperationException("The task rename did not advance its revision.");
        }

        return Result.Success(newRevision.ToString(CultureInfo.InvariantCulture));
    }

    private async Task<(long Revision, string Title)?> ReadAsync(PetRunRecord run, CancellationToken cancellationToken)
    {
        await topology.AcquireWorkspaceTopologyAsync(run.WorkspaceId, cancellationToken).ConfigureAwait(false);
        if (run.ItemId is not { } anchor || !await permissions.CanWriteWorkspaceAsync(run.WorkspaceId, cancellationToken).ConfigureAwait(false)
            || await revisions.LockItemRevisionAsync(run.WorkspaceId, anchor, cancellationToken).ConfigureAwait(false) is not { } revision
            || (await locks.LockedAmongAsync([anchor], cancellationToken).ConfigureAwait(false)).Count != 0
            || await items.FindAsync(anchor, cancellationToken).ConfigureAwait(false) is not
            { Type: "note", ManagedBy: null, LifecycleState: ItemLifecycleState.Active } item
            || item.WorkspaceId != run.WorkspaceId || ItemSettings.Read(item.Settings).WithholdFromPets)
        {
            return null;
        }

        return (revision, ItemProperties.ReadTitle(item.Properties));
    }

    private static NixError Conflict() => new("pet_runs.conflict", "The task changed or cannot be renamed.");
}
