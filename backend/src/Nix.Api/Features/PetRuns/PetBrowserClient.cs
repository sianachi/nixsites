using System.Diagnostics.CodeAnalysis;
using System.Net.Http.Json;
using System.Security.Cryptography;
using System.Text.Json;
using System.Text.Json.Serialization;
using Microsoft.AspNetCore.DataProtection;
using Nix.Abstractions;
using Nix.Abstractions.Connections;
using Nix.Abstractions.Files;
using Nix.Abstractions.PetRuns;
using Nix.Domain.Files;
using Nix.Domain.Items;
using Nix.Domain.Primitives;
using Nix.Persistence.ObjectStorage;

namespace Nix.Features.PetRuns;

internal static class PetBrowserServiceCollectionExtensions
{
    internal static void AddPetBrowser(this IServiceCollection services)
    {
        services.AddHttpClient<PetBrowserClient>(static client =>
        {
            client.Timeout = TimeSpan.FromSeconds(45);
            client.MaxResponseContentBufferSize = 128 * 1024;
        }).ConfigurePrimaryHttpMessageHandler(static () => new HttpClientHandler
        {
            AllowAutoRedirect = false,
            UseCookies = false,
        });
        services.AddScoped<IPetRunCapability, PetBrowserSearch>();
        services.AddScoped<IPetRunCapability, PetBrowserBrowse>();
        services.AddScoped<IPetRunCapability, PetBrowserSubmitForm>();
    }
}

