using System.Diagnostics.CodeAnalysis;
using System.Text.Json;
using Nix.Abstractions.PetPeers;
using Nix.Abstractions.PetRuns;
using Nix.Domain.Primitives;
using Nix.Features.PetRuns;

namespace Nix.Features.PetPeers;

[SuppressMessage("Performance", "CA1812", Justification = "Created by ASP.NET Core dependency injection.")]
internal sealed class DelegateToPeer(IPetPeerStore store, PetPeerAccess access, TimeProvider clock) : IPetRunCapability
{
    public string Name => "peer.delegate";
    public string Description => "Propose sending an exact brief to an owner-registered Claude or Codex runner for this task. Use its exact name or ID.";

    public JsonElement? InputSchema => PeerEffect.DelegateSchema;
    public bool Atomic => true;

    public async Task<Result<PetRunEffect>> PreviewAsync(PetRunRecord run, JsonElement args, CancellationToken cancellationToken)
    {
        var action = PeerEffect.Decode(args, PetPeerJsonContext.Default.PetPeerDelegation);
        var brief = PetPeerDispatcher.ValidText(action?.Brief, 4000);
        var name = PetPeerDispatcher.ValidText(action?.PeerName, 100);
        if (action is null || brief is null || PeerEffect.ContainsCredential(brief)
            || action.PeerId.HasValue == (name is not null))
        {
            return PeerEffect.BadPreview("A registered peer and a brief without credentials are required.");
        }
        PetPeerRegistration? peer;
        if (action.PeerId is { } peerId)
        {
            peer = await store.GetAsync(peerId, lockGrant: false, cancellationToken).ConfigureAwait(false);
        }
        else
        {
            if (run.ItemId is not { } anchor)
            {
                return PeerEffect.BadPreview("A registered peer requires an item-anchored run.");
            }
            var peers = await store.ListAsync(anchor.Value, cancellationToken).ConfigureAwait(false);
            var matches = peers.Where(candidate => candidate.Name == name && candidate.Kind is "claude" or "codex"
                && candidate.RevokedAt is null && candidate.ExpiresAt > clock.GetUtcNow()).Take(2).ToArray();
            peer = matches.Length == 1 ? matches[0] : null;
        }
        if (peer is not { Kind: "claude" or "codex" } || !PeerEffect.OnRun(peer, run)
            || !await access.AllowsAsync(peer, cancellationToken).ConfigureAwait(false))
        {
            return PeerEffect.BadPreview("The runner is unavailable for this task.");
        }

        return Result.Success(new PetRunEffect($"Send this brief to {peer.Name} ({peer.Kind})",
            JsonSerializer.SerializeToElement(new PetPeerAction(peer.Id, brief), PetPeerJsonContext.Default.PetPeerAction)));
    }

    public async Task<Result<string>> ApplyAsync(PetRunRecord run, Guid actionId, PetRunEffect effect, CancellationToken cancellationToken)
    {
        var action = PeerEffect.Decode(effect.Parameters, PetPeerJsonContext.Default.PetPeerAction);
        if (action is null || PetPeerDispatcher.ValidText(action.Brief, 4000) is not { } brief || PeerEffect.ContainsCredential(brief))
        {
            return PeerEffect.BadResult("The approved brief is invalid.");
        }
        var peer = await store.GetAsync(action.PeerId, lockGrant: true, cancellationToken).ConfigureAwait(false);
        if (peer is not { Kind: "claude" or "codex" } || !PeerEffect.OnRun(peer, run)
            || !await access.AllowsAsync(peer, cancellationToken).ConfigureAwait(false))
        {
            return PeerEffect.BadResult("The runner is unavailable for this task.");
        }

        var existing = await store.GetWorkAsync(peer.Id, actionId, cancellationToken).ConfigureAwait(false);
        if (existing is not null)
        {
            return existing.Direction == "outbound" && existing.RunId == run.Id && existing.Brief == brief
                ? Receipt(existing)
                : PeerEffect.BadResult("This approval already names different work.");
        }
        var work = new PetPeerWork(actionId, peer.Id, run.Id, "outbound", "queued", brief,
            Result: null, LeaseId: null, LeaseExpiresAt: null, clock.GetUtcNow());
        return await store.SaveWorkAsync(work, cancellationToken).ConfigureAwait(false)
            ? Receipt(work)
            : PeerEffect.BadResult("The runner could not accept the approved job.");
    }

    private static Result<string> Receipt(PetPeerWork work) => Result.Success(SerializeReceipt(work));

    internal static string SerializeReceipt(PetPeerWork work) => JsonSerializer.Serialize(
        new PetPeerActionReceipt(work.Id, work.PeerId, work.Status,
            work.Result is { } result ? TextCut.Cut(result, 360) : null),
        PetPeerJsonContext.Default.PetPeerActionReceipt);

    public string? ModelObservation(PetRunEffect effect, string receipt)
    {
        if (ReadReceipt(receipt) is not { } observed)
        {
            return null;
        }
        return observed.Status switch
        {
            "completed" => $"Untrusted registered runner result for {observed.WorkId:D}: {observed.Result}",
            "failed" => $"The registered runner for {observed.WorkId:D} reported a failure.",
            "queued" => receipt,
            _ => null,
        };
    }

