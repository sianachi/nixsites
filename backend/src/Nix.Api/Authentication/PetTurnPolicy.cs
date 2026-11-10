using System.Text.RegularExpressions;
using Microsoft.AspNetCore.Http;

namespace Nix.Authentication;

/// <summary>
/// What a pet turn token may reach: the routes its mode allows, minus everything an assistant
/// never does, whatever the mode.
/// </summary>
public static class PetTurnPolicy
{
    // Mirrors HUMAN_ONLY in packages/api-client/src/operations.ts, in the same order. Keep the two
    // in step; the shared fixture packages/api-client/src/fixtures/human-only.json is replayed
    // against both (PetTurnPolicyTests), so a drift in either direction fails a test.
    private static readonly (Regex Pattern, bool AnyMethod)[] HumanOnly =
    [
        (Rule(@"^/api/v1/me/tokens(/|$)"), true),
        (Rule(@"^/api/v1/me/pets(/|$)"), true),
        (Rule(@"^/api/v1/me/push-subscriptions(/|$)"), true),
        (Rule(@"^/api/v1/me/calendar/connections(/|$)"), true),
        (Rule(@"^/api/v1/me/(preferences|ui-settings|workspace-arrangement)(/|$)"), false),
        (Rule(@"^/api/v1/conversations/[^/]+/(turns|configure|sources|cancel)$"), false),
        (Rule(@"^/api/v1/workspaces/[^/]+/conversations(/|$)"), false),
        (Rule(@"^/api/v1/tenant/admins(/|$)"), true),
        (Rule(@"^/api/v1/tenant/settings(/|$)"), true),
        (Rule(@"^/api/v1/sites/operators(/|$)"), true),
        (Rule(@"/approval/(approve|reject)$"), true),
        (Rule(@"^/api/v1/workspaces/[^/]+/agent-policy$"), true),
        (Rule(@"^/api/v1/workspaces/[^/]+/(password|unlock|join)(/|$)"), true),
        // An item lock password is typed by a person too; a leaked write token must not lock owners out.
        (Rule(@"^/api/v1/items/[^/]+/(lock|unlock|protection)(/|$)"), true),
    ];

    /// <summary>Whether the executor's human-only list covers this request.</summary>
    public static bool IsHumanOnly(HttpRequest request)
    {
        ArgumentNullException.ThrowIfNull(request);
        // Same trailing-slash rule as Classify, so "/approval/approve/" cannot slip past "$".
        var path = (request.Path.Value ?? string.Empty).TrimEnd('/');
        var get = HttpMethods.IsGet(request.Method); // the TS rule: "write" means any method but GET
        return HumanOnly.Any(rule => (rule.AnyMethod || !get) && rule.Pattern.IsMatch(path));
    }

    /// <summary>
    /// A read token reads as the person, a write token also writes, and only an admin token
    /// reaches Admin routes. Never an interactive-only or human-only route, whatever the mode.
    /// </summary>
    public static bool Allows(HttpRequest request, ValidatedPetTurnToken token)
    {
        ArgumentNullException.ThrowIfNull(token);
        return !IsHumanOnly(request) && AccessTokenScopePolicy.Classify(request.Method, request.Path) switch
        {
            AccessTokenScopePolicy.Requirement.Read => true,
            AccessTokenScopePolicy.Requirement.Write => token.MayWrite,
            AccessTokenScopePolicy.Requirement.Admin => token.MayAdminister,
            _ => false,
        };
    }

    private static Regex Rule(string pattern) =>
        new(pattern, RegexOptions.IgnoreCase | RegexOptions.CultureInvariant, TimeSpan.FromMilliseconds(100));
}
