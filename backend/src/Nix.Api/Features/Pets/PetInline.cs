using System.Buffers;
using System.Diagnostics;
using System.Text;
using Microsoft.AspNetCore.Http.Features;
using Microsoft.AspNetCore.Http.HttpResults;
using Microsoft.AspNetCore.Mvc;
using Microsoft.Extensions.Logging;
using Nix.Abstractions;
using Nix.Domain.Items;
using Nix.Domain.Primitives;
using Nix.Errors;
using Nix.Features.Items;
using Nix.Messaging;

namespace Nix.Features.Pets;

/// <summary>Bounds on one inline writing request, in UTF-8 bytes, matching the worker's own limits.</summary>
internal static class PetInlineLimits
{
    /// <summary>The person's own instruction.</summary>
    internal const int InstructionBytes = 2_000;

    /// <summary>The selected material.</summary>
    internal const int SelectionBytes = 16_000;

    /// <summary>The text around the selection.</summary>
    internal const int ContextBytes = 32_000;

    /// <summary>The target language name.</summary>
    internal const int LanguageBytes = 64;

    /// <summary>The model identifier.</summary>
    internal const int ModelBytes = 160;

    /// <summary>
    /// The most worker output copied to the browser. The worker caps the text at 24,000 bytes, so
    /// this is that plus framing with room to spare; past it the response is ended.
    /// </summary>
    internal const int StreamBytes = 64 * 1024;

    /// <summary>The longest one stream may stay open, just above the worker's own 120 seconds.</summary>
    internal static readonly TimeSpan StreamDeadline = TimeSpan.FromSeconds(130);

    /// <summary>Open inline streams one person may hold in this process.</summary>
    internal const int OpenStreamsPerPrincipal = 2;

    /// <summary>The closed set of operations the worker understands.</summary>
    internal static bool IsKind(string? kind) =>
        kind is "continue" or "summarise" or "improve" or "fix" or "translate" or "action_items" or "custom";
}

/// <summary>
/// Caps how many inline streams one principal holds open at once, in this process only.
/// </summary>
/// <remarks>
/// Each open stream pins a database connection and transaction (the unit of work stays open for
/// the whole response) and a model turn, so the cap is what bounds both. It lives in memory and
/// is therefore per Core process, not per deployment: with several Core replicas a person can hold
/// that many on each. The worker enforces its own cap per account, which is the cap that holds
/// across replicas; this one exists so the common case is refused before a connection is pinned.
/// </remarks>
public sealed class PetInlineLimiter
{
    private readonly object _gate = new();
    private readonly Dictionary<Guid, int> _open = [];

    /// <summary>Takes a slot for the principal, or returns null when they already hold the maximum.</summary>
    /// <param name="principal">The principal asking.</param>
    /// <returns>A lease that returns the slot when disposed, or <see langword="null"/>.</returns>
    public IDisposable? TryAcquire(Guid principal)
    {
        lock (_gate)
        {
            _ = _open.TryGetValue(principal, out var held);
            if (held >= PetInlineLimits.OpenStreamsPerPrincipal)
            {
                return null;
            }

            _open[principal] = held + 1;
        }

        return new PetInlineLease(this, principal);
    }

    private void Release(Guid principal)
    {
        lock (_gate)
        {
            if (_open.TryGetValue(principal, out var held) && held > 1)
            {
                _open[principal] = held - 1;
            }
            else
            {
                _ = _open.Remove(principal);
            }
        }
    }

    /// <summary>One held slot; disposing it more than once returns it once.</summary>
    /// <param name="owner">The limiter the slot came from.</param>
    /// <param name="principal">The principal holding it.</param>
    internal sealed class PetInlineLease(PetInlineLimiter owner, Guid principal) : IDisposable
    {
        private int _released;

        public void Dispose()
        {
            if (Interlocked.Exchange(ref _released, 1) == 0)
            {
                owner.Release(principal);
            }
        }
    }
}

/// <summary>Checks the shape and bounds of an inline request before anything else happens.</summary>
public static class PetInlineValidation
{
    private static readonly UTF8Encoding Strict = new(false, true);

