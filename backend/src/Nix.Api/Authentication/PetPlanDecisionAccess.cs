using System.Diagnostics.CodeAnalysis;
using Nix.Abstractions;
using Nix.Abstractions.PetRuns;
using Nix.Domain.Primitives;
using Nix.Domain.Tenancy;
using Nix.Features.BrowserAuth;
using Nix.Features.PetRuns;

namespace Nix.Authentication;

[SuppressMessage("Performance", "CA1812", Justification = "Created by dependency injection.")]
internal sealed class PetPlanDecisionAccess(BrowserAccess browser, IHttpContextAccessor http,
    AccessTokenSessionContext access, CredentialSessionContext credential, INixSessionContextAccessor session,
    IPetPlanConsentStore store, TimeProvider clock)
{
    internal bool HasOperatorCredential => credential.CredentialId is not null && !access.IsPetTurn
        && !access.IsExternalBearer && (access.IsInteractive || access.IsTokenSession);
    internal bool HasDelegatedCredential => credential.CredentialId is not null && access.IsTokenSession
        && !access.IsInteractive && !access.IsPetTurn && !access.IsExternalBearer;

    internal async Task<Result<PetPlanDecisionRecord>> AuthorizeAsync(Guid workspaceId, Guid runId, Guid planId,
        int planVersion, string reviewDigest, bool approve, Guid requestId, string? decisionContext,
        CancellationToken cancellationToken)
    {
        var caller = session.Current;
        if (caller is null || requestId == Guid.Empty)
        {
            return Denied();
        }

        var browserSession = http.HttpContext is { } request
            ? await browser.VerifyAsync(request, requireOrigin: true).ConfigureAwait(false) : null;
        if (browserSession is not null && string.IsNullOrEmpty(decisionContext))
        {
            return Result.Success(new PetPlanDecisionRecord(requestId, approve, clock.GetUtcNow(), "browser",
                browserSession.Id.Value.ToString("D"), caller.Value.PrincipalId.Value));
        }

        if (!HasDelegatedCredential || credential.CredentialId is not { } credentialId
            || decisionContext is not { Length: >= 32 and <= 256 })
        {
            return Denied();
        }

        var context = await store.ConsumeContextAsync(PetPlanSharingService.Hash(decisionContext), WorkspaceId.From(workspaceId),
            runId, planId, planVersion, reviewDigest, approve, credentialId, requestId, clock.GetUtcNow(), cancellationToken).ConfigureAwait(false);
        return context is { AuthorityId: not null, ConsumedAt: not null }
            ? Result.Success(new PetPlanDecisionRecord(requestId, approve, context.ConsumedAt.Value, "delegated",
                context.Id.ToString("D"), caller.Value.PrincipalId.Value)) : Denied();
    }

    private static Result<PetPlanDecisionRecord> Denied() => Result.Failure<PetPlanDecisionRecord>(new(
        "pet_plans.owner_decision_required", "Use your signed-in Nix browser or a matching browser-authorized decision context."));
}
