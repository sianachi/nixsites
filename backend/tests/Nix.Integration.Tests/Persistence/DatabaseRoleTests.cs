using Nix.Integration.Tests.Harness;
using Npgsql;

namespace Nix.Integration.Tests.Persistence;

/// <summary>
/// The database's own account of what each role may do, read from the catalogue and from
/// attempted operations - never from documentation.
/// </summary>
/// <remarks>
/// Every isolation test in this suite is worthless if the runtime role can bypass policies or
/// change the schema. These assertions are the foundation the others stand on, so they interrogate
/// the live cluster rather than the SQL that was supposed to have configured it.
/// </remarks>
[Collection(PostgresSecondaryCollectionDefinition.Name)]
public sealed class DatabaseRoleTests
{
    private readonly NixPostgresFixture _fixture;

    public DatabaseRoleTests(NixPostgresFixture fixture) => _fixture = fixture;

    [Fact]
    public async Task The_application_role_cannot_bypass_row_level_security()
    {
        var connection = await _fixture.OpenApplicationConnectionAsync();
        await using (connection.ConfigureAwait(false))
        {
            var canBypass = await RawSql.BooleanAsync(
                connection,
                $"SELECT rolbypassrls FROM pg_roles WHERE rolname = '{NixDatabaseRoles.Application}'");

            Assert.False(canBypass);
        }
    }

    [Fact]
    public async Task The_migration_role_is_the_only_non_superuser_that_can_bypass_row_level_security()
    {
        var connection = await _fixture.OpenMigratorConnectionAsync();
        await using (connection.ConfigureAwait(false))
        {
            // Superusers are excluded because the attribute is implied for them; the cluster
            // superuser exists only to provision the roles and is never used by the application.
            var roles = await RawSql.TextListAsync(
                connection,
                "SELECT rolname FROM pg_roles WHERE rolbypassrls AND NOT rolsuper ORDER BY rolname");

            Assert.Equal([NixDatabaseRoles.Migrator], roles);
        }
    }

    [Fact]
    public async Task The_application_role_cannot_create_objects_in_the_schema()
    {
        var connection = await _fixture.OpenApplicationConnectionAsync();
        await using (connection.ConfigureAwait(false))
        {
            var failure = await Assert.ThrowsAsync<PostgresException>(
                async () => await RawSql.ExecuteAsync(
                    connection,
                    transaction: null,
                    "CREATE TABLE application_role_should_not_be_able_to_create_this (id integer)"));

            Assert.Equal(PostgresErrorCodes.InsufficientPrivilege, failure.SqlState);
        }
    }

    [Fact]
    public async Task The_application_role_cannot_disable_row_level_security_on_a_table()
    {
        var connection = await _fixture.OpenApplicationConnectionAsync();
        await using (connection.ConfigureAwait(false))
        {
            // Turning the policy off is a shorter route to every tenant's data than defeating it.
            // Only the table owner may, and the runtime role owns nothing.
            var failure = await Assert.ThrowsAsync<PostgresException>(
                async () => await RawSql.ExecuteAsync(
                    connection,
                    transaction: null,
                    $"ALTER TABLE {RlsProbeSchema.TableName} DISABLE ROW LEVEL SECURITY"));

            Assert.Equal(PostgresErrorCodes.InsufficientPrivilege, failure.SqlState);
        }
    }

    [Fact]
    public async Task The_application_role_cannot_add_a_permissive_policy_of_its_own()
    {
        var connection = await _fixture.OpenApplicationConnectionAsync();
        await using (connection.ConfigureAwait(false))
        {
            var failure = await Assert.ThrowsAsync<PostgresException>(
                async () => await RawSql.ExecuteAsync(
                    connection,
                    transaction: null,
                    $"CREATE POLICY see_everything ON {RlsProbeSchema.TableName} USING (true)"));

            Assert.Equal(PostgresErrorCodes.InsufficientPrivilege, failure.SqlState);
        }
    }

