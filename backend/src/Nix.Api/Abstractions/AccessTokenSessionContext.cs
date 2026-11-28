namespace Nix.Abstractions;

/// <summary>
/// The scope ceiling of the unit of work, when a personal access token authenticated it.
/// </summary>
/// <remarks>
/// <para>
/// <b>Why this exists apart from the route-level check.</b> The unit-of-work middleware refuses a
/// token-authenticated request whose scope does not reach the route it called. That closes every
/// surface Core owns. It does not close the one surface Core answers <i>about</i> rather than
/// <i>for</i>: <c>GetItemAuthorization</c> reports <c>CanWrite</c> to the collaboration service,
/// which then accepts body updates on its own without another call to Core. A read-scoped token
/// reaches that endpoint legitimately - it is a GET - so the report has to carry the ceiling too,
/// or the scope stops at Core's door and the documents behind it are unprotected.
/// </para>
/// <para>
/// So the middleware, once it has admitted a token session, records here what that token may do,
/// and the authorization handler intersects its answer with it. An interactive session never sets
/// this, and its defaults are permissive: a person's ceiling is their permissions, resolved the
/// usual way.
/// </para>
/// <para>
/// Set once per scope, like <see cref="NixSessionContext"/>, and for the same reason: a capability
/// that changed mid-request would let later work assume a ceiling earlier work did not enforce.
/// </para>
/// </remarks>
public sealed class AccessTokenSessionContext
{
    private bool _set;

    /// <summary>
    /// Whether a personal access token authenticated this unit of work. <see langword="false"/>
    /// for an interactive session.
    /// </summary>
    public bool IsTokenSession { get; private set; }

    /// <summary>Whether a validated pet turn credential authenticated this unit of work.</summary>
    public bool IsPetTurn { get; private set; }

    /// <summary>
    /// Whether the acting credential may write content. Always <see langword="true"/> for an
    /// interactive session; for a token session, whether it holds the write scope.
    /// </summary>
    public bool MayWrite { get; private set; } = true;

    /// <summary>
    /// Whether the acting credential may change who can see what. Always <see langword="true"/>
    /// for an interactive session; for a token session, whether it holds the admin scope.
    /// </summary>
    public bool MayAdminister { get; private set; } = true;

    /// <summary>
    /// Whether the acting credential may address pets and agents in a message and read an agent inbox. Always <see langword="true"/>
    /// for an interactive session; for a token session, whether it holds the <c>agents</c> scope.
    /// </summary>
    public bool MayAgents { get; private set; } = true;

    /// <summary>
    /// Whether the acting credential is a person's browser session. Fail-closed: <see langword="false"/>
    /// unless the middleware validated a browser-session token, so an access token, an external
    /// bearer, a worker delegation and in-process work are all <see langword="false"/>.
    /// </summary>
    /// <remarks>
    /// Not the inverse of <see cref="IsTokenSession"/>: that is also <see langword="false"/> for an
    /// external bearer, which is not a person at a keyboard.
    /// </remarks>
    public bool IsInteractive { get; private set; }

    /// <summary>
    /// Whether a validated external-IdP bearer authenticated this unit of work. Fail-closed:
    /// <see langword="false"/> for in-process work and worker delegations, which the agent gate refuses.
    /// </summary>
    public bool IsExternalBearer { get; private set; }

    /// <summary>Marks the unit of work as an external bearer. Called only for a validated external token.</summary>
    public void SetExternalBearer() => IsExternalBearer = true;

    /// <summary>Marks the unit of work as a person's browser session. Called only for a validated browser-session token.</summary>
    public void SetInteractive() => IsInteractive = true;

    /// <summary>Records the ceiling of a validated pet turn credential and its pet identity.</summary>
    public void SetPetTurn(bool mayWrite, bool mayAdminister)
    {
        SetTokenCeiling(mayWrite, mayAdminister);
        IsPetTurn = true;
    }

    /// <summary>
    /// Records the ceiling a token session was admitted under.
    /// </summary>
    /// <param name="mayWrite">Whether the token holds the write scope.</param>
    /// <param name="mayAdminister">Whether the token holds the admin scope.</param>
    /// <exception cref="InvalidOperationException">The ceiling was already recorded.</exception>
    /// <param name="mayAgents">Whether the token holds the agents scope.</param>
    public void SetTokenCeiling(bool mayWrite, bool mayAdminister, bool mayAgents = false)
    {
        if (_set)
        {
            throw new InvalidOperationException(
                "The access-token ceiling is already recorded for this scope and is write-once. "
                + "A capability that changed mid-request would let later work assume a ceiling "
                + "earlier work did not enforce.");
        }

        _set = true;
        IsTokenSession = true;
        MayWrite = mayWrite;
        MayAdminister = mayAdminister;
        MayAgents = mayAgents;
    }
}
