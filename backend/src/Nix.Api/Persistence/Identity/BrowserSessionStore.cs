using Microsoft.EntityFrameworkCore;
using Nix.Abstractions;
using Nix.Domain.Identity;
using Nix.Domain.Tenancy;
using Nix.Persistence.Sql;
using Nix.Persistence.Sql.Statements;
using Npgsql;
using NpgsqlTypes;

namespace Nix.Persistence.Identity;

/// <summary>Postgres browser-session storage with exact pre-authentication resolvers.</summary>
public sealed class BrowserSessionStore(
    NpgsqlDataSource dataSource,
    NixDbContext context,
    INixSessionContextAccessor sessionContext) : IBrowserSessions
{
    private readonly PooledSql _db = new(dataSource);

    /// <inheritdoc />
    public ValueTask<AuthenticatedBrowserSession?> FindByTokenHashAsync(
        string tokenHash,
        CancellationToken cancellationToken)
    {
        ArgumentException.ThrowIfNullOrWhiteSpace(tokenHash);
        return ResolveAsync(
            BrowserSessionSql.ResolveByTokenHash,
            new NpgsqlParameter("token_hash", NpgsqlDbType.Text) { Value = tokenHash },
            cancellationToken);
    }

    /// <inheritdoc />
    public ValueTask<AuthenticatedBrowserSession?> FindByIdAsync(
        BrowserSessionId id,
        CancellationToken cancellationToken) => ResolveAsync(
            BrowserSessionSql.ResolveById,
            new NpgsqlParameter("session_id", NpgsqlDbType.Uuid) { Value = id.Value },
            cancellationToken);

    /// <inheritdoc />
    public async ValueTask AddAsync(BrowserSession session, CancellationToken cancellationToken)
    {
        ArgumentNullException.ThrowIfNull(session);
        AssertActor(session.TenantId, session.PrincipalId);
        context.BrowserSessions.Add(session);
        await context.SaveChangesAsync(cancellationToken).ConfigureAwait(false);
    }

    /// <inheritdoc />
    public async ValueTask<bool> RevokeAsync(
        BrowserSessionId id,
        DateTimeOffset revokedAt,
        CancellationToken cancellationToken)
    {
        var actor = sessionContext.Current
            ?? throw new InvalidOperationException("A browser session can only be revoked inside a unit of work.");
        var changed = await context.BrowserSessions
            .Where(session => session.Id == id
                && session.TenantId == actor.TenantId
                && session.PrincipalId == actor.PrincipalId
                && session.RevokedAt == null)
            .ExecuteUpdateAsync(
                setters => setters.SetProperty(session => session.RevokedAt, (DateTimeOffset?)revokedAt),
                cancellationToken)
            .ConfigureAwait(false);
        return changed > 0;
    }

    private void AssertActor(TenantId tenantId, PrincipalId principalId)
    {
        var actor = sessionContext.Current
            ?? throw new InvalidOperationException("A browser session can only be created inside a unit of work.");
        if (actor.TenantId != tenantId || actor.PrincipalId != principalId)
        {
            throw new InvalidOperationException("A browser session cannot be created for a different actor.");
        }
    }

    private async ValueTask<AuthenticatedBrowserSession?> ResolveAsync(
        string sql,
        NpgsqlParameter parameter,
        CancellationToken cancellationToken) =>
        (await _db.RowsAsync(sql,
            static reader => new AuthenticatedBrowserSession(
                BrowserSessionId.From(reader.GetGuid(0)),
                TenantId.From(reader.GetGuid(1)),
                PrincipalId.From(reader.GetGuid(2)),
                ParseStatus(reader.GetString(3)),
                reader.GetString(4),
                reader.GetFieldValue<DateTimeOffset>(5)),
            cancellationToken, parameter).ConfigureAwait(false)).FirstOrDefault();

    private static PrincipalStatus ParseStatus(string value) => value switch
    {
        "active" => PrincipalStatus.Active,
        "suspended" => PrincipalStatus.Suspended,
        _ => PrincipalStatus.Deprovisioned,
    };
}