[SuppressMessage("Performance", "CA1812", Justification = "Created by the typed HTTP client factory.")]
internal sealed class PetBrowserClient(
    HttpClient http, IConfiguration settings, IConnectorStore connections, IDataProtectionProvider protection,
    IFileStore files, IItemLocks locks, IItemTree items, S3CapabilitySigner signer)
{
    internal const string SiteSessionPurpose = "Nix.PetBrowser.SiteSession.v1";
    private readonly IDataProtector _session = protection.CreateProtector(SiteSessionPurpose);

    internal async Task<Result<BrowserVisit>> VisitAsync(
        PetRunRecord run, BrowserBrowseInput input, CancellationToken cancellationToken)
    {
        if (!TryWebUri(input.Url, out var target))
        {
            return Result.Failure<BrowserVisit>(PetBrowserErrors.Invalid());
        }
        var id = input.ConnectionId;
        if (id is null && input.UseSiteSession)
        {
            var site = target.GetLeftPart(UriPartial.Authority);
            var grants = await connections.ListAsync(run.WorkspaceId, cancellationToken).ConfigureAwait(false);
            id = grants.SingleOrDefault(grant => grant.Provider == "browser-site" && grant.ResourceId == site)?.Id;
            if (id is null)
            {
                return Result.Failure<BrowserVisit>(PetBrowserErrors.Connection());
            }
        }
        if (id is null)
        {
            return Result.Success(new BrowserVisit(target.AbsoluteUri, null, null));
        }

        var grant = await connections.GetAsync(run.WorkspaceId, id.Value, false, cancellationToken).ConfigureAwait(false);
        if (!Usable(grant, target, "browser.browse"))
        {
            return Result.Failure<BrowserVisit>(PetBrowserErrors.Connection());
        }
        return Result.Success(new BrowserVisit(target.AbsoluteUri, id, grant!.Revision));
    }

    internal async Task<Result<BrowserSiteSession?>> SessionAsync(
        PetRunRecord run, BrowserVisit visit, string action, CancellationToken cancellationToken)
    {
        if (!TryWebUri(visit.Url, out var target))
        {
            return Result.Failure<BrowserSiteSession?>(PetBrowserErrors.Invalid());
        }
        if (visit.ConnectionId is not { } id)
        {
            return visit.ConnectionRevision is null
                ? Result.Success<BrowserSiteSession?>(null)
                : Result.Failure<BrowserSiteSession?>(PetBrowserErrors.Connection());
        }
        if (id == Guid.Empty || visit.ConnectionRevision is not { } revision || revision == Guid.Empty)
        {
            return Result.Failure<BrowserSiteSession?>(PetBrowserErrors.Connection());
        }

        var grant = await connections.GetAsync(run.WorkspaceId, id, false, cancellationToken).ConfigureAwait(false);
        if (!Usable(grant, target, action) || grant.Id != id || grant.WorkspaceId != run.WorkspaceId
            || grant.Revision != revision)
        {
            return Result.Failure<BrowserSiteSession?>(PetBrowserErrors.Connection());
        }
        try
        {
            var session = JsonSerializer.Deserialize(_session.Unprotect(grant.ProtectedTokens!),
                PetBrowserJson.Default.BrowserSiteSession);
            return session?.Origin == grant.ResourceId
                ? Result.Success<BrowserSiteSession?>(session)
                : Result.Failure<BrowserSiteSession?>(PetBrowserErrors.Connection());
        }
        catch (Exception error) when (error is CryptographicException or JsonException)
        {
            return Result.Failure<BrowserSiteSession?>(PetBrowserErrors.Connection());
        }
    }

    internal async Task<Result<IReadOnlyList<BrowserFile>>> AttachmentsAsync(
        PetRunRecord run, IReadOnlyList<BrowserAttachmentInput> inputs, CancellationToken cancellationToken)
    {
        if (inputs.Count > 4 || (inputs.Count > 0 && !signer.IsConfigured)
            || inputs.Any(input => input is null || input.FileId == Guid.Empty || !ValidField(input.Field))
            || inputs.Select(input => input.Field).Distinct(StringComparer.Ordinal).Count() != inputs.Count)
        {
            return Result.Failure<IReadOnlyList<BrowserFile>>(PetBrowserErrors.Attachments());
        }

        var itemIds = inputs.Select(input => ItemId.From(input.FileId)).ToArray();
        if (inputs.Any(input => input.FileId != run.ItemId?.Value && !run.SourceItemIds.Contains(input.FileId)
                && run.ReadOnlySourceItemIds?.Contains(input.FileId) != true)
            || (itemIds.Length != 0 && (await locks.LockedAmongAsync(itemIds, cancellationToken).ConfigureAwait(false)).Count != 0))
        {
            return Result.Failure<IReadOnlyList<BrowserFile>>(PetBrowserErrors.Attachments());
        }

        var result = new List<BrowserFile>(inputs.Count);
        long size = 0;
        foreach (var input in inputs)
        {
            var item = await items.FindAsync(ItemId.From(input.FileId), cancellationToken).ConfigureAwait(false);
            if (item?.WorkspaceId != run.WorkspaceId || item.LifecycleState != ItemLifecycleState.Active
                || ItemSettings.Read(item.Settings).WithholdFromPets)
            {
                return Result.Failure<IReadOnlyList<BrowserFile>>(PetBrowserErrors.Attachments());
            }

            var file = await files.AuthorizeDownloadAsync(ItemId.From(input.FileId),
                input.VersionId is { } id ? FileVersionId.From(id) : null, cancellationToken).ConfigureAwait(false);
            if (file is null || file.WorkspaceId != run.WorkspaceId.Value
                || file.VersionId is not { } version || file.State == FileVersionStates.Revoked
                || file.ByteLength is <= 0 or > 4 * 1024 * 1024
                || file.Sha256.Length != 64 || !file.Sha256.All(Uri.IsHexDigit))
            {
                return Result.Failure<IReadOnlyList<BrowserFile>>(PetBrowserErrors.Attachments());
            }

            size += file.ByteLength;
            if (size > 4 * 1024 * 1024 || file.FileName.Length is < 1 or > 180
                || file.FileName.Any(character => char.IsControl(character) || character is '/' or '\\' or '"'))
            {
                return Result.Failure<IReadOnlyList<BrowserFile>>(PetBrowserErrors.Attachments());
            }

            var metadata = new BrowserAttachment(input.Field!, file.FileName, "application/octet-stream",
                file.ByteLength, Convert.ToHexStringLower(Convert.FromHexString(file.Sha256)));
            result.Add(new BrowserFile(input with { VersionId = version }, metadata, file.ObjectKey));
        }
        return Result.Success<IReadOnlyList<BrowserFile>>(result);
    }

    internal BrowserAttachmentGrant Grant(BrowserFile file) => new(file.Metadata.Field, file.Metadata.Filename,
        file.Metadata.ContentType, file.Metadata.Size, file.Metadata.Sha256, signer.Get(file.ObjectKey).Url.AbsoluteUri);

    internal async Task<Result<JsonElement>> SendAsync(BrowserWorkerCommand command, CancellationToken cancellationToken)
    {
        var configuredUrl = settings["Nix:PetBrowser:Url"];
        var secret = settings["Nix:PetBrowser:InternalSecret"];
        if (!Uri.TryCreate(configuredUrl, UriKind.Absolute, out var origin) || origin.Scheme is not ("http" or "https")
            || origin.AbsolutePath != "/" || origin.Query.Length != 0 || origin.Fragment.Length != 0
            || origin.UserInfo.Length != 0 || string.IsNullOrWhiteSpace(secret))
        {
            return Result.Failure<JsonElement>(PetBrowserErrors.Unavailable());
        }

        using var request = new HttpRequestMessage(HttpMethod.Post, new Uri(origin, "/v1/browser"));
        request.Headers.Add("X-Nix-Internal-Secret", secret);
        request.Content = JsonContent.Create(command, PetBrowserJson.Default.BrowserWorkerCommand);
        try
        {
            using var response = await http.SendAsync(request, cancellationToken).ConfigureAwait(false);
            var result = await response.Content.ReadFromJsonAsync(PetBrowserJson.Default.JsonElement,
                cancellationToken).ConfigureAwait(false);
            if (result.ValueKind != JsonValueKind.Object)
            {
                return FailedDispatch(command.Operation);
            }
            if (response.IsSuccessStatusCode)
            {
                return Result.Success(result);
            }

            if (command.Operation == "submit" &&
                (!result.TryGetProperty("dispatched", out var dispatched) || dispatched.ValueKind != JsonValueKind.False))
            {
                return FailedDispatch(command.Operation);
            }
            var code = result.TryGetProperty("code", out var reason) && reason.ValueKind == JsonValueKind.String
                ? reason.GetString() : null;
            return Result.Failure<JsonElement>(code switch
            {
                "website_form_changed" or "website_form_needs_takeover" or "website_form_missing"
                    => PetBrowserErrors.Stale(),
                "attachment_changed" or "attachment_grant_invalid" or "attachment_unavailable"
                    => PetBrowserErrors.Attachments(),
                "website_egress_blocked" or "attachment_egress_blocked" or "website_response_contains_secret"
                    => PetBrowserErrors.Screened(),
                "website_destination_blocked" or "website_origin_changed" => PetBrowserErrors.Invalid(),
                _ => PetBrowserErrors.Unavailable(),
            });
        }
        catch (Exception error) when (error is HttpRequestException or JsonException or OperationCanceledException)
        {
            return FailedDispatch(command.Operation);
        }
    }

    internal static bool TryWebUri(string? raw, [NotNullWhen(true)] out Uri? target)
    {
        if (raw is { Length: > 0 and <= 2048 } && Uri.TryCreate(raw, UriKind.Absolute, out target)
            && target.Scheme is "http" or "https" && target.UserInfo.Length == 0 && target.IsDefaultPort
            && target.Fragment.Length == 0 && !target.IsLoopback)
        {
            return true;
        }

        target = null;
        return false;
    }

    internal static bool ValidField(string? name) => name is { Length: > 0 and <= 128 }
        && !string.IsNullOrWhiteSpace(name) && !name.Any(char.IsControl);

    private static bool Usable([NotNullWhen(true)] ConnectorGrant? grant, Uri target, string action) =>
        grant is { Provider: "browser-site", ResourceKind: "origin", ProtectedTokens: not null }
        && target.Scheme == "https" && target.GetLeftPart(UriPartial.Authority) == grant.ResourceId
        && grant.Actions.Contains(action, StringComparer.Ordinal);

    private static Result<JsonElement> FailedDispatch(string operation) => Result.Failure<JsonElement>(
        operation == "submit" ? PetBrowserErrors.Unknown() : PetBrowserErrors.Unavailable());
}

