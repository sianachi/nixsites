using System.Text.Json;
using System.Text.Json.Serialization;
using Nix.Abstractions.PetRuns;
using Nix.Domain.Primitives;
using Nix.Domain.Tenancy;
using Nix.Messaging;

namespace Nix.Features.PetRuns;

internal sealed record PetPlanSourceScope(string Kind, IReadOnlyList<Guid>? ItemIds = null, IReadOnlyList<Guid>? ReadOnlyWorkspaceIds = null);
internal sealed record PetPlanChatSource(string ConversationId, IReadOnlyList<string> ToolCallIds,
    Guid TurnId, string? Mode = null, Guid? RootItemId = null);
internal sealed record StartPetPlanRequest(Guid PetId, string? Brief, Guid? AnchorItemId,
    PetPlanSourceScope SourceScope, string? AfterMessageId, Guid RequestId, PetPlanChatSource? ChatSource = null);
internal sealed record PetPlanFieldEdit(Guid StepId, string FieldId, JsonElement Value);
internal sealed record RevisePetPlanRequest(long ExpectedRunRevision, int? PlanVersion,
    IReadOnlyList<PetPlanFieldEdit>? FieldEdits, string? Feedback, Guid RequestId);
internal sealed record DecidePetPlanRequest(long ExpectedRunRevision, int PlanVersion,
    string ReviewDigest, bool Approve, Guid RequestId, string? DecisionContext = null);
internal sealed record CancelPetPlanRequest(long ExpectedRunRevision, Guid RequestId);
internal sealed record AnswerPetPlanRequest(long ExpectedRunRevision, Guid QuestionId, string? Answer, Guid RequestId);
internal sealed record ClaimPetPlanStepRequest(long ExpectedRunRevision, int PlanVersion,
    string ReviewDigest, Guid RequestId, Guid RunnerContextId);
internal sealed record RecordPetPlanStepRequest(int PlanVersion, string ReviewDigest,
    Guid ClaimId, Guid ExecutionId, string Status, string? Receipt);
internal sealed record UndoPetPlanStepRequest(long ExpectedRunRevision, Guid RequestId);
internal sealed record PetPlanStepClaimResponse(PetPlanResponse Run, Guid ClaimId, Guid ExecutionId,
    Guid StepId, string Capability, JsonElement Arguments, JsonElement Preview, string Executor, string DispatchContext);
internal sealed record PetPlansResponse(bool Enabled, IReadOnlyList<PetRunAbility> Abilities, IReadOnlyList<PetPlanResponse> Runs);
internal sealed record PetPlanResponse(Guid Id, Guid WorkspaceId, Guid? AnchorItemId, Guid PetId,
    string Brief, PetPlanSourceScope SourceScope, string Status, long Revision,
    PetRunQuestion? Question, PetPlanReview? Plan,
    IReadOnlyList<PetRunResult> Results, DateTimeOffset CreatedAt, DateTimeOffset UpdatedAt,
    string? AfterMessageId = null, PetRunFailure? Failure = null, IReadOnlyList<PetPlanObservation>? Observations = null);
internal sealed record PetPlanRequestState(Guid RequestId, PetPlanSourceScope SourceScope, PetPlanChatSource? ChatSource = null,
    bool ProtectedRead = false, string? TimeZone = null, IReadOnlyList<PetPlanToolBinding>? SourceBindings = null,
    bool SourceSuperseded = false, string? PendingFinalStatus = null, bool SourceResolved = false,
    IReadOnlyList<PetPlanBuildLedgerEntry>? BuildLedger = null, bool ReadWithoutAsking = false, bool ReadPhase = false,
    bool SourceReadOnly = false, string? StartFingerprint = null,
    IReadOnlyList<Guid>? DisclosureSourceItemIds = null, bool UnboundedDisclosure = false);
