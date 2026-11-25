using System.Net;
using System.Net.Http.Headers;
using System.Net.Http.Json;
using System.Text;
using System.Text.Json;
using System.Text.Json.Serialization;
using Microsoft.AspNetCore.Http.HttpResults;
using Microsoft.AspNetCore.Mvc;
using Nix.Abstractions;
using Nix.Domain.Items;
using Nix.Domain.Primitives;
using Nix.Errors;
using Nix.Features.Exports;
using Nix.Messaging;

namespace Nix.Features.Items;

/// <summary>How much Markdown, and how large a request, the body routes accept.</summary>
/// <remarks>
/// <para>
/// 200,000 characters is the ceiling <c>nixctl</c>'s note-write tool publishes. The collaboration
/// service enforces the same number; the two have to move together.
/// </para>
/// <para>
/// The request bound is the collaboration service's HTTP body limit. A Markdown string of the
/// character ceiling fits inside it, including JSON escaping, and anything larger is refused
/// before it is parsed.
/// </para>
/// </remarks>
public static class ItemBodyLimits
{
    /// <summary>The most characters of Markdown one write accepts.</summary>
    public const int MarkdownCharacters = 200_000;

    /// <summary>The most bytes the replace and append requests accept.</summary>
    public const long RequestBytes = 2L * 1024 * 1024;
}

/// <summary>What one Markdown conversion could not carry, in the vocabulary <c>@nix/markdown</c> uses.</summary>
/// <param name="Kind">A stable loss kind, such as <c>underline-dropped</c>.</param>
/// <param name="Detail">The sentence a person should read. Not parsed.</param>
public sealed record ItemBodyLoss(string Kind, string Detail);

/// <summary>A note body rendered as Markdown.</summary>
/// <param name="Markdown">The body. Empty when nobody has edited the note yet.</param>
/// <param name="SchemaVersion">The document schema the body was written against.</param>
/// <param name="Empty">Whether the note has no blocks yet.</param>
/// <param name="Losses">What Markdown could not carry. Empty when nothing was dropped.</param>
public sealed record ItemBodyResponse(
    string Markdown,
    int SchemaVersion,
    bool Empty,
    IReadOnlyList<ItemBodyLoss> Losses)
{
    [JsonIgnore] internal ItemBodyRevision? Revision { get; init; }
}

internal sealed record ItemBodyRevision(Guid DocumentId, string HeadSeq);

/// <summary>
/// Counts of Markdown constructs that were kept as text rather than turned into Nix structure.
/// </summary>
/// <param name="UnresolvedWikiLinks">Wiki links left as literal text.</param>
/// <param name="UnresolvedObsidianEmbeds">Obsidian embeds left as literal text.</param>
/// <param name="UnresolvedLocalImages">Filesystem image paths left as text.</param>
/// <param name="UnsupportedImageAddresses">Image addresses Nix cannot display, left as text.</param>
/// <param name="InlineImagesFlattened">Inline images represented as links or text.</param>
public sealed record ItemBodyMarkdownChanges(
    int UnresolvedWikiLinks,
    int UnresolvedObsidianEmbeds,
    int UnresolvedLocalImages,
    int UnsupportedImageAddresses,
    int InlineImagesFlattened);

/// <summary>A body write that landed in the collaboration log.</summary>
/// <param name="Id">The item.</param>
/// <param name="Seq">The sequence number of the update, as a decimal string.</param>
/// <param name="UpdateBytes">How many bytes the Yjs update was.</param>
/// <param name="MarkdownChanges">What the Markdown import kept as text.</param>
public sealed record ItemBodyWriteResponse(
    Guid Id,
    string Seq,
    int UpdateBytes,
    ItemBodyMarkdownChanges MarkdownChanges);

/// <summary>The JSON body of a replace or append.</summary>
/// <param name="Markdown">The Markdown to apply. Null when the field was omitted.</param>
internal sealed record WriteItemBodyRequest(string? Markdown);

