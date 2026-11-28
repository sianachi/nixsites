using Microsoft.EntityFrameworkCore;
using Microsoft.EntityFrameworkCore.Storage;
using Nix.Abstractions;
using Nix.Domain.Calendar;
using Nix.Integration.Tests.Harness;
using Npgsql;

namespace Nix.Integration.Tests.Persistence;

/// <summary>
/// [SEC] Calendar sync rows are private to their owner (Amendment 1 A2): no other principal, in the
/// same tenant or another, sees or changes a connection, link, map row or log row; grants are
/// exactly <c>nix_app</c>'s; every SECURITY DEFINER function pins its search path; and a stored
/// refresh token is never the plaintext.
/// </summary>
[Collection(PostgresCollectionDefinition.Name)]
public sealed class CalendarSecurityTests(NixPostgresFixture fixture) : IAsyncLifetime
{
    private static readonly Guid Colleague = new("1c1c1c1c-1111-4111-8111-1c1c1c1c1c1c");

    private static readonly string[] Tables = ["calendar_connection", "calendar_link", "calendar_event_map", "calendar_sync_log"];

    private CalendarSyncHost _host = null!;

    private static CancellationToken Cancellation => TestContext.Current.CancellationToken;

    private static NixSessionContext Peer => TestTenants.ContextFor(TestTenants.Alpha, TestTenants.AlphaWorkspace, Colleague);

    public async ValueTask InitializeAsync()
    {
        await fixture.ResetAsync();
        await M0SchemaSeed.SeedBothTenantsAsync(fixture);
        var connection = await fixture.OpenMigratorConnectionAsync();
        await using (connection.ConfigureAwait(false))
        {
            await RawSql.ExecuteAsync(connection, transaction: null, $"""
                INSERT INTO principal
                    (principal_id, tenant_id, external_subject, kind, display_name, email, status, deprovisioned_at)
                VALUES ('{Colleague}', '{TestTenants.Alpha}', 'alpha-calendar-peer', 'user', 'Peer',
                        'calendar-peer@example.test', 'active', NULL);
                INSERT INTO workspace_member
                    (workspace_id, subject_type, subject_id, tenant_id, role, granted_by, granted_at)
                VALUES ('{TestTenants.AlphaWorkspace}', 'principal', '{Colleague}', '{TestTenants.Alpha}', 'owner',
                        '{TestTenants.AlphaPrincipal}', now());
                """);
        }

        _host = await CalendarSyncHost.StartAsync(fixture);
    }

    public async ValueTask DisposeAsync() => await _host.DisposeAsync();

    [Fact]
    public async Task Another_principal_in_the_same_tenant_or_another_tenant_sees_and_changes_none_of_an_owners_calendar_rows()
    {
        var connectionId = await _host.ConnectAsync(TestTenants.AlphaContext);
        var link = await _host.LinkAsync(TestTenants.AlphaContext, connectionId);

        // The peer owns the workspace the link lives in, and still sees nothing.
        foreach (var context in new[] { Peer, TestTenants.BetaContext })
        {
            await AssertInvisibleAsync(context, connectionId, link.Id);
        }

        var check = await fixture.OpenMigratorConnectionAsync();
        await using (check.ConfigureAwait(false))
        {
            Assert.Equal("active", await RawSql.TextAsync(check, null, $"SELECT status FROM calendar_connection WHERE id = '{connectionId}'"));
            Assert.Equal("two_way", await RawSql.TextAsync(check, null, $"SELECT direction FROM calendar_link WHERE id = '{link.Id}'"));
        }
    }

    private async Task AssertInvisibleAsync(NixSessionContext context, Guid connectionId, Guid linkId)
    {
        var work = await fixture.Application.BeginUnitOfWorkAsync(context, Cancellation);
        await using (work.ConfigureAwait(false))
        {
            Assert.Equal(0, await work.DbContext.Set<CalendarConnection>().CountAsync(row => row.Id == connectionId, Cancellation));
            Assert.Equal(0, await work.DbContext.Set<CalendarLink>().CountAsync(row => row.Id == linkId, Cancellation));
            Assert.Equal(0, await work.DbContext.Set<CalendarEventMap>().CountAsync(row => row.LinkId == linkId, Cancellation));
            Assert.Equal(0, await work.DbContext.Set<CalendarSyncLogEntry>().CountAsync(row => row.LinkId == linkId, Cancellation));

            var connection = (NpgsqlConnection)work.DbContext.Database.GetDbConnection();
            var transaction = (NpgsqlTransaction)work.Transaction.GetDbTransaction();
            Assert.Equal(0, await RawSql.ExecuteAsync(connection, transaction, $"UPDATE calendar_connection SET status = 'revoked' WHERE id = '{connectionId}'"));
            Assert.Equal(0, await RawSql.ExecuteAsync(connection, transaction, $"UPDATE calendar_link SET direction = 'import_only' WHERE id = '{linkId}'"));
            Assert.Equal(0, await RawSql.ExecuteAsync(connection, transaction, $"DELETE FROM calendar_link WHERE id = '{linkId}'"));
            await work.CommitAsync(Cancellation);
        }
    }

