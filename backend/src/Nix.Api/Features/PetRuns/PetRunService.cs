using System.Diagnostics.CodeAnalysis;
using System.Text;
using System.Text.Json;
using Nix.Abstractions;
using Nix.Abstractions.PetRuns;
using Nix.Abstractions.Workers;
using Nix.Domain.Items;
using Nix.Domain.Primitives;
using Nix.Domain.Tenancy;
using Nix.Features.Pets;
using Nix.Messaging;

namespace Nix.Features.PetRuns;

[SuppressMessage("Performance", "CA1812", Justification = "Created by ASP.NET Core dependency injection.")]
internal sealed partial class PetRunService(
    IPetRunStore runs,
    IWorkerJobStore jobs,
    IWorkerDispatchStore dispatch,
    IItemTree items,
    IItemLocks itemLocks,
    IWorkspaceLocks workspaceLocks,
    IPermissionResolver permissions,
    INixSessionContextAccessor session,
    IIsolatedUnitOfWork isolated,
    INotificationWriter notifications,
    NixDispatcher dispatcher,
    IEnumerable<IPetRunCapability> capabilities,
    IConfiguration configuration,
    IServiceProvider services,
    TimeProvider clock)
    : IQueryHandler<ListPetRuns, Result<PetRunsResponse>>,
        IQueryHandler<ReadPetRun, Result<PetRunResponse>>,
        ICommandHandler<StartPetRun, PetRunResponse>,
        ICommandHandler<AnswerPetRun, PetRunResponse>,
        ICommandHandler<DecidePetRunProposal, PetRunResponse>,
        ICommandHandler<DecidePetRunScope, PetRunResponse>,
        ICommandHandler<RevisePetRunProposal, PetRunResponse>,
        ICommandHandler<CancelPetRun, PetRunResponse>,
        ICommandHandler<RetryPetRun, PetRunResponse>,
        ICommandHandler<UndoPetRunStep, PetRunResponse>
{
    private const string AdvanceKind = "pet.advance";
    private const int MaxTurns = 24;
    private static readonly JsonElement EmptyPreview = JsonSerializer.SerializeToElement(new Dictionary<string, string>());
    private readonly Dictionary<string, IPetRunCapability> _capabilities =
        capabilities.ToDictionary(capability => capability.Name, StringComparer.Ordinal);
    private NixSessionContext Caller => session.Current ?? throw new InvalidOperationException("A principal session is required.");

    public async ValueTask<Result<PetRunsResponse>> HandleAsync(ListPetRuns query, CancellationToken cancellationToken)
    {
        var item = query.ItemId is { } itemId
            ? await items.FindAsync(itemId, cancellationToken).ConfigureAwait(false)
            : null;
        var workspace = item?.WorkspaceId ?? query.WorkspaceId;
        if (workspace is not { } workspaceId || !await WorkspaceAvailableAsync(workspaceId, cancellationToken).ConfigureAwait(false)
            || item is not null && !await ScopeAvailableAsync(item, [], cancellationToken).ConfigureAwait(false))
        {
            return Result.Failure<PetRunsResponse>(Missing());
        }

        var enabled = IsEnabled(workspaceId) && await FindPetAsync(cancellationToken).ConfigureAwait(false) is not null;
        if (!IsEnabled(workspaceId))
        {
            return Result.Success(new PetRunsResponse(false, [], []));
        }

        var visible = new List<PetRunResponse>();
        foreach (var run in await runs.ListAsync(workspaceId, item?.Id, cancellationToken).ConfigureAwait(false))
        {
            var root = item ?? await items.FindAsync(run.ItemId, cancellationToken).ConfigureAwait(false);
            if (root is not null && root.WorkspaceId == run.WorkspaceId
                && await ScopeAvailableAsync(root, ReadSources(run, Checkpoint(run)), cancellationToken).ConfigureAwait(false))
            {
                var response = await RespondAsync(run, cancellationToken).ConfigureAwait(false);
                visible.Add(response with
                {
                    Proposals = [.. response.Proposals.Select(proposal => proposal with
                    {
                        Preview = proposal.Status is "pending" or "stale" or "unknown" ? proposal.Preview : EmptyPreview,
                        Receipt = null,
                    })],
                });
            }
        }

        return Result.Success(new PetRunsResponse(enabled, enabled
            ? [.. _capabilities.Values.OrderBy(capability => capability.Name, StringComparer.Ordinal)
                .Select(capability => new PetRunAbility(capability.Name, capability.Name, capability.Description))]
            : [], visible));
    }

    public ValueTask<Result<PetRunResponse>> HandleAsync(ReadPetRun query, CancellationToken cancellationToken) =>
        ReadAsync(query.ItemId, query.RunId, cancellationToken);

    internal async ValueTask<Result<PetRunResponse>> ReadAsync(ItemId itemId, Guid runId, CancellationToken cancellationToken)
    {
        var found = await FindAsync(itemId, runId, cancellationToken).ConfigureAwait(false);
        return found.IsSuccess
            ? Result.Success(await RespondAsync(found.Value, cancellationToken).ConfigureAwait(false))
            : Result.Failure<PetRunResponse>(found.Error);
    }

    public ValueTask<Result<PetRunResponse>> HandleAsync(StartPetRun command, CancellationToken cancellationToken) =>
        StartAsync(command.ItemId, command.Request, cancellationToken);

    internal ValueTask<Result<PetRunResponse>> StartAsync(
        ItemId itemId, StartPetRunRequest request, CancellationToken cancellationToken) =>
        StartAsync(itemId, request, null, cancellationToken);

    internal ValueTask<Result<PetRunResponse>> StartRoutineAsync(
        ItemId itemId, StartPetRunRequest request, PetRoutineBinding binding, CancellationToken cancellationToken) =>
        StartAsync(itemId, request, binding, cancellationToken);

    private async ValueTask<Result<PetRunResponse>> StartAsync(
        ItemId itemId, StartPetRunRequest request, PetRoutineBinding? routine, CancellationToken cancellationToken)
    {
        if (request.SourceItemIds?.Count > 24 || request.Abilities?.Count > 32
            || request.AfterMessageId is not null && !ValidText(request.AfterMessageId, 160, 500)
            || !ValidText(request.Brief, 4_000, 8_000))
        {
            return Invalid("Use a nonempty brief of at most 4000 characters and select at most 24 sources and 32 abilities.");
        }

        var sources = (request.SourceItemIds ?? []).Where(id => id != itemId.Value).Distinct().ToArray();
        if (sources.Contains(Guid.Empty))
        {
            return Invalid("Choose valid Nix sources and available abilities.");
        }

        var item = await items.FindAsync(itemId, cancellationToken).ConfigureAwait(false);
        if (item is null || !await ScopeAvailableAsync(item, sources, cancellationToken).ConfigureAwait(false))
        {
            return Result.Failure<PetRunResponse>(Missing());
        }
        var names = (request.Abilities ?? (request.IncludeTargetText.HasValue ? DefaultAbilities(item) : []))
            .Distinct(StringComparer.Ordinal).ToArray();
        if (names.Any(name => string.IsNullOrEmpty(name) || !_capabilities.ContainsKey(name))
            || request.IncludeTargetText == true && item.Type != "note")
        {
            return Invalid("Choose valid abilities and only share text from a note.");
        }
        if (!IsEnabled(item.WorkspaceId) || await FindPetAsync(cancellationToken).ConfigureAwait(false) is not { } pet)
        {
            return Result.Failure<PetRunResponse>(new NixError("pet_runs.disabled", "Enable the pet in this workspace before starting a job."));
        }

        var now = clock.GetUtcNow();
        var run = new PetRunRecord(Guid.NewGuid(), itemId, item.WorkspaceId, Caller.TenantId, Caller.PrincipalId,
            request.Brief!.Trim(), sources, request.WorkspaceScope, names, "queued", 1, default, now, now);
        var job = await QueueJobAsync(run, run.Revision, cancellationToken).ConfigureAwait(false);
        var checkpoint = new PetRunCheckpoint(pet.Id, job, null, [], [], [], 0, routine, pet.Provider,
            IncludeTargetText: request.IncludeTargetText, AfterMessageId: request.AfterMessageId);
        run = run with { State = Serialize(checkpoint) };
        return await runs.CreateAsync(run, cancellationToken).ConfigureAwait(false)
            ? Result.Success(Respond(run, checkpoint))
            : Result.Failure<PetRunResponse>(Missing());
    }

    public async ValueTask<Result<PetRunResponse>> HandleAsync(AnswerPetRun command, CancellationToken cancellationToken)
    {
        if (!ValidText(command.Request.Answer, 2_000, 8_000))
        {
            return Invalid("Answer the current question with at most 2000 characters.");
        }
        var found = await FindAsync(command.ItemId, command.RunId, cancellationToken).ConfigureAwait(false);
        if (found.IsFailure)
        {
            return Result.Failure<PetRunResponse>(found.Error);
        }
        var run = found.Value;
        var state = Checkpoint(run);
        if (run.Status != "waiting_for_input" || state.Question is not { Scope: null } question || question.Id != command.Request.QuestionId)
        {
            return Conflict();
        }
        var observation = $"Owner's answer to \"{question.Text}\": {command.Request.Answer!.Trim()}";
        return await QueueAsync(run, state with { Question = null, Answers = [.. state.Answers, observation] },
            cancellationToken).ConfigureAwait(false);
    }

    public async ValueTask<Result<PetRunResponse>> HandleAsync(DecidePetRunProposal command, CancellationToken cancellationToken)
    {
        var found = await FindAsync(command.ItemId, command.RunId, cancellationToken).ConfigureAwait(false);
        if (found.IsFailure)
        {
            return Result.Failure<PetRunResponse>(found.Error);
        }
        var run = found.Value;
        var state = Checkpoint(run);
        if (run.Status != "waiting_for_approval"
            || state.Proposals.Count == 0 || state.Proposals[^1] is not { Status: "pending" } pending
            || pending.Id != command.ProposalId)
        {
            return Conflict();
        }

        var approval = pending with { Status = command.Approve ? "approved" : "declined", DecisionAt = clock.GetUtcNow() };
        return await QueueAsync(run, Replace(state, approval), cancellationToken).ConfigureAwait(false);
    }

    internal async ValueTask<Result<PetRunResponse>> ResumeHandoffAsync(
        ItemId itemId, Guid runId, Guid workId, string receipt, CancellationToken cancellationToken)
    {
        var found = await FindAsync(itemId, runId, cancellationToken).ConfigureAwait(false);
        if (found.IsFailure)
        {
            return Result.Failure<PetRunResponse>(found.Error);
        }
        var run = found.Value;
        var state = Checkpoint(run);
        if (run.Status != "waiting_for_handoff"
            || state.Proposals.Count == 0
            || state.Proposals[^1] is not { Capability: "peer.delegate", Status: "applied" } delegated
            || delegated.Id != workId)
        {
            return Conflict();
        }

        var resumed = Replace(state, delegated with { Receipt = receipt });
        return Fits(resumed)
            ? await QueueAsync(run, resumed, cancellationToken).ConfigureAwait(false)
            : await SaveResponseAsync(run, state, "failed", cancellationToken).ConfigureAwait(false);
    }

    public ValueTask<Result<PetRunResponse>> HandleAsync(CancelPetRun command, CancellationToken cancellationToken) =>
        CancelAsync(command.ItemId, command.RunId, cancellationToken);

    internal async ValueTask<Result<PetRunResponse>> CancelAsync(ItemId itemId, Guid runId, CancellationToken cancellationToken)
    {
        var found = await FindAsync(itemId, runId, cancellationToken).ConfigureAwait(false);
        if (found.IsFailure)
        {
            return Result.Failure<PetRunResponse>(found.Error);
        }
        var run = found.Value;
        var state = Checkpoint(run);
        if (run.Status is "completed" or "failed" or "cancelled" or "review_required")
        {
            return Conflict();
        }

        if (state.ActiveJobId is { } job)
        {
            await jobs.CancelAsync(run.TenantId, run.ActorId, job, cancellationToken).ConfigureAwait(false);
        }

        var active = state.Proposals.FirstOrDefault(proposal => proposal.Status is "applying" or "undo_applying");
        if (active is not null)
        {
            state = Replace(state, active with { Status = "unknown" });
        }
        if (state.Proposals.FirstOrDefault(proposal => proposal.Status == "undo_pending") is { } pendingUndo)
        {
            state = Replace(state, pendingUndo with { Status = "applied", UndoId = null });
        }
        return await SaveResponseAsync(run, state with { ActiveJobId = null, Question = null, UndoResumeStatus = null },
            active is null ? "cancelled" : "review_required", cancellationToken).ConfigureAwait(false);
    }

    public async ValueTask<Result<PetRunResponse>> HandleAsync(RetryPetRun command, CancellationToken cancellationToken)
    {
        var found = await FindAsync(command.ItemId, command.RunId, cancellationToken).ConfigureAwait(false);
        if (found.IsFailure)
        {
            return Result.Failure<PetRunResponse>(found.Error);
        }
        var run = found.Value;
        var state = Checkpoint(run);
        var response = await RespondAsync(run, cancellationToken).ConfigureAwait(false);
        if (response.Status != "failed" || state.Turns >= MaxTurns
            || state.Proposals.Any(proposal => proposal.Status is "unknown" or "applying" or "undo_applying"))
        {
            return Conflict();
        }
        return await QueueAsync(run, state, cancellationToken).ConfigureAwait(false);
    }

    public async ValueTask<Result<PetRunResponse>> HandleAsync(UndoPetRunStep command, CancellationToken cancellationToken)
    {
        var found = await FindAsync(command.ItemId, command.RunId, cancellationToken).ConfigureAwait(false);
        if (found.IsFailure)
        {
            return Result.Failure<PetRunResponse>(found.Error);
        }
        var run = found.Value;
        var state = Checkpoint(run);
        var proposal = state.Proposals.SingleOrDefault(candidate => candidate.Id == command.StepId);
        if (run.Status is not ("completed" or "failed" or "cancelled")
            || proposal is not { Status: "applied", Receipt: not null }
            || !_capabilities.TryGetValue(proposal.Capability, out var capability) || !capability.Reversible)
        {
            return Conflict();
        }

        var undo = Replace(state, proposal with { Status = "undo_pending", UndoId = Guid.NewGuid() });
        return await QueueAsync(run, undo with { UndoResumeStatus = run.Status },
            cancellationToken).ConfigureAwait(false);
    }

    private async Task<Result<PetRunRecord>> FindAsync(ItemId itemId, Guid runId, CancellationToken cancellationToken)
    {
        var run = await runs.GetAsync(runId, cancellationToken).ConfigureAwait(false);
        if (run is null || run.ItemId != itemId || run.ActorId != Caller.PrincipalId || run.TenantId != Caller.TenantId
            || !IsEnabled(run.WorkspaceId))
        {
            return Result.Failure<PetRunRecord>(Missing());
        }

        return await RunScopeAvailableAsync(run, cancellationToken).ConfigureAwait(false)
            ? Result.Success(run)
            : Result.Failure<PetRunRecord>(Missing());
    }

    private async Task<bool> RunScopeAvailableAsync(PetRunRecord run, CancellationToken cancellationToken)
    {
        var root = await items.FindAsync(run.ItemId, cancellationToken).ConfigureAwait(false);
        return root is not null && root.WorkspaceId == run.WorkspaceId
            && await ScopeAvailableAsync(root, ReadSources(run, Checkpoint(run)), cancellationToken).ConfigureAwait(false);
    }

    private async Task<bool> ScopeAvailableAsync(Item item, IReadOnlyList<Guid> sources, CancellationToken cancellationToken)
    {
        if (!CanUseSource(item)
            || !await WorkspaceAvailableAsync(item.WorkspaceId, cancellationToken).ConfigureAwait(false))
        {
            return false;
        }
        ItemId[] ids = [item.Id, .. sources.Select(ItemId.From)];
        if ((await itemLocks.LockedAmongAsync(ids, cancellationToken).ConfigureAwait(false)).Count > 0)
        {
            return false;
        }
        foreach (var id in ids.Skip(1))
        {
            var source = await items.FindAsync(id, cancellationToken).ConfigureAwait(false);
            if (source is null || source.WorkspaceId != item.WorkspaceId || !CanUseSource(source))
            {
                return false;
            }
        }
        return true;
    }

    private static bool CanUseSource(Item item) => item.LifecycleState == ItemLifecycleState.Active
        && !ItemSettings.Read(item.Settings).WithholdFromPets;

    private async Task<bool> WorkspaceAvailableAsync(WorkspaceId workspace, CancellationToken cancellationToken) =>
        await permissions.CanReadWorkspaceAsync(workspace, cancellationToken).ConfigureAwait(false)
            && !(await workspaceLocks.GetStateAsync(workspace, cancellationToken).ConfigureAwait(false)).PasswordProtected;

    private bool IsEnabled(WorkspaceId workspace) => IsEnabled(configuration, workspace);

    internal static bool IsEnabled(IConfiguration configuration, WorkspaceId workspace) =>
        configuration.GetValue<bool>("Nix:PetRuns:Enabled") && IsPilotWorkspace(configuration, workspace);

    internal static bool IsPaused(IConfiguration configuration, WorkspaceId workspace) =>
        !configuration.GetValue<bool>("Nix:PetRuns:Enabled") && IsPilotWorkspace(configuration, workspace);

    private static bool IsPilotWorkspace(IConfiguration configuration, WorkspaceId workspace) =>
        configuration.GetSection("Nix:PetRuns:AllowedWorkspaces").GetChildren()
            .Any(entry => Guid.TryParse(entry.Value, out var allowed) && allowed == workspace.Value);

    private async Task<PetProfile?> FindPetAsync(CancellationToken cancellationToken)
    {
        var preferences = await dispatcher.QueryAsync<GetPetSettings, PetSettingsResponse>(new GetPetSettings(), cancellationToken).ConfigureAwait(false);
        return preferences.Settings is { Enabled: true, ActivePetId: { } active } settings
            ? settings.Profiles.FirstOrDefault(pet => pet.Id == active)
            : null;
    }

    private async Task<Result<PetRunResponse>> QueueAsync(PetRunRecord run, PetRunCheckpoint state, CancellationToken cancellationToken)
    {
        if (!Fits(state))
        {
            return Invalid("This pet job reached its checkpoint limit. Start a new job with a smaller scope.");
        }
        var job = await QueueJobAsync(run, run.Revision + 1, cancellationToken).ConfigureAwait(false);
        return await SaveResponseAsync(run, state with { ActiveJobId = job, Failure = null }, "queued", cancellationToken).ConfigureAwait(false);
    }

    private async ValueTask<Guid> QueueJobAsync(PetRunRecord run, long revision, CancellationToken cancellationToken)
    {
        var job = await jobs.CreateAsync(run.TenantId, run.ActorId, run.WorkspaceId, AdvanceKind,
            FormattableString.Invariant($"pet-run:{run.Id:N}:{revision}"),
            JsonSerializer.Serialize(new PetRunJobPayload(run.Id), PetRunJsonContext.Default.PetRunJobPayload),
            cancellationToken).ConfigureAwait(false);
        return job.Id;
    }

    private async Task<Result<PetRunResponse>> SaveResponseAsync(
        PetRunRecord run, PetRunCheckpoint state, string status, CancellationToken cancellationToken)
    {
        var next = Next(run, state, status);
        return await runs.UpdateAsync(next, run.Revision, cancellationToken).ConfigureAwait(false)
            ? Result.Success(Respond(next, state))
            : Conflict();
    }

    private PetRunRecord Next(PetRunRecord run, PetRunCheckpoint state, string status) =>
        run with { Status = status, State = Serialize(state), Revision = run.Revision + 1, UpdatedAt = clock.GetUtcNow() };

    private async Task<PetRunResponse> RespondAsync(PetRunRecord run, CancellationToken cancellationToken)
    {
        var state = Checkpoint(run);
        if (run.Status is "queued" or "running" && state.ActiveJobId is { } id
            && (await jobs.GetAsync(run.TenantId, run.ActorId, id, cancellationToken).ConfigureAwait(false))?.Status is "failed" or "cancelled")
        {
            var uncertain = state.Proposals.FirstOrDefault(proposal => proposal.Status is "applying" or "undo_applying");
            state = uncertain is null ? state : Replace(state, uncertain with { Status = "unknown" });
            run = run with { Status = uncertain is null ? "failed" : "review_required" };
        }
        return Respond(run, state);
    }

    private static PetRunResponse Respond(PetRunRecord run, PetRunCheckpoint state) => new(
        run.Id, run.ItemId.Value, run.WorkspaceId.Value, run.Brief, ReadSources(run, state), run.WorkspaceScope,
        RunAbilities(run, state), run.Status, run.Revision, state.Question, state.Proposals, state.Results, run.CreatedAt, run.UpdatedAt,
        state.IncludeTargetText, state.AfterMessageId, state.Failure);

    private static PetRunCheckpoint Checkpoint(PetRunRecord run) =>
        run.State.Deserialize(PetRunJsonContext.Default.PetRunCheckpoint)
        ?? throw new InvalidOperationException("The persisted pet run checkpoint is unavailable.");

    private static JsonElement Serialize(PetRunCheckpoint checkpoint) =>
        JsonSerializer.SerializeToElement(checkpoint, PetRunJsonContext.Default.PetRunCheckpoint);

    private static PetRunCheckpoint Replace(PetRunCheckpoint state, PetRunProposal replacement) =>
        state with { Proposals = [.. state.Proposals.Select(proposal => proposal.Id == replacement.Id ? replacement : proposal)] };

    private static bool ValidText(string? value, int maxChars, int maxBytes) =>
        value is { Length: > 0 } && value.Length <= maxChars && !string.IsNullOrWhiteSpace(value)
        && Encoding.UTF8.GetByteCount(value) <= maxBytes && !value.Contains('\0', StringComparison.Ordinal);

    private static NixError Missing() => new("pet_runs.not_found", "This pet job or its task is unavailable.");
    private static Result<PetRunResponse> Invalid(string detail) => Result.Failure<PetRunResponse>(new NixError("pet_runs.invalid", detail));
    private static Result<PetRunResponse> Conflict() => Result.Failure<PetRunResponse>(
        new NixError("pet_runs.conflict", "The pet job changed. Refresh the task before continuing."));
}
