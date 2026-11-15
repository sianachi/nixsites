using Microsoft.AspNetCore.Http.HttpResults;

namespace Nix.Authentication;

/// <summary>Makes an endpoint or group answer only in one sign-in mode.</summary>
internal static class AuthModeEndpointExtensions
{
    /// <summary>
    /// Every local endpoint calls this with <see cref="AuthMode.Local"/>, and /auth/callback with
    /// <see cref="AuthMode.Oidc"/>. In the other mode the route answers 404, as if it did not exist.
    /// </summary>
    /// <remarks>
    /// An endpoint filter runs after parameter binding, so a malformed body still draws a 400 first; the
    /// route's existence leaks, its behaviour does not.
    /// </remarks>
    internal static TBuilder RequireAuthMode<TBuilder>(this TBuilder builder, AuthMode mode)
        where TBuilder : IEndpointConventionBuilder
    {
        ArgumentNullException.ThrowIfNull(builder);
        return builder.AddEndpointFilter(async (context, next) =>
            context.HttpContext.RequestServices.GetRequiredService<AuthSettings>().Mode == mode
                ? await next(context).ConfigureAwait(false)
                : TypedResults.NotFound());
    }
}