/// <summary>Reads one note body as Markdown.</summary>
/// <param name="ItemId">The item.</param>
/// <param name="AccessToken">
/// The caller's session JWT, forwarded to the collaboration service. Never logged.
/// </param>
public sealed record ReadItemBody(ItemId ItemId, string AccessToken) : IQuery<Result<ItemBodyResponse>>;

/// <summary>Replaces or appends a note body from Markdown.</summary>
/// <param name="ItemId">The item.</param>
/// <param name="Markdown">The Markdown to apply.</param>
/// <param name="Append">
/// <see langword="true"/> to add blocks at the end; <see langword="false"/> to replace the body.
/// </param>
/// <param name="AccessToken">
/// The caller's session JWT, forwarded to the collaboration service. Never logged.
/// </param>
public sealed record WriteItemBody(ItemId ItemId, string Markdown, bool Append, string AccessToken)
    : ICommand<ItemBodyWriteResponse>;

/// <summary>
/// Reads and writes a note body by asking the collaboration service to do it as the caller.
/// </summary>
/// <remarks>
/// <para>
/// Core does not write the content tables. The collaboration service is the only process that
/// can validate a Yjs update, and it is the process that tells open editors about one. This
/// client forwards the caller's own session, so the write is authorized by the same
/// <c>GetItemAuthorization</c> answer a socket and <c>nixctl</c> already use. The internal
/// secret is not sent: a secret that could name any item would be a second permission path.
/// </para>
/// <para>
/// Replace is the minimal diff <c>updateYFragment</c> produces. Append inserts blocks and does
/// not reserialise the rest of the note.
/// </para>
/// </remarks>
public sealed class ItemBodyClient(HttpClient http, IConfiguration configuration)
{
    private const int ReadResponseBytes = 12_000_000;
    private const int WriteResponseBytes = 64_000;
    private static readonly TimeSpan CallTimeout = TimeSpan.FromSeconds(30);

    // A typed client from DI already has this timeout. A hand-built client does not, and the
    // framework default is longer than a request should wait on the collaboration service.
    private readonly HttpClient _http = Prepare(http);
    private readonly IConfiguration _configuration = configuration
        ?? throw new ArgumentNullException(nameof(configuration));

    private static HttpClient Prepare(HttpClient client)
    {
        ArgumentNullException.ThrowIfNull(client);
        if (client.Timeout > CallTimeout)
        {
            client.Timeout = CallTimeout;
        }

        return client;
    }

    /// <summary>Reads the body.</summary>
    /// <param name="itemId">The item.</param>
    /// <param name="accessToken">The caller's session JWT.</param>
    /// <param name="cancellationToken">Cancels the read.</param>
    /// <returns>The Markdown, or why it could not be read.</returns>
    public Task<Result<ItemBodyResponse>> ReadAsync(
        Guid itemId,
        string accessToken,
        CancellationToken cancellationToken) =>
        SendAsync(
            HttpMethod.Get,
            itemId,
            content: null,
            accessToken,
            ReadResponseBytes,
            static (root, _) => ParseRead(root),
            cancellationToken);

    internal Task<Result<ItemBodyResponse>> ReadWithRevisionAsync(Guid itemId, string accessToken, CancellationToken cancellationToken) =>
        SendAsync(HttpMethod.Get, itemId, null, accessToken, ReadResponseBytes,
            static (root, _) => ParseRead(root), cancellationToken, includeRevision: true);

    /// <summary>Replaces or appends the body.</summary>
    /// <param name="itemId">The item.</param>
    /// <param name="markdown">The Markdown.</param>
    /// <param name="append">Whether to append instead of replace.</param>
    /// <param name="accessToken">The caller's session JWT.</param>
    /// <param name="cancellationToken">Cancels the write.</param>
    /// <returns>The update that landed, or why it did not.</returns>
    public async Task<Result<ItemBodyWriteResponse>> WriteAsync(
        Guid itemId,
        string markdown,
        bool append,
        string accessToken,
        CancellationToken cancellationToken)
    {
        return await WriteWithRevisionAsync(itemId, markdown, append, accessToken, revision: null, cancellationToken).ConfigureAwait(false);
    }

