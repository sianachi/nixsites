using Nix.Abstractions;
using Nix.Domain.Identity;
using Nix.Domain.Primitives;
using Nix.Messaging;

namespace Nix.Features.Tokens;

/// <summary>The token feature's stable failure codes.</summary>
public static class TokenErrors
{
    /// <summary>The request's name, scopes or expiry cannot mint a token.</summary>
    public const string InvalidCode = "tokens.invalid";

    /// <summary>The caller already holds as many live tokens as one principal may.</summary>
    public const string LimitReachedCode = "tokens.limit_reached";
}

/// <summary>Mints a personal access token for the acting principal.</summary>
/// <param name="Name">What the token is for.</param>
/// <param name="Scopes">The requested ceiling, in wire spelling.</param>
/// <param name="ExpiresInDays">How long it lives.</param>
public sealed record CreateAccessToken(
    string? Name,
    IReadOnlyList<string>? Scopes,
    int? ExpiresInDays) : ICommand<IssuedAccessToken>;

/// <summary>A minted token: the row that was stored, and the secret that was not.</summary>
/// <param name="Row">The stored row.</param>
/// <param name="Secret">The full token string, on its way to the one response that shows it.</param>
public sealed record IssuedAccessToken(PersonalAccessToken Row, string Secret);

/// <summary>Reads the acting principal's tokens.</summary>
public sealed record ListAccessTokens : IQuery<Result<IReadOnlyList<PersonalAccessToken>>>;

/// <summary>Revokes one of the acting principal's tokens.</summary>
/// <param name="Id">The token to revoke.</param>
public sealed record RevokeAccessToken(PersonalAccessTokenId Id) : ICommand<bool>;

/// <summary>
/// Mints a token: validates what was asked for, bounds how many one principal may hold, stores
/// the hash and hands the secret to the response - the only place it will ever exist.
/// </summary>
/// <remarks>
/// The scopes and the expiry are validated here rather than trusted from the request, and the
/// expiry is required rather than defaulted: a ceiling nobody chose is not a ceiling. The live
/// count is bounded (<see cref="PersonalAccessToken.MaximumLiveTokensPerPrincipal"/>) because a
/// principal drowning in tokens cannot audit them, and an unbounded mint is an unbounded write.
/// </remarks>
public sealed class CreateAccessTokenHandler(
    IPersonalAccessTokens tokens,
    INixSessionContextAccessor session,
    TimeProvider clock)
    : ICommandHandler<CreateAccessToken, IssuedAccessToken>
{
    private readonly IPersonalAccessTokens _tokens = tokens;
    private readonly INixSessionContextAccessor _session = session;

    /// <summary>Mints the token.</summary>
    /// <param name="command">What was asked for.</param>
    /// <param name="cancellationToken">Cancels the write.</param>
    /// <returns>The issued token, or why there is none.</returns>
    public async ValueTask<Result<IssuedAccessToken>> HandleAsync(
        CreateAccessToken command,
        CancellationToken cancellationToken)
    {
        ArgumentNullException.ThrowIfNull(command);

        var name = command.Name?.Trim();
        if (string.IsNullOrEmpty(name) || name.Length > PersonalAccessToken.MaximumNameLength)
        {
            return Result.Failure<IssuedAccessToken>(
                TokenErrors.InvalidCode,
                $"A token needs a name of 1 to {PersonalAccessToken.MaximumNameLength} characters, "
                + "so the list of tokens reads as a list of intentions.");
        }

        var scopes = NormaliseScopes(command.Scopes);
        if (scopes is null)
        {
            return Result.Failure<IssuedAccessToken>(
                TokenErrors.InvalidCode,
                "Scopes must name at least one of: "
                + string.Join(", ", AccessTokenScopes.All) + ".");
        }

        if (command.ExpiresInDays is not { } days
            || days < 1
            || days > PersonalAccessToken.MaximumLifetimeDays)
        {
            return Result.Failure<IssuedAccessToken>(
                TokenErrors.InvalidCode,
                $"Expiry is chosen, not defaulted: expiresInDays must be 1 to "
                + $"{PersonalAccessToken.MaximumLifetimeDays}.");
        }

        var now = clock.GetUtcNow();
        var live = await _tokens.CountLiveAsync(now, cancellationToken).ConfigureAwait(false);
        if (live >= PersonalAccessToken.MaximumLiveTokensPerPrincipal)
        {
            return Result.Failure<IssuedAccessToken>(
                TokenErrors.LimitReachedCode,
                $"You already hold {live} live tokens, the most one principal may. Revoke one "
                + "you no longer use before minting another.");
        }

        var session = _session.Current
            ?? throw new InvalidOperationException(
                "No session context has been established for this unit of work. A token is "
                + "issued by a specific principal; there is no anonymous path.");

        var minted = PersonalAccessTokenSecret.Mint();
        var row = new PersonalAccessToken
        {
            Id = PersonalAccessTokenId.Create(),
            TenantId = session.TenantId,
            PrincipalId = session.PrincipalId,
            Name = name,
            Lookup = minted.Lookup,
            SecretHash = minted.Hash,
            Scopes = scopes,
            CreatedAt = now,
            ExpiresAt = now.AddDays(days),
        };

        await _tokens.AddAsync(row, cancellationToken).ConfigureAwait(false);

        return Result.Success(new IssuedAccessToken(row, minted.Token));
    }

    /// <summary>
    /// Parses, deduplicates and canonically orders the requested scopes.
    /// </summary>
    /// <param name="requested">The wire spellings.</param>
    /// <returns>The stored spellings, or <see langword="null"/> when the request is unusable.</returns>
    private static List<string>? NormaliseScopes(IReadOnlyList<string>? requested)
    {
        if (requested is null || requested.Count == 0)
        {
            return null;
        }

        var held = new bool[AccessTokenScopes.All.Count];
        foreach (var spelling in requested)
        {
            if (!AccessTokenScopes.TryParse(spelling, out var scope))
            {
                return null;
            }

            held[(int)scope] = true;
        }

        var scopes = new List<string>(AccessTokenScopes.All.Count);
        for (var index = 0; index < held.Length; index++)
        {
            if (held[index])
            {
                scopes.Add(AccessTokenScopes.Format((AccessTokenScope)index));
            }
        }

        return scopes;
    }
}

