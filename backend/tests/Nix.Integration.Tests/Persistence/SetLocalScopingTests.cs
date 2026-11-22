using System.Globalization;
using Microsoft.EntityFrameworkCore;
using Nix.Abstractions;
using Nix.Integration.Tests.Harness;
using Nix.Persistence.Sql.Statements;
using Npgsql;

namespace Nix.Integration.Tests.Persistence;

/// <summary>
/// The session context is scoped to the transaction, not to the connection.
/// </summary>
/// <remarks>
/// <para>
/// This is the class that justifies the goal. Row-level security can be perfectly configured and
/// still leak if the session variables it reads outlive the request that set them, because Npgsql
/// hands the same physical connection to the next request - which belongs to a different
/// customer.
/// </para>
/// <para>
/// Every test here forces a pool of exactly one physical connection and then asserts, from
/// <c>pg_backend_pid()</c> rather than from the configuration, that the units of work really did
/// land on the same backend. Without that assertion a passing test could just mean the pool
/// handed out two connections.
/// </para>
/// </remarks>
[Collection(PostgresSecondaryCollectionDefinition.Name)]
public sealed class SetLocalScopingTests : IAsyncLifetime
{
    private readonly NixPostgresFixture _fixture;

    public SetLocalScopingTests(NixPostgresFixture fixture) => _fixture = fixture;

    private static CancellationToken Cancellation => TestContext.Current.CancellationToken;

    public async ValueTask InitializeAsync() => await _fixture.ResetAsync();

    public ValueTask DisposeAsync() => ValueTask.CompletedTask;

    /// <summary>
    /// A pool that can hold exactly one physical connection, so consecutive leases are
    /// necessarily the same backend.
    /// </summary>
    private string SingleConnectionPool() =>
        _fixture.ApplicationConnectionString_With(builder =>
        {
            builder.MaxPoolSize = 1;
            builder.MinPoolSize = 0;
        });

    [Fact]
    public async Task Interleaved_units_of_work_on_the_same_pooled_connection_see_only_their_own_tenant()
    {
        await RlsProbe.SeedAsync(_fixture, TestTenants.Alpha, "alpha-one");
        await RlsProbe.SeedAsync(_fixture, TestTenants.Alpha, "alpha-two");
        await RlsProbe.SeedAsync(_fixture, TestTenants.Beta, "beta-one");

        var host = NixPersistenceHost.Create(SingleConnectionPool());
        await using (host.ConfigureAwait(false))
        {
            // Alpha, then Beta, then Alpha again - three leases of one physical connection, which
            // is the shape of three consecutive requests on a busy pod.
            var first = await ReadAsAsync(host, TestTenants.AlphaContext);
            var second = await ReadAsAsync(host, TestTenants.BetaContext);
            var third = await ReadAsAsync(host, TestTenants.AlphaContext);

            // Same backend throughout: the leak, if there were one, had somewhere to live.
            Assert.Equal(first.BackendProcessId, second.BackendProcessId);
            Assert.Equal(second.BackendProcessId, third.BackendProcessId);

            Assert.Equal(["alpha-one", "alpha-two"], first.Labels);
            Assert.Equal(["beta-one"], second.Labels);
            Assert.Equal(["alpha-one", "alpha-two"], third.Labels);

            // Stated as the breach it would be: Beta's request must not have seen Alpha's rows,
            // and Alpha's second request must not have inherited Beta's scope.
            Assert.DoesNotContain("alpha-one", second.Labels, StringComparer.Ordinal);
            Assert.DoesNotContain("beta-one", third.Labels, StringComparer.Ordinal);

            // Nothing was inherited from the previous lease. Note what this on its own does not
            // prove: with Npgsql's default settings the pool issues DISCARD ALL when a connection
            // is returned, which would clear a leaked session variable too. The next test removes
            // that crutch and asserts the same thing without it.
            Assert.True(
                string.IsNullOrEmpty(second.InheritedTenantSetting),
                "the second unit of work leased a connection still carrying " +
                $"nix.tenant_id = '{second.InheritedTenantSetting}' from the first");
            Assert.True(
                string.IsNullOrEmpty(third.InheritedTenantSetting),
                "the third unit of work leased a connection still carrying " +
                $"nix.tenant_id = '{third.InheritedTenantSetting}' from the second");
        }
    }