internal static class PetBrowserErrors
{
    internal static NixError Invalid() => new("browser.invalid", "Choose a valid public web address or a supported field on a reviewed form.");
    internal static NixError Screened() => new("browser.invalid", "The browser stopped a credential disclosure or could not screen the attachment.");
    internal static NixError Connection() => new("browser.connection_changed", "The website connection changed or cannot perform this action.");
    internal static NixError Unavailable() => new("browser.unavailable", "The browser could not read this website.");
    internal static NixError Stale() => new("browser.form_changed", "The website form changed or needs you to take over.");
    internal static NixError Attachments() => new("browser.attachments_changed", "Choose a current file version from this run's selected sources.");
    internal static NixError Unknown() => new("browser.unknown_outcome", "The website may have accepted the submission. Check the site before trying again.");
}

internal sealed record BrowserSearchInput(string? Query);
internal sealed record BrowserBrowseInput(string? Url, Guid? ConnectionId, bool UseSiteSession);
internal sealed record BrowserVisit(string Url, Guid? ConnectionId, Guid? ConnectionRevision);
internal sealed record BrowserBrowseReceipt(Guid ActionId, BrowserVisit Visit, JsonElement Page);
internal sealed record BrowserField(string Name, string Value);
internal sealed record BrowserAttachmentInput(string? Field, Guid FileId, Guid? VersionId);
internal sealed record BrowserAttachment(string Field, string Filename, string ContentType, long Size, string Sha256);
internal sealed record BrowserAttachmentGrant(string Field, string Filename, string ContentType, long Size, string Sha256, string Source);
internal sealed record BrowserFile(BrowserAttachmentInput Input, BrowserAttachment Metadata, string ObjectKey);
internal sealed record BrowserFormInput(Guid BrowseActionId, int FormIndex, BrowserField[]? Fields, BrowserAttachmentInput[]? Attachments);
internal sealed record BrowserFormDescriptor(int Index, bool Supported, string? Target, string? Enctype, string? Revision, BrowserControl[]? Fields);
internal sealed record BrowserControl(string Name, string Kind, bool Required, string[]? Options);
internal sealed record BrowserFormProposal(string PageUrl, string Target, string Method, int FormIndex, BrowserField[] Fields,
    BrowserAttachment[] Attachments, string Revision);
