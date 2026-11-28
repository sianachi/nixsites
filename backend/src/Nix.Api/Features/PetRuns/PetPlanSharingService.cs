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
using Nix.Features.Pets;
using Nix.Messaging;

namespace Nix.Features.PetRuns;

[SuppressMessage("Performance", "CA1812", Justification = "Created by dependency injection.")]
internal sealed class PetPlanSharingService(INixSessionContextAccessor session,
    NixDispatcher dispatcher, IPermissionResolver permissions, IPetProviderCredentialStore credentials,
    IDataProtectionProvider protection, TimeProvider clock, IIsolatedUnitOfWork isolated, IIdentityDirectory identities)
{
    private readonly IDataProtector _protector = protection.CreateProtector("Nix.PetDisclosure.v1");
    private NixSessionContext Caller => session.Current ?? throw new InvalidOperationException("An owner transaction is required.");
    private static NixError NoKey => new("pets.no_provider_key", PetWorkerClient.NoKeyMessage);

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

    internal async Task<Result<PetPlanDisclosure>> DescribeAsync(Guid workspaceId, Guid petId,
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
            return Result.Failure<PetPlanDisclosure>(new("pets.invalid_scope", "Choose readable sources in a workspace."));
        }
        foreach (var sourceWorkspace in scope.ReadOnlyWorkspaceIds ?? [])
        {
            if (!await permissions.CanReadWorkspaceAsync(WorkspaceId.From(sourceWorkspace), cancellationToken).ConfigureAwait(false))
            {
                return Result.Failure<PetPlanDisclosure>(new("pets.invalid_scope", "A selected source workspace is unavailable."));
            }
        }

        var settings = await dispatcher.QueryAsync<GetPetSettings, PetSettingsResponse>(new(), cancellationToken).ConfigureAwait(false);
        var pet = settings.Settings.Profiles.FirstOrDefault(value => value.Id == petId);
        if (pet is null)
        {
            return Result.Failure<PetPlanDisclosure>(new("pets.invalid_request", "Choose a saved pet."));
        }

        var provider = pet.Provider;
        var credential = await credentials.FindAsync(Caller.TenantId, Caller.PrincipalId, provider, cancellationToken).ConfigureAwait(false);
        var revision = credential is null ? "unknown" : Hash(string.Join('\n', "credential-v1", Caller.TenantId.Value,
            Caller.PrincipalId.Value, provider, credential.SavedAt.ToUniversalTime().ToString("O", CultureInfo.InvariantCulture)));

        var destination = provider switch
        {
            PetProviders.Anthropic => "https://api.anthropic.com",
            PetProviders.OpenRouter => "https://openrouter.ai/api/v1",
            _ => "unknown",
        };
        var routing = provider == PetProviders.OpenRouter ? "openrouter-provider-routing" : "direct";
        var recipient = new PetPlanRecipientDescriptor(provider, destination, routing, revision);
        var normalized = scope with
        {
            ItemIds = (scope.ItemIds ?? []).Distinct().Order().ToArray(),
            ReadOnlyWorkspaceIds = (scope.ReadOnlyWorkspaceIds ?? []).Distinct().Order().ToArray()
        };
        return Result.Success(new PetPlanDisclosure(ScopeDigest(workspaceId, petId, normalized), RecipientRevision(recipient), normalized, recipient));
    }

    internal async Task<Result<string>> PinAsync(Guid workspaceId, Guid petId, PetPlanSourceScope scope,
        Guid turnId, CancellationToken cancellationToken)
    {
        var described = await DescribeAsync(workspaceId, petId, scope, cancellationToken).ConfigureAwait(false);
        if (described.IsFailure || turnId == Guid.Empty || described.Value.Recipient.ConnectionRevision == "unknown")
        {
            return Result.Failure<string>(described.IsFailure ? described.Error : NoKey);
        }

        var attestation = new PetSharingAttestation(Caller.TenantId.Value, Caller.PrincipalId.Value, workspaceId, petId,
            described.Value.Recipient.Provider, described.Value.SourceScope, described.Value.ScopeDigest,
            described.Value.RecipientRevision, turnId, clock.GetUtcNow().AddMinutes(10));
        return Result.Success(_protector.Protect(JsonSerializer.Serialize(attestation, PetPlanSharingJson.Default.PetSharingAttestation)));
    }

    internal async Task<Result<string>> PinOwnerTextAsync(Guid workspaceId, Guid petId, Guid turnId,
        CancellationToken cancellationToken)
    {
        if (turnId == Guid.Empty)
        {
            return Result.Failure<string>(new("pets.invalid_request", "A turn id is required."));
        }
        var described = await DescribeAsync(workspaceId, petId, new("selected", []), cancellationToken).ConfigureAwait(false);
        if (described.IsFailure || described.Value.Recipient.ConnectionRevision == "unknown")
        {
            return Result.Failure<string>(described.IsFailure ? described.Error : NoKey);
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

        return described.Value.Recipient.ConnectionRevision != "unknown"
            && (!bound.OwnerTextOnly || bound.SourceScope is { Kind: "selected" } && bound.SourceScope.ItemIds is not { Count: > 0 }
                && bound.SourceScope.ReadOnlyWorkspaceIds is not { Count: > 0 });
    }
}
