using Nix.Features.People;
using Nix.Persistence.Sql;
using Npgsql;

namespace Nix.Persistence.Identity;

/// <summary>Calls <c>nix_local_list_people</c> and <c>nix_local_set_person_status</c>.</summary>
public sealed class PeopleStore(NpgsqlDataSource dataSource) : IPeopleStore
{
    private readonly PooledSql _db = new(dataSource);

    /// <inheritdoc />
    public async ValueTask<IReadOnlyList<PersonResponse>> ListAsync(Guid tenantId, CancellationToken cancellationToken) =>
        await _db.RowsAsync(
            "SELECT principal_id, email, display_name, status, is_admin, has_password, passkey_count, totp_enabled, created_at FROM nix_local_list_people(@tenant)",
            static reader => new PersonResponse(
                reader.GetGuid(0),
                reader.IsDBNull(1) ? string.Empty : reader.GetString(1),
                reader.GetString(2),
                // The wire word for a suspended person is "disabled"; anything else is passed through.
                reader.GetString(3) is "suspended" ? "disabled" : reader.GetString(3),
                reader.GetBoolean(4),
                reader.GetBoolean(5),
                reader.GetInt32(6),
                reader.GetBoolean(7),
                reader.GetFieldValue<DateTimeOffset>(8)),
            cancellationToken,
            NixParameter.Uuid("tenant", tenantId)).ConfigureAwait(false);

    /// <inheritdoc />
    public async ValueTask<bool> SetDisabledAsync(Guid tenantId, Guid principalId, bool disabled, CancellationToken cancellationToken) =>
        await _db.ScalarAsync<bool>(
            "SELECT nix_local_set_person_status(@tenant, @principal, @status)",
            cancellationToken,
            NixParameter.Uuid("tenant", tenantId),
            NixParameter.Uuid("principal", principalId),
            NixParameter.Text("status", disabled ? "suspended" : "active")).ConfigureAwait(false);
}
