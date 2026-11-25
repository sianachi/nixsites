using System.Reflection;
using Microsoft.AspNetCore.Http;
using Nix.Abstractions;
using Nix.Abstractions.PetRuns;
using Nix.Domain.Identity;
using Nix.Domain.Tenancy;
using Nix.Features.Pets;
using Nix.Persistence;

namespace Nix.Tests.Features.Pets;

public sealed class PetPlanDecisionContextAccessTests
{
    private static CancellationToken Cancellation => TestContext.Current.CancellationToken;

    [Theory]
    [InlineData("browser")]
    [InlineData("worker")]
    [InlineData("pet-turn")]
    [InlineData("external")]
    public async Task Execution_and_browser_bearers_cannot_consume_a_delegated_context(string kind)
    {
        var access = new AccessTokenSessionContext();
        switch (kind)
        {
            case "browser": access.SetInteractive(); break;
            case "pet-turn": access.SetPetTurn(true, true); break;
            case "external": access.SetExternalBearer(); break;
            default: break;
        }
        var (allowed, store) = await Authorize(access, "fixture-context-secret-with-thirty-two-characters");
        Assert.False(allowed);
        Assert.Equal(0, store.ConsumeCalls);
    }

    [Fact]
    public async Task PAT_scope_alone_cannot_decide_but_an_authorized_exact_context_records_delegated_provenance()
    {
        var access = new AccessTokenSessionContext();
        access.SetTokenCeiling(true, true);
        var (missing, first) = await Authorize(access, null);
        Assert.False(missing);
        Assert.Equal(0, first.ConsumeCalls);
        var (allowed, second) = await Authorize(access, "fixture-context-secret-with-thirty-two-characters");
        Assert.True(allowed);
        Assert.Equal(1, second.ConsumeCalls);
    }

    private static async Task<(bool Allowed, ContextIoFake Store)> Authorize(AccessTokenSessionContext access, string? secret)
    {
        var context = new NixSessionContext(TenantId.Create(), WorkspaceId.Create(), PrincipalId.Create());
        var session = new ScopedNixSessionContextAccessor();
        session.Set(context);
        var credential = new CredentialSessionContext();
        credential.Set(Guid.NewGuid());
        var store = new ContextIoFake();
        var type = typeof(PetWorkerClient).Assembly.GetType("Nix.Authentication.PetPlanDecisionAccess", throwOnError: true)!;
        var authority = Activator.CreateInstance(type, [null, new HttpContextAccessor(), access, credential, session, store, TimeProvider.System]);
        var method = type.GetMethod("AuthorizeAsync", BindingFlags.Instance | BindingFlags.NonPublic)!;
        var task = Assert.IsAssignableFrom<Task>(method.Invoke(authority, [context.WorkspaceId!.Value.Value,
            Guid.NewGuid(), Guid.NewGuid(), 1, "review-digest", true, Guid.NewGuid(), secret, Cancellation]));
        await task;
        var result = task.GetType().GetProperty("Result")!.GetValue(task)!;
        var allowed = Assert.IsType<bool>(result.GetType().GetProperty("IsSuccess")!.GetValue(result));
        if (allowed)
        {
            var value = result.GetType().GetProperty("Value")!.GetValue(result)!;
            Assert.Equal("delegated", value.GetType().GetProperty("CredentialClass")!.GetValue(value));
        }
        return (allowed, store);
    }

    private sealed class ContextIoFake : IPetPlanConsentStore
    {
        internal int ConsumeCalls { get; private set; }
        public Task<PetPlanDecisionContextRecord?> ConsumeContextAsync(string secretHash, WorkspaceId workspaceId,
            Guid runId, Guid planId, int planVersion, string reviewDigest, bool approve, Guid granteeCredentialId,
            Guid requestId, DateTimeOffset now, CancellationToken cancellationToken)
        {
            ConsumeCalls++;
            return Task.FromResult<PetPlanDecisionContextRecord?>(new(Guid.NewGuid(), workspaceId, runId, planId,
                planVersion, reviewDigest, granteeCredentialId, "Fixture CLI", approve, secretHash,
                now.AddMinutes(1), Guid.NewGuid(), now, ConsumedRequestId: requestId, ConsumedAt: now));
        }
        public Task<PetPlanConsentRecord?> FindAsync(WorkspaceId workspaceId, Guid petId, string scopeDigest, string recipientRevision, CancellationToken cancellationToken) => throw new NotSupportedException();
        public Task<PetPlanConsentQuestion> PrepareQuestionAsync(WorkspaceId workspaceId, Guid petId, string scopeDigest, string recipientRevision, DateTimeOffset now, CancellationToken cancellationToken) => throw new NotSupportedException();
        public Task<bool> DecideAsync(PetPlanConsentRecord consent, Guid decisionNonce, CancellationToken cancellationToken) => throw new NotSupportedException();
        public Task<bool> CreateContextAsync(PetPlanDecisionContextRecord context, CancellationToken cancellationToken) => throw new NotSupportedException();
        public Task<PetPlanDecisionContextRecord?> ReadContextAsync(Guid contextId, CancellationToken cancellationToken) => throw new NotSupportedException();
        public Task<bool> AuthorizeContextAsync(PetPlanDecisionContextRecord context, Guid authorityId, DateTimeOffset now, CancellationToken cancellationToken) => throw new NotSupportedException();
        public Task<bool> RevokeContextAsync(Guid contextId, DateTimeOffset now, CancellationToken cancellationToken) => throw new NotSupportedException();
        public Task CleanupAsync(DateTimeOffset now, CancellationToken cancellationToken) => throw new NotSupportedException();
    }
}