    /// <summary>The first problem with the request, as a detail naming the field, or null when it is well formed.</summary>
    public static string? Check(PetInlineRequest? request)
    {
        if (request is null)
        {
            return "A request body is required.";
        }

        if (request.WorkspaceId == Guid.Empty || request.ItemId == Guid.Empty || request.RequestId == Guid.Empty)
        {
            return "workspaceId, itemId and requestId must be identifiers.";
        }

        if (!PetInlineLimits.IsKind(request.Kind))
        {
            return "kind must be one of continue, summarise, improve, fix, translate, action_items, custom.";
        }

        foreach (var (name, value, limit) in new (string, string?, int)[]
        {
            ("instruction", request.Instruction, PetInlineLimits.InstructionBytes),
            ("selection", request.Selection, PetInlineLimits.SelectionBytes),
            ("context", request.Context, PetInlineLimits.ContextBytes),
            ("language", request.Language, PetInlineLimits.LanguageBytes),
            ("model", request.Model, PetInlineLimits.ModelBytes),
        })
        {
            if (value is null)
            {
                continue;
            }

            int bytes;
            try
            {
                bytes = Strict.GetByteCount(value);
            }
            catch (EncoderFallbackException)
            {
                return $"{name} must be valid text.";
            }

            if (bytes > limit)
            {
                return $"{name} is too long: at most {limit} bytes of UTF-8 are allowed and it is {bytes}.";
            }
        }

        if (request.Kind == "custom" && string.IsNullOrWhiteSpace(request.Instruction))
        {
            return "instruction is required for a custom request.";
        }

        if (request.Kind is not ("continue" or "custom") && string.IsNullOrWhiteSpace(request.Selection))
        {
            return "selection is required for this kind of request.";
        }

        if (request.Kind == "translate" && !IsLanguageName(request.Language))
        {
            return "language is required for translate and may hold only letters, spaces, hyphens, apostrophes and parentheses.";
        }

        return null;
    }

    private static bool IsLanguageName(string? value)
    {
        if (string.IsNullOrWhiteSpace(value))
        {
            return false;
        }

        foreach (var rune in value.EnumerateRunes())
        {
            if (!Rune.IsLetter(rune) && rune.Value is not (' ' or '-' or '\'' or '(' or ')'))
            {
                return false;
            }
        }

        return true;
    }
}