internal sealed record PetPlanToolBinding(string ToolId, Guid RunId, Guid PlanId, int PlanVersion, string ReviewDigest, Guid StepId);
internal sealed record PetPlanBuildLedgerEntry(string NodeId, Guid? ItemId = null, string? Status = null);
internal sealed record PetPlanPrepared(Guid Id, int Version, string Summary, string ReviewDigest,
    string ScopeDigest, string RecipientRevision, string Status, IReadOnlyList<PetPlanPreparedStep> Steps,
    PetPlanDecisionRecord? Decision = null, bool ProtectedRead = false);
internal sealed record PetPlanPreparedStep(Guid Id, string Capability, JsonElement Arguments,
    PetRunEffect Effect, string Executor, string Status, IReadOnlyList<PetPlanEditableField> Fields,
    PetPlanStepExecution? Execution = null, string? Receipt = null, Guid? UndoId = null,
    IReadOnlyList<Guid>? SourceItemIds = null, bool UnboundedSourceProvenance = false, bool IncludedInReview = true,
    bool ObservationBlocked = false);
internal sealed record PetPlanEditableField(string Id, string Label, string Kind, JsonElement Value,
    string? Help = null, bool Required = false, IReadOnlyList<string>? Choices = null,
    JsonElement? CurrentValue = null, IReadOnlyList<string>? ArgumentPath = null);
internal sealed record PetPlanStepExecution(Guid ClaimId, Guid ExecutionId, Guid RequestId,
    Guid RunnerContextId, Guid? JobId, DateTimeOffset ClaimedAt,
    DateTimeOffset? DispatchedAt = null, string? WorkerExecutionId = null,
    IReadOnlyList<PetPlanChildPermit>? Children = null, string? ExpectedRevisions = null);
internal sealed record PetPlanChildPermit(int ChildId, Guid RequestId, string Destination,
    string Method, string Target, string? Body, string Revisions, string Binding,
    string Status, int? ResponseStatus = null, string? ResponseBody = null,
    IReadOnlyDictionary<string, string>? Headers = null, IReadOnlyDictionary<string, string>? ResponseHeaders = null,
    PetPlanTemplateProgress? TemplateProgress = null);
internal sealed record PetPlanTemplateProgress(Guid? OperationId = null, IReadOnlyList<Guid>? SourceItemIds = null,
    IReadOnlyList<Guid>? TargetItemIds = null, bool Finished = false);
internal sealed record PetPlanDecisionRecord(Guid RequestId, bool Approve, DateTimeOffset At,
    string CredentialClass, string AuthorityId, Guid ActorId);
internal sealed record PetPlanReview(Guid Id, int Version, string Summary, string ReviewDigest,
    string ScopeDigest, string RecipientRevision, string Status, IReadOnlyList<PetPlanStepResponse> Steps,
    PetPlanDecisionRecord? Decision = null);
internal sealed record PetPlanStepResponse(Guid Id, string Capability, JsonElement Arguments,
    PetRunEffect Effect, string Executor, string Status, IReadOnlyList<PetPlanFieldResponse> Fields,
    string? Receipt = null, Guid? UndoId = null, PetPlanReceiptView? ReceiptView = null);
internal sealed record PetPlanReceiptView(string Summary, JsonElement? Details = null, string? Text = null);
internal sealed record PetPlanObservation(Guid Id, string Capability, string Description, PetPlanReceiptView? ReceiptView);
internal sealed record PetPlanDiscovery(Guid Id, string Capability, PetRunEffect Effect, string Status = "pending");
internal sealed record PetPlanFieldResponse(string Id, string Label, string Kind, JsonElement Value,
    string? Help = null, bool Required = false, IReadOnlyList<string>? Choices = null, JsonElement? CurrentValue = null);

internal interface IPetPlanCapability
{
    public string Executor(PetRunEffect effect);
    public IReadOnlyList<PetPlanEditableField> Fields(PetRunEffect effect);
    public JsonElement Arguments(PetRunEffect effect, JsonElement supplied) => supplied;
    public string FrozenArgumentsHash(PetRunEffect effect, JsonElement arguments) => PetPlanExecution.Hash(arguments);
    public PetRunEffect PublicEffect(PetRunEffect effect) => effect;
    public string ExpectedRevisions(PetRunEffect effect) => "";
}

