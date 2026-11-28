using Microsoft.EntityFrameworkCore;
using Microsoft.EntityFrameworkCore.Infrastructure;
using Microsoft.EntityFrameworkCore.Migrations;
using Nix.Integration.Tests.Harness;
using Nix.Persistence;

namespace Nix.Integration.Tests.Persistence;

[Collection(PostgresSecondaryCollectionDefinition.Name)]
public sealed class RetireChatGptAndOpenAiMigrationTests(NixPostgresFixture fixture) : IAsyncLifetime
{
    private static CancellationToken Cancellation => TestContext.Current.CancellationToken;

    public async ValueTask InitializeAsync()
    {
        await fixture.ResetAsync();
        await M0SchemaSeed.SeedBothTenantsAsync(fixture);
        await M0SchemaSeed.SeedCurrentSchemaRowsAsync(fixture);
    }

    public ValueTask DisposeAsync() => ValueTask.CompletedTask;

    [Theory]
    [InlineData("chatgpt", "anthropic", "anthropic", true)]
    [InlineData("openai", "openrouter", "openrouter", true)]
    [InlineData("chatgpt", "", "anthropic", true)]
    [InlineData("", "openrouter", "openrouter", true)]
    [InlineData("chatgpt", "anthropic openrouter", "anthropic", true)]
    [InlineData("openrouter", "anthropic", "openrouter", false)]
    public async Task A_profile_off_the_retired_providers_moves_to_a_provider_the_person_has_a_key_for(
        string start, string keys, string expected, bool changes)
    {
        ArgumentNullException.ThrowIfNull(start);
        ArgumentNullException.ThrowIfNull(keys);
        var options = new DbContextOptionsBuilder<NixDbContext>().UseNpgsql(fixture.MigratorConnectionString).Options;
        await using var context = new NixDbContext(options);
        var migrator = context.GetService<IMigrator>();
        // Walking back also proves Down leaves a schema the older code can use.
        await migrator.MigrateAsync("20261125010100_PetPlanConsents", Cancellation);
        try
        {
            var principal = TestTenants.AlphaPrincipal;
            var tenant = TestTenants.Alpha;
            var settings = start.Length == 0
                ? """{"profiles": [{"id": "0199c0de-0000-7000-8000-000000000001", "name": "Owl"}]}"""
                : $$"""{"profiles": [{"id": "0199c0de-0000-7000-8000-000000000001", "name": "Owl", "provider": "{{start}}"}]}""";
            var stored = keys + " openai";
            await context.Database.ExecuteSqlAsync($"""
                DELETE FROM pet_provider_credential WHERE principal_id = {principal};
                INSERT INTO pet_provider_credential (tenant_id, principal_id, provider, protected_key, key_hint, saved_at)
                SELECT {tenant}, {principal}, provider, decode('0102', 'hex'), 'seed', now()
                  FROM unnest(string_to_array({stored}, ' ')) AS provider WHERE provider <> '';
                UPDATE pet_preferences SET settings = CAST({settings} AS jsonb), revision = 5 WHERE principal_id = {principal};
                """, Cancellation);

            await migrator.MigrateAsync(targetMigration: null, cancellationToken: Cancellation);

            var moved = await context.Database.SqlQuery<string>($"""
                SELECT settings->'profiles'->0->>'provider' AS "Value" FROM pet_preferences WHERE principal_id = {principal}
                """).SingleAsync(Cancellation);
            Assert.Equal(expected, moved);
            var revision = await context.Database.SqlQuery<long>($"SELECT revision AS \"Value\" FROM pet_preferences WHERE principal_id = {principal}").SingleAsync(Cancellation);
            Assert.Equal(changes ? 6 : 5, revision);
            var openAiKeys = await context.Database.SqlQueryRaw<int>("SELECT count(*)::int AS \"Value\" FROM pet_provider_credential WHERE provider = 'openai'").SingleAsync(Cancellation);
            Assert.Equal(0, openAiKeys);
        }
        finally
        {
            await migrator.MigrateAsync(targetMigration: null, cancellationToken: Cancellation);
        }
    }
}
