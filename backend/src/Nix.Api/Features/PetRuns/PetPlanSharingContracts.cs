using System.Diagnostics.CodeAnalysis;
using System.Text.Json;
using System.Text.Json.Serialization;

namespace Nix.Features.PetRuns;

internal sealed record PetPlanRecipientDescriptor(string Provider, string Destination, string RoutingPolicy, string ConnectionRevision);
internal sealed record PetPlanSharingQuestion(string ScopeDigest, string RecipientRevision,
    PetPlanSourceScope SourceScope, PetPlanRecipientDescriptor Recipient, string Message, Guid? DecisionNonce = null);
internal sealed record DecidePetPlanSharingRequest(long ExpectedRunRevision, string RecipientRevision,
    string ScopeDigest, bool Approve, Guid RequestId, [property: JsonRequired] Guid DecisionNonce = default);
[SuppressMessage("Performance", "CA1812", Justification = "Bound from owner HTTP requests.")]
internal sealed record PetSharingQuestionRequest(Guid PetId, PetPlanSourceScope SourceScope, bool ForDecision = false);
[SuppressMessage("Performance", "CA1812", Justification = "Bound from owner HTTP requests.")]
internal sealed record PetSharingDecisionRequest(Guid PetId, PetPlanSourceScope SourceScope, string RecipientRevision,
    string ScopeDigest, bool Approve, Guid RequestId, [property: JsonRequired] Guid DecisionNonce = default);
internal sealed record PetSharingQuestionResponse(PetPlanSharingQuestion? Question);
[SuppressMessage("Performance", "CA1812", Justification = "Bound from operator HTTP requests.")]
internal sealed record CreatePetPlanDecisionHandoffRequest(Guid PlanId, int PlanVersion, string ReviewDigest,
    string ClientName, bool Approve);
[SuppressMessage("Performance", "CA1812", Justification = "Bound from verified browser requests.")]
internal sealed record CreatePetPlanDecisionContextRequest(Guid HandoffId, Guid PlanId, int PlanVersion,
    string ReviewDigest, Guid GranteeCredentialId, string ClientName, bool Approve);
internal sealed record PetPlanDecisionHandoffResponse(Guid HandoffId, string BrowserPath, string DecisionContext, DateTimeOffset ExpiresAt);
internal sealed record PetPlanDecisionHandoffStatus(Guid HandoffId, Guid GranteeCredentialId, string ClientName,
    Guid PlanId, int PlanVersion, string ReviewDigest, bool Approve, string Status, DateTimeOffset ExpiresAt);
internal sealed record PetSharingAttestation(Guid TenantId, Guid PrincipalId, Guid WorkspaceId, Guid PetId,
    string Provider, PetPlanSourceScope SourceScope, string ScopeDigest, string RecipientRevision, Guid TurnId,
    DateTimeOffset ExpiresAt, bool OwnerTextOnly = false);
[SuppressMessage("Performance", "CA1812", Justification = "Bound from trusted service HTTP requests.")]
internal sealed record ValidatePetSharingRequest(string Attestation, Guid TenantId, Guid PrincipalId,
    Guid WorkspaceId, Guid PetId, string Provider, Guid TurnId, Guid? PriorTurnId = null,
    IReadOnlyList<Guid>? ContextSourceItemIds = null, bool ContextProtected = false,
    bool ContextUnbounded = false, string? PriorRecipientRevision = null, PetPlanSourceScope? PriorSourceScope = null);
internal sealed record ValidatePetSharingResponse(bool Allowed, string? RecipientRevision = null, PetPlanSourceScope? SourceScope = null);

[JsonSourceGenerationOptions(JsonSerializerDefaults.Web)]
[JsonSerializable(typeof(PetSharingAttestation))]
[JsonSerializable(typeof(PetSharingQuestionRequest))]
[JsonSerializable(typeof(PetSharingDecisionRequest))]
[JsonSerializable(typeof(PetSharingQuestionResponse))]
[JsonSerializable(typeof(DecidePetPlanSharingRequest))]
[JsonSerializable(typeof(CreatePetPlanDecisionHandoffRequest))]
[JsonSerializable(typeof(CreatePetPlanDecisionContextRequest))]
[JsonSerializable(typeof(PetPlanDecisionHandoffResponse))]
[JsonSerializable(typeof(PetPlanDecisionHandoffStatus))]
[JsonSerializable(typeof(ValidatePetSharingRequest))]
[JsonSerializable(typeof(ValidatePetSharingResponse))]
internal sealed partial class PetPlanSharingJson : JsonSerializerContext;
