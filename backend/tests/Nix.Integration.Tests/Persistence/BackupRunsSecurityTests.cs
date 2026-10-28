using Nix.Integration.Tests.Harness;
using Npgsql;

namespace Nix.Integration.Tests.Persistence;

/// <summary>
/// The nightly backup log is instance-wide: no tenant owns a row, so isolation comes from the
/// capability-only shape. Only the superuser acting as <c>nix_backup</c> can write, only
/// <c>nix_app</c> can read, and neither can touch the table itself.
/// </summary>
[Collection(PostgresCollectionDefinition.Name)]
public sealed class BackupRunsSecurityTests(NixPostgresFixture fixture) : IAsyncLifetime
{
    private const string Writer = "nix_record_backup_run(timestamptz, timestamptz, text, text, text, bigint, text)";
    private const string Reader = "nix_backup_runs(integer)";

    public async ValueTask InitializeAsync() => await fixture.ResetAsync();

    public ValueTask DisposeAsync() => ValueTask.CompletedTask;

    [Theory]
    [InlineData(Writer, "nix_backup")]
    [InlineData(Reader, "nix_app")]
    public async Task Each_function_is_executable_by_exactly_its_one_service_role(string function, string allowed)
    {
        var connection = await fixture.OpenMigratorConnectionAsync();
        await using (connection.ConfigureAwait(false))
        {
            foreach (var role in new[] { "nix_app", "nix_collab", "nix_backup" })
            {
                var may = await RawSql.BooleanAsync(connection, $"SELECT has_function_privilege('{role}', '{function}', 'EXECUTE')");
                Assert.Equal(role == allowed, may);
            }

            Assert.Equal(0, await RawSql.CountAsync(connection, null, $"""
                SELECT count(*) FROM pg_proc p, aclexplode(p.proacl) acl
                 WHERE p.oid = '{function}'::regprocedure AND acl.grantee = 0
                """));
        }
    }

    [Fact]
    public async Task The_backup_role_can_record_a_run_but_cannot_touch_the_table()
    {
        var connection = await fixture.OpenSuperuserConnectionAsync();
        await using (connection.ConfigureAwait(false))
        {
            await RawSql.ExecuteAsync(connection, null, "SET ROLE nix_backup");
            await RecordAsync(connection, "'2026-10-14T01:00:00Z'", "'2026-10-14T01:05:00Z'", "'local'", "'succeeded'", "NULL", "1048576", "NULL");

            foreach (var statement in new[]
            {
                "SELECT count(*) FROM backup_runs",
                "INSERT INTO backup_runs (started_at, finished_at, step, status) VALUES (now(), now(), 'local', 'succeeded')",
                "UPDATE backup_runs SET status = 'succeeded'",
                "DELETE FROM backup_runs",
            })
            {
                var failure = await Assert.ThrowsAsync<PostgresException>(() => RawSql.ExecuteAsync(connection, null, statement));
                Assert.Equal(PostgresErrorCodes.InsufficientPrivilege, failure.SqlState);
            }
        }
    }

    [Fact]
    public async Task The_application_role_reads_recorded_runs_newest_first_through_the_function_only()
    {
        var writer = await fixture.OpenSuperuserConnectionAsync();
        await using (writer.ConfigureAwait(false))
        {
            await RawSql.ExecuteAsync(writer, null, "SET ROLE nix_backup");
            await RecordAsync(writer, "'2026-10-13T01:00:00Z'", "'2026-10-13T01:05:00Z'", "'local'", "'succeeded'", "NULL", "10", "NULL");
            await RecordAsync(writer, "'2026-10-14T01:00:00Z'", "'2026-10-14T01:01:00Z'", "'offsite'", "'failed'", "NULL", "NULL", "'off-host push failed (exit 1)'");
            await RecordAsync(writer, "'2026-10-12T01:00:00Z'", "'2026-10-12T01:05:00Z'", "'offsite'", "'succeeded'", "'0123abcd'", "10", "''");
        }

        var app = await fixture.OpenApplicationConnectionAsync();
        await using (app.ConfigureAwait(false))
        {
            Assert.Equal(
                ["2026-10-14|offsite|failed", "2026-10-13|local|succeeded", "2026-10-12|offsite|succeeded"],
                await RawSql.TextListAsync(app, "SELECT to_char(started_at AT TIME ZONE 'UTC', 'YYYY-MM-DD') || '|' || step || '|' || status FROM nix_backup_runs(5)"));
            Assert.Equal(
                ["off-host push failed (exit 1)"],
                await RawSql.TextListAsync(app, "SELECT error FROM nix_backup_runs(5) WHERE status = 'failed'"));
            Assert.Equal(["0123abcd"], await RawSql.TextListAsync(app, "SELECT snapshot_id FROM nix_backup_runs(5) WHERE snapshot_id IS NOT NULL"));
        }
    }