    internal async Task<Result<ItemBodyWriteResponse>> WriteWithRevisionAsync(
        Guid itemId, string markdown, bool append, string accessToken, ItemBodyRevision? revision,
        CancellationToken cancellationToken, ItemBodyPlanPermit? planPermit = null)
    {
        using var content = new StringContent(WritePayload(markdown, revision), Encoding.UTF8, "application/json");
        return await SendAsync(
            append ? HttpMethod.Post : HttpMethod.Put,
            itemId,
            content,
            accessToken,
            WriteResponseBytes,
            (root, id) => ParseWrite(id, root),
            cancellationToken, planPermit: planPermit).ConfigureAwait(false);
    }

    internal static string WritePayload(string markdown, ItemBodyRevision? revision) =>
        JsonSerializer.Serialize(new MarkdownPayload(markdown, revision?.DocumentId, revision?.HeadSeq), JsonSerializerOptions.Web);

    private async Task<Result<T>> SendAsync<T>(
        HttpMethod method,
        Guid itemId,
        HttpContent? content,
        string accessToken,
        int maxBytes,
        Func<JsonElement, Guid, Result<T>> parse,
        CancellationToken cancellationToken,
        bool includeRevision = false, ItemBodyPlanPermit? planPermit = null)
    {
        if (!ExportEndpoints.TryCollaborationBaseUri(_configuration, out var origin))
        {
            return Result.Failure<T>(ItemErrors.BodyUnavailable("The note body service is not configured."));
        }

        using var timeout = CancellationTokenSource.CreateLinkedTokenSource(cancellationToken);
        timeout.CancelAfter(TimeSpan.FromSeconds(30));
        using var request = new HttpRequestMessage(method, new Uri(origin, $"documents/{itemId:D}/markdown" + (includeRevision ? "?revision=true" : "")))
        {
            Content = content,
        };
        request.Headers.Authorization = new AuthenticationHeaderValue("Bearer", accessToken);
        request.Headers.Accept.Add(new MediaTypeWithQualityHeaderValue("application/json"));
        if (planPermit is not null)
        {
            request.Headers.Add("X-Nix-Pet-Plan-Request", planPermit.RequestId.ToString("D"));
            if (planPermit.Revisions.Length > 0)
            {
                request.Headers.Add("X-Nix-Pet-Item-Revisions", planPermit.Revisions);
            }
        }

        try
        {
            using var response = await _http
                .SendAsync(request, HttpCompletionOption.ResponseHeadersRead, timeout.Token)
                .ConfigureAwait(false);
            if (!response.IsSuccessStatusCode)
            {
                return Result.Failure<T>(await MapFailureAsync(response, timeout.Token).ConfigureAwait(false));
            }

            // One JSON document, bounded by the collaboration service's own document ceiling.
            // The buffer is that response, not a second copy of the Yjs log.
            await response.Content.LoadIntoBufferAsync(maxBytes, timeout.Token).ConfigureAwait(false);
            using var stream = await response.Content.ReadAsStreamAsync(timeout.Token).ConfigureAwait(false);
            using var document = await JsonDocument.ParseAsync(stream, cancellationToken: timeout.Token)
                .ConfigureAwait(false);
            return parse(document.RootElement, itemId);
        }
        catch (OperationCanceledException) when (!cancellationToken.IsCancellationRequested)
        {
            return Result.Failure<T>(ItemErrors.BodyUnavailable("The note body service timed out. Retry."));
        }
        catch (Exception exception) when (exception is HttpRequestException or JsonException or InvalidOperationException)
        {
            return Result.Failure<T>(ItemErrors.BodyUnavailable("The note body could not be reached. Retry."));
        }
    }

