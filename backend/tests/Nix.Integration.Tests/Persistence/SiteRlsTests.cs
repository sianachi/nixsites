using Nix.Integration.Tests.Harness;
using Nix.Persistence;
using Npgsql;

namespace Nix.Integration.Tests.Persistence;

/// <summary>
/// [SEC] The sites tables against the live roles: tenants cannot see or write each other's rows, a
/// build's manifest rows cannot be rewritten or erased by the application, and the collaboration
/// service has no grant on any of them.
/// </summary>
[Collection(PostgresCollectionDefinition.Name)]
public sealed class SiteRlsTests(NixPostgresFixture fixture) : IAsyncLifetime
{
    private static readonly string[] Tables =
    [
        NixTables.Site, NixTables.SiteHostname, NixTables.SiteExclusion, NixTables.SiteDatedCollection, NixTables.SitePage,
        NixTables.SiteRedirect, NixTables.SiteBuild, NixTables.SiteBuildPage, NixTables.SiteBuildFile,
        NixTables.SiteBuildObject, NixTables.SiteActivation, NixTables.SiteOperator,
    ];

    private static CancellationToken Cancellation => TestContext.Current.CancellationToken;

    public async ValueTask InitializeAsync()
    {
        await fixture.ResetAsync();
        await M0SchemaSeed.SeedBothTenantsAsync(fixture);
        await M0SchemaSeed.SeedSitesAsync(fixture);
    }

    public ValueTask DisposeAsync() => ValueTask.CompletedTask;

    public static TheoryData<string> AllTables()
    {
        var data = new TheoryData<string>();
        foreach (var table in Tables)
        {
            data.Add(table);
        }

        return data;
    }

    [Theory]
    [MemberData(nameof(AllTables))]
    public async Task Each_tenant_reads_only_its_own_rows_of_every_sites_table(string table)
    {
        foreach (var (self, other) in new[] { (TestTenants.Alpha, TestTenants.Beta), (TestTenants.Beta, TestTenants.Alpha) })
        {
            await AsAsync(self, async (connection, transaction) =>
            {
                Assert.True(await RawSql.CountAsync(connection, transaction, $"SELECT count(*) FROM {table} WHERE tenant_id = '{self}'") > 0);
                Assert.Equal(0, await RawSql.CountAsync(connection, transaction, $"SELECT count(*) FROM {table} WHERE tenant_id = '{other}'"));
            });
        }
    }

    [Fact]
    public async Task A_tenant_cannot_plant_a_site_or_a_build_under_another_tenant()
    {
        await AsAsync(TestTenants.Alpha, async (connection, transaction) =>
        {
            var site = await Assert.ThrowsAsync<PostgresException>(() => RawSql.ExecuteAsync(
                connection,
                transaction,
                $"""
                INSERT INTO site (tenant_id, id, workspace_id, root_item_id, slug, layout, settings, republish_mode,
                                  debounce_seconds, status, created_by, created_at, updated_at)
                VALUES ('{TestTenants.Beta}', gen_random_uuid(), '{M0SchemaSeed.Beta.WorkspaceId}', '{M0SchemaSeed.Beta.ItemId}',
                        'planted', 'docs', jsonb_build_object(), 'manual', 300, 'draft', '{M0SchemaSeed.Beta.PrincipalId}', now(), now())
                """));
            Assert.Equal(PostgresErrorCodes.InsufficientPrivilege, site.SqlState);
        });

        await AsAsync(TestTenants.Alpha, async (connection, transaction) =>
        {
            var build = await Assert.ThrowsAsync<PostgresException>(() => RawSql.ExecuteAsync(
                connection,
                transaction,
                $"""
                INSERT INTO site_build_object (tenant_id, build_id, key, sha256, byte_length, kind, created_at)
                VALUES ('{TestTenants.Beta}', '{M0SchemaSeed.BuildIdFor(M0SchemaSeed.Beta)}', 'sites/x/index.html', repeat('a', 64), 1, 'build', now())
                """));
            Assert.Equal(PostgresErrorCodes.InsufficientPrivilege, build.SqlState);
        });
    }

