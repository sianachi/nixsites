using Microsoft.EntityFrameworkCore;
using Microsoft.Extensions.DependencyInjection;
using Nix.Abstractions;
using Nix.Integration.Tests.Harness;
using Nix.Persistence;
using Nix.Persistence.Sql.Statements;
using Npgsql;

namespace Nix.Integration.Tests.Persistence;

/// <summary>
/// Row-level security isolates tenants, proved against a real Postgres with two tenants and the
/// runtime role that cannot bypass policies.
/// </summary>
[Collection(PostgresSecondaryCollectionDefinition.Name)]
public sealed class RlsIsolationTests : IAsyncLifetime
{
    private readonly NixPostgresFixture _fixture;

    public RlsIsolationTests(NixPostgresFixture fixture) => _fixture = fixture;

    private static CancellationToken Cancellation => TestContext.Current.CancellationToken;

    public async ValueTask InitializeAsync() => await _fixture.ResetAsync();

    public ValueTask DisposeAsync() => ValueTask.CompletedTask;

    [Fact]
    public async Task Each_tenant_sees_its_own_rows_and_none_of_the_others()
    {
        await RlsProbe.SeedAsync(_fixture, TestTenants.Alpha, "alpha-one");
        await RlsProbe.SeedAsync(_fixture, TestTenants.Alpha, "alpha-two");
        await RlsProbe.SeedAsync(_fixture, TestTenants.Beta, "beta-one");

        var alphaWork = await _fixture.Application.BeginUnitOfWorkAsync(TestTenants.AlphaContext, Cancellation);
        IReadOnlyList<RlsProbe.ProbeRow> alphaRows;
        await using (alphaWork.ConfigureAwait(false))
        {
            alphaRows = await RlsProbe.ReadVisibleAsync(alphaWork);
        }

        var betaWork = await _fixture.Application.BeginUnitOfWorkAsync(TestTenants.BetaContext, Cancellation);
        IReadOnlyList<RlsProbe.ProbeRow> betaRows;
        await using (betaWork.ConfigureAwait(false))
        {
            betaRows = await RlsProbe.ReadVisibleAsync(betaWork);
        }

        Assert.Equal(["alpha-one", "alpha-two"], alphaRows.Select(static row => row.Label));
        Assert.Equal(["beta-one"], betaRows.Select(static row => row.Label));

        // Stated the other way round as well, because "sees two rows" would also pass if the
        // second tenant's row happened to be one of them.
        Assert.All(alphaRows, row => Assert.Equal(TestTenants.Alpha, row.TenantId));
        Assert.All(betaRows, row => Assert.Equal(TestTenants.Beta, row.TenantId));
    }

    [Fact]
    public async Task A_tenant_with_no_rows_sees_nothing_rather_than_everything()
    {
        await RlsProbe.SeedAsync(_fixture, TestTenants.Beta, "beta-only");

        var work = await _fixture.Application.BeginUnitOfWorkAsync(TestTenants.AlphaContext, Cancellation);
        await using (work.ConfigureAwait(false))
        {
            var rows = await RlsProbe.ReadVisibleAsync(work);

            Assert.Empty(rows);
        }
    }

    [Fact]
    public async Task Writing_a_row_for_another_tenant_is_rejected_by_the_policy()
    {
        var work = await _fixture.Application.BeginUnitOfWorkAsync(TestTenants.AlphaContext, Cancellation);
        await using (work.ConfigureAwait(false))
        {
            var parameters = new[]
            {
                new NpgsqlParameter<Guid>("id", Guid.NewGuid()),
                new NpgsqlParameter<Guid>("tenant_id", TestTenants.Beta),
                new NpgsqlParameter("workspace_id", NpgsqlTypes.NpgsqlDbType.Uuid) { Value = DBNull.Value },
                new NpgsqlParameter<string>("label", "planted-under-beta"),
                new NpgsqlParameter("payload", NpgsqlTypes.NpgsqlDbType.Bytea) { Value = DBNull.Value },
            };

            // A USING clause alone would allow this: the row would be written and simply be
            // invisible to its author. The WITH CHECK clause is what stops one tenant seeding
            // data inside another.
            var failure = await Assert.ThrowsAsync<PostgresException>(
                async () => await work.Sql.ExecuteAsync(RlsProbeSchema.InsertSql, parameters, Cancellation));

            Assert.Equal(PostgresErrorCodes.InsufficientPrivilege, failure.SqlState);
        }
    }

