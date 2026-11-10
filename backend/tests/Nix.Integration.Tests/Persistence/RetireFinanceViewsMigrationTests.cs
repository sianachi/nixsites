using System.Text.Json.Nodes;
using Microsoft.EntityFrameworkCore;
using Microsoft.EntityFrameworkCore.Infrastructure;
using Microsoft.EntityFrameworkCore.Migrations;
using Microsoft.Extensions.DependencyInjection;
using Nix.Integration.Tests.Harness;
using Nix.Persistence;

namespace Nix.Integration.Tests.Persistence;

[Collection(PostgresCollectionDefinition.Name)]
public sealed class RetireFinanceViewsMigrationTests(NixPostgresFixture fixture) : IAsyncLifetime
{
    private static CancellationToken Cancellation => TestContext.Current.CancellationToken;

    public async ValueTask InitializeAsync()
    {
        await fixture.ResetAsync();
        await M0SchemaSeed.SeedBothTenantsAsync(fixture);
    }

    public ValueTask DisposeAsync() => ValueTask.CompletedTask;

    [Fact]
    public async Task Upgrade_turns_finance_views_into_sheet_views_and_leaves_item_data_alone()
    {
        var options = new DbContextOptionsBuilder<NixDbContext>()
            .UseNpgsql(fixture.MigratorConnectionString).Options;
        await using var context = new NixDbContext(options);
        var migrator = context.GetService<IMigrator>();
        await migrator.MigrateAsync("20261107120000_TenantSettings", Cancellation);
        try
        {
            const string views = """
                {"views":[{"id":"money","name":"Money","kind":"finance","columns":["title"]},{"id":"all","name":"All","kind":"list"}],"default":"money"}
                """;
            const string properties = """{"title":"Money","$fin_currency":"GBP","$fin_accounts_id":"11111111-1111-4111-8111-111111111111"}""";
            var ids = await context.Database.SqlQueryRaw<Guid>("SELECT id AS \"Value\" FROM item ORDER BY id LIMIT 2")
                .ToListAsync(Cancellation);
            Assert.Equal(2, ids.Count);
            await context.Database.ExecuteSqlRawAsync(
                "UPDATE item SET views = {0}::jsonb, properties = {1}::jsonb WHERE id = {2}",
                [views, properties, ids[0]], Cancellation);
            // A plain list-only view set on another item must come through byte for byte.
            await context.Database.ExecuteSqlRawAsync(
                "UPDATE item SET views = {0}::jsonb WHERE id = {1}",
                ["""{"views":[{"id":"all","name":"All","kind":"list"}],"default":"all"}""", ids[1]], Cancellation);

            await migrator.MigrateAsync(targetMigration: null, cancellationToken: Cancellation);

            var migrated = JsonNode.Parse((await context.Database
                .SqlQueryRaw<string>("SELECT views::text AS \"Value\" FROM item WHERE id = {0}", ids[0])
                .ToListAsync(Cancellation)).Single())!;
            Assert.Equal("sheet", (string?)migrated["views"]![0]!["kind"]);
            Assert.Equal("money", (string?)migrated["views"]![0]!["id"]);
            Assert.Equal("list", (string?)migrated["views"]![1]!["kind"]);
            Assert.Equal("money", (string?)migrated["default"]);

            var untouched = JsonNode.Parse((await context.Database
                .SqlQueryRaw<string>("SELECT views::text AS \"Value\" FROM item WHERE id = {0}", ids[1])
                .ToListAsync(Cancellation)).Single())!;
            Assert.Equal("list", (string?)untouched["views"]![0]!["kind"]);

            var kept = JsonNode.Parse((await context.Database
                .SqlQueryRaw<string>("SELECT properties::text AS \"Value\" FROM item WHERE id = {0}", ids[0])
                .ToListAsync(Cancellation)).Single())!;
            Assert.Equal("GBP", (string?)kept["$fin_currency"]);
        }
        finally
        {
            await migrator.MigrateAsync(targetMigration: null, cancellationToken: Cancellation);
        }
    }
}