internal sealed record PetPlanExecutionOutcome(string Status, string? Receipt, NixError? Failure = null, bool LockedContent = false,
    IReadOnlyList<Guid>? SourceItemIds = null, bool UnboundedSourceProvenance = false);
internal interface IPetPlanOutcomeCapability
{
    public Task<PetPlanExecutionOutcome> ApplyPlanAsync(PetRunRecord run, Guid executionId, PetRunEffect effect, CancellationToken cancellationToken);
}
internal interface IPetPlanDiscoveryCapability
{
    public Task<PetPlanExecutionOutcome> DiscoverAsync(PetRunRecord run, PetRunEffect prepared, CancellationToken cancellationToken);
}

internal sealed record ListPetPlans(WorkspaceId WorkspaceId) : IQuery<Result<PetPlansResponse>>;
internal sealed record ReadPetPlan(WorkspaceId WorkspaceId, Guid RunId) : IQuery<Result<PetPlanResponse>>;
internal sealed record StartPetPlan(WorkspaceId WorkspaceId, StartPetPlanRequest Request) : ICommand<PetPlanResponse>;
internal sealed record RevisePetPlan(WorkspaceId WorkspaceId, Guid RunId, RevisePetPlanRequest Request) : ICommand<PetPlanResponse>;
internal sealed record DecidePetPlan(WorkspaceId WorkspaceId, Guid RunId, Guid PlanId, DecidePetPlanRequest Request) : ICommand<PetPlanResponse>;
internal sealed record AnswerPetPlan(WorkspaceId WorkspaceId, Guid RunId, AnswerPetPlanRequest Request) : ICommand<PetPlanResponse>;
internal sealed record CancelPetPlan(WorkspaceId WorkspaceId, Guid RunId, CancelPetPlanRequest Request) : ICommand<PetPlanResponse>;
internal sealed record ClaimPetPlanStep(WorkspaceId WorkspaceId, Guid RunId, Guid PlanId, Guid StepId,
    ClaimPetPlanStepRequest Request) : ICommand<PetPlanStepClaimResponse>;
internal sealed record RecordPetPlanStep(WorkspaceId WorkspaceId, Guid RunId, Guid PlanId, Guid StepId,
    RecordPetPlanStepRequest Request) : ICommand<PetPlanResponse>;
internal sealed record UndoPetPlanStep(WorkspaceId WorkspaceId, Guid RunId, Guid PlanId, Guid StepId,
    UndoPetPlanStepRequest Request) : ICommand<PetPlanResponse>;

[JsonSourceGenerationOptions(JsonSerializerDefaults.Web)]
[JsonSerializable(typeof(StartPetPlanRequest))]
[JsonSerializable(typeof(RevisePetPlanRequest))]
[JsonSerializable(typeof(DecidePetPlanRequest))]
[JsonSerializable(typeof(CancelPetPlanRequest))]
[JsonSerializable(typeof(AnswerPetPlanRequest))]
[JsonSerializable(typeof(ClaimPetPlanStepRequest))]
[JsonSerializable(typeof(RecordPetPlanStepRequest))]
[JsonSerializable(typeof(UndoPetPlanStepRequest))]
[JsonSerializable(typeof(PetPlanResponse))]
[JsonSerializable(typeof(PetPlansResponse))]
[JsonSerializable(typeof(PetPlanStepClaimResponse))]
[JsonSerializable(typeof(PetPlanToolBinding))]
[JsonSerializable(typeof(IReadOnlyList<PetPlanBuildLedgerEntry>), TypeInfoPropertyName = "BuildLedger")]
internal sealed partial class PetPlanJsonContext : JsonSerializerContext;
