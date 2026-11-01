using System.Security.Cryptography;
using System.Text;
using Nix.Errors;

namespace Nix.Authentication;

/// <summary>
/// Refuses every <c>/internal</c> request that does not prove it came from a trusted service.
/// </summary>
/// <remarks>
/// <para>
/// The internal surface answers questions the public surface deliberately does not - "may this
/// principal write that item" - so reaching it requires two proofs, layered: this middleware
/// checks a shared secret that only the collaboration service is configured with, and the
/// unit-of-work middleware behind it validates the forwarded user token exactly as it would on a
/// public route. Network policy is the deployment's half of the same boundary; this is the
/// application's half, and it holds even when the network is misconfigured.
/// </para>
/// <para>
/// <b>Every refusal is 404, not 401.</b> A caller without the secret must not learn that an
/// internal surface exists, which routes live on it, or whether a secret is configured at all. For
/// the same reason a deployment with no secret configured refuses everything: an accidentally
/// unset secret must fail closed, and it is logged once at startup rather than per request.
/// </para>
/// <para>
/// The comparison is constant-time (<see cref="CryptographicOperations.FixedTimeEquals"/>): the
/// secret is long-lived, so a timing oracle on its prefix would be worth an attacker's while.
/// </para>
/// </remarks>
public sealed class InternalBoundaryMiddleware
{
    /// <summary>The header a trusted service presents its secret in.</summary>
    public const string SecretHeaderName = "x-nix-internal-secret";

    /// <summary>The configuration key the shared secret is read from.</summary>
    public const string SecretConfigurationKey = "Nix:InternalSecret";

    /// <summary>Stable code for a refused internal request.</summary>
    public const string NotFoundCode = "internal.not_found";

    private readonly RequestDelegate _next;
    private readonly byte[]? _secretDigest;

    /// <summary>Initializes a new instance of the <see cref="InternalBoundaryMiddleware"/> class.</summary>
    /// <param name="next">The rest of the pipeline, reached only past the boundary.</param>
    /// <param name="configuration">Where the shared secret is configured.</param>
    public InternalBoundaryMiddleware(RequestDelegate next, IConfiguration configuration)
    {
        ArgumentNullException.ThrowIfNull(next);
        ArgumentNullException.ThrowIfNull(configuration);

        _next = next;

        var secret = configuration[SecretConfigurationKey];
        _secretDigest = string.IsNullOrWhiteSpace(secret)
            ? null
            : SHA256.HashData(Encoding.UTF8.GetBytes(secret));
    }

    /// <summary>Whether the internal surface is enabled at all.</summary>
    public bool Enabled => _secretDigest is not null;

    /// <summary>Lets the request through only when it carries the shared secret.</summary>
    /// <param name="context">The request.</param>
    /// <returns>A task that completes when the request has been handled or refused.</returns>
    public async Task InvokeAsync(HttpContext context)
    {
        ArgumentNullException.ThrowIfNull(context);

        if (_secretDigest is not null && PresentsSecret(context.Request))
        {
            // Only a caller holding the secret may say which release it runs.
            context.RequestServices.GetService<Nix.Features.Health.ServiceVersions>()?.Record(context.Request);
            await _next(context).ConfigureAwait(false);
            return;
        }

        var problem = ApiProblem.Create(
            context,
            StatusCodes.Status404NotFound,
            NotFoundCode,
            "Not found",
            "The requested resource does not exist.");

        context.Response.StatusCode = StatusCodes.Status404NotFound;
        await context.Response
            .WriteAsJsonAsync(
                problem,
                options: null,
                contentType: "application/problem+json",
                cancellationToken: context.RequestAborted)
            .ConfigureAwait(false);
    }

    private bool PresentsSecret(HttpRequest request)
    {
        var presentedDigest = SHA256.HashData(
            Encoding.UTF8.GetBytes(request.Headers[SecretHeaderName].ToString()));
        return CryptographicOperations.FixedTimeEquals(presentedDigest, _secretDigest!);
    }
}