    /// <summary>
    /// The same interleaving, with Npgsql's connection reset disabled, so the isolation can only
    /// be coming from <c>SET LOCAL</c>.
    /// </summary>
    /// <remarks>
    /// <para>
    /// By default Npgsql sends <c>DISCARD ALL</c> when a connection returns to the pool, which
    /// happens to erase a leaked session variable. Relying on that would be relying on a driver
    /// default for tenant isolation, and it is not always there: <c>No Reset On Close=true</c> is a
    /// supported, latency-motivated setting, and a transaction-pooling proxy such as PgBouncer
    /// removes the reset from underneath the driver entirely.
    /// </para>
    /// <para>
    /// So this test turns the reset off and asserts the same isolation. It is the one that fails
    /// if the interceptor ever emits a session-scoped <c>SET</c>.
    /// </para>
    /// </remarks>
    [Fact]
    public async Task Interleaved_units_of_work_inherit_no_tenant_even_without_the_connection_reset()
    {
        await RlsProbe.SeedAsync(_fixture, TestTenants.Alpha, "alpha-one");
        await RlsProbe.SeedAsync(_fixture, TestTenants.Beta, "beta-one");

        var connectionString = _fixture.ApplicationConnectionString_With(builder =>
        {
            builder.MaxPoolSize = 1;
            builder.MinPoolSize = 0;
            builder.NoResetOnClose = true;
        });

        var host = NixPersistenceHost.Create(connectionString);
        await using (host.ConfigureAwait(false))
        {
            var first = await ReadAsAsync(host, TestTenants.AlphaContext);
            var second = await ReadAsAsync(host, TestTenants.BetaContext);
            var third = await ReadAsAsync(host, TestTenants.AlphaContext);

            Assert.Equal(first.BackendProcessId, second.BackendProcessId);
            Assert.Equal(second.BackendProcessId, third.BackendProcessId);

            Assert.True(
                string.IsNullOrEmpty(second.InheritedTenantSetting),
                "with the connection reset disabled, the second unit of work leased a connection " +
                $"still carrying nix.tenant_id = '{second.InheritedTenantSetting}'. The session " +
                "context is outliving its transaction, which is what a plain SET does.");
            Assert.True(
                string.IsNullOrEmpty(third.InheritedTenantSetting),
                "with the connection reset disabled, the third unit of work leased a connection " +
                $"still carrying nix.tenant_id = '{third.InheritedTenantSetting}'");

            Assert.Equal(["alpha-one"], first.Labels);
            Assert.Equal(["beta-one"], second.Labels);
            Assert.Equal(["alpha-one"], third.Labels);
        }
    }

    [Fact]
    public async Task The_session_context_does_not_survive_the_transaction_that_established_it()
    {
        var host = NixPersistenceHost.Create(SingleConnectionPool());
        await using (host.ConfigureAwait(false))
        {
            var work = await host.BeginUnitOfWorkAsync(TestTenants.AlphaContext, Cancellation);
            await using (work.ConfigureAwait(false))
            {
                // An extra reference so the connection stays open after the transaction ends and
                // can be questioned about what it remembers.
                await work.DbContext.Database.OpenConnectionAsync(Cancellation);
                var connection = (NpgsqlConnection)work.DbContext.Database.GetDbConnection();

                try
                {
                    var inside = await work.Sql.ScalarRefAsync<string>(
                        "SELECT current_setting('nix.tenant_id', true)",
                        cancellationToken: Cancellation);
                    Assert.Equal(TestTenants.Alpha.ToString("D"), inside);

                    await work.CommitAsync(Cancellation);

                    var afterCommit = await RawSql.TextAsync(
                        connection,
                        transaction: null,
                        "SELECT current_setting('nix.tenant_id', true)");

                    // COMMIT unwinds SET LOCAL. Anything other than null or empty here means the
                    // next lease of this connection starts inside Alpha's tenant.
                    Assert.True(
                        string.IsNullOrEmpty(afterCommit),
                        $"the session context outlived its transaction: nix.tenant_id is still '{afterCommit}'");
                }
                finally
                {
                    await work.DbContext.Database.CloseConnectionAsync();
                }
            }
        }
    }

    [Fact]
    public async Task The_session_context_does_not_survive_a_rolled_back_transaction()
    {
        var host = NixPersistenceHost.Create(SingleConnectionPool());
        await using (host.ConfigureAwait(false))
        {
            var work = await host.BeginUnitOfWorkAsync(TestTenants.AlphaContext, Cancellation);
            await using (work.ConfigureAwait(false))
            {
                await work.DbContext.Database.OpenConnectionAsync(Cancellation);
                var connection = (NpgsqlConnection)work.DbContext.Database.GetDbConnection();

                try
                {
                    await work.Transaction.RollbackAsync(Cancellation);

                    var afterRollback = await RawSql.TextAsync(
                        connection,
                        transaction: null,
                        "SELECT current_setting('nix.tenant_id', true)");

                    Assert.True(string.IsNullOrEmpty(afterRollback));
                }
                finally
                {
                    await work.DbContext.Database.CloseConnectionAsync();
                }
            }
        }
    }