    [Fact]
    public async Task A_principal_cannot_plant_a_connection_owned_by_someone_else()
    {
        var work = await fixture.Application.BeginUnitOfWorkAsync(Peer, Cancellation);
        await using (work.ConfigureAwait(false))
        {
            var connection = (NpgsqlConnection)work.DbContext.Database.GetDbConnection();
            var transaction = (NpgsqlTransaction)work.Transaction.GetDbTransaction();
            var failure = await Assert.ThrowsAsync<PostgresException>(async () => await RawSql.ExecuteAsync(connection, transaction, $"""
                INSERT INTO calendar_connection (tenant_id, id, principal_id, provider, account_subject, account_email, status, scopes, created_at, updated_at)
                VALUES ('{TestTenants.Alpha}', gen_random_uuid(), '{TestTenants.AlphaPrincipal}', 'google', 'planted', 'x@example.test', 'active', '', now(), now())
                """));
            Assert.Equal(PostgresErrorCodes.InsufficientPrivilege, failure.SqlState);
        }
    }

    [Fact]
    public async Task Grants_are_exactly_the_application_roles_and_every_definer_pins_its_search_path()
    {
        var connection = await fixture.OpenMigratorConnectionAsync();
        await using (connection.ConfigureAwait(false))
        {
            foreach (var table in Tables)
            {
                var grantees = await RawSql.TextListAsync(connection, $"""
                    SELECT DISTINCT grantee FROM information_schema.role_table_grants
                     WHERE table_schema = 'public' AND table_name = '{table}' AND grantee NOT IN ('nix_migrator')
                     ORDER BY grantee
                    """);
                Assert.Equal(["nix_app"], grantees);
                Assert.Equal(true, await RawSql.BooleanAsync(connection, $"SELECT relforcerowsecurity FROM pg_class WHERE oid = 'public.{table}'::regclass"));
            }

            foreach (var function in new[] { "nix_find_active_calendar_links(integer, uuid)", "nix_purge_calendar_sync_log(integer)" })
            {
                Assert.Equal(true, await RawSql.BooleanAsync(connection, $"SELECT has_function_privilege('nix_app', '{function}', 'EXECUTE')"));
                Assert.Equal(false, await RawSql.BooleanAsync(connection, $"SELECT has_function_privilege('nix_collab', '{function}', 'EXECUTE')"));
            }

            Assert.Equal(false, await RawSql.BooleanAsync(connection,
                "SELECT has_function_privilege('nix_app', 'nix_mark_calendar_link_dirty()', 'EXECUTE')"));

            var paths = await RawSql.TextListAsync(connection, """
                SELECT p.proname || '=' || array_to_string(p.proconfig, ',')
                  FROM pg_proc p
                 WHERE p.prosecdef
                   AND p.proname IN ('nix_find_active_calendar_links', 'nix_mark_calendar_link_dirty', 'nix_purge_calendar_sync_log')
                 ORDER BY p.proname
                """);
            Assert.Equal(3, paths.Count);
            Assert.All(paths, path => Assert.EndsWith("search_path=pg_catalog, public, pg_temp", path, StringComparison.Ordinal));
        }
    }

    [Fact]
    public async Task A_stored_refresh_token_is_never_the_plaintext()
    {
        var connectionId = await _host.ConnectAsync(TestTenants.AlphaContext, refreshToken: "refresh-plaintext-canary");
        var connection = await fixture.OpenMigratorConnectionAsync();
        await using (connection.ConfigureAwait(false))
        {
            Assert.Equal(0, await RawSql.CountAsync(connection, null, $"""
                SELECT count(*) FROM calendar_connection
                 WHERE id = '{connectionId}'
                   AND (position(convert_to('refresh-plaintext-canary', 'UTF8') in refresh_token_protected) > 0
                        OR position(convert_to('refresh-plaintext-canary', 'UTF8') in access_token_protected) > 0)
                """));
            Assert.Equal(1, await RawSql.CountAsync(connection, null, $"SELECT count(*) FROM calendar_connection WHERE id = '{connectionId}' AND refresh_token_protected IS NOT NULL"));
        }
    }

    [Fact]
    public async Task A_temporary_table_cannot_shadow_what_the_finder_reads()
    {
        var link = await _host.LinkAsync(TestTenants.AlphaContext, await _host.ConnectAsync(TestTenants.AlphaContext));
        var connection = await fixture.OpenMigratorConnectionAsync();
        await using (connection.ConfigureAwait(false))
        {
            await RawSql.ExecuteAsync(connection, transaction: null, """
                CREATE TEMP TABLE calendar_link (tenant_id uuid, id uuid, workspace_id uuid, principal_id uuid,
                    container_item_id uuid, connection_id uuid, status text);
                INSERT INTO calendar_link VALUES (gen_random_uuid(), gen_random_uuid(), gen_random_uuid(), gen_random_uuid(),
                    gen_random_uuid(), gen_random_uuid(), 'active');
                """);
            var found = await RawSql.GuidListAsync(connection, transaction: null, "SELECT link_id FROM nix_find_active_calendar_links(500)");
            await RawSql.ExecuteAsync(connection, transaction: null, "DROP TABLE pg_temp.calendar_link");
            Assert.Equal([link.Id], found);
        }
    }
}