    [Fact]
    public async Task Recording_a_run_drops_runs_started_more_than_six_months_before_it()
    {
        var writer = await fixture.OpenSuperuserConnectionAsync();
        await using (writer.ConfigureAwait(false))
        {
            await RawSql.ExecuteAsync(writer, null, "SET ROLE nix_backup");
            await RecordAsync(writer, "'2026-04-14T00:59:59Z'", "'2026-04-14T00:59:59Z'", "'local'", "'succeeded'", "NULL", "10", "NULL");
            await RecordAsync(writer, "'2026-04-14T01:00:00Z'", "'2026-04-14T01:05:00Z'", "'offsite'", "'succeeded'", "NULL", "10", "NULL");
            await RecordAsync(writer, "'2026-10-14T01:00:00Z'", "'2026-10-14T01:05:00Z'", "'local'", "'succeeded'", "NULL", "10", "NULL");
        }

        var app = await fixture.OpenApplicationConnectionAsync();
        await using (app.ConfigureAwait(false))
        {
            // The cutoff is 2026-04-14T01:00Z: the run one second before it goes, the run exactly at it stays.
            Assert.Equal(
                ["2026-10-14|local", "2026-04-14|offsite"],
                await RawSql.TextListAsync(app, "SELECT to_char(started_at AT TIME ZONE 'UTC', 'YYYY-MM-DD') || '|' || step FROM nix_backup_runs(10)"));
        }
    }

    [Fact]
    public async Task The_limit_is_clamped_to_between_one_and_one_hundred()
    {
        var migrator = await fixture.OpenMigratorConnectionAsync();
        await using (migrator.ConfigureAwait(false))
        {
            await RawSql.ExecuteAsync(migrator, null, """
                INSERT INTO backup_runs (started_at, finished_at, step, status)
                SELECT t, t, 'local', 'succeeded' FROM generate_series('2026-01-01'::timestamptz, '2026-04-15'::timestamptz, '1 day') AS t
                """);
        }

        var app = await fixture.OpenApplicationConnectionAsync();
        await using (app.ConfigureAwait(false))
        {
            Assert.Equal(["1", "1", "1", "100", "100"], await RawSql.TextListAsync(app, """
                SELECT (SELECT count(*) FROM nix_backup_runs(0))::text
                UNION ALL SELECT (SELECT count(*) FROM nix_backup_runs(-5))::text
                UNION ALL SELECT (SELECT count(*) FROM nix_backup_runs(NULL))::text
                UNION ALL SELECT (SELECT count(*) FROM nix_backup_runs(100))::text
                UNION ALL SELECT (SELECT count(*) FROM nix_backup_runs(1000))::text
                """));
        }
    }

    [Theory]
    [InlineData("'x'", "'succeeded'", "NULL", "NULL")] // unknown step
    [InlineData("'local'", "'x'", "NULL", "NULL")] // unknown status
    [InlineData("'local'", "'failed'", "NULL", "NULL")] // failed without an error
    [InlineData("'local'", "'succeeded'", "NULL", "'unexpected'")] // succeeded with an error
    [InlineData("'local'", "'failed'", "NULL", "repeat('x', 301)")] // error too long
    [InlineData("'local'", "'succeeded'", "'NOT-HEX'", "NULL")] // malformed snapshot id
    public async Task The_table_refuses_inconsistent_rows(string step, string status, string snapshot, string error)
    {
        var connection = await fixture.OpenSuperuserConnectionAsync();
        await using (connection.ConfigureAwait(false))
        {
            await RawSql.ExecuteAsync(connection, null, "SET ROLE nix_backup");
            var failure = await Assert.ThrowsAsync<PostgresException>(
                () => RecordAsync(connection, "'2026-10-14T01:00:00Z'", "'2026-10-14T01:05:00Z'", step, status, snapshot, "NULL", error));
            Assert.Equal(PostgresErrorCodes.CheckViolation, failure.SqlState);
        }
    }

    [Fact]
    public async Task A_run_cannot_finish_before_it_started()
    {
        var connection = await fixture.OpenSuperuserConnectionAsync();
        await using (connection.ConfigureAwait(false))
        {
            await RawSql.ExecuteAsync(connection, null, "SET ROLE nix_backup");
            var failure = await Assert.ThrowsAsync<PostgresException>(
                () => RecordAsync(connection, "'2026-10-14T01:05:00Z'", "'2026-10-14T01:00:00Z'", "'local'", "'succeeded'", "NULL", "NULL", "NULL"));
            Assert.Equal(PostgresErrorCodes.CheckViolation, failure.SqlState);
        }
    }

    private static Task<int> RecordAsync(NpgsqlConnection connection, string started, string finished, string step, string status, string snapshot, string bytes, string error) =>
        RawSql.ExecuteAsync(connection, null, $"SELECT nix_record_backup_run({started}, {finished}, {step}, {status}, {snapshot}, {bytes}, {error})");
}