/// <summary>The inline writing endpoint: gates the request, then streams the worker's answer through.</summary>
/// <remarks>
/// <para>
/// <b>What this endpoint does not do.</b> It does not load the item's body. The text to work on
/// comes from the client, taken from the editor where the person can already read it. The gates
/// establish that this person may read that item, in that workspace, and that it is not locked;
/// they do not, and cannot, establish that <c>selection</c> and <c>context</c> were really taken
/// from <c>itemId</c>. A caller who can read one note and is permitted to use inline writing could
/// send text from somewhere else under that note's identity. That text is whatever they already
/// hold, sent to the provider they chose to connect and enabled this feature for, so nothing they
/// could not otherwise disclose leaves Core; the residual risk is a mislabelled request, not
/// access to anyone's content.
/// </para>
/// <para>
/// <b>Locked notes are refused outright.</b> A locked note's text must never be sent to a model
/// provider, so an item that is locked, or sits under a locked ancestor, is refused whether or not
/// this credential currently holds the lock open. That is the rule the graph and search apply to
/// answers derived from bodies (ADR-0056): an unlock lets a person read, it does not license
/// copying the text to a third party. The predicate is <see cref="IItemLocks.LockedAmongAsync"/>,
/// the same item-or-ancestor test the calendar and automations use, which ignores grants.
/// </para>
/// <para>
/// <b>Permission.</b> The item is read through <see cref="GetItem"/>, which looks it up through the
/// visibility-filtered item tree and then asks the permission resolver about its workspace, so an
/// invisible or unreadable item is simply not found. An item outside the stated workspace is
/// reported the same way, never as forbidden.
/// </para>
/// <para>
/// <b>Concurrency.</b> At most two streams per principal are open at once in this process
/// (<see cref="PetInlineLimiter"/>); the worker enforces its own cap per account.
/// </para>
/// <para>
/// <b>Cost.</b> Like the watch endpoint, the unit of work holds a Postgres connection and
/// transaction open for the whole stream, up to 130 seconds. The per-principal cap is what bounds
/// the connections one person can pin.
/// </para>
/// </remarks>
internal static class PetInlineEndpoint
{
    internal static async Task<IResult> Handle(
        PetInlineRequest request,
        HttpContext context,
        [FromServices] NixDispatcher dispatcher,
        [FromServices] IItemLocks locks,
        [FromServices] PetInlineLimiter limiter,
        [FromServices] PetWorkerClient worker,
        [FromServices] INixSessionContextAccessor session,
        [FromServices] ILogger<PetWorkerClient> log)
    {
        ArgumentNullException.ThrowIfNull(context);
        context.Response.Headers.CacheControl = "no-store";
        var aborted = context.RequestAborted;

        // (a) Shape and bounds, before any lookup.
        if (PetInlineValidation.Check(request) is { } invalid)
        {
            return Refuse(context, StatusCodes.Status422UnprocessableEntity, "pets.invalid_request", "Inline writing request is not valid", invalid);
        }

        // (b) The person opted in, twice: pets on, and inline writing on.
        var settings = (await dispatcher.QueryAsync<GetPetSettings, PetSettingsResponse>(new(), aborted).ConfigureAwait(false)).Settings;
        if (!settings.Enabled || !settings.InlineWriting || settings.ActivePetId is not { } petId)
        {
            return Refuse(context, StatusCodes.Status409Conflict, "pets.inline_disabled", "Inline writing is turned off",
                "Turn on the companion and inline writing in settings first.");
        }

        var pet = settings.Profiles.FirstOrDefault(profile => profile.Id == petId);
        if (pet is null)
        {
            return Refuse(context, StatusCodes.Status409Conflict, "pets.inline_disabled", "Inline writing is turned off",
                "Choose a saved pet in settings first.");
        }

        // (c) The caller can read the item, and it is in the workspace they named.
        var item = await dispatcher.QueryAsync<GetItem, Result<Item>>(new(new ItemId(request.ItemId)), aborted).ConfigureAwait(false);
        if (item.IsFailure || item.Value.WorkspaceId.Value != request.WorkspaceId)
        {
            return Refuse(context, StatusCodes.Status404NotFound, "pets.not_found", "Item not found", "The item is unavailable.");
        }

        // (d) Never a locked note, whoever holds it open.
        if ((await locks.LockedAmongAsync([item.Value.Id], aborted).ConfigureAwait(false)).Contains(item.Value.Id))
        {
            return Refuse(context, StatusCodes.Status409Conflict, "pets.inline_item_locked", "Item is locked",
                "A locked note's text is never sent to a model provider, even while it is unlocked for you.");
        }

        // (e) Per-principal cap, taken last so a refused request never holds a slot.
        var principal = (session.Current ?? throw new InvalidOperationException("A session is required.")).PrincipalId.Value;
        // The slot and the deadline belong to this method until the stream result takes them over;
        // the result then releases both when the stream ends, however it ends.
        var started = Stopwatch.GetTimestamp();
        IDisposable? lease = null;
        CancellationTokenSource? deadline = null;
        try
        {
            lease = limiter.TryAcquire(principal);
            if (lease is null)
            {
                return Refuse(context, StatusCodes.Status429TooManyRequests, "pets.inline_busy", "Too many writing requests",
                    "Two writing requests are already open. Wait for one to finish.");
            }

            deadline = CancellationTokenSource.CreateLinkedTokenSource(aborted);
            deadline.CancelAfter(PetInlineLimits.StreamDeadline);
            var opened = await worker.OpenInlineAsync(request, pet, deadline.Token).ConfigureAwait(false);
            if (opened.IsFailure)
            {
                var status = opened.Error.Code switch
                {
                    "pets.invalid_request" => StatusCodes.Status422UnprocessableEntity,
                    "pets.inline_busy" => StatusCodes.Status429TooManyRequests,
                    _ => StatusCodes.Status503ServiceUnavailable,
                };
                return Refuse(context, status, opened.Error.Code, "Inline writing request failed", opened.Error.Message);
            }

            var result = new PetStreamResult(opened.Value, lease, deadline, PetInlineLimits.StreamBytes, (outcome, copied, status) =>
            {
                if (log.IsEnabled(LogLevel.Information))
                {
                    ApiLog.PetInlineEnded(log, request.RequestId, request.Kind, outcome, Encoding.UTF8.GetByteCount(request.Selection ?? string.Empty),
                        copied, status, (long)Stopwatch.GetElapsedTime(started).TotalMilliseconds);
                }
            });
            lease = null;
            deadline = null;
            return result;
        }
        catch (OperationCanceledException) when (!aborted.IsCancellationRequested)
        {
            ApiLog.PetWorkerFailed(log, "inline", "deadline reached before the stream opened", "pets.unavailable");
            return Refuse(context, StatusCodes.Status503ServiceUnavailable, "pets.unavailable", "Inline writing request failed",
                "The companion did not answer in time.");
        }
        finally
        {
            deadline?.Dispose();
            lease?.Dispose();
        }
    }