/// <summary>Reads the acting principal's tokens, newest first.</summary>
/// <remarks>
/// Revoked and expired rows are listed rather than filtered: the list is an audit of what has
/// been able to act as this principal, and an audit that forgets is not one.
/// </remarks>
public sealed class ListAccessTokensHandler(IPersonalAccessTokens tokens)
    : IQueryHandler<ListAccessTokens, Result<IReadOnlyList<PersonalAccessToken>>>
{
    private readonly IPersonalAccessTokens _tokens = tokens;

    /// <summary>Reads the list.</summary>
    /// <param name="query">Carries nothing: tokens belong to whoever is asking.</param>
    /// <param name="cancellationToken">Cancels the read.</param>
    /// <returns>The caller's tokens.</returns>
    public async ValueTask<Result<IReadOnlyList<PersonalAccessToken>>> HandleAsync(
        ListAccessTokens query,
        CancellationToken cancellationToken)
    {
        var tokens = await _tokens.ListOwnAsync(cancellationToken).ConfigureAwait(false);
        return Result.Success(tokens);
    }
}

/// <summary>
/// Revokes one of the acting principal's tokens.
/// </summary>
/// <remarks>
/// Idempotent, and scoped to the caller's own rows in the statement: revoking a token twice, a
/// token that never existed, and a token belonging to somebody else all answer the same way,
/// because telling them apart would let any principal probe which identifiers name rows.
/// </remarks>
public sealed class RevokeAccessTokenHandler(
    IPersonalAccessTokens tokens,
    TimeProvider clock)
    : ICommandHandler<RevokeAccessToken, bool>
{
    /// <summary>Revokes the token.</summary>
    /// <param name="command">The token to revoke.</param>
    /// <param name="cancellationToken">Cancels the write.</param>
    /// <returns>Whether a row changed.</returns>
    public async ValueTask<Result<bool>> HandleAsync(
        RevokeAccessToken command,
        CancellationToken cancellationToken)
    {
        ArgumentNullException.ThrowIfNull(command);

        var revoked = await tokens
            .RevokeOwnAsync(command.Id, clock.GetUtcNow(), cancellationToken)
            .ConfigureAwait(false);

        return Result.Success(revoked);
    }
}