    private static async Task<NixError> MapFailureAsync(HttpResponseMessage response, CancellationToken cancellationToken)
    {
        string? code = null;
        string? detail = null;
        try
        {
            await response.Content.LoadIntoBufferAsync(8_192, cancellationToken).ConfigureAwait(false);
            using var stream = await response.Content.ReadAsStreamAsync(cancellationToken).ConfigureAwait(false);
            using var document = await JsonDocument.ParseAsync(stream, cancellationToken: cancellationToken)
                .ConfigureAwait(false);
            if (document.RootElement.TryGetProperty("code", out var codeProperty)
                && codeProperty.ValueKind == JsonValueKind.String)
            {
                code = codeProperty.GetString();
            }

            if (document.RootElement.TryGetProperty("detail", out var detailProperty)
                && detailProperty.ValueKind == JsonValueKind.String)
            {
                detail = detailProperty.GetString();
            }
        }
        catch (Exception exception) when (exception is JsonException or HttpRequestException or InvalidOperationException)
        {
            // A refusal with no problem document still has a status. The mapping below uses that.
        }

        var message = string.IsNullOrWhiteSpace(detail) ? null : detail;
        return code switch
        {
            "markdown_invalid" or "document_does_not_parse" or "update_unreadable" =>
                ItemErrors.MarkdownInvalid(message ?? "The Markdown does not make a valid note body."),
            "markdown_too_large" =>
                ItemErrors.MarkdownTooLarge(message ?? "The Markdown is too long."),
            "body_not_prose" =>
                ItemErrors.BodyNotProse(message ?? "Markdown cannot carry this item's body."),
            "read_only" =>
                ItemErrors.BodyReadOnly(message ?? "You may read this note but not change it."),
            "body_locked" =>
                ItemErrors.Locked(message ?? "Unlock the note before changing its body."),
            "document_not_found" =>
                ItemErrors.NotFound(message ?? "No item is visible."),
            "rate_limited" =>
                ItemErrors.BodyRateLimited(message ?? "Too many updates to this note. Retry shortly."),
            "update_too_large" or "document_too_large" or "document_too_many_nodes" =>
                ItemErrors.BodyTooLarge(message ?? "The note is too large to accept this change."),
            "schema_version_mismatch" or "document_above_schema_pin" or "document_changed" =>
                ItemErrors.BodyConflict(message ?? "The note body could not be updated. Retry."),
            _ when response.StatusCode == HttpStatusCode.NotFound =>
                ItemErrors.NotFound("No item is visible."),
            _ when response.StatusCode == HttpStatusCode.Forbidden =>
                ItemErrors.BodyReadOnly("You may read this note but not change it."),
            _ => ItemErrors.BodyUnavailable("The note body could not be updated. Retry."),
        };
    }

    private static Result<ItemBodyResponse> ParseRead(JsonElement root)
    {
        if (!root.TryGetProperty("markdown", out var markdown) || markdown.ValueKind != JsonValueKind.String
            || !root.TryGetProperty("schemaVersion", out var schema) || !schema.TryGetInt32(out var schemaVersion)
            || schemaVersion < 0
            || !root.TryGetProperty("empty", out var empty) || empty.ValueKind is not JsonValueKind.True and not JsonValueKind.False
            || !TryLosses(root, out var losses))
        {
            return Result.Failure<ItemBodyResponse>(
                ItemErrors.BodyUnavailable("The note body service returned an invalid response."));
        }

        ItemBodyRevision? revision = null;
        if (root.TryGetProperty("revision", out var revisionRow)
            && revisionRow.ValueKind == JsonValueKind.Object
            && revisionRow.TryGetProperty("documentId", out var documentId)
            && documentId.ValueKind == JsonValueKind.String && documentId.TryGetGuid(out var id)
            && revisionRow.TryGetProperty("headSeq", out var head)
            && head.ValueKind == JsonValueKind.String && head.GetString() is { Length: > 0 and <= 19 } sequence
            && sequence.All(char.IsAsciiDigit))
        {
            revision = new ItemBodyRevision(id, sequence);
        }
        return Result.Success(new ItemBodyResponse(markdown.GetString() ?? "", schemaVersion, empty.GetBoolean(), losses)
        {
            Revision = revision,
        });
    }

