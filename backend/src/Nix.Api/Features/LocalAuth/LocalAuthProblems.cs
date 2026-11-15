using System.Text.Json.Nodes;
using Nix.Errors;

namespace Nix.Features.LocalAuth;

/// <summary>The refusals local sign-in shares. Wrong email and wrong password are the same answer on purpose.</summary>
internal static class LocalAuthProblems
{
    internal static IResult InvalidCredentials(HttpContext context) => TypedResults.Problem(ApiProblem.Create(
        context,
        StatusCodes.Status401Unauthorized,
        "invalid_credentials",
        "Sign-in failed",
        "The email or password is not right."));

    internal static IResult Paused(HttpContext context, TimeSpan retryAfter)
    {
        var seconds = Math.Max(1, (int)Math.Ceiling(retryAfter.TotalSeconds));
        var problem = ApiProblem.Create(
            context,
            StatusCodes.Status429TooManyRequests,
            "paused",
            "Sign-in is paused",
            "Too many wrong passwords. Try again in a few minutes.");
        problem.Extensions["retryAfterSeconds"] = JsonValue.Create(seconds);
        context.Response.Headers.RetryAfter = seconds.ToString(System.Globalization.CultureInfo.InvariantCulture);
        return TypedResults.Problem(problem);
    }

    internal static IResult Invalid(HttpContext context, string code, string detail) => TypedResults.Problem(ApiProblem.Create(
        context,
        StatusCodes.Status422UnprocessableEntity,
        code,
        "Request refused",
        detail));

    internal static IResult Refuse(HttpContext context, int status, string code, string title, string detail) =>
        TypedResults.Problem(ApiProblem.Create(context, status, code, title, detail));
}
