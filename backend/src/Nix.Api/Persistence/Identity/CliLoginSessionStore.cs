using Nix.Abstractions;
using Nix.Domain.Identity;
using Nix.Domain.Tenancy;
using Nix.Persistence.Sql;
using Npgsql;
using static Nix.Persistence.Sql.NixParameter;

namespace Nix.Persistence.Identity;

/// <summary>Capability-only Postgres I/O; identity always comes from a standing server session.</summary>
public sealed class CliLoginSessionStore(NpgsqlDataSource dataSource) : ICliLoginSessions
{
    private readonly PooledSql _db = new(dataSource);

    /// <inheritdoc />
    public async ValueTask<bool> StartAsync(string deviceHash, string userHash, CancellationToken cancellationToken) =>
        await _db.ScalarAsync<bool>("SELECT nix_start_cli_login(@device, @user)", cancellationToken,
            Text("device", deviceHash), Text("user", userHash)).ConfigureAwait(false) is true;

    /// <inheritdoc />
    public ValueTask<DateTimeOffset?> FindPendingAsync(string userHash, CancellationToken cancellationToken) =>
        _db.ScalarAsync<DateTimeOffset>("SELECT nix_find_pending_cli_login(@user)", cancellationToken, Text("user", userHash));

    /// <inheritdoc />
    public async ValueTask<bool> DecideAsync(string userHash, string browserHash, bool approve, CancellationToken cancellationToken) =>
        await _db.ScalarAsync<bool>("SELECT nix_decide_cli_login(@user, @browser, @approve)", cancellationToken,
            Text("user", userHash), Text("browser", browserHash),
            NixParameter.Boolean("approve", approve)).ConfigureAwait(false) is true;

    /// <inheritdoc />
    public async ValueTask<CliLoginRedemption> RedeemAsync(
        string deviceHash, BrowserSessionId sessionId, string refreshHash, CancellationToken cancellationToken) =>
        (await _db.RowsAsync("SELECT * FROM nix_redeem_cli_login(@device, @session, @refresh)",
            static reader =>
            {
                var status = reader.GetString(0);
                return new CliLoginRedemption(status, status == "approved" ? ReadSession(reader, 1) : null);
            },
            cancellationToken,
            Text("device", deviceHash), Text("refresh", refreshHash),
            NixParameter.Uuid("session", sessionId.Value)).ConfigureAwait(false))
        .FirstOrDefault() ?? new CliLoginRedemption("expired", null);

    /// <inheritdoc />
    public async ValueTask<AuthenticatedBrowserSession?> FindByRefreshHashAsync(string refreshHash, CancellationToken cancellationToken) =>
        (await _db.RowsAsync("SELECT * FROM nix_resolve_cli_session(@refresh)", static reader => ReadSession(reader, 0),
            cancellationToken, Text("refresh", refreshHash)).ConfigureAwait(false)).FirstOrDefault();

    /// <inheritdoc />
    public async ValueTask RevokeAsync(string refreshHash, CancellationToken cancellationToken) =>
        _ = await _db.RowsAsync("SELECT nix_revoke_cli_session(@refresh)", static _ => 0,
            cancellationToken, Text("refresh", refreshHash)).ConfigureAwait(false);

    private static AuthenticatedBrowserSession ReadSession(NpgsqlDataReader reader, int offset) =>
        new(BrowserSessionId.From(reader.GetGuid(offset)), TenantId.From(reader.GetGuid(offset + 1)),
            PrincipalId.From(reader.GetGuid(offset + 2)), PrincipalStatus.Active, reader.GetString(offset + 4),
            reader.GetFieldValue<DateTimeOffset>(offset + 5));
}