    private static Result<ItemBodyWriteResponse> ParseWrite(Guid itemId, JsonElement root)
    {
        if (!root.TryGetProperty("seq", out var seq) || seq.ValueKind != JsonValueKind.String
            || seq.GetString() is not { Length: > 0 and <= 40 } sequence
            || !sequence.All(static character => char.IsAsciiDigit(character))
            || !root.TryGetProperty("updateBytes", out var bytes) || !bytes.TryGetInt32(out var updateBytes)
            || updateBytes < 0
            || !TryChanges(root, out var changes))
        {
            return Result.Failure<ItemBodyWriteResponse>(
                ItemErrors.BodyUnavailable("The note body service returned an invalid response."));
        }

        return Result.Success(new ItemBodyWriteResponse(itemId, sequence, updateBytes, changes));
    }

    private static bool TryLosses(JsonElement root, out IReadOnlyList<ItemBodyLoss> losses)
    {
        losses = [];
        if (!root.TryGetProperty("losses", out var array) || array.ValueKind != JsonValueKind.Array
            || array.GetArrayLength() > 100)
        {
            return false;
        }

        var parsed = new List<ItemBodyLoss>(array.GetArrayLength());
        foreach (var loss in array.EnumerateArray())
        {
            if (!loss.TryGetProperty("kind", out var kind) || kind.ValueKind != JsonValueKind.String
                || !loss.TryGetProperty("detail", out var detail) || detail.ValueKind != JsonValueKind.String
                || kind.GetString() is not { Length: > 0 } kindText
                || detail.GetString() is not { Length: > 0 } detailText)
            {
                return false;
            }

            parsed.Add(new ItemBodyLoss(kindText, detailText));
        }

        losses = parsed;
        return true;
    }

    private static bool TryChanges(JsonElement root, out ItemBodyMarkdownChanges changes)
    {
        changes = new ItemBodyMarkdownChanges(0, 0, 0, 0, 0);
        if (!root.TryGetProperty("markdownChanges", out var value) || value.ValueKind != JsonValueKind.Object)
        {
            return false;
        }

        if (!Count(value, "unresolvedWikiLinks", out var wiki)
            || !Count(value, "unresolvedObsidianEmbeds", out var embeds)
            || !Count(value, "unresolvedLocalImages", out var local)
            || !Count(value, "unsupportedImageAddresses", out var unsupported)
            || !Count(value, "inlineImagesFlattened", out var inline))
        {
            return false;
        }

        changes = new ItemBodyMarkdownChanges(wiki, embeds, local, unsupported, inline);
        return true;
    }

    private static bool Count(JsonElement value, string name, out int count)
    {
        count = 0;
        return value.TryGetProperty(name, out var property)
            && property.TryGetInt32(out count)
            && count >= 0;
    }

    private sealed record MarkdownPayload(
        string Markdown,
        [property: JsonIgnore(Condition = JsonIgnoreCondition.WhenWritingNull)] Guid? ExpectedDocumentId,
        [property: JsonIgnore(Condition = JsonIgnoreCondition.WhenWritingNull)] string? ExpectedHeadSeq);
}

internal sealed record ItemBodyPlanPermit(Guid RequestId, string Revisions);

