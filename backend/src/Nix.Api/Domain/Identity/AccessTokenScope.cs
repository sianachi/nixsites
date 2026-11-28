namespace Nix.Domain.Identity;

/// <summary>
/// What a personal access token may do, as a ceiling under the principal's own permissions.
/// </summary>
/// <remarks>
/// <para>
/// <b>A scope only ever narrows; it never grants.</b> Every request a token authenticates still
/// resolves permissions from the database for the principal who issued it, exactly as an
/// interactive session would. The scope is intersected with that answer, so a token holds at most
/// what its principal holds - a read-only token in the hands of an administrator reads what they
/// read and writes nothing.
/// </para>
/// <para>
/// Three levels rather than a per-endpoint matrix, deliberately. A matrix invites tokens whose
/// reach nobody can state from memory; three words on a settings screen can be read at a glance
/// and revoked with confidence. The classification of every route into these levels lives in
/// <c>Nix.Authentication.AccessTokenScopePolicy</c>, and a test holds it exhaustive against the
/// OpenAPI contract.
/// </para>
/// </remarks>
public enum AccessTokenScope
{
    /// <summary>May read: every GET the principal could make, search and query included.</summary>
    Read,

    /// <summary>May write content and structure: items, bodies, properties, views.</summary>
    Write,

    /// <summary>May administer: sharing, permission entries, public exposure of views.</summary>
    Admin,

    /// <summary>
    /// Makes the token an agent: it may post a message that addresses the principal's pets or other agents and
    /// read its own inbox, and the principal's other agents can address it. Nothing else new.
    /// </summary>
    Agents,
}

/// <summary>
/// The wire and storage spellings of <see cref="AccessTokenScope"/>.
/// </summary>
public static class AccessTokenScopes
{
    /// <summary>The storage spelling of <see cref="AccessTokenScope.Read"/>.</summary>
    public const string Read = "read";

    /// <summary>The storage spelling of <see cref="AccessTokenScope.Write"/>.</summary>
    public const string Write = "write";

    /// <summary>The storage spelling of <see cref="AccessTokenScope.Admin"/>.</summary>
    public const string Admin = "admin";

    /// <summary>The storage spelling of <see cref="AccessTokenScope.Agents"/>. Tokens minted as <c>pets:send</c> were migrated to it.</summary>
    public const string Agents = "agents";

    /// <summary>Every scope, in the order the API lists them.</summary>
    public static IReadOnlyList<string> All { get; } = [Read, Write, Admin, Agents];

    /// <summary>
    /// Parses a stored or requested spelling.
    /// </summary>
    /// <param name="value">The spelling to parse.</param>
    /// <param name="scope">The scope it names, when it names one.</param>
    /// <returns>Whether <paramref name="value"/> names a scope.</returns>
    /// <remarks>
    /// Exact and case-sensitive: these strings are written by this codebase and read back by it,
    /// so anything else in the column is a bug worth refusing, not a variant worth accepting.
    /// </remarks>
    public static bool TryParse(string? value, out AccessTokenScope scope)
    {
        switch (value)
        {
            case Read:
                scope = AccessTokenScope.Read;
                return true;
            case Write:
                scope = AccessTokenScope.Write;
                return true;
            case Admin:
                scope = AccessTokenScope.Admin;
                return true;
            case Agents:
                scope = AccessTokenScope.Agents;
                return true;
            default:
                scope = default;
                return false;
        }
    }

    /// <summary>
    /// Formats a scope into its storage spelling.
    /// </summary>
    /// <param name="scope">The scope to format.</param>
    /// <returns>The spelling.</returns>
    public static string Format(AccessTokenScope scope) => scope switch
    {
        AccessTokenScope.Read => Read,
        AccessTokenScope.Write => Write,
        AccessTokenScope.Admin => Admin,
        AccessTokenScope.Agents => Agents,
        _ => throw new ArgumentOutOfRangeException(nameof(scope), scope, "Unknown scope."),
    };
}
