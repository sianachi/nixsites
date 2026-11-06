using System.Diagnostics;
using Microsoft.AspNetCore.Mvc;
using Microsoft.Extensions.DependencyInjection;
using Microsoft.Extensions.Logging;
using Nix.Domain.Primitives;
using Nix.Http;

namespace Nix.Errors;

/// <summary>
/// Single factory for every RFC 9457 problem-details response the API emits.
/// </summary>
/// <remarks>
/// <para>
/// The wire shape is RFC 9457 (<c>type</c>, <c>title</c>, <c>status</c>,
/// <c>detail</c>, <c>instance</c>) plus two extension members that are part of
/// the contract, not decoration:
/// </para>
/// <list type="bullet">
///   <item><description><c>code</c> — a stable, machine-readable identifier the
///   frontend switches on. Never derived from a message string, never localized,
///   never renamed without an OpenAPI breaking-change review.</description></item>
///   <item><description><c>traceId</c> — the current activity id, so a user-visible
///   failure can be joined to a trace.</description></item>
/// </list>
/// <para>
/// Two code paths produce problem details and both end here: endpoints returning
/// a typed failure call <see cref="Create"/>, while framework-produced problems
/// (unmatched route, unhandled exception) are completed by <see cref="Enrich"/>
/// from <c>ProblemDetailsOptions.CustomizeProblemDetails</c>. Minimal API
/// <c>TypedResults.Problem</c> writes its payload directly instead of routing
/// through <c>IProblemDetailsService</c>, so the enrichment cannot live in only
/// one of the two places. The RFC <c>type</c> and default <c>title</c> are left
/// to the framework, which applies them for both paths.
/// </para>
/// <para>
/// <c>ProblemDetails</c> lives in <c>Microsoft.AspNetCore.Mvc</c> but is not
/// controller infrastructure; the type is explicitly allowed while MVC
/// controllers are prohibited (engineering plan section 2.3).
/// </para>
/// </remarks>
public static class ApiProblem
{
    // These four name the wire contract, so they share one visibility: a test asserting the shape
    // of a problem payload must be able to say the same words the payload does.

    /// <summary>Extension member carrying the stable machine-readable error code.</summary>
    public const string CodeExtension = "code";

    /// <summary>Extension member carrying the correlating trace identifier.</summary>
    public const string TraceIdExtension = "traceId";

    /// <summary>
    /// Fallback code for problems the framework produced without a feature-owned
    /// code (an unmatched route, an unhandled exception). Clients must not branch
    /// on it beyond "unexpected"; it exists so <c>code</c> is never absent.
    /// </summary>
    public const string UnexpectedCode = "api.unexpected_error";

    /// <summary>
    /// Stable code for a request body over the connection's bound. The status is decided where the
    /// body is refused - Kestrel's limit, or an endpoint's <c>WithRequestBodyLimit</c> - and both
    /// surface as a 413 that only this enrichment path turns into a coded problem, so the code
    /// lives here rather than with any one endpoint.
    /// </summary>
    public const string BodyTooLargeCode = "request.body_too_large";

    /// <summary>
    /// Builds a problem-details payload with the stable <paramref name="code"/> and
    /// the standard extensions applied.
    /// </summary>
    /// <param name="httpContext">Request context, used for <c>instance</c> and trace correlation.</param>
    /// <param name="status">HTTP status code of the failure.</param>
    /// <param name="code">Stable machine-readable code, owned by the feature that fails.</param>
    /// <param name="title">Short, non-localized summary of the failure class.</param>
    /// <param name="detail">Human-readable explanation of this specific occurrence.</param>
    internal static ProblemDetails Create(
        HttpContext httpContext,
        int status,
        string code,
        string title,
        string detail)
    {
        ArgumentNullException.ThrowIfNull(httpContext);
        ArgumentException.ThrowIfNullOrWhiteSpace(code);

        var problem = new ProblemDetails
        {
            Status = status,
            Title = title,
            Detail = detail,
        };

        problem.Extensions[CodeExtension] = code;
        Enrich(problem, httpContext);
        return problem;
    }

    /// <summary>Builds a problem for a use-case failure, carrying its per-field violations and conflicting item.</summary>
    /// <param name="httpContext">Request context.</param>
    /// <param name="status">HTTP status code of the failure.</param>
    /// <param name="error">The failure.</param>
    internal static ProblemDetails Create(HttpContext httpContext, int status, NixError error)
    {
        var problem = Create(httpContext, status, error.Code, "Request refused", error.Message);
        if (error.Violations is { Count: > 0 } violations)
        {
            // JSON nodes rather than anonymous objects: they serialise without reflection.
            problem.Extensions["violations"] = new System.Text.Json.Nodes.JsonArray(
                [.. violations.Select(violation => (System.Text.Json.Nodes.JsonNode)new System.Text.Json.Nodes.JsonObject
                {
                    ["key"] = violation.Key,
                    ["reason"] = violation.Reason,
                })]);
        }

        if (error.ExistingItemId is { } existing)
        {
            problem.Extensions["existingItemId"] = existing;
        }

        return problem;
    }

    /// <summary>
    /// Applies the invariants every problem response must satisfy: an
    /// <c>instance</c> pointing at the failed request, a <c>code</c>, and a
    /// <c>traceId</c>. Safe to call on a payload that already carries a code — an
    /// existing code is never overwritten.
    /// </summary>
    /// <param name="problem">The payload being completed.</param>
    /// <param name="httpContext">The request the problem describes.</param>
    public static void Enrich(ProblemDetails problem, HttpContext httpContext)
    {
        ArgumentNullException.ThrowIfNull(problem);
        ArgumentNullException.ThrowIfNull(httpContext);

        problem.Instance ??= httpContext.Request.Path.Value;

        // A 413 reaches here from two directions - the exception handler mapping Kestrel's
        // BadHttpRequestException (see Program), and the status-code-pages path when the refusal
        // never threw. Neither owns a feature code, so the stable code is stamped centrally.
        if (problem.Status == StatusCodes.Status413PayloadTooLarge
            && !problem.Extensions.ContainsKey(CodeExtension))
        {
            problem.Title ??= "Request body too large";
            problem.Extensions[CodeExtension] = BodyTooLargeCode;

            // The only place a 413 becomes visible to an operator. Service location rather than an
            // injected logger because Enrich is called from ProblemDetailsOptions and from static
            // factories that have no container of their own; it runs once per refused request, not
            // on any success path. Null-tolerant so a unit test may enrich a bare context.
            var logger = httpContext.RequestServices?.GetService<ILoggerFactory>()?.CreateLogger(typeof(ApiProblem));
            if (logger?.IsEnabled(LogLevel.Information) == true)
            {
                var requestPath = httpContext.Request.Path.Value ?? string.Empty;
                var clientKey = ClientKey.For(httpContext);
                ApiLog.RequestBodyTooLarge(
                    logger,
                    requestPath,
                    clientKey);
            }
        }

        if (!problem.Extensions.ContainsKey(CodeExtension))
        {
            problem.Extensions[CodeExtension] = UnexpectedCode;
        }

        problem.Extensions[TraceIdExtension] = Activity.Current?.Id ?? httpContext.TraceIdentifier;
    }
}
