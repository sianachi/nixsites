using Microsoft.AspNetCore.Http;
using Nix.Domain.Identity;

namespace Nix.Authentication;

/// <summary>
/// Classifies every route into the scope a personal access token must hold to call it.
/// </summary>
/// <remarks>
/// <para>
/// <b>The classification is by shape, not by endpoint list, and that is a safety property.</b>
/// The default for anything unrecognised is the strictest reading its method allows: a read needs
/// <see cref="AccessTokenScope.Read"/>, everything else needs <see cref="AccessTokenScope.Write"/>,
/// and the narrow set of routes that change who can see what needs
/// <see cref="AccessTokenScope.Admin"/>. A new endpoint therefore arrives classified - possibly
/// too strictly, never too loosely - and the contract test that walks the OpenAPI document
/// (<c>AccessTokenScopePolicyTests</c>) is where each operation's class is made deliberate.
/// </para>
/// <para>
/// <b>Token management is not a scope; it is refused outright.</b> A token that could list, mint
/// or revoke tokens could quietly extend its own life past every ceiling its issuer chose.
/// Managing tokens is something a person does in an interactive session.
/// </para>
/// <para>
/// This applies only to token-authenticated sessions. An interactive principal is not scoped -
/// their permissions are the ceiling - so the middleware consults this only when the validated
/// token names an access-token row.
/// </para>
/// </remarks>
public static class AccessTokenScopePolicy
{
    /// <summary>What a route demands of a token-authenticated caller.</summary>
    public enum Requirement
    {
        /// <summary>The token must hold <see cref="AccessTokenScope.Read"/>.</summary>
        Read,

        /// <summary>The token must hold <see cref="AccessTokenScope.Write"/>.</summary>
        Write,

        /// <summary>The token must hold <see cref="AccessTokenScope.Admin"/>.</summary>
        Admin,

        /// <summary>No scope admits a token here; only an interactive session may call it.</summary>
        InteractiveOnly,
    }