    /// <summary>
    /// Demonstrates the failure mode the interceptor exists to prevent, by issuing the plain
    /// <c>SET</c> the production code refuses to emit and watching it survive.
    /// </summary>
    /// <remarks>
    /// <para>
    /// A negative test written with raw SQL rather than by misconfiguring the interceptor: the
    /// interceptor has no switch that makes it emit a session-scoped SET, and adding one so a test
    /// could flip it would put the dangerous path in the shipping binary. What this asserts is the
    /// database and driver behaviour that makes <c>SET LOCAL</c> non-negotiable, and it fails if
    /// Postgres or Npgsql ever changes it - at which point the reasoning in
    /// <c>RlsSessionCommand</c> needs revisiting.
    /// </para>
    /// <para>
    /// Two horizons, because they leak for different reasons:
    /// </para>
    /// <list type="number">
    ///   <item>
    ///     <description>
    ///     Across transactions on one lease. Always true, no special configuration: a plain SET is
    ///     session state, and COMMIT does not unwind session state. Two units of work sharing a
    ///     leased connection - a request that opens two transactions, a background worker looping
    ///     over jobs - is enough.
    ///     </description>
    ///   </item>
    ///   <item>
    ///     <description>
    ///     Across leases of the same pooled connection, with Npgsql's connection reset disabled.
    ///     <c>No Reset On Close=true</c> is a real, documented, latency-motivated setting, and
    ///     transaction-pooling proxies such as PgBouncer remove the reset in the same way. Under
    ///     it, the leaked value is read by an entirely different request.
    ///     </description>
    ///   </item>
    /// </list>
    /// </remarks>
    [Fact]
    public async Task A_session_scoped_set_leaks_where_set_local_does_not()
    {
        // A tenant used by nothing else, so the leak observed here cannot be another test's.
        var leakProbeTenant = new Guid("9e9e9e9e-9999-4999-8999-9e9e9e9e9e9e");
        var leaked = leakProbeTenant.ToString("D", CultureInfo.InvariantCulture);

        var connectionString = _fixture.ApplicationConnectionString_With(builder =>
        {
            builder.MaxPoolSize = 1;
            builder.MinPoolSize = 0;

            // The setting that turns a session-scoped SET into a cross-request leak.
            builder.NoResetOnClose = true;
        });

        var dataSource = NpgsqlDataSource.Create(connectionString);
        await using (dataSource.ConfigureAwait(false))
        {
            int firstLeaseBackend;

            // --- Horizon 1: across transactions on one lease --------------------------------
            var lease = await dataSource.OpenConnectionAsync(Cancellation);
            await using (lease.ConfigureAwait(false))
            {
                firstLeaseBackend = await RawSql.BackendProcessIdAsync(lease);

                var setting = await lease.BeginTransactionAsync(Cancellation);
                await using (setting.ConfigureAwait(false))
                {
                    await RawSql.ExecuteAsync(lease, setting, $"SET nix.tenant_id = '{leaked}'");
                    await RawSql.ExecuteAsync(lease, setting, $"SET LOCAL nix.principal_id = '{leaked}'");
                    await setting.CommitAsync(Cancellation);
                }

                var observing = await lease.BeginTransactionAsync(Cancellation);
                await using (observing.ConfigureAwait(false))
                {
                    var tenantAfterCommit = await RawSql.TextAsync(
                        lease, observing, "SELECT current_setting('nix.tenant_id', true)");
                    var principalAfterCommit = await RawSql.TextAsync(
                        lease, observing, "SELECT current_setting('nix.principal_id', true)");

                    Assert.Equal(leaked, tenantAfterCommit);
                    Assert.True(
                        string.IsNullOrEmpty(principalAfterCommit),
                        "SET LOCAL should not have survived the commit");

                    await observing.RollbackAsync(Cancellation);
                }
            }

            // --- Horizon 2: across leases of the same pooled connection ---------------------
            var nextLease = await dataSource.OpenConnectionAsync(Cancellation);
            await using (nextLease.ConfigureAwait(false))
            {
                var secondLeaseBackend = await RawSql.BackendProcessIdAsync(nextLease);
                Assert.Equal(firstLeaseBackend, secondLeaseBackend);

                var tenantOnNextLease = await RawSql.TextAsync(
                    nextLease, transaction: null, "SELECT current_setting('nix.tenant_id', true)");
                var principalOnNextLease = await RawSql.TextAsync(
                    nextLease, transaction: null, "SELECT current_setting('nix.principal_id', true)");

                Assert.Equal(leaked, tenantOnNextLease);
                Assert.True(
                    string.IsNullOrEmpty(principalOnNextLease),
                    "SET LOCAL should not have survived the lease");
            }
        }
    }

