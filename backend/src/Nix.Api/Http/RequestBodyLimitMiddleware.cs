using Microsoft.AspNetCore.Http.Features;

namespace Nix.Http;

/// <summary>
/// Applies an endpoint's declared <see cref="RequestBodyLimitMetadata"/> to the connection before
/// anything reads the request body.
/// </summary>
/// <remarks>
/// Must sit after routing (which <c>WebApplication</c> places at the front of the pipeline, so the
/// endpoint is already resolved here) and before any middleware or handler that reads the body.
/// The feature is left alone when the server marks it read-only - that happens once reading has
/// begun, at which point changing the bound would be a lie.
/// </remarks>
public sealed class RequestBodyLimitMiddleware(RequestDelegate next)
{
    /// <summary>Raises or lowers the request-body bound to what the matched endpoint declared.</summary>
    /// <param name="context">The request.</param>
    /// <returns>A task that completes when the request has been handled.</returns>
    public Task InvokeAsync(HttpContext context)
    {
        ArgumentNullException.ThrowIfNull(context);

        var declared = context.GetEndpoint()?.Metadata.GetMetadata<RequestBodyLimitMetadata>();
        if (declared is not null)
        {
            var feature = context.Features.Get<IHttpMaxRequestBodySizeFeature>();
            if (feature is { IsReadOnly: false })
            {
                feature.MaxRequestBodySize = declared.MaxRequestBodyBytes;
            }
        }

        return next(context);
    }
}