    [Fact]
    public async Task Every_security_definer_function_searches_the_temporary_schema_last()
    {
        var connection = await _fixture.OpenMigratorConnectionAsync();
        await using (connection.ConfigureAwait(false))
        {
            // Without pg_temp in the list, Postgres searches the caller's temporary schema first
            // for relations, so a caller could shadow a table the function names and run a
            // trigger of their own as the owner. Listed last, it can shadow nothing in public.
            var unsafeFunctions = await RawSql.TextListAsync(
                connection,
                """
                SELECT p.oid::regprocedure::text
                         || ' [' || coalesce(array_to_string(p.proconfig, '; '), 'no config') || ']'
                FROM pg_proc p
                JOIN pg_namespace n ON n.oid = p.pronamespace
                WHERE n.nspname = 'public'
                  AND p.prosecdef
                  AND NOT EXISTS (
                      SELECT 1
                      FROM unnest(p.proconfig) AS setting
                      WHERE setting ~ '^search_path=(.*,\s*)?"?pg_temp"?$')
                ORDER BY 1
                """);

            Assert.Empty(unsafeFunctions);
        }
    }

    [Fact]
    public async Task Every_security_definer_function_is_owned_by_the_migration_role()
    {
        var connection = await _fixture.OpenMigratorConnectionAsync();
        await using (connection.ConfigureAwait(false))
        {
            // The hardening migration alters search paths in place, which only the owner may do.
            var owners = await RawSql.TextListAsync(
                connection,
                """
                SELECT DISTINCT pg_get_userbyid(p.proowner)::text
                FROM pg_proc p
                JOIN pg_namespace n ON n.oid = p.pronamespace
                WHERE n.nspname = 'public' AND p.prosecdef
                ORDER BY 1
                """);

            Assert.Equal([NixDatabaseRoles.Migrator], owners);
        }
    }

    [Theory]
    [InlineData(NixDatabaseRoles.Application)]
    [InlineData(NixDatabaseRoles.Collaboration)]
    [InlineData(NixDatabaseRoles.Backup)]
    public async Task Service_roles_cannot_create_temporary_objects(string role)
    {
        var connection = await _fixture.OpenMigratorConnectionAsync();
        await using (connection.ConfigureAwait(false))
        {
            // The second wall behind the pinned search paths: with no temporary schema of its
            // own, a service role has nowhere to put a shadowing relation.
            var mayCreateTemporary = await RawSql.BooleanAsync(
                connection,
                $"SELECT has_database_privilege('{role}', current_database(), 'TEMPORARY')");

            Assert.False(mayCreateTemporary);
        }
    }

    [Fact]
    public async Task The_backup_role_can_neither_log_in_nor_bypass_row_level_security()
    {
        var connection = await _fixture.OpenMigratorConnectionAsync();
        await using (connection.ConfigureAwait(false))
        {
            var attributes = await RawSql.TextAsync(
                connection,
                null,
                $"SELECT rolcanlogin || ',' || rolbypassrls || ',' || rolsuper FROM pg_roles WHERE rolname = '{NixDatabaseRoles.Backup}'");

            Assert.Equal("false,false,false", attributes);
        }
    }

    [Fact]
    public async Task The_application_role_cannot_create_a_temporary_table()
    {
        var connection = await _fixture.OpenApplicationConnectionAsync();
        await using (connection.ConfigureAwait(false))
        {
            var failure = await Assert.ThrowsAsync<PostgresException>(
                async () => await RawSql.ExecuteAsync(
                    connection,
                    transaction: null,
                    "CREATE TEMPORARY TABLE worker_job (job_id uuid)"));

            Assert.Equal(PostgresErrorCodes.InsufficientPrivilege, failure.SqlState);
        }
    }

    [Fact]
    public async Task Row_level_security_is_enabled_and_forced_on_every_tenant_scoped_table()
    {
        var connection = await _fixture.OpenMigratorConnectionAsync();
        await using (connection.ConfigureAwait(false))
        {
            // Enabled without forced would exempt the table owner. The owner is nix_migrator,
            // which bypasses anyway, but the tenancy goal will add tables owned by roles that do
            // not - so the shape is asserted from the start.
            var unprotected = await RawSql.TextListAsync(
                connection,
                """
                SELECT c.relname
                FROM pg_class c
                JOIN pg_namespace n ON n.oid = c.relnamespace
                WHERE n.nspname = 'public'
                  AND c.relkind = 'r'
                  AND c.relname NOT LIKE '\_\_%'
                  AND (NOT c.relrowsecurity OR NOT c.relforcerowsecurity)
                ORDER BY c.relname
                """);

            Assert.Empty(unprotected);
        }
    }
}