internal sealed record BrowserSubmission(BrowserVisit Visit, BrowserFormProposal Proposal, BrowserAttachmentInput[] Sources);
internal sealed record BrowserSiteSession(string Origin, BrowserSiteCookie[] Cookies);
internal sealed record BrowserSiteCookie(string Name, string Value, string Path);
internal sealed record BrowserWorkerCommand(string Operation, string? Url = null, string? Query = null,
    BrowserSiteSession? Session = null, Guid? ActionId = null, BrowserFormProposal? Proposal = null,
    BrowserAttachmentGrant[]? Attachments = null);

[JsonSourceGenerationOptions(JsonSerializerDefaults.Web, DefaultIgnoreCondition = JsonIgnoreCondition.WhenWritingNull)]
[JsonSerializable(typeof(BrowserSearchInput))]
[JsonSerializable(typeof(BrowserBrowseInput))]
[JsonSerializable(typeof(BrowserVisit))]
[JsonSerializable(typeof(BrowserBrowseReceipt))]
[JsonSerializable(typeof(BrowserFormInput))]
[JsonSerializable(typeof(BrowserFormDescriptor[]))]
[JsonSerializable(typeof(BrowserSubmission))]
[JsonSerializable(typeof(BrowserSiteSession))]
[JsonSerializable(typeof(BrowserWorkerCommand))]
[JsonSerializable(typeof(JsonElement))]
[JsonSerializable(typeof(SavePetBrowserSiteRequest))]
internal sealed partial class PetBrowserJson : JsonSerializerContext;
