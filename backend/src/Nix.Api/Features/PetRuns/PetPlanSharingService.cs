using System.Diagnostics.CodeAnalysis;
using System.Globalization;
using System.Security.Cryptography;
using System.Text;
using System.Text.Json;
using Microsoft.AspNetCore.DataProtection;
using Nix.Abstractions;
using Nix.Abstractions.PetRuns;
using Nix.Domain.Identity;
using Nix.Domain.Primitives;
using Nix.Domain.Tenancy;
using Nix.Features.BrowserAuth;
using Nix.Features.Pets;
using Nix.Messaging;

namespace Nix.Features.PetRuns;

[SuppressMessage("Performance", "CA1812", Justification = "Created by dependency injection.")]
internal sealed class PetPlanSharingService(IPetPlanConsentStore store, INixSessionContextAccessor session,
    NixDispatcher dispatcher, IPermissionResolver permissions, IPetProviderCredentialStore credentials,
    PetRecipientMetadataClient metadata, IDataProtectionProvider protection, BrowserAccess browser,
    IHttpContextAccessor httpContext, TimeProvider clock, IIsolatedUnitOfWork isolated, IIdentityDirectory identities)
{
    private readonly IDataProtector _protector = protection.CreateProtector("Nix.PetDisclosure.v1");
    private NixSessionContext Caller => session.Current ?? throw new InvalidOperationException("An owner transaction is required.");
    internal static NixError ConsentRequired => new("pets.sharing_required", "Review the selected sources and provider before sharing content.");

    internal static string ScopeDigest(Guid workspaceId, Guid petId, PetPlanSourceScope scope)
    {
        ArgumentNullException.ThrowIfNull(scope);
        return Hash(string.Join('\n', "scope-v1", workspaceId.ToString("D"), petId.ToString("D"), scope.Kind,
            string.Join(',', (scope.ItemIds ?? []).Distinct().Order().Select(id => id.ToString("D"))),
            string.Join(',', (scope.ReadOnlyWorkspaceIds ?? []).Distinct().Order().Select(id => id.ToString("D")))));
    }

    internal static string RecipientRevision(PetPlanRecipientDescriptor recipient) =>
        Hash(string.Join('\n', "recipient-v1", recipient.Provider, recipient.Destination, recipient.RoutingPolicy, recipient.ConnectionRevision));
    internal static string Hash(string value) => Convert.ToHexStringLower(SHA256.HashData(Encoding.UTF8.GetBytes(value)));

    internal async Task<Result<PetPlanSharingQuestion>> DescribeAsync(Guid workspaceId, Guid petId,
        PetPlanSourceScope scope, CancellationToken cancellationToken)
    {
        if (workspaceId == Guid.Empty || petId == Guid.Empty || scope is null
            || scope.Kind is not ("workspace" or "selected" or "subtree")
            || scope.ItemIds is { Count: > 100 } || (scope.ItemIds ?? []).Any(id => id == Guid.Empty)
            || scope.ReadOnlyWorkspaceIds is { Count: > 20 } || (scope.ReadOnlyWorkspaceIds ?? []).Any(id => id == Guid.Empty)
            || scope.Kind == "subtree" && scope.ItemIds?.Count != 1
            || scope.Kind == "workspace" && scope.ItemIds is { Count: > 0 }
            || !await permissions.CanReadWorkspaceAsync(WorkspaceId.From(workspaceId), cancellationToken).ConfigureAwait(false))
        {
            return Result.Failure<PetPlanSharingQuestion>(new("pets.invalid_scope", "Choose readable sources in a workspace."));
        }
        foreach (var sourceWorkspace in scope.ReadOnlyWorkspaceIds ?? [])
        {
            if (!await permissions.CanReadWorkspaceAsync(WorkspaceId.From(sourceWorkspace), cancellationToken).ConfigureAwait(false))
            {
                return Result.Failure<PetPlanSharingQuestion>(new("pets.invalid_scope", "A selected source workspace is unavailable."));
            }
        }

        var settings = await dispatcher.QueryAsync<GetPetSettings, PetSettingsResponse>(new(), cancellationToken).ConfigureAwait(false);
        var pet = settings.Settings.Profiles.FirstOrDefault(value => value.Id == petId);
        if (pet is null)
        {
            return Result.Failure<PetPlanSharingQuestion>(new("pets.invalid_request", "Choose a saved pet."));
        }

        var provider = pet.Provider;
        string revision;
        if (PetProviders.NeedsKey(provider))
        {
            var credential = await credentials.FindAsync(Caller.TenantId, Caller.PrincipalId, provider, cancellationToken).ConfigureAwait(false);
            revision = credential is null ? "unknown" : Hash(string.Join('\n', "credential-v1", Caller.TenantId.Value,
                Caller.PrincipalId.Value, provider, credential.SavedAt.ToUniversalTime().ToString("O", CultureInfo.InvariantCulture)));
        }
        else
        {
            revision = await metadata.ConnectionRevisionAsync(provider, cancellationToken).ConfigureAwait(false) ?? "unknown";
        }

        var destination = provider switch
        {
            PetProviders.Anthropic => "https://api.anthropic.com",
            PetProviders.OpenAi => "https://api.openai.com",
            PetProviders.OpenRouter => "https://openrouter.ai/api/v1",
            PetProviders.ChatGpt => "https://chatgpt.com/backend-api/codex",
            _ => "unknown",
        };
        var routing = provider == PetProviders.OpenRouter ? "openrouter-provider-routing" : "direct";
        var recipient = new PetPlanRecipientDescriptor(provider, destination, routing, revision);
        var normalized = scope with
        {
            ItemIds = (scope.ItemIds ?? []).Distinct().Order().ToArray(),
            ReadOnlyWorkspaceIds = (scope.ReadOnlyWorkspaceIds ?? []).Distinct().Order().ToArray()
        };
        var label = scope.Kind switch { "workspace" => "readable workspace content", "subtree" => "this item and its readable children", _ => "the selected sources" };
        if (normalized.ReadOnlyWorkspaceIds is { Count: > 0 })
        {
            label += " and the selected read-only source workspaces";
        }
        return Result.Success(new PetPlanSharingQuestion(ScopeDigest(workspaceId, petId, normalized), RecipientRevision(recipient), normalized,
            recipient, revision == "unknown" ? "Connect the selected provider before reviewing content sharing."
                : provider == PetProviders.OpenRouter
                    ? $"May I share {label} with OpenRouter at {destination} and the model providers it routes requests to, to help with this task?"
                    : $"May I share {label} with {provider} at {destination} to help with this task?"));
    }

    internal async Task<Result<PetPlanSharingQuestion?>> PrepareAsync(Guid workspaceId, Guid petId,
        PetPlanSourceScope scope, CancellationToken cancellationToken, bool forDecision = false, bool issueDecisionNonce = true)
    {
        var described = await DescribeAsync(workspaceId, petId, scope, cancellationToken).ConfigureAwait(false);
        if (described.IsFailure)
        {
            return Result.Failure<PetPlanSharingQuestion?>(described.Error);
        }

        var question = described.Value;
        var consent = await store.FindAsync(WorkspaceId.From(workspaceId), petId, question.ScopeDigest,
            question.RecipientRevision, cancellationToken).ConfigureAwait(false);
        if (!forDecision && question.Recipient.ConnectionRevision != "unknown"
            && consent is { RevokedAt: null } && consent.ExpiresAt > clock.GetUtcNow())
        {
            return Result.Success<PetPlanSharingQuestion?>(null);
        }
        var http = httpContext.HttpContext;
        if (!issueDecisionNonce || question.Recipient.ConnectionRevision == "unknown" || http is null || http.Request.Method != HttpMethods.Post
            || await browser.VerifyAsync(http, requireOrigin: true).ConfigureAwait(false) is null)
        {
            return Result.Success<PetPlanSharingQuestion?>(question);
        }
        var owner = NixSessionContext.ForTenant(Caller.TenantId, Caller.PrincipalId);
        var pending = await isolated.RunAsync(owner, async (services, token) =>
            new IsolatedOutcome<PetPlanConsentQuestion>(await services.GetRequiredService<IPetPlanConsentStore>()
                .PrepareQuestionAsync(WorkspaceId.From(workspaceId), petId, question.ScopeDigest,
                    question.RecipientRevision, clock.GetUtcNow(), token).ConfigureAwait(false), true), cancellationToken).ConfigureAwait(false);
        return Result.Success<PetPlanSharingQuestion?>(question with { DecisionNonce = pending.DecisionNonce });
    }

    internal async Task<Result<bool>> DecideAsync(Guid workspaceId, Guid petId, PetPlanSourceScope scope,
        DecidePetPlanSharingRequest request, CancellationToken cancellationToken)
    {
        var http = httpContext.HttpContext;
        var verified = http is null ? null : await browser.VerifyAsync(http, requireOrigin: true).ConfigureAwait(false);
        if (verified is null)
        {
            return Result.Failure<bool>(new("pet_plans.owner_decision_required", "Use your signed-in Nix browser to decide sharing."));
        }

        var described = await DescribeAsync(workspaceId, petId, scope, cancellationToken).ConfigureAwait(false);
        if (described.IsFailure)
        {
            return Result.Failure<bool>(described.Error);
        }

        if (request.RequestId == Guid.Empty || request.DecisionNonce == Guid.Empty || described.Value.ScopeDigest != request.ScopeDigest
            || described.Value.RecipientRevision != request.RecipientRevision || described.Value.Recipient.ConnectionRevision == "unknown")
        {
            return Result.Failure<bool>(new("pets.sharing_changed", "The sources or provider changed. Review sharing again."));
        }

        var now = clock.GetUtcNow();
        var saved = await store.DecideAsync(new(Guid.Empty, WorkspaceId.From(workspaceId), petId,
            described.Value.ScopeDigest, described.Value.RecipientRevision, request.RequestId, verified.Id.Value,
            now, now.AddDays(30), request.Approve ? null : now), request.DecisionNonce, cancellationToken).ConfigureAwait(false);
        if (!saved)
        {
            return Result.Failure<bool>(new("pets.sharing_changed", "This sharing question expired or changed. Review sharing again."));
        }
        return Result.Success(true);
    }

    internal async Task<Result<string>> PinAsync(Guid workspaceId, Guid petId, PetPlanSourceScope scope,
        Guid turnId, CancellationToken cancellationToken)
    {
        var prepared = await PrepareAsync(workspaceId, petId, scope, cancellationToken, issueDecisionNonce: false).ConfigureAwait(false);
        if (prepared.IsFailure)
        {
            return Result.Failure<string>(prepared.Error);
        }

        if (prepared.Value is not null || turnId == Guid.Empty)
        {
            return Result.Failure<string>(ConsentRequired);
        }

        var described = await DescribeAsync(workspaceId, petId, scope, cancellationToken).ConfigureAwait(false);
        if (described.IsFailure)
        {
            return Result.Failure<string>(described.Error);
        }

        var consent = await store.FindAsync(WorkspaceId.From(workspaceId), petId, described.Value.ScopeDigest,
            described.Value.RecipientRevision, cancellationToken).ConfigureAwait(false);
        if (consent is not { RevokedAt: null } || consent.ExpiresAt <= clock.GetUtcNow())
        {
            return Result.Failure<string>(ConsentRequired);
        }

        var attestation = new PetSharingAttestation(Caller.TenantId.Value, Caller.PrincipalId.Value, workspaceId, petId,
            described.Value.Recipient.Provider, described.Value.SourceScope, described.Value.ScopeDigest,
            described.Value.RecipientRevision, turnId, clock.GetUtcNow().AddMinutes(10));
        return Result.Success(_protector.Protect(JsonSerializer.Serialize(attestation, PetPlanSharingJson.Default.PetSharingAttestation)));
    }

    internal async Task<Result<string>> PinOwnerTextAsync(Guid workspaceId, Guid petId, Guid turnId,
        CancellationToken cancellationToken)
    {
        var http = httpContext.HttpContext;
        if (http is null || turnId == Guid.Empty || await browser.VerifyAsync(http, requireOrigin: true).ConfigureAwait(false) is null)
        {
            return Result.Failure<string>(ConsentRequired);
        }
        var described = await DescribeAsync(workspaceId, petId, new("selected", []), cancellationToken).ConfigureAwait(false);
        if (described.IsFailure || described.Value.Recipient.ConnectionRevision == "unknown")
        {
            return Result.Failure<string>(described.IsFailure ? described.Error : ConsentRequired);
        }
        var attestation = new PetSharingAttestation(Caller.TenantId.Value, Caller.PrincipalId.Value, workspaceId, petId,
            described.Value.Recipient.Provider, described.Value.SourceScope, described.Value.ScopeDigest,
            described.Value.RecipientRevision, turnId, clock.GetUtcNow().AddMinutes(10), OwnerTextOnly: true);
        return Result.Success(_protector.Protect(JsonSerializer.Serialize(attestation, PetPlanSharingJson.Default.PetSharingAttestation)));
    }

    internal PetSharingAttestation? Unprotect(string? attestation)
    {
        if (attestation is not { Length: > 0 and <= 16384 })
        {
            return null;
        }

        try { return JsonSerializer.Deserialize(_protector.Unprotect(attestation), PetPlanSharingJson.Default.PetSharingAttestation); }
        catch (Exception error) when (error is CryptographicException or JsonException or FormatException) { return null; }
    }

    internal async Task<bool> ValidateAsync(string attestation, CancellationToken cancellationToken)
    {
        var bound = Unprotect(attestation);
        if (session.Current is null)
        {
            if (bound is null || bound.TenantId == Guid.Empty || bound.PrincipalId == Guid.Empty || bound.WorkspaceId == Guid.Empty)
            {
                return false;
            }
            return await isolated.RunAsync(new(TenantId.From(bound.TenantId), WorkspaceId.From(bound.WorkspaceId), PrincipalId.From(bound.PrincipalId)),
                async (services, token) => new IsolatedOutcome<bool>(await services.GetRequiredService<PetPlanSharingService>()
                    .ValidateAsync(attestation, token).ConfigureAwait(false), false), cancellationToken).ConfigureAwait(false);
        }
        if (bound is null || bound.ExpiresAt <= clock.GetUtcNow() || bound.TenantId != Caller.TenantId.Value
            || bound.PrincipalId != Caller.PrincipalId.Value
            || Caller.WorkspaceId is { } workspace && workspace.Value != bound.WorkspaceId
            || (await identities.FindPrincipalByIdAsync(Caller.TenantId, Caller.PrincipalId, cancellationToken).ConfigureAwait(false))?.Status != PrincipalStatus.Active)
        {
            return false;
        }

        var described = await DescribeAsync(bound.WorkspaceId, bound.PetId, bound.SourceScope, cancellationToken).ConfigureAwait(false);
        if (described.IsFailure || described.Value.ScopeDigest != bound.ScopeDigest || described.Value.RecipientRevision != bound.RecipientRevision)
        {
            return false;
        }

        if (bound.OwnerTextOnly)
        {
            return bound.SourceScope is { Kind: "selected" } && bound.SourceScope.ItemIds is not { Count: > 0 }
                && bound.SourceScope.ReadOnlyWorkspaceIds is not { Count: > 0 }
                && described.Value.Recipient.ConnectionRevision != "unknown";
        }

        var grant = await store.FindAsync(WorkspaceId.From(bound.WorkspaceId), bound.PetId, bound.ScopeDigest,
            bound.RecipientRevision, cancellationToken).ConfigureAwait(false);
        return grant is { RevokedAt: null } && grant.ExpiresAt > clock.GetUtcNow();
    }
}