/// <summary>Reads and writes note bodies for the item routes.</summary>
public sealed class ItemBodyHandlers(
    IVisibleItems visible,
    IPermissionResolver permissions,
    INixSessionContextAccessor session,
    ItemBodyClient bodies) : IQueryHandler<ReadItemBody, Result<ItemBodyResponse>>,
    ICommandHandler<WriteItemBody, ItemBodyWriteResponse>
{
    /// <summary>Reads the body after the same visibility and lock checks as opening it.</summary>
    /// <param name="query">The item, and the session to forward.</param>
    /// <param name="cancellationToken">Cancels the read.</param>
    /// <returns>The Markdown, or why it is not available.</returns>
    public async ValueTask<Result<ItemBodyResponse>> HandleAsync(
        ReadItemBody query,
        CancellationToken cancellationToken)
    {
        ArgumentNullException.ThrowIfNull(query);
        var authorized = await AuthorizeAsync(query.ItemId, write: false, cancellationToken).ConfigureAwait(false);
        if (authorized.IsFailure)
        {
            return Result.Failure<ItemBodyResponse>(authorized.Error);
        }

        return await bodies.ReadAsync(query.ItemId.Value, query.AccessToken, cancellationToken).ConfigureAwait(false);
    }

    /// <summary>Replaces or appends the body after the caller is allowed to write it.</summary>
    /// <param name="command">The item, the Markdown, and the session to forward.</param>
    /// <param name="cancellationToken">Cancels the write.</param>
    /// <returns>The update that landed, or why it did not.</returns>
    public async ValueTask<Result<ItemBodyWriteResponse>> HandleAsync(
        WriteItemBody command,
        CancellationToken cancellationToken)
    {
        ArgumentNullException.ThrowIfNull(command);
        if (command.Markdown.Length > ItemBodyLimits.MarkdownCharacters)
        {
            return Result.Failure<ItemBodyWriteResponse>(ItemErrors.MarkdownTooLarge(
                $"Markdown may be at most {ItemBodyLimits.MarkdownCharacters} characters."));
        }

        if (command.Append && string.IsNullOrWhiteSpace(command.Markdown))
        {
            return Result.Failure<ItemBodyWriteResponse>(
                ItemErrors.MarkdownInvalid("Append Markdown that is not empty."));
        }

        var authorized = await AuthorizeAsync(command.ItemId, write: true, cancellationToken).ConfigureAwait(false);
        if (authorized.IsFailure)
        {
            return Result.Failure<ItemBodyWriteResponse>(authorized.Error);
        }

        return await bodies
            .WriteAsync(command.ItemId.Value, command.Markdown, command.Append, command.AccessToken, cancellationToken)
            .ConfigureAwait(false);
    }

    private async ValueTask<Result<Item>> AuthorizeAsync(
        ItemId itemId,
        bool write,
        CancellationToken cancellationToken)
    {
        _ = session.Current ?? throw new InvalidOperationException("No session context; the pipeline must establish one.");

        // "Locked" is said only after the read check, matching the collaboration authorization: an
        // item the caller cannot see is not found, and "locked" is reserved for somebody who could open it.
        var lookup = await visible.FindAsync(
            itemId, ItemAccess.Read, cancellationToken, lockedDetail: $"The body of item {itemId} is locked.").ConfigureAwait(false);
        if (lookup.IsFailure)
        {
            return Result.Failure<Item>(lookup.Error);
        }

        var item = lookup.Value;

        if (!IsProse(item.Type))
        {
            return Result.Failure<Item>(ItemErrors.BodyNotProse(
                $"This item is a {item.Type}, which Markdown cannot carry."));
        }

        if (write && !await permissions.CanWriteWorkspaceAsync(item.WorkspaceId, cancellationToken).ConfigureAwait(false))
        {
            return Result.Failure<Item>(ItemErrors.BodyReadOnly("You may read this note but not change it."));
        }

        return Result.Success(item);
    }

    /// <summary>
    /// Whether Markdown can carry this body kind. Canvas and spreadsheet are the kinds the
    /// collaboration service dispatches away from prose; every other kind, including one this
    /// build has not heard of, is prose.
    /// </summary>
    private static bool IsProse(string type) =>
        !string.Equals(type, "canvas", StringComparison.Ordinal)
        && !string.Equals(type, "spreadsheet", StringComparison.Ordinal);
}

/// <summary>Route handler for reading a note body.</summary>
internal static class ReadItemBodyEndpoint
{
    /// <summary>Handles a request to read a note body as Markdown.</summary>
    /// <param name="itemId">The item.</param>
    /// <param name="httpContext">The current request.</param>
    /// <param name="dispatcher">Sends the query to its handler.</param>
    /// <returns>The Markdown, or a problem describing why it is not available.</returns>
    internal static async Task<Results<Ok<ItemBodyResponse>, ProblemHttpResult>> Handle(
        Guid itemId,
        HttpContext httpContext,
        [FromServices] NixDispatcher dispatcher)
    {
        var token = Bearer(httpContext);
        if (token is null)
        {
            return TypedResults.Problem(ApiProblem.Create(
                httpContext,
                StatusCodes.Status401Unauthorized,
                "auth.unauthenticated",
                "Not authenticated",
                "This endpoint requires a bearer token."));
        }

        var result = await dispatcher
            .QueryAsync<ReadItemBody, Result<ItemBodyResponse>>(
                new ReadItemBody(ItemId.From(itemId), token),
                httpContext.RequestAborted)
            .ConfigureAwait(false);
        return result.IsFailure
            ? TypedResults.Problem(ItemEndpoints.Problem(httpContext, result.Error))
            : TypedResults.Ok(result.Value);
    }