    /// <summary>
    /// Classifies one request.
    /// </summary>
    /// <param name="method">The HTTP method.</param>
    /// <param name="path">The request path.</param>
    /// <returns>What the route demands.</returns>
    public static Requirement Classify(string method, PathString path)
    {
        ArgumentException.ThrowIfNullOrWhiteSpace(method);

        // Linked ChatGPT credentials and their usage are an interactive-user boundary, not a
        // capability implicitly delegated by a Nix personal access token. Inline writing is the
        // same boundary: it sends note text to the person's own provider account from the editor,
        // which a token used by an automation has no reason to do.
        if (path.StartsWithSegments("/api/v1/me/tokens", StringComparison.OrdinalIgnoreCase)
            || path.StartsWithSegments("/api/v1/me/pets/runtime", StringComparison.OrdinalIgnoreCase)
            || path.StartsWithSegments("/api/v1/me/pets/connection", StringComparison.OrdinalIgnoreCase)
            || path.StartsWithSegments("/api/v1/me/pets/inline", StringComparison.OrdinalIgnoreCase)
            || (path.StartsWithSegments("/api/v1/conversations", StringComparison.OrdinalIgnoreCase)
                && (path.Value ?? string.Empty).TrimEnd('/').EndsWith("/turns", StringComparison.OrdinalIgnoreCase)))
        {
            return Requirement.InteractiveOnly;
        }

        // ASP.NET routing matches a path with a trailing slash to the same endpoint, so every
        // suffix and exact-path rule below compares the path with trailing slashes removed;
        // otherwise "/move/" or "/api/v1/me/preferences/" would slip past the rule meant for it.
        var value = (path.Value ?? string.Empty).TrimEnd('/');

        // Preferences writes and registering or removing a push device are interactive-user
        // boundaries: a personal access token used by an automation should never be able to
        // change where a person's reminders are pushed or silence their notifications. Reading
        // either remains Read through the shortcut below.
        if (!IsRead(method)
            && (path.StartsWithSegments("/api/v1/me/preferences", StringComparison.OrdinalIgnoreCase)
                || path.StartsWithSegments("/api/v1/me/pets/providers", StringComparison.OrdinalIgnoreCase)
                || path.StartsWithSegments("/api/v1/me/workspace-arrangement", StringComparison.OrdinalIgnoreCase)
                || path.StartsWithSegments("/api/v1/me/ui-settings", StringComparison.OrdinalIgnoreCase)
                || path.StartsWithSegments("/api/v1/me/push-subscriptions", StringComparison.OrdinalIgnoreCase)))
        {
            return Requirement.InteractiveOnly;
        }

        // Connecting or disconnecting a calendar account hands a third party an OAuth grant, or
        // takes it away: an interactive-user boundary, like managing tokens. Listing accounts and
        // their calendars remains Read through the shortcut below.
        if (!IsRead(method)
            && path.StartsWithSegments("/api/v1/me/calendar/connections", StringComparison.OrdinalIgnoreCase))
        {
            return Requirement.InteractiveOnly;
        }

        // A calendar link pushes workspace data to a third party unattended, as its owner, every
        // few minutes (ADR-0052): creating, changing or deleting one is an admin capability for a
        // token, never an ordinary write. Asking an existing link to sync now is an ordinary write.
        if (!IsRead(method)
            && path.StartsWithSegments("/api/v1/me/calendar/links", StringComparison.OrdinalIgnoreCase))
        {
            return value.EndsWith("/sync", StringComparison.OrdinalIgnoreCase) ? Requirement.Write : Requirement.Admin;
        }

        // Admin surfaces, whichever method reaches them, because each changes or exposes who can
        // see what rather than what there is to see:
        //  - `/public-link` publishes a view to the anonymous internet, and its GET reads back a
        //    live submission URL - a write capability, not data - so the read is admin too;
        //  - `/move` re-parents an item, which through closure inheritance can hand its contents
        //    to everyone who can see the new parent.
        // These are matched before the read shortcut precisely so a GET does not slip through as
        // a plain read.
        if (value.Contains("/public-link", StringComparison.OrdinalIgnoreCase)
            || value.EndsWith("/move", StringComparison.OrdinalIgnoreCase)
            || value.EndsWith("/invitees", StringComparison.OrdinalIgnoreCase))
        {
            return Requirement.Admin;
        }

        if (IsRead(method))
        {
            return Requirement.Read;
        }

        // A read sent as a POST only because its input - a passage of text - is too long for a
        // URL. Classified as a read, by exact path, because the default here would be wrong in the
        // dangerous direction: scopes are independent, so a write-only ingest token would be
        // admitted to a route that returns titles, and a read-only agent refused one that changes
        // nothing. Exact match rather than a prefix, so nothing later nested under it inherits it.
        if (HttpMethods.IsPost(method)
            && string.Equals(value, "/api/v1/search/mentions", StringComparison.OrdinalIgnoreCase))
        {
            return Requirement.Read;
        }

        // The ad-hoc workspace query and its aggregate: reads sent as POSTs because rules do not
        // fit a URL, classified as reads for the mentions reason. Matched by exact shape - the
        // workspaces prefix, one id segment, then "query" or "query/aggregate" - so nothing later
        // nested under either path inherits it.
        if (HttpMethods.IsPost(method) && IsWorkspaceQueryPath(value))
        {
            return Requirement.Read;
        }

        // Workspace membership administration changes who can reach an entire item tree. The
        // database role remains the authority; an admin-scoped token is an additional ceiling.
        if (value.Contains("/members", StringComparison.OrdinalIgnoreCase)
            || value.Contains("/invitations", StringComparison.OrdinalIgnoreCase)
            || value.EndsWith("/sharing", StringComparison.OrdinalIgnoreCase)
            || value.EndsWith("/leave", StringComparison.OrdinalIgnoreCase)
            || value.EndsWith("/recover", StringComparison.OrdinalIgnoreCase)
            // Workspace lifecycle changes the availability of the whole workspace. In particular,
            // permanent deletion destroys its durable data, so a write-scoped automation cannot
            // make either transition.
            || (value.StartsWith("/api/v1/workspaces/", StringComparison.OrdinalIgnoreCase)
                && (value.EndsWith("/archive", StringComparison.OrdinalIgnoreCase)
                    || value.EndsWith("/restore", StringComparison.OrdinalIgnoreCase)))
            || (HttpMethods.IsDelete(method)
                && value.StartsWith("/api/v1/workspaces/", StringComparison.OrdinalIgnoreCase))
            // Plugin writes pin publisher trust or grant executable components access to
            // workspace data. Listing installations remains a read through the shortcut above.
            || value.Contains("/plugins", StringComparison.OrdinalIgnoreCase)
            // Automation rules act later, unattended, with their owner's write access
            // (ADR-0051 section 6): a token may read them, but creating, changing, running or
            // deleting one is an admin capability, never an ordinary write.
            || value.Contains("/automations", StringComparison.OrdinalIgnoreCase)
            // Publishing a site puts a subtree on the public internet (ADR-0063), as
            // `/public-link` does for a view: creating, changing, publishing, rolling back,
            // withdrawing or deleting one is an admin capability for a token. Reading a site and
            // its builds stays a read through the shortcut above.
            || value.StartsWith("/api/v1/sites", StringComparison.OrdinalIgnoreCase)
            // Tenant administrators can reach everything in the tenant: granting or removing one
            // is an admin capability for a token. Listing them stays a read.
            || value.StartsWith("/api/v1/tenant/admins", StringComparison.OrdinalIgnoreCase))
        {
            return Requirement.Admin;
        }

        // Permission entries are the remaining admin write: they name who may act, and reading
        // the ACL (a GET, already returned as Read above) is data disclosure rather than a
        // capability, so only the writes land here.
        if (value.Contains("/permissions", StringComparison.OrdinalIgnoreCase))
        {
            return Requirement.Admin;
        }

        return Requirement.Write;
    }

