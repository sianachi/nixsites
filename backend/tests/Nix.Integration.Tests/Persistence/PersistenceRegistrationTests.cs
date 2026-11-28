using Microsoft.EntityFrameworkCore;
using Microsoft.Extensions.DependencyInjection;
using Nix.Abstractions;
using Nix.Integration.Tests.Harness;
using Nix.Persistence;
using Nix.Persistence.Sql;

namespace Nix.Integration.Tests.Persistence;

/// <summary>
/// What <c>AddNixPersistence</c> registers, and what it refuses to register.
/// </summary>
[Collection(PostgresCollectionDefinition.Name)]
public sealed class PersistenceRegistrationTests
{
    private readonly NixPostgresFixture _fixture;

    public PersistenceRegistrationTests(NixPostgresFixture fixture) => _fixture = fixture;

    private static CancellationToken Cancellation => TestContext.Current.CancellationToken;

    [Fact]
    public void The_application_is_refused_a_connection_string_for_the_migration_role()
    {
        var services = new ServiceCollection();

        var failure = Assert.Throws<ArgumentException>(() => services.AddNixPersistence(
            "Host=localhost;Database=nix;Username=nix_migrator;Password=x"));

        Assert.Contains("nix_migrator", failure.Message, StringComparison.Ordinal);
    }

    [Fact]
    public void The_application_is_refused_a_superuser_connection_string()
    {
        var services = new ServiceCollection();

        Assert.Throws<ArgumentException>(() => services.AddNixPersistence(
            "Host=localhost;Database=nix;Username=postgres;Password=x"));
    }

    [Fact]
    public void The_forbidden_role_check_is_case_insensitive()
    {
        var services = new ServiceCollection();

        Assert.Throws<ArgumentException>(() => services.AddNixPersistence(
            "Host=localhost;Database=nix;Username=NIX_MIGRATOR;Password=x"));
    }

    [Fact]
    public async Task Every_service_the_persistence_stack_registers_resolves_within_a_scope()
    {
        var host = NixPersistenceHost.Create(_fixture.ApplicationConnectionString);
        await using (host.ConfigureAwait(false))
        {
            var scope = host.CreateUnscopedScope();
            await using (scope.ConfigureAwait(false))
            {
                Assert.NotNull(scope.ServiceProvider.GetRequiredService<NixDbContext>());
                Assert.NotNull(scope.ServiceProvider.GetRequiredService<NixSqlExecutor>());
                Assert.NotNull(scope.ServiceProvider.GetRequiredService<INixSessionContextAccessor>());
            }
        }
    }

    [Fact]
    public async Task The_session_context_accessor_is_one_instance_per_scope_and_write_once()
    {
        var host = NixPersistenceHost.Create(_fixture.ApplicationConnectionString);
        await using (host.ConfigureAwait(false))
        {
            var scope = host.CreateUnscopedScope();
            await using (scope.ConfigureAwait(false))
            {
                var writer = scope.ServiceProvider.GetRequiredService<ScopedNixSessionContextAccessor>();
                var reader = scope.ServiceProvider.GetRequiredService<INixSessionContextAccessor>();

                Assert.Same(writer, reader);
                Assert.Null(reader.Current);

                writer.Set(TestTenants.AlphaContext);
                Assert.Equal(TestTenants.AlphaContext, reader.Current);

                // Re-pointing a live scope at another tenant would leave an open transaction
                // running under the old one.
                Assert.Throws<InvalidOperationException>(() => writer.Set(TestTenants.BetaContext));
            }
        }
    }

    [Fact]
    public async Task A_statement_outside_a_transaction_is_refused_rather_than_returning_nothing()
    {
        var host = NixPersistenceHost.Create(_fixture.ApplicationConnectionString);
        await using (host.ConfigureAwait(false))
        {
            var scope = host.CreateUnscopedScope();
            await using (scope.ConfigureAwait(false))
            {
                scope.ServiceProvider
                    .GetRequiredService<ScopedNixSessionContextAccessor>()
                    .Set(TestTenants.AlphaContext);

                var dbContext = scope.ServiceProvider.GetRequiredService<NixDbContext>();

                // Without a transaction there is no SET LOCAL, so row-level security would answer
                // with nothing and the symptom would look like missing data. Loud beats quiet.
                var failure = await Assert.ThrowsAsync<InvalidOperationException>(
                    async () => await dbContext.Database.ExecuteSqlRawAsync("SELECT 1", Cancellation));

                Assert.Contains("outside a transaction", failure.Message, StringComparison.Ordinal);
            }
        }
    }

    [Fact]
    public async Task Hand_written_sql_outside_a_transaction_is_refused()
    {
        var host = NixPersistenceHost.Create(_fixture.ApplicationConnectionString);
        await using (host.ConfigureAwait(false))
        {
            var scope = host.CreateUnscopedScope();
            await using (scope.ConfigureAwait(false))
            {
                scope.ServiceProvider
                    .GetRequiredService<ScopedNixSessionContextAccessor>()
                    .Set(TestTenants.AlphaContext);

                var sql = scope.ServiceProvider.GetRequiredService<NixSqlExecutor>();

                var failure = await Assert.ThrowsAsync<InvalidOperationException>(
                    async () => await sql.ScalarAsync<int>("SELECT 1", cancellationToken: Cancellation));

                Assert.Contains("outside a transaction", failure.Message, StringComparison.Ordinal);
            }
        }
    }
}