    [Theory]
    [InlineData("UPDATE site_build_page SET title = 'rewritten'")]
    [InlineData("DELETE FROM site_build_page")]
    [InlineData("UPDATE site_build_file SET sha256 = repeat('f', 64)")]
    [InlineData("DELETE FROM site_build_file")]
    [InlineData("DELETE FROM site_build")]
    [InlineData("UPDATE site_build_object SET sha256 = repeat('f', 64)")]
    [InlineData("TRUNCATE site_build_page")]
    public async Task A_builds_manifest_cannot_be_rewritten_or_erased_by_the_application(string statement)
    {
        await AsAsync(TestTenants.Alpha, async (connection, transaction) =>
        {
            var refused = await Assert.ThrowsAsync<PostgresException>(() => RawSql.ExecuteAsync(connection, transaction, statement));
            Assert.Equal(PostgresErrorCodes.InsufficientPrivilege, refused.SqlState);
        });
    }

    [Fact]
    public async Task The_application_may_add_and_read_manifest_rows_and_delete_only_object_rows()
    {
        await AsAsync(TestTenants.Alpha, async (connection, transaction) =>
        {
            Assert.Equal(1, await RawSql.ExecuteAsync(
                connection,
                transaction,
                $"""
                INSERT INTO site_build_file
                    (tenant_id, build_id, source_item_id, file_item_id, file_version_id, sha256, media_type, byte_length, created_at)
                VALUES ('{TestTenants.Alpha}', '{M0SchemaSeed.BuildIdFor(M0SchemaSeed.Alpha)}', gen_random_uuid(), gen_random_uuid(),
                        gen_random_uuid(), repeat('e', 64), 'image/webp', 5, now())
                """));
            Assert.Equal(1, await RawSql.ExecuteAsync(connection, transaction, "DELETE FROM site_build_object"));
        });
    }

    [Fact]
    public async Task The_collaboration_service_has_no_grant_on_any_sites_table()
    {
        var connection = await fixture.OpenMigratorConnectionAsync();
        await using (connection.ConfigureAwait(false))
        {
            var granted = await RawSql.TextListAsync(
                connection,
                $"""
                SELECT table_name || ':' || privilege_type
                FROM information_schema.table_privileges
                WHERE table_schema = 'public'
                  AND grantee = '{NixDatabaseRoles.Collaboration}'
                  AND table_name LIKE 'site%'
                """);

            Assert.Empty(granted);
        }
    }

    [Fact]
    public async Task Only_the_application_role_may_run_the_cross_tenant_rebuild_planner()
    {
        var connection = await fixture.OpenMigratorConnectionAsync();
        await using (connection.ConfigureAwait(false))
        {
            const string function = "nix_site_rebuild_candidates(timestamptz, integer)";
            Assert.True(await RawSql.BooleanAsync(connection, $"SELECT has_function_privilege('{NixDatabaseRoles.Application}', '{function}', 'EXECUTE')"));
            Assert.False(await RawSql.BooleanAsync(connection, $"SELECT has_function_privilege('{NixDatabaseRoles.Collaboration}', '{function}', 'EXECUTE')"));
            Assert.False(await RawSql.BooleanAsync(connection, "SELECT has_function_privilege('public', 'nix_site_rebuild_candidates(timestamptz, integer)', 'EXECUTE')"));
            var definition = await RawSql.TextListAsync(
                connection,
                "SELECT pg_get_userbyid(proowner) || '|' || prosecdef::text || '|' || array_to_string(proconfig, ',') FROM pg_proc WHERE proname = 'nix_site_rebuild_candidates'");
            Assert.Equal([$"{NixDatabaseRoles.Migrator}|true|search_path=pg_catalog, public, pg_temp"], definition);
        }
    }

    private async Task AsAsync(Guid tenant, Func<NpgsqlConnection, NpgsqlTransaction, Task> work)
    {
        var connection = await fixture.OpenApplicationConnectionAsync();
        await using (connection.ConfigureAwait(false))
        {
            var transaction = await connection.BeginTransactionAsync(Cancellation);
            await using (transaction.ConfigureAwait(false))
            {
                await RawSql.ExecuteAsync(connection, transaction, $"SELECT set_config('nix.tenant_id', '{tenant}', true)");
                await work(connection, transaction);
            }
        }
    }
}