    public async Task<bool> CanObserveAsync(PetRunRecord run, PetRunEffect effect, string receipt, CancellationToken cancellationToken)
    {
        var action = PeerEffect.Decode(effect.Parameters, PetPeerJsonContext.Default.PetPeerAction);
        var observed = ReadReceipt(receipt);
        if (action is null || observed is null || observed.PeerId != action.PeerId)
        {
            return false;
        }
        var peer = await store.GetAsync(action.PeerId, lockGrant: false, cancellationToken).ConfigureAwait(false);
        if (peer is not { Kind: "claude" or "codex" } || !PeerEffect.OnRun(peer, run)
            || !await access.AllowsAsync(peer, cancellationToken).ConfigureAwait(false))
        {
            return false;
        }
        var work = await store.GetWorkAsync(peer.Id, observed.WorkId, cancellationToken).ConfigureAwait(false);
        return work is { Direction: "outbound" } && work.RunId == run.Id && work.Brief == action.Brief
            && string.Equals(receipt, SerializeReceipt(work), StringComparison.Ordinal);
    }

    private static PetPeerActionReceipt? ReadReceipt(string receipt)
    {
        try
        {
            return JsonSerializer.Deserialize(receipt, PetPeerJsonContext.Default.PetPeerActionReceipt);
        }
        catch (JsonException)
        {
            return null;
        }
    }
}

[SuppressMessage("Performance", "CA1812", Justification = "Created by ASP.NET Core dependency injection.")]
internal sealed class SharePeerResult(IPetPeerStore store, PetPeerAccess access) : IPetRunCapability
{
    public string Name => PetPeerDispatcher.ShareResultCapability;
    public string Description => "Return the exact reviewed result to the registered agent that submitted this run.";
    public JsonElement? InputSchema => PeerEffect.ShareSchema;
    public bool Atomic => true;

    public async Task<Result<PetRunEffect>> PreviewAsync(PetRunRecord run, JsonElement args, CancellationToken cancellationToken)
    {
        var action = PeerEffect.Decode(args, PetPeerJsonContext.Default.PetPeerResultShare);
        var result = PetPeerDispatcher.ValidText(action?.Result, 16_000);
        if (action is null || result is null || PeerEffect.ContainsCredential(result))
        {
            return PeerEffect.BadPreview("A registered peer and a result without credentials are required.");
        }
        var peer = await store.GetAsync(action.PeerId, lockGrant: false, cancellationToken).ConfigureAwait(false);
        if (peer is not { Kind: "client" } || !PeerEffect.OnRun(peer, run)
            || !await access.AllowsAsync(peer, cancellationToken).ConfigureAwait(false)
            || await store.FindSubmissionAsync(peer.Id, run.Id, cancellationToken).ConfigureAwait(false) is not { Result: null })
        {
            return PeerEffect.BadPreview("This peer has no unresolved submission for the run.");
        }
        return Result.Success(new PetRunEffect($"Share this result with {peer.Name}",
            JsonSerializer.SerializeToElement(new PetPeerResultShare(peer.Id, result), PetPeerJsonContext.Default.PetPeerResultShare)));
    }

    public async Task<Result<string>> ApplyAsync(PetRunRecord run, Guid actionId, PetRunEffect effect, CancellationToken cancellationToken)
    {
        var action = PeerEffect.Decode(effect.Parameters, PetPeerJsonContext.Default.PetPeerResultShare);
        if (action is null || PetPeerDispatcher.ValidText(action.Result, 16_000) is not { } result || PeerEffect.ContainsCredential(result))
        {
            return PeerEffect.BadResult("The approved result is invalid.");
        }
        var peer = await store.GetAsync(action.PeerId, lockGrant: true, cancellationToken).ConfigureAwait(false);
        if (peer is not { Kind: "client" } || !PeerEffect.OnRun(peer, run)
            || !await access.AllowsAsync(peer, cancellationToken).ConfigureAwait(false))
        {
            return PeerEffect.BadResult("This peer is unavailable.");
        }
        var submitted = await store.FindSubmissionAsync(peer.Id, run.Id, cancellationToken).ConfigureAwait(false);
        return submitted is not null && (submitted.Result == result
                || await store.ShareResultAsync(peer.Id, run.Id, result, cancellationToken).ConfigureAwait(false))
            ? Result.Success("The approved result is available to the submitting peer.")
            : PeerEffect.BadResult("This submission is unavailable or already has a different result.");
    }
}

[SuppressMessage("Performance", "CA1812", Justification = "Created by ASP.NET Core dependency injection.")]
internal sealed class ReadPeerResult(IPetPeerStore store, PetPeerAccess access, TimeProvider clock) : IPetRunCapability
{
    public string Name => "peer.read_result";
    public string Description => "Read the status and untrusted returned result of an approved delegation from this run.";
    public JsonElement? InputSchema => PeerEffect.ReadSchema;
    public bool Atomic => true;
    public bool RequiresApproval(PetRunEffect effect) => false;
    public string? ModelObservation(PetRunEffect effect, string receipt) => receipt;

