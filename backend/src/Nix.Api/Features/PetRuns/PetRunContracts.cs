using System.Text.Json;
using System.Text.Json.Serialization;
using Nix.Abstractions.PetRuns;
using Nix.Domain.Items;
using Nix.Domain.Primitives;
using Nix.Domain.Tenancy;
using Nix.Messaging;

namespace Nix.Features.PetRuns;

internal sealed record StartPetRunRequest(
    string? Brief,
    IReadOnlyList<Guid>? SourceItemIds = null,
    bool WorkspaceScope = false,
    IReadOnlyList<string>? Abilities = null,
    bool? IncludeTargetText = null,
    string? AfterMessageId = null);

internal sealed record AnswerPetRunRequest(Guid QuestionId, string? Answer);
internal sealed record DecidePetProposalRequest(bool Approve);
internal sealed record DecidePetRunScopeRequest(Guid QuestionId, bool Approve, Guid? SourceItemId = null);
internal sealed record RevisePetRunProposalRequest(string? Feedback = null);
internal sealed record PetRunAbility(string Id, string Name, string Description);
internal sealed record PetRunQuestion(Guid Id, string Text, string? Scope = null, string? Ability = null);
internal sealed record PetRunProposal(
    Guid Id,
    string Capability,
    string Description,
    JsonElement Preview,
    string Status,
    DateTimeOffset? DecisionAt = null,
    string? Receipt = null,
    Guid? UndoId = null,
    bool Automatic = false);

internal sealed record PetRunResult(Guid Id, string Text, bool Reversible);
internal sealed record PetRunsResponse(bool Enabled, IReadOnlyList<PetRunAbility> Abilities, IReadOnlyList<PetRunResponse> Runs);
internal sealed record PetRunResponse(
    Guid Id,
    Guid ItemId,
    Guid WorkspaceId,
    string Brief,
    IReadOnlyList<Guid> SourceItemIds,
    bool WorkspaceScope,
    IReadOnlyList<string> Abilities,
    string Status,
    long Revision,
    PetRunQuestion? Question,
    IReadOnlyList<PetRunProposal> Proposals,
    IReadOnlyList<PetRunResult> Results,
    DateTimeOffset CreatedAt,
    DateTimeOffset UpdatedAt,
    bool? IncludeTargetText = null,
    string? AfterMessageId = null,
    PetRunFailure? Failure = null);

internal sealed record PetRunFailure(string Stage, string Code, string Message);

internal sealed record PetRunEffect(string Description, JsonElement Parameters);
internal sealed record PetTaskCommentPreview(Guid ItemId, string Title, string Audience, DateTimeOffset Revision, string Body);

internal sealed record PetRunCheckpoint(
    Guid PetId,
    Guid? ActiveJobId,
    PetRunQuestion? Question,
    IReadOnlyList<PetRunProposal> Proposals,
    IReadOnlyList<PetRunResult> Results,
    IReadOnlyList<string> Answers,
    int Turns,
    PetRoutineBinding? Routine = null,
    string? Provider = null,
    string? UndoResumeStatus = null,
    bool? IncludeTargetText = null,
    string? AfterMessageId = null,
    IReadOnlyList<Guid>? AddedSources = null,
    IReadOnlyList<string>? AddedAbilities = null,
    PetRunRevisionFeedback? RevisionFeedback = null,
    IReadOnlyList<string>? OwnerRevisions = null,
    PetRunFailure? Failure = null);

internal sealed record PetRunRevisionFeedback(Guid ProposalId, string? Feedback);

internal sealed record PetRunJobPayload(Guid RunId);

internal sealed record PetRoutineBinding(Guid RuleId, long Revision);

internal interface IPetRunRoutineAuthorization
{
    public Task<bool> AllowsAsync(
        PetRoutineBinding binding, PetRunRecord run, string capability, PetRunEffect effect, CancellationToken cancellationToken);
}

internal sealed record ListPetRuns(ItemId? ItemId, WorkspaceId? WorkspaceId) : IQuery<Result<PetRunsResponse>>;
internal sealed record ReadPetRun(ItemId ItemId, Guid RunId) : IQuery<Result<PetRunResponse>>;
internal sealed record StartPetRun(ItemId ItemId, StartPetRunRequest Request) : ICommand<PetRunResponse>;
internal sealed record AnswerPetRun(ItemId ItemId, Guid RunId, AnswerPetRunRequest Request) : ICommand<PetRunResponse>;
internal sealed record DecidePetRunProposal(ItemId ItemId, Guid RunId, Guid ProposalId, bool Approve) : ICommand<PetRunResponse>;
internal sealed record DecidePetRunScope(ItemId ItemId, Guid RunId, DecidePetRunScopeRequest Request) : ICommand<PetRunResponse>;
internal sealed record RevisePetRunProposal(ItemId ItemId, Guid RunId, Guid ProposalId, RevisePetRunProposalRequest Request) : ICommand<PetRunResponse>;
internal sealed record CancelPetRun(ItemId ItemId, Guid RunId) : ICommand<PetRunResponse>;
internal sealed record RetryPetRun(ItemId ItemId, Guid RunId) : ICommand<PetRunResponse>;
internal sealed record UndoPetRunStep(ItemId ItemId, Guid RunId, Guid StepId) : ICommand<PetRunResponse>;

internal interface IPetRunCapability
{
    public string Name { get; }
    public string Description { get; }
    public JsonElement? InputSchema => null;
    public bool Atomic => false;
    public bool Reversible => false;
    public bool RequiresApproval(PetRunEffect effect) => true;
    public bool RoutineEligible(PetRunEffect effect) => false;
    public string? ModelObservation(PetRunEffect effect, string receipt) => null;
    public Task<bool> CanObserveAsync(
        PetRunRecord run, PetRunEffect effect, string receipt, CancellationToken cancellationToken) => Task.FromResult(true);
    public Task<string?> RevisionObservationAsync(PetRunRecord run, PetRunEffect effect, CancellationToken cancellationToken) =>
        Task.FromResult<string?>(null);

    public Task<Result<PetRunEffect>> PreviewAsync(PetRunRecord run, JsonElement args, CancellationToken cancellationToken);
    public Task<Result<string>> ApplyAsync(PetRunRecord run, Guid actionId, PetRunEffect effect, CancellationToken cancellationToken);
    public Task<Result<string>> UndoAsync(
        PetRunRecord run, Guid actionId, PetRunEffect effect, string receipt, CancellationToken cancellationToken) =>
        Task.FromResult(Result.Failure<string>(new NixError("pet_runs.not_reversible", "This action has no undo.")));
}

[JsonSourceGenerationOptions(JsonSerializerDefaults.Web)]
[JsonSerializable(typeof(StartPetRunRequest))]
[JsonSerializable(typeof(AnswerPetRunRequest))]
[JsonSerializable(typeof(DecidePetProposalRequest))]
[JsonSerializable(typeof(DecidePetRunScopeRequest))]
[JsonSerializable(typeof(RevisePetRunProposalRequest))]
[JsonSerializable(typeof(PetRunResponse))]
[JsonSerializable(typeof(PetRunsResponse))]
[JsonSerializable(typeof(PetRunCheckpoint))]
[JsonSerializable(typeof(PetRunJobPayload))]
[JsonSerializable(typeof(PetTaskCommentPreview))]
internal sealed partial class PetRunJsonContext : JsonSerializerContext;