    private static ProblemHttpResult Refuse(HttpContext context, int status, string code, string title, string detail) =>
        TypedResults.Problem(ApiProblem.Create(context, status, code, title, detail));
}

/// <summary>Copies the worker's event stream (inline writing or a chat watch) to the response as it arrives and cleans up after it.</summary>
/// <remarks>
/// The worker's framing is the contract, so bytes are copied without being parsed or re-encoded,
/// and flushed after every read so each event reaches the browser when the worker sends it.
/// Disposing the worker response on every path is what cancels the model's turn when the browser
/// goes away: the browser's disconnect cancels <c>RequestAborted</c>, which cancels the linked
/// token the worker request was sent with.
/// </remarks>
internal sealed class PetStreamResult(HttpResponseMessage response, IDisposable? lease, CancellationTokenSource deadline,
    long byteCap, Action<string, long, int> ended) : IResult
{
    public async Task ExecuteAsync(HttpContext httpContext)
    {
        ArgumentNullException.ThrowIfNull(httpContext);
        var outcome = "complete";
        long copied = 0;
        var buffer = ArrayPool<byte>.Shared.Rent(4096);
        try
        {
            httpContext.Response.StatusCode = StatusCodes.Status200OK;
            httpContext.Response.ContentType = "text/event-stream";
            httpContext.Response.Headers.CacheControl = "no-store";
            httpContext.Response.Headers["X-Accel-Buffering"] = "no";
            httpContext.Features.Get<IHttpResponseBodyFeature>()?.DisableBuffering();

            var token = deadline.Token;
            var upstream = await response.Content.ReadAsStreamAsync(token).ConfigureAwait(false);
            await using (upstream.ConfigureAwait(false))
            {
                int read;
                while ((read = await upstream.ReadAsync(buffer.AsMemory(), token).ConfigureAwait(false)) > 0)
                {
                    if (copied + read > byteCap)
                    {
                        outcome = "capped";
                        break;
                    }

                    await httpContext.Response.Body.WriteAsync(buffer.AsMemory(0, read), token).ConfigureAwait(false);
                    await httpContext.Response.Body.FlushAsync(token).ConfigureAwait(false);
                    copied += read;
                }
            }
        }
        catch (OperationCanceledException)
        {
            outcome = httpContext.RequestAborted.IsCancellationRequested ? "client_aborted" : "deadline";
        }
        catch (Exception exception) when (exception is HttpRequestException or IOException)
        {
            outcome = httpContext.RequestAborted.IsCancellationRequested ? "client_aborted" : "upstream_error";
        }
        finally
        {
            ArrayPool<byte>.Shared.Return(buffer);
            response.Dispose();
            deadline.Dispose();
            lease?.Dispose();
            ended(outcome, copied, httpContext.Response.StatusCode);
        }
    }
}