    /// <summary>
    /// Whether a trimmed path is exactly <c>/api/v1/workspaces/{id}/query</c> or
    /// <c>/api/v1/workspaces/{id}/query/aggregate</c>, with one segment for the id.
    /// </summary>
    private static bool IsWorkspaceQueryPath(string value)
    {
        const string Prefix = "/api/v1/workspaces/";
        if (!value.StartsWith(Prefix, StringComparison.OrdinalIgnoreCase))
        {
            return false;
        }

        // One segment for the workspace: the route's guid constraint is what makes it an id (any
        // other segment matches no endpoint and answers 404), and the contract walk classifies the
        // templated path, so the segment is not parsed here.
        var rest = value[Prefix.Length..];
        var slash = rest.IndexOf('/', StringComparison.Ordinal);
        if (slash <= 0)
        {
            return false;
        }

        var tail = rest[(slash + 1)..];
        return string.Equals(tail, "query", StringComparison.OrdinalIgnoreCase)
            || string.Equals(tail, "query/aggregate", StringComparison.OrdinalIgnoreCase);
    }

    /// <summary>
    /// Whether a set of held scopes satisfies a requirement.
    /// </summary>
    /// <param name="held">The scopes on the token row, in their storage spelling.</param>
    /// <param name="requirement">What the route demands.</param>
    /// <returns>Whether the request may proceed.</returns>
    /// <remarks>
    /// Scopes are independent rather than ordered: a write-only token exists (an ingest that
    /// should never be able to exfiltrate), so holding <c>write</c> does not imply <c>read</c>.
    /// An unrecognised string in the column satisfies nothing - the safe reading of a scope this
    /// build cannot interpret is "not granted".
    /// </remarks>
    public static bool Satisfies(IReadOnlyList<string> held, Requirement requirement)
    {
        ArgumentNullException.ThrowIfNull(held);

        if (requirement == Requirement.InteractiveOnly)
        {
            return false;
        }

        var needed = requirement switch
        {
            Requirement.Read => AccessTokenScopes.Read,
            Requirement.Write => AccessTokenScopes.Write,
            Requirement.Admin => AccessTokenScopes.Admin,
            _ => throw new ArgumentOutOfRangeException(nameof(requirement), requirement, "Unknown requirement."),
        };

        for (var index = 0; index < held.Count; index++)
        {
            if (string.Equals(held[index], needed, StringComparison.Ordinal))
            {
                return true;
            }
        }

        return false;
    }

    /// <summary>
    /// Names a requirement the way a problem document should: as the scope the caller lacked.
    /// </summary>
    /// <param name="requirement">The unmet requirement.</param>
    /// <returns>The scope's storage spelling, or a sentence for the interactive-only case.</returns>
    public static string Describe(Requirement requirement) => requirement switch
    {
        Requirement.Read => AccessTokenScopes.Read,
        Requirement.Write => AccessTokenScopes.Write,
        Requirement.Admin => AccessTokenScopes.Admin,
        Requirement.InteractiveOnly => "an interactive session",
        _ => throw new ArgumentOutOfRangeException(nameof(requirement), requirement, "Unknown requirement."),
    };

    private static bool IsRead(string method) =>
        HttpMethods.IsGet(method) || HttpMethods.IsHead(method) || HttpMethods.IsOptions(method);
}
