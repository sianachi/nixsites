using Microsoft.EntityFrameworkCore;
using Nix.Abstractions;
using Nix.Domain.Identity;
using Nix.Domain.Tenancy;
using Nix.Persistence.Sql.Statements;
using Npgsql;
using NpgsqlTypes;

namespace Nix.Persistence.Tokens;

/// <summary>
/// Reads and writes personal access tokens: the pre-authentication resolve on its own
/// connection, and the session-scoped CRUD through the unit of work.
/// </summary>
/// <remarks>
/// <para>
/// <see cref="FindForExchangeAsync"/> follows <c>IdentityDirectory</c>'s shape exactly, and for
/// the reason recorded there: it runs before any transaction exists, so it takes a short-lived
/// connection from the data source and goes through a security-definer function that returns at
/// most one row. Everything else here runs on the request's context, inside the transaction that
/// published the session, and takes the acting principal from the session context - never as a
/// parameter.
/// </para>
/// </remarks>
public sealed class PersonalAccessTokenStore(
    NpgsqlDataSource dataSource,
    NixDbContext context,
    INixSessionContextAccessor session)
    : IPersonalAccessTokens
{
    // The window last_used_at is coarsened to. Matches the caller's own granularity in the
    // unit-of-work middleware; the two must agree, because the statement's guard and the caller's
    // skip are the same decision made in two places.
    private static readonly TimeSpan LastUsedTouchInterval = TimeSpan.FromMinutes(5);

    private readonly NixDbContext _context = context;
    private readonly INixSessionContextAccessor _session = session;

    private PrincipalId Principal => (_session.Current
        ?? throw new InvalidOperationException(
            "No session context has been established for this unit of work. Tokens belong to a "
            + "specific principal in a specific tenant; there is no anonymous path."))
        .PrincipalId;

    /// <inheritdoc />
    public async ValueTask<AccessTokenExchangeCandidate?> FindForExchangeAsync(
        string lookup,
        CancellationToken cancellationToken)
    {
        ArgumentException.ThrowIfNullOrWhiteSpace(lookup);

        var connection = await dataSource.OpenConnectionAsync(cancellationToken).ConfigureAwait(false);
        await using (connection.ConfigureAwait(false))
        {
#pragma warning disable CA2100 // Review SQL queries for security vulnerabilities
            // Justification: the statement is a const from AccessTokenSql; every value is bound.
            var command = new NpgsqlCommand(AccessTokenSql.ResolveForExchange, connection);
#pragma warning restore CA2100
            await using (command.ConfigureAwait(false))
            {
                command.Parameters.Add(
                    new NpgsqlParameter("lookup", NpgsqlDbType.Text) { Value = lookup });

                var reader = await command.ExecuteReaderAsync(cancellationToken).ConfigureAwait(false);
                await using (reader.ConfigureAwait(false))
                {
                    if (!await reader.ReadAsync(cancellationToken).ConfigureAwait(false))
                    {
                        return null;
                    }

                    return new AccessTokenExchangeCandidate(
                        PersonalAccessTokenId.From(reader.GetGuid(0)),
                        TenantId.From(reader.GetGuid(1)),
                        PrincipalId.From(reader.GetGuid(2)),
                        ParseStatus(reader.GetString(3)),
                        await reader.GetFieldValueAsync<byte[]>(4, cancellationToken).ConfigureAwait(false),
                        await reader.GetFieldValueAsync<string[]>(5, cancellationToken).ConfigureAwait(false),
                        await reader.GetFieldValueAsync<DateTimeOffset>(6, cancellationToken).ConfigureAwait(false),
                        await reader.IsDBNullAsync(7, cancellationToken).ConfigureAwait(false)
                            ? null
                            : await reader.GetFieldValueAsync<DateTimeOffset>(7, cancellationToken).ConfigureAwait(false));
                }
            }
        }
    }

    /// <inheritdoc />
    public async ValueTask<IReadOnlyList<PersonalAccessToken>> ListOwnAsync(
        CancellationToken cancellationToken)
    {
        var principal = Principal;
        return await _context.PersonalAccessTokens
            .Where(token => token.PrincipalId == principal)
            .OrderByDescending(token => token.CreatedAt)
            .ToListAsync(cancellationToken)
            .ConfigureAwait(false);
    }

    /// <inheritdoc />
    public async ValueTask<int> CountLiveAsync(DateTimeOffset now, CancellationToken cancellationToken)
    {
        var principal = Principal;
        return await _context.PersonalAccessTokens
            .Where(token => token.PrincipalId == principal
                && token.RevokedAt == null
                && token.ExpiresAt > now)
            .CountAsync(cancellationToken)
            .ConfigureAwait(false);
    }

    /// <inheritdoc />
    public async ValueTask AddAsync(PersonalAccessToken token, CancellationToken cancellationToken)
    {
        ArgumentNullException.ThrowIfNull(token);

        _context.PersonalAccessTokens.Add(token);
        await _context.SaveChangesAsync(cancellationToken).ConfigureAwait(false);
    }

    /// <inheritdoc />
    public async ValueTask<bool> RevokeOwnAsync(
        PersonalAccessTokenId id,
        DateTimeOffset at,
        CancellationToken cancellationToken)
    {
        var principal = Principal;

        // The principal predicate is the ownership check, inside the statement: a row that is not
        // the caller's is a row this update does not match, indistinguishable from one that does
        // not exist. Already-revoked rows are left alone so the first revocation's timestamp is
        // the one the audit keeps.
        var changed = await _context.PersonalAccessTokens
            .Where(token => token.Id == id
                && token.PrincipalId == principal
                && token.RevokedAt == null)
            .ExecuteUpdateAsync(
                setters => setters.SetProperty(token => token.RevokedAt, (DateTimeOffset?)at),
                cancellationToken)
            .ConfigureAwait(false);

        return changed > 0;
    }

    /// <inheritdoc />
    public async ValueTask<AccessTokenSessionState?> FindSessionStateAsync(
        PersonalAccessTokenId id,
        CancellationToken cancellationToken)
    {
        return await _context.PersonalAccessTokens
            .Where(token => token.Id == id)
            .Select(token => new AccessTokenSessionState(
                token.PrincipalId,
                token.Scopes,
                token.ExpiresAt,
                token.RevokedAt,
                token.LastUsedAt))
            .FirstOrDefaultAsync(cancellationToken)
            .ConfigureAwait(false);
    }

    /// <inheritdoc />
    public async ValueTask TouchAsync(
        PersonalAccessTokenId id,
        DateTimeOffset at,
        CancellationToken cancellationToken)
    {
        var principal = Principal;

        // The staleness guard is in the statement, not only in the caller. The middleware already
        // skips the touch when last_used_at is fresh, but many requests on one hot token read the
        // same stale value at the start of their transactions and would all queue on the row.
        // With the guard, a waiter that wakes to find the column already advanced re-checks under
        // EvalPlanQual and proceeds without writing - which is what keeps a burst of parallel
        // requests on one token from serialising. The principal predicate makes the ownership the
        // statement enforces visible at the call site, the standard this file sets elsewhere.
        var threshold = at - LastUsedTouchInterval;
        await _context.PersonalAccessTokens
            .Where(token => token.Id == id
                && token.PrincipalId == principal
                && (token.LastUsedAt == null || token.LastUsedAt < threshold))
            .ExecuteUpdateAsync(
                setters => setters.SetProperty(token => token.LastUsedAt, (DateTimeOffset?)at),
                cancellationToken)
            .ConfigureAwait(false);
    }

    /// <summary>
    /// Anything unrecognised is treated as deprovisioned - the same fail-closed reading
    /// <c>IdentityDirectory</c> gives a status this build cannot interpret, on the same
    /// authentication path.
    /// </summary>
    private static PrincipalStatus ParseStatus(string value) => value switch
    {
        "active" => PrincipalStatus.Active,
        "suspended" => PrincipalStatus.Suspended,
        _ => PrincipalStatus.Deprovisioned,
    };
}