    [Fact]
    public async Task Updating_another_tenants_row_affects_nothing()
    {
        await RlsProbe.SeedAsync(_fixture, TestTenants.Beta, "beta-untouched");

        var work = await _fixture.Application.BeginUnitOfWorkAsync(TestTenants.AlphaContext, Cancellation);
        await using (work.ConfigureAwait(false))
        {
            var affected = await work.Sql.ExecuteAsync(
                $"UPDATE {RlsProbeSchema.TableName} SET label = 'tampered'",
                cancellationToken: Cancellation);

            Assert.Equal(0, affected);
        }

        var betaWork = await _fixture.Application.BeginUnitOfWorkAsync(TestTenants.BetaContext, Cancellation);
        await using (betaWork.ConfigureAwait(false))
        {
            var rows = await RlsProbe.ReadVisibleAsync(betaWork);

            Assert.Equal(["beta-untouched"], rows.Select(static row => row.Label));
        }
    }

    [Fact]
    public async Task A_session_that_established_no_tenant_sees_nothing()
    {
        await RlsProbe.SeedAsync(_fixture, TestTenants.Alpha, "alpha-one");
        await RlsProbe.SeedAsync(_fixture, TestTenants.Beta, "beta-one");

        // Deliberately outside the application's execution path: the interceptor refuses to open
        // a transaction with no context, so the only way to reach the database unscoped is a raw
        // connection. This asserts the database's own answer to an unscoped read - which must be
        // "nothing", not "everything".
        var connection = await _fixture.OpenApplicationConnectionAsync();
        await using (connection.ConfigureAwait(false))
        {
            var visible = await RawSql.TextAsync(
                connection,
                transaction: null,
                $"SELECT count(*)::text FROM {RlsProbeSchema.TableName}");

            Assert.Equal("0", visible);
        }
    }

    [Fact]
    public async Task Opening_a_transaction_with_no_session_context_is_refused()
    {
        var scope = _fixture.Application.CreateUnscopedScope();
        await using (scope.ConfigureAwait(false))
        {
            var dbContext = scope.ServiceProvider.GetRequiredService<NixDbContext>();

            var failure = await Assert.ThrowsAsync<InvalidOperationException>(
                async () => await dbContext.Database.BeginTransactionAsync(Cancellation));

            Assert.Contains("session context", failure.Message, StringComparison.OrdinalIgnoreCase);
        }
    }

    [Fact]
    public async Task Hand_written_sql_runs_under_the_same_tenant_scope_as_the_context()
    {
        var work = await _fixture.Application.BeginUnitOfWorkAsync(TestTenants.AlphaContext, Cancellation);
        await using (work.ConfigureAwait(false))
        {
            var tenant = await work.Sql.ScalarRefAsync<string>(
                "SELECT NULLIF(current_setting('nix.tenant_id', true), '')",
                cancellationToken: Cancellation);

            var principal = await work.Sql.ScalarRefAsync<string>(
                "SELECT NULLIF(current_setting('nix.principal_id', true), '')",
                cancellationToken: Cancellation);

            // The executor borrows the context's connection and transaction, so it inherits the
            // SET LOCAL the interceptor issued. A second connection would have no context at all.
            Assert.Equal(TestTenants.Alpha.ToString("D"), tenant);
            Assert.NotNull(principal);
        }
    }

    [Fact]
    public async Task A_tenant_wide_unit_of_work_publishes_an_empty_workspace()
    {
        var tenantWide = TestTenants.ContextFor(TestTenants.Alpha, workspaceId: null, Guid.NewGuid());

        var work = await _fixture.Application.BeginUnitOfWorkAsync(tenantWide, Cancellation);
        await using (work.ConfigureAwait(false))
        {
            // Column 0 of the session-context statement is the tenant, folded through NULLIF the
            // way a policy reads it.
            var tenant = await work.Sql.ScalarRefAsync<string>(
                SessionSql.CurrentSessionContext,
                cancellationToken: Cancellation);
            var rawWorkspace = await work.Sql.ScalarRefAsync<string>(
                "SELECT current_setting('nix.workspace_id', true)",
                cancellationToken: Cancellation);

            // NULLIF folds the workspace to null for the policies; the raw setting is an empty
            // string, not absent, so nothing stale from a previous transaction on this physical
            // connection can be read in its place.
            Assert.Equal(TestTenants.Alpha.ToString("D"), tenant);
            Assert.Equal(string.Empty, rawWorkspace);
        }
    }
}
