using System.Globalization;
using System.Security.Cryptography;
using System.Text;
using Microsoft.AspNetCore.Http.Features;
using Nix.Abstractions;
using Nix.Domain.Items;
using Nix.Domain.Tenancy;

namespace Nix.Authentication;

/// <summary>Fences a Core-issued pet action credential to the exact approved HTTP request.</summary>
public static class PetActionRequestBinding
{
    public const int MaximumBodyBytes = 128 * 1024;

    internal const string RevisionsHeader = "X-Nix-Pet-Item-Revisions";
    internal const int MaximumRevisionsLength = 4_000;

    /// <summary>Builds the binding for an escaped request target and the exact UTF-8 body.</summary>
    public static string Create(string method, string requestTarget, string? body, string itemRevisions = "")
    {
        ArgumentException.ThrowIfNullOrWhiteSpace(method);
        ArgumentException.ThrowIfNullOrWhiteSpace(requestTarget);
        if (Encoding.UTF8.GetByteCount(body ?? string.Empty) > MaximumBodyBytes)
        {
            throw new ArgumentException("The action body exceeds its size limit.", nameof(body));
        }

        return FromBodyHash(method, requestTarget, itemRevisions, SHA256.HashData(Encoding.UTF8.GetBytes(body ?? string.Empty)));
    }

    /// <summary>Checks the exact request and leaves its bounded body readable by the endpoint.</summary>
    public static async Task<bool> MatchesAsync(HttpRequest request, string binding, CancellationToken cancellationToken)
    {
        ArgumentNullException.ThrowIfNull(request);
        ArgumentNullException.ThrowIfNull(binding);
        var revisions = request.Headers[RevisionsHeader].ToString();
        if (!IsDigest(binding) || request.ContentLength > MaximumBodyBytes || revisions.Length > MaximumRevisionsLength)
        {
            return false;
        }

        var target = request.HttpContext.Features.Get<IHttpRequestFeature>()?.RawTarget;
        if (string.IsNullOrEmpty(target))
        {
            target = request.PathBase.ToUriComponent() + request.Path.ToUriComponent() + request.QueryString.ToUriComponent();
        }

        request.EnableBuffering(bufferThreshold: MaximumBodyBytes, bufferLimit: MaximumBodyBytes);
        var initialPosition = request.Body.Position;
        try
        {
            var bodyHash = await SHA256.HashDataAsync(request.Body, cancellationToken).ConfigureAwait(false);
            return string.Equals(binding, FromBodyHash(request.Method, target, revisions, bodyHash), StringComparison.Ordinal);
        }
        catch (IOException)
        {
            return false;
        }
        finally
        {
            request.Body.Position = initialPosition;
        }
    }

    internal static bool IsDigest(string value) => value.Length == 64 && value.All(Uri.IsHexDigit);

    internal static bool TryReadPlanRequest(string value, out Guid runId, out Guid requestId)
    {
        runId = default;
        requestId = default;
        return value.Length == 65 && value[32] == '.' && Guid.TryParseExact(value.AsSpan(0, 32), "N", out runId)
            && Guid.TryParseExact(value.AsSpan(33), "N", out requestId) && runId != Guid.Empty && requestId != Guid.Empty;
    }

    internal static async Task<bool> RevisionsMatchAsync(HttpContext context, CancellationToken cancellationToken)
    {
        var revisions = context.Request.Headers[RevisionsHeader].ToString();
        if (revisions.Length == 0)
        {
            return true;
        }

        var tree = context.RequestServices.GetRequiredService<IItemTree>();
        var locks = context.RequestServices.GetRequiredService<IItemLocks>();
        var split = revisions.IndexOf('|', StringComparison.Ordinal);
        if (split < 0 || !Guid.TryParseExact(revisions.AsSpan(0, split), "D", out var rawWorkspaceId))
        {
            return false;
        }
        var workspaceId = WorkspaceId.From(rawWorkspaceId);
        var topology = context.RequestServices.GetRequiredService<IStructuralLock>();
        await topology.AcquireWorkspaceTopologyAsync(workspaceId, cancellationToken).ConfigureAwait(false);
        var workspaceLocks = context.RequestServices.GetRequiredService<IWorkspaceLocks>();
        if ((await workspaceLocks.GetStateAsync(workspaceId, cancellationToken).ConfigureAwait(false)).PasswordProtected)
        {
            return false;
        }
        foreach (var value in revisions[(split + 1)..].Split(','))
        {
            var separator = value.IndexOf(':', StringComparison.Ordinal);
            if (separator < 0
                || !Guid.TryParseExact(value.AsSpan(0, separator), "D", out var rawItemId)
                || !long.TryParse(value.AsSpan(separator + 1), NumberStyles.None, CultureInfo.InvariantCulture, out var expected))
            {
                return false;
            }
            var itemId = ItemId.From(rawItemId);
            var pinned = await tree.ReadPetRevisionAsync(workspaceId, itemId, pin: true, cancellationToken).ConfigureAwait(false);
            var item = await tree.FindStoredAsync(itemId, cancellationToken).ConfigureAwait(false);
            if (pinned != expected || item is null || ItemSettings.Read(item.Settings).WithholdFromPets
                || (await locks.GetStateAsync(itemId, cancellationToken).ConfigureAwait(false)).Locked)
            {
                return false;
            }
        }
        return true;
    }

    private static string FromBodyHash(string method, string target, string revisions, ReadOnlySpan<byte> bodyHash)
    {
        // A raw request target contains no newline. Separators keep each component unambiguous.
        return Convert.ToHexString(SHA256.HashData(Encoding.UTF8.GetBytes(
            method + "\n" + target + "\n" + revisions + "\n" + Convert.ToHexString(bodyHash))));
    }
}