    /// <summary>
    /// Asserts what Postgres actually received, read from the server's own statement log.
    /// </summary>
    /// <remarks>
    /// The container runs with <c>log_statement=all</c>, so this reads the statements the server
    /// logged rather than the text the application believes it sent. Between the two, the server's
    /// record is the one that decides whether a tenant leaks.
    /// </remarks>
    [Fact]
    public async Task Postgres_receives_only_set_local_statements_for_the_session_context()
    {
        var since = DateTime.UtcNow.AddSeconds(-2);
        // The server log is shared with other tests and background hosts. Alpha appears in
        // those statements too, including intentional raw set_config(..., true) setup. Use a
        // fresh context and its actual backend rather than treating a time window as ownership.
        var context = TestTenants.ContextFor(Guid.NewGuid(), Guid.NewGuid(), Guid.NewGuid());
        var tenant = context.TenantId.Value.ToString("D", CultureInfo.InvariantCulture);
        var workspace = context.WorkspaceId!.Value.Value.ToString("D", CultureInfo.InvariantCulture);
        var principal = context.PrincipalId.Value.ToString("D", CultureInfo.InvariantCulture);
        var host = NixPersistenceHost.Create(SingleConnectionPool());
        int backendProcessId;
        await using (host.ConfigureAwait(false))
        {
            var work = await host.BeginUnitOfWorkAsync(context, Cancellation);
            await using (work.ConfigureAwait(false))
            {
                backendProcessId = await work.Sql.ScalarAsync<int>(
                    SessionSql.BackendProcessId, cancellationToken: Cancellation) ?? throw new InvalidOperationException("pg_backend_pid returned no value.");
                await work.CommitAsync(Cancellation);
            }
        }

        var backendMarker = $"[{backendProcessId}]";
        IReadOnlyList<string> lines = [];
        // Docker's log snapshot can lag the completed transaction under load.
        for (var attempt = 0; attempt < 5; attempt++)
        {
            lines = await _fixture.ServerLogLinesSinceAsync(since);
            if (lines.Any(line => line.Contains(backendMarker, StringComparison.Ordinal)
                && line.EndsWith(": COMMIT", StringComparison.Ordinal)))
            {
                break;
            }

            await Task.Delay(TimeSpan.FromMilliseconds(100), Cancellation);
        }

        Assert.Contains(lines, line => line.Contains(backendMarker, StringComparison.Ordinal)
            && line.EndsWith(": COMMIT", StringComparison.Ordinal));

        var sessionContextLines = lines
            .Where(line => line.Contains(backendMarker, StringComparison.Ordinal)
                && (line.Contains(tenant, StringComparison.Ordinal)
                    || line.Contains(workspace, StringComparison.Ordinal)
                    || line.Contains(principal, StringComparison.Ordinal)))
            .ToArray();

        Assert.Equal(3, sessionContextLines.Length);
        Assert.All(sessionContextLines, line =>
            Assert.Contains(": SET LOCAL ", line, StringComparison.Ordinal));
        Assert.Contains(sessionContextLines, line => line.EndsWith($"SET LOCAL nix.tenant_id = '{tenant}'", StringComparison.Ordinal));
        Assert.Contains(sessionContextLines, line => line.EndsWith($"SET LOCAL nix.workspace_id = '{workspace}'", StringComparison.Ordinal));
        Assert.Contains(sessionContextLines, line => line.EndsWith($"SET LOCAL nix.principal_id = '{principal}'", StringComparison.Ordinal));
    }

    private static async Task<UnitOfWorkObservation> ReadAsAsync(
        NixPersistenceHost host,
        NixSessionContext context)
    {
        var work = await host.BeginUnitOfWorkAsync(context, Cancellation);
        await using (work.ConfigureAwait(false))
        {
            var backendProcessId = await work.Sql.ScalarAsync<int>(SessionSql.BackendProcessId) ?? throw new InvalidOperationException("pg_backend_pid returned no value.");

            var rows = await RlsProbe.ReadVisibleAsync(work);
            await work.CommitAsync(Cancellation);

            return new UnitOfWorkObservation(
                backendProcessId,
                rows.Select(static row => row.Label).ToArray(),
                work.InheritedTenantSetting);
        }
    }

    private sealed record UnitOfWorkObservation(
        int BackendProcessId,
        IReadOnlyList<string> Labels,
        string? InheritedTenantSetting);
}