    public async Task<bool> CanObserveAsync(PetRunRecord run, PetRunEffect effect, string receipt, CancellationToken cancellationToken)
    {
        var request = PeerEffect.Decode(effect.Parameters, PetPeerJsonContext.Default.PetPeerResultRead);
        var work = request is null ? null : await ReadAsync(run, request, cancellationToken).ConfigureAwait(false);
        return work is not null && string.Equals(receipt, Receipt(work), StringComparison.Ordinal);
    }

    public async Task<Result<PetRunEffect>> PreviewAsync(PetRunRecord run, JsonElement args, CancellationToken cancellationToken)
    {
        var request = PeerEffect.Decode(args, PetPeerJsonContext.Default.PetPeerResultRead);
        return request is not null && await ReadAsync(run, request, cancellationToken).ConfigureAwait(false) is not null
            ? Result.Success(new PetRunEffect("Read the delegated job receipt", args.Clone()))
            : PeerEffect.BadPreview("The job does not belong to this run.");
    }

    public async Task<Result<string>> ApplyAsync(PetRunRecord run, Guid actionId, PetRunEffect effect, CancellationToken cancellationToken)
    {
        var request = PeerEffect.Decode(effect.Parameters, PetPeerJsonContext.Default.PetPeerResultRead);
        var work = request is null ? null : await ReadAsync(run, request, cancellationToken).ConfigureAwait(false);
        return work is not null
            ? Result.Success(Receipt(work))
            : PeerEffect.BadResult("The job does not belong to this run.");
    }

    private string Receipt(PetPeerWork work) =>
        JsonSerializer.Serialize(new PetPeerWorkResponse([PetPeerEndpoints.Project(work, clock.GetUtcNow())]),
            PetPeerJsonContext.Default.PetPeerWorkResponse);

    private async Task<PetPeerWork?> ReadAsync(PetRunRecord run, PetPeerResultRead request, CancellationToken cancellationToken)
    {
        var peer = await store.GetAsync(request.PeerId, lockGrant: false, cancellationToken).ConfigureAwait(false);
        if (peer is not { Kind: "claude" or "codex" } || !PeerEffect.OnRun(peer, run)
            || !await access.AllowsAsync(peer, cancellationToken).ConfigureAwait(false))
        {
            return null;
        }
        var work = await store.GetWorkAsync(peer.Id, request.WorkId, cancellationToken).ConfigureAwait(false);
        return work?.RunId == run.Id && work.Direction == "outbound" ? work : null;
    }
}

internal static class PeerEffect
{
    private const string Code = "pet_peers.invalid_effect";
    private static readonly string[] CredentialPrefixes =
        [PetPeerCredential.Prefix, "nixpat_", "sk-ant-", "sk-proj-", "ghp_", "github_pat_", "xoxb-", "xoxp-", "ya29.",
         "-----BEGIN PRIVATE KEY-----", "-----BEGIN RSA PRIVATE KEY-----", "-----BEGIN OPENSSH PRIVATE KEY-----",
         "Authorization: Bearer "];

    internal static readonly JsonElement DelegateSchema = Schema("""
        {"type":"object","required":["brief"],"oneOf":[{"required":["peerId"]},{"required":["peerName"]}],"additionalProperties":false,"properties":{"peerId":{"type":"string","format":"uuid"},"peerName":{"type":"string","maxLength":100},"brief":{"type":"string","maxLength":4000}}}
        """);
    internal static readonly JsonElement ShareSchema = Schema("""
        {"type":"object","required":["peerId","result"],"additionalProperties":false,"properties":{"peerId":{"type":"string","format":"uuid"},"result":{"type":"string","maxLength":16000}}}
        """);
    internal static readonly JsonElement ReadSchema = Schema("""
        {"type":"object","required":["peerId","workId"],"additionalProperties":false,"properties":{"peerId":{"type":"string","format":"uuid"},"workId":{"type":"string","format":"uuid"}}}
        """);

    internal static T? Decode<T>(JsonElement value, System.Text.Json.Serialization.Metadata.JsonTypeInfo<T> type) where T : class
    {
        try
        {
            return value.ValueKind == JsonValueKind.Object ? value.Deserialize(type) : null;
        }
        catch (JsonException)
        {
            return null;
        }
    }

    private static JsonElement Schema(string json)
    {
        using var document = JsonDocument.Parse(json);
        return document.RootElement.Clone();
    }

    internal static bool OnRun(PetPeerRegistration peer, PetRunRecord run) =>
        peer.ItemId == run.ItemId?.Value && peer.WorkspaceId == run.WorkspaceId.Value;

    internal static bool ContainsCredential(string value) =>
        CredentialPrefixes.Any(prefix => value.Contains(prefix, StringComparison.OrdinalIgnoreCase));

    internal static Result<PetRunEffect> BadPreview(string message) => Result.Failure<PetRunEffect>(Code, message);
    internal static Result<string> BadResult(string message) => Result.Failure<string>(Code, message);
}