    internal static string? Bearer(HttpContext httpContext)
    {
        const string prefix = "Bearer ";
        var header = httpContext.Request.Headers.Authorization.ToString();
        if (!header.StartsWith(prefix, StringComparison.OrdinalIgnoreCase))
        {
            return null;
        }

        var token = header[prefix.Length..].Trim();
        return token.Length == 0 ? null : token;
    }
}

/// <summary>Route handler for replacing a note body.</summary>
internal static class ReplaceItemBodyEndpoint
{
    /// <summary>Handles a request to replace a note body.</summary>
    /// <param name="itemId">The item.</param>
    /// <param name="request">The Markdown.</param>
    /// <param name="httpContext">The current request.</param>
    /// <param name="dispatcher">Sends the command to its handler.</param>
    /// <returns>The update that landed, or a problem describing why it did not.</returns>
    internal static Task<Results<Ok<ItemBodyWriteResponse>, ProblemHttpResult>> Handle(
        Guid itemId,
        WriteItemBodyRequest? request,
        HttpContext httpContext,
        [FromServices] NixDispatcher dispatcher) =>
        WriteItemBodyEndpoint.Handle(itemId, request, append: false, httpContext, dispatcher);
}

/// <summary>Route handler for appending to a note body.</summary>
internal static class AppendItemBodyEndpoint
{
    /// <summary>Handles a request to append Markdown to a note body.</summary>
    /// <param name="itemId">The item.</param>
    /// <param name="request">The Markdown.</param>
    /// <param name="httpContext">The current request.</param>
    /// <param name="dispatcher">Sends the command to its handler.</param>
    /// <returns>The update that landed, or a problem describing why it did not.</returns>
    internal static Task<Results<Ok<ItemBodyWriteResponse>, ProblemHttpResult>> Handle(
        Guid itemId,
        WriteItemBodyRequest? request,
        HttpContext httpContext,
        [FromServices] NixDispatcher dispatcher) =>
        WriteItemBodyEndpoint.Handle(itemId, request, append: true, httpContext, dispatcher);
}

/// <summary>Shared replace and append route.</summary>
internal static class WriteItemBodyEndpoint
{
    /// <summary>Handles a replace or an append.</summary>
    /// <param name="itemId">The item.</param>
    /// <param name="request">The Markdown.</param>
    /// <param name="append">Whether to append.</param>
    /// <param name="httpContext">The current request.</param>
    /// <param name="dispatcher">Sends the command to its handler.</param>
    /// <returns>The update that landed, or a problem describing why it did not.</returns>
    internal static async Task<Results<Ok<ItemBodyWriteResponse>, ProblemHttpResult>> Handle(
        Guid itemId,
        WriteItemBodyRequest? request,
        bool append,
        HttpContext httpContext,
        NixDispatcher dispatcher)
    {
        if (request?.Markdown is null)
        {
            return TypedResults.Problem(ItemEndpoints.Problem(
                httpContext,
                ItemErrors.MarkdownInvalid("Expected { markdown: string }.")));
        }

        var token = ReadItemBodyEndpoint.Bearer(httpContext);
        if (token is null)
        {
            return TypedResults.Problem(ApiProblem.Create(
                httpContext,
                StatusCodes.Status401Unauthorized,
                "auth.unauthenticated",
                "Not authenticated",
                "This endpoint requires a bearer token."));
        }

        var result = await dispatcher
            .SendAsync<WriteItemBody, ItemBodyWriteResponse>(
                new WriteItemBody(ItemId.From(itemId), request.Markdown, append, token),
                httpContext.RequestAborted)
            .ConfigureAwait(false);
        return result.IsFailure
            ? TypedResults.Problem(ItemEndpoints.Problem(httpContext, result.Error))
            : TypedResults.Ok(result.Value);
    }
}
