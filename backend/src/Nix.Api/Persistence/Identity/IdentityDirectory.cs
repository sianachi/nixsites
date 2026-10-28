using Nix.Abstractions;
using Nix.Domain.Identity;
using Nix.Domain.Tenancy;
using Nix.Persistence.Sql.Statements;
using Npgsql;
using NpgsqlTypes;

namespace Nix.Persistence.Identity;

/// <summary>
/// The pre-authentication lookups, over the security-definer resolver and the principal table.
/// </summary>
/// <remarks>
/// <b>These two statements deliberately bypass <c>NixSqlExecutor</c>.</b> That executor refuses to
/// run outside a transaction, because tenant-scoped SQL evaluated without a session context would
/// silently see nothing - a guard worth having, and one these two calls legitimately fail. They run
/// <i>before</i> any transaction exists, by necessity: the transaction is what publishes the
/// session context, and the context cannot be built until these have answered. Both are
/// security-definer functions that take no tenant and return at most one row, so there is nothing
/// for row-level security to scope in the first place.
///
/// They therefore take their own short-lived connection from the data source rather than borrowing
/// the request's. Going around the guard is the point; doing it anywhere else is not.
/// </remarks>
public sealed class IdentityDirectory(NpgsqlDataSource dataSource) : IIdentityDirectory
{
    /// <inheritdoc />
    public async ValueTask<IdentityProviderRegistration?> ResolveProviderAsync(
        string issuer,
        string audience,
        CancellationToken cancellationToken)
    {
        ArgumentException.ThrowIfNullOrWhiteSpace(issuer);
        ArgumentException.ThrowIfNullOrWhiteSpace(audience);

        return await QuerySingleAsync(
            IdentitySql.ResolveProvider,
            [Text("issuer", issuer), Text("audience", audience)],
            static reader => new IdentityProviderRegistration(
                TenantId.From(reader.GetGuid(1)),
                reader.GetString(2),
                reader.GetString(3),
                new Uri(reader.GetString(4), UriKind.Absolute),
                reader.GetFieldValue<string[]>(5),
                IdentityProviderId.From(reader.GetGuid(0)),
                reader.GetBoolean(6),
                reader.IsDBNull(7) ? null : new Uri(reader.GetString(7), UriKind.Absolute)),
            cancellationToken).ConfigureAwait(false);
    }

    /// <inheritdoc />
    public async ValueTask<AuthenticatedPrincipal?> FindExternalPrincipalAsync(
        TenantId tenantId,
        string externalIssuer,
        string externalSubject,
        CancellationToken cancellationToken)
    {
        ArgumentException.ThrowIfNullOrWhiteSpace(externalIssuer);
        ArgumentException.ThrowIfNullOrWhiteSpace(externalSubject);

        return await QuerySingleAsync(
            IdentitySql.FindPrincipalByExternalIdentity,
            [
                new NpgsqlParameter("tenant_id", NpgsqlDbType.Uuid) { Value = tenantId.Value },
                Text("external_issuer", externalIssuer),
                Text("external_subject", externalSubject),
            ],
            static reader => new AuthenticatedPrincipal(
                PrincipalId.From(reader.GetGuid(0)),
                TenantId.From(reader.GetGuid(1)),
                ParseStatus(reader.GetString(2)),
                reader.GetString(3)),
            cancellationToken).ConfigureAwait(false);
    }

    /// <inheritdoc />
    public async ValueTask<AuthenticatedPrincipal?> FindPrincipalByIdAsync(
        TenantId tenantId,
        PrincipalId principalId,
        CancellationToken cancellationToken) =>
        await QuerySingleAsync(
            IdentitySql.FindPrincipalById,
            [
                new NpgsqlParameter("tenant_id", NpgsqlDbType.Uuid) { Value = tenantId.Value },
                new NpgsqlParameter("principal_id", NpgsqlDbType.Uuid) { Value = principalId.Value },
            ],
            static reader => new AuthenticatedPrincipal(
                PrincipalId.From(reader.GetGuid(0)),
                TenantId.From(reader.GetGuid(1)),
                ParseStatus(reader.GetString(2)),
                reader.GetString(3)),
            cancellationToken).ConfigureAwait(false);

    private static NpgsqlParameter Text(string name, string value) =>
        new(name, NpgsqlDbType.Text) { Value = value };

    private async ValueTask<TRow?> QuerySingleAsync<TRow>(
        string sql,
        NpgsqlParameter[] parameters,
        Func<NpgsqlDataReader, TRow> map,
        CancellationToken cancellationToken)
        where TRow : class
    {
        var connection = await dataSource.OpenConnectionAsync(cancellationToken).ConfigureAwait(false);
        await using (connection.ConfigureAwait(false))
        {
#pragma warning disable CA2100 // Review SQL queries for security vulnerabilities
            // Justification: the statement is a const from IdentitySql; every value is bound.
            var command = new NpgsqlCommand(sql, connection);
#pragma warning restore CA2100
            await using (command.ConfigureAwait(false))
            {
                command.Parameters.AddRange(parameters);

                var reader = await command.ExecuteReaderAsync(cancellationToken).ConfigureAwait(false);
                await using (reader.ConfigureAwait(false))
                {
                    return await reader.ReadAsync(cancellationToken).ConfigureAwait(false)
                        ? map(reader)
                        : null;
                }
            }
        }
    }

    /// <summary>
    /// Anything unrecognised is treated as deprovisioned.
    /// </summary>
    /// <remarks>
    /// The opposite of the enum converter's behaviour elsewhere, and deliberately so. This runs on
    /// the authentication path, where the safe reading of "a status this build cannot interpret" is
    /// "do not admit them" rather than an exception that becomes a 500 - and certainly not "active".
    /// </remarks>
    private static PrincipalStatus ParseStatus(string value) => value switch
    {
        "active" => PrincipalStatus.Active,
        "suspended" => PrincipalStatus.Suspended,
        _ => PrincipalStatus.Deprovisioned,
    };
}
