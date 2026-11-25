using System.Diagnostics.CodeAnalysis;
using System.Security.Cryptography;
using System.Text.Json;
using Nix.Abstractions;
using Nix.Abstractions.PetRuns;
using Nix.Authentication;
using Nix.Domain.Primitives;
using Nix.Features.BrowserAuth;

namespace Nix.Features.PetRuns;

[SuppressMessage("Performance", "CA1812", Justification = "Created by dependency injection.")]
internal sealed class PetPlanDecisionContextService(IPetPlanConsentStore store, IPetRunStore runs,
    INixSessionContextAccessor session, CredentialSessionContext credential, PetPlanDecisionAccess access,
    BrowserAccess browser, IHttpContextAccessor http, TimeProvider clock, IIsolatedUnitOfWork isolated)
{
    private static NixError Denied => new("pet_plans.context_denied", "This exact decision handoff is unavailable. Request a fresh handoff.");

    internal async Task<Result<PetPlanDecisionHandoffResponse>> CreateAsync(Guid workspaceId, Guid runId,
        CreatePetPlanDecisionHandoffRequest request, CancellationToken cancellationToken)
    {
        if (!access.HasDelegatedCredential)
        {
            return Result.Failure<PetPlanDecisionHandoffResponse>(new("pet_plans.context_denied",
                "Use a personal access token for a named delegated handoff, or review this plan directly in your signed-in Nix browser."));
        }
        if (!access.HasDelegatedCredential || credential.CredentialId is not { } credentialId
            || !ValidName(request.ClientName) || !await MatchesPlanAsync(workspaceId, runId, request.PlanId,
                request.PlanVersion, request.ReviewDigest, cancellationToken).ConfigureAwait(false))
        {
            return Result.Failure<PetPlanDecisionHandoffResponse>(Denied);
        }
        var caller = session.Current ?? throw new InvalidOperationException("An owner transaction is required.");

        var secret = Convert.ToBase64String(RandomNumberGenerator.GetBytes(32)).TrimEnd('=').Replace('+', '-').Replace('/', '_');
        var record = new PetPlanDecisionContextRecord(Guid.NewGuid(), Nix.Domain.Tenancy.WorkspaceId.From(workspaceId),
            runId, request.PlanId, request.PlanVersion, request.ReviewDigest, credentialId,
            request.ClientName.Trim(), request.Approve, PetPlanSharingService.Hash(secret), clock.GetUtcNow().AddMinutes(5));
        var created = await isolated.RunAsync(NixSessionContext.ForTenant(caller.TenantId, caller.PrincipalId), async (services, token) =>
        {
            var ownerStore = services.GetRequiredService<IPetPlanConsentStore>();
            var added = await ownerStore.CreateContextAsync(record, token).ConfigureAwait(false);
            if (added)
            {
                await ownerStore.CleanupAsync(clock.GetUtcNow(), token).ConfigureAwait(false);
            }
            return new IsolatedOutcome<bool>(added, added);
        }, cancellationToken).ConfigureAwait(false);
        if (!created)
        {
            return Result.Failure<PetPlanDecisionHandoffResponse>(Denied);
        }

        return Result.Success(new PetPlanDecisionHandoffResponse(record.Id,
            $"/w/{workspaceId:D}/pet/plans/{runId:D}/review?handoffId={record.Id:D}", secret, record.ExpiresAt));
    }

    internal async Task<Result<PetPlanDecisionHandoffStatus>> ReadAsync(Guid workspaceId, Guid runId, Guid handoffId,
        CancellationToken cancellationToken)
    {
        var record = await store.ReadContextAsync(handoffId, cancellationToken).ConfigureAwait(false);
        return record is not null && record.WorkspaceId.Value == workspaceId && record.RunId == runId
            && access.HasOperatorCredential ? Result.Success(Status(record)) : Result.Failure<PetPlanDecisionHandoffStatus>(Denied);
    }

    internal async Task<Result<PetPlanDecisionHandoffStatus>> AuthorizeAsync(Guid workspaceId, Guid runId,
        CreatePetPlanDecisionContextRequest request, CancellationToken cancellationToken)
    {
        var verified = http.HttpContext is { } context ? await browser.VerifyAsync(context, requireOrigin: true).ConfigureAwait(false) : null;
        var record = await store.ReadContextAsync(request.HandoffId, cancellationToken).ConfigureAwait(false);
        if (verified is null || record is null || record.WorkspaceId.Value != workspaceId || record.RunId != runId
            || record.PlanId != request.PlanId || record.PlanVersion != request.PlanVersion || record.ReviewDigest != request.ReviewDigest
            || record.GranteeCredentialId != request.GranteeCredentialId || record.ClientName != request.ClientName
            || record.Approve != request.Approve || !await MatchesPlanAsync(workspaceId, runId, request.PlanId,
                request.PlanVersion, request.ReviewDigest, cancellationToken).ConfigureAwait(false))
        {
            return Result.Failure<PetPlanDecisionHandoffStatus>(Denied);
        }

        if (record.AuthorityId == verified.Id.Value && record.RevokedAt is null && record.ExpiresAt > clock.GetUtcNow())
        {
            return Result.Success(Status(record));
        }

        if (!await store.AuthorizeContextAsync(record, verified.Id.Value, clock.GetUtcNow(), cancellationToken).ConfigureAwait(false))
        {
            return Result.Failure<PetPlanDecisionHandoffStatus>(Denied);
        }

        return Result.Success(Status(record with { AuthorityId = verified.Id.Value, AuthorizedAt = clock.GetUtcNow() }));
    }

    internal async Task<Result<PetPlanDecisionHandoffStatus>> RevokeAsync(Guid workspaceId, Guid runId, Guid handoffId,
        CancellationToken cancellationToken)
    {
        var record = await store.ReadContextAsync(handoffId, cancellationToken).ConfigureAwait(false);
        var verified = http.HttpContext is { } context ? await browser.VerifyAsync(context, requireOrigin: true).ConfigureAwait(false) : null;
        if (record is null || record.WorkspaceId.Value != workspaceId || record.RunId != runId
            || verified is null && (!access.HasOperatorCredential || credential.CredentialId != record.GranteeCredentialId)
            || !await store.RevokeContextAsync(handoffId, clock.GetUtcNow(), cancellationToken).ConfigureAwait(false))
        {
            return Result.Failure<PetPlanDecisionHandoffStatus>(Denied);
        }

        return Result.Success(Status(record with { RevokedAt = clock.GetUtcNow() }));
    }

    private async Task<bool> MatchesPlanAsync(Guid workspaceId, Guid runId, Guid planId, int planVersion,
        string reviewDigest, CancellationToken cancellationToken)
    {
        if (session.Current is not { } caller || planId == Guid.Empty || planVersion < 1 || reviewDigest is not { Length: >= 1 and <= 128 })
        {
            return false;
        }

        var run = await runs.GetAsync(runId, cancellationToken).ConfigureAwait(false);
        if (run is null || run.ActorId != caller.PrincipalId || run.TenantId != caller.TenantId
            || run.WorkspaceId.Value != workspaceId || run.Status != "waiting_for_approval")
        {
            return false;
        }

        var state = run.State.Deserialize(PetRunJsonContext.Default.PetRunCheckpoint);
        return state?.Plan is { Status: "awaiting_review" } plan && plan.Id == planId && plan.Version == planVersion && plan.ReviewDigest == reviewDigest;
    }

    private PetPlanDecisionHandoffStatus Status(PetPlanDecisionContextRecord context) => new(context.Id,
        context.GranteeCredentialId, context.ClientName, context.PlanId, context.PlanVersion, context.ReviewDigest,
        context.Approve, context.RevokedAt is not null ? "revoked" : context.ConsumedAt is not null ? "consumed"
            : context.ExpiresAt <= clock.GetUtcNow() ? "expired" : context.AuthorityId is not null ? "authorized" : "pending", context.ExpiresAt);
    private static bool ValidName(string? value) => value is { Length: >= 1 and <= 80 }
        && !string.IsNullOrWhiteSpace(value) && !value.Any(char.IsControl);
}
