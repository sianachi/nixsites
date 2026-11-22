using Nix.Abstractions;
using Nix.Domain.Identity;
using Nix.Domain.Tenancy;
using Npgsql;
using NpgsqlTypes;
using static Nix.Persistence.Sql.NixParameter;

namespace Nix.Persistence.Identity;

/// <summary>Capability-only Postgres I/O; identity always comes from a standing server session.</summary>
public sealed class CliLoginSessionStore(NpgsqlDataSource dataSource) : ICliLoginSessions
{
    /// <inheritdoc />
    public async ValueTask<bool> StartAsync(string deviceHash, string userHash, CancellationToken cancellationToken) =>
        await ScalarAsync<bool>("SELECT nix_start_cli_login(@device, @user)", cancellationToken,
            Text("device", deviceHash), Text("user", userHash)).ConfigureAwait(false);

    /// <inheritdoc />
    public async ValueTask<DateTimeOffset?> FindPendingAsync(string userHash, CancellationToken cancellationToken) =>
        await ScalarAsync<DateTimeOffset?>("SELECT nix_find_pending_cli_login(@user)", cancellationToken,
            Text("user", userHash)).ConfigureAwait(false);

    /// <inheritdoc />
    public async ValueTask<bool> DecideAsync(string userHash, string browserHash, bool approve, CancellationToken cancellationToken) =>
        await ScalarAsync<bool>("SELECT nix_decide_cli_login(@user, @browser, @approve)", cancellationToken,
            Text("user", userHash), Text("browser", browserHash),
            new NpgsqlParameter("approve", NpgsqlDbType.Boolean) { Value = approve }).ConfigureAwait(false);

    /// <inheritdoc />
    public async ValueTask<CliLoginRedemption> RedeemAsync(
        string deviceHash, BrowserSessionId sessionId, string refreshHash, CancellationToken cancellationToken)
    {
        var connection = await dataSource.OpenConnectionAsync(cancellationToken).ConfigureAwait(false);
        await using (connection.ConfigureAwait(false))
        {
            var command = Command("SELECT * FROM nix_redeem_cli_login(@device, @session, @refresh)", connection,
                Text("device", deviceHash), Text("refresh", refreshHash),
                new NpgsqlParameter("session", NpgsqlDbType.Uuid) { Value = sessionId.Value });
            await using (command.ConfigureAwait(false))
            {
                var reader = await command.ExecuteReaderAsync(cancellationToken).ConfigureAwait(false);
                await using (reader.ConfigureAwait(false))
                {
                    if (!await reader.ReadAsync(cancellationToken).ConfigureAwait(false))
                    {
                        return new CliLoginRedemption("expired", null);
                    }

                    var status = reader.GetString(0);
                    return new CliLoginRedemption(status, status == "approved"
                        ? await ReadSessionAsync(reader, 1, cancellationToken).ConfigureAwait(false)
                        : null);
                }
            }
        }
    }

    /// <inheritdoc />
    public async ValueTask<AuthenticatedBrowserSession?> FindByRefreshHashAsync(string refreshHash, CancellationToken cancellationToken)
    {
        var connection = await dataSource.OpenConnectionAsync(cancellationToken).ConfigureAwait(false);
        await using (connection.ConfigureAwait(false))
        {
            var command = Command("SELECT * FROM nix_resolve_cli_session(@refresh)", connection, Text("refresh", refreshHash));
            await using (command.ConfigureAwait(false))
            {
                var reader = await command.ExecuteReaderAsync(cancellationToken).ConfigureAwait(false);
                await using (reader.ConfigureAwait(false))
                {
                    return await reader.ReadAsync(cancellationToken).ConfigureAwait(false)
                        ? await ReadSessionAsync(reader, 0, cancellationToken).ConfigureAwait(false)
                        : null;
                }
            }
        }
    }

    /// <inheritdoc />
    public async ValueTask RevokeAsync(string refreshHash, CancellationToken cancellationToken) =>
        _ = await ScalarAsync<object?>("SELECT nix_revoke_cli_session(@refresh)", cancellationToken,
            Text("refresh", refreshHash)).ConfigureAwait(false);

    private async ValueTask<T> ScalarAsync<T>(string sql, CancellationToken cancellationToken, params NpgsqlParameter[] parameters)
    {
        var connection = await dataSource.OpenConnectionAsync(cancellationToken).ConfigureAwait(false);
        await using (connection.ConfigureAwait(false))
        {
            var command = Command(sql, connection, parameters);
            await using (command.ConfigureAwait(false))
            {
                var result = await command.ExecuteScalarAsync(cancellationToken).ConfigureAwait(false);
                if (result is DateTime instant && typeof(T) == typeof(DateTimeOffset?))
                {
                    return (T)(object)new DateTimeOffset(instant);
                }

                return result is null or DBNull ? default! : (T)result;
            }
        }
    }

    private static NpgsqlCommand Command(string sql, NpgsqlConnection connection, params NpgsqlParameter[] parameters)
    {
#pragma warning disable CA2100 // Only constant, reviewed SQL above reaches this helper; all caller values are bound.
        var command = new NpgsqlCommand(sql, connection);
#pragma warning restore CA2100
        command.Parameters.AddRange(parameters);
        return command;
    }

    private static async ValueTask<AuthenticatedBrowserSession> ReadSessionAsync(NpgsqlDataReader reader, int offset, CancellationToken cancellationToken) =>
        new(BrowserSessionId.From(reader.GetGuid(offset)), TenantId.From(reader.GetGuid(offset + 1)),
            PrincipalId.From(reader.GetGuid(offset + 2)), PrincipalStatus.Active, reader.GetString(offset + 4),
            await reader.GetFieldValueAsync<DateTimeOffset>(offset + 5, cancellationToken).ConfigureAwait(false));
}
