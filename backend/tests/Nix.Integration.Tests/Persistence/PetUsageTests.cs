using System.Net;
using System.Net.Http.Json;
using System.Text.Json;
using Microsoft.Extensions.DependencyInjection;
using Nix.Abstractions;
using Nix.Abstractions.Scheduling;
using Nix.Authentication;
using Nix.Domain.Tenancy;
using Nix.Features.Pets;
using Nix.Integration.Tests.Harness;
using Nix.Messaging;

namespace Nix.Integration.Tests.Persistence;

[Collection(PostgresSecondaryCollectionDefinition.Name)]
public sealed class PetUsageTests(NixPostgresFixture fixture) : IAsyncLifetime
{
    private static readonly Guid Pet = Guid.NewGuid();
    private static CancellationToken Cancellation => TestContext.Current.CancellationToken;

    public async ValueTask InitializeAsync()
    {
        await fixture.ResetAsync();
        await M0SchemaSeed.SeedBothTenantsAsync(fixture);
    }

    public ValueTask DisposeAsync() => ValueTask.CompletedTask;

    private SiteHttpHost CreateHost() => SiteHttpHost.Create(fixture, new Dictionary<string, string?>());

    private static object Report(SiteHttpHost host, Guid tenant, Guid principal, string source = "app", decimal? cost = 2.5m, string provider = "anthropic") => new
    {
        ticket = host.PetUsageTicket(tenant, principal, Pet, source),
        workspaceId = "",
        provider,
        model = "claude-haiku-5-5",
        inputTokens = 100,
        cacheReadTokens = 10,
        cacheWriteTokens = 5,
        outputTokens = 50,
        costUsd = cost,
        startedAt = DateTimeOffset.UtcNow,
        durationMs = 1200,
    };

    private static async Task<HttpStatusCode> PostReport(SiteHttpHost host, object body, bool secret = true)
    {
        using var request = new HttpRequestMessage(HttpMethod.Post, "/internal/pets/usage") { Content = JsonContent.Create(body) };
        if (secret)
        {
            request.Headers.Add(InternalBoundaryMiddleware.SecretHeaderName, SiteHttpHost.InternalSecret);
        }

        using var response = await host.Client.SendAsync(request, Cancellation);
        return response.StatusCode;
    }

    [Fact]
    public async Task Reported_turns_add_up_for_their_owner_only_and_a_token_can_read_them()
    {
        await using var host = CreateHost();
        Assert.Equal(HttpStatusCode.NoContent, await PostReport(host, Report(host, TestTenants.Alpha, TestTenants.AlphaPrincipal)));
        Assert.Equal(HttpStatusCode.NoContent, await PostReport(host, Report(host, TestTenants.Alpha, TestTenants.AlphaPrincipal, "inline", null)));
        Assert.Equal(HttpStatusCode.NoContent, await PostReport(host, Report(host, TestTenants.Beta, TestTenants.BetaPrincipal, cost: 9m)));

        var pat = await host.TokenAsync(TestTenants.AlphaContext, admin: false);
        using var response = await host.SendAsync(HttpMethod.Get, "/api/v1/me/pets/usage", pat);
        response.EnsureSuccessStatusCode();
        using var body = await SiteHttpHost.JsonAsync(response);
        var total = body.RootElement.GetProperty("total");
        Assert.Equal(2, total.GetProperty("turns").GetInt32());
        Assert.Equal(200, total.GetProperty("inputTokens").GetInt64());
        Assert.Equal(2.5m, total.GetProperty("costUsd").GetDecimal());
        Assert.Equal(["app", "inline"], body.RootElement.GetProperty("bySource").EnumerateArray().Select(group => group.GetProperty("key").GetString()).ToArray());
        Assert.Single(body.RootElement.GetProperty("days").EnumerateArray());
        Assert.Equal(JsonValueKind.Null, body.RootElement.GetProperty("budget").GetProperty("limitUsd").ValueKind);
    }

    [Fact]
    public async Task The_budget_follows_the_saved_limit_and_a_bad_month_is_refused()
    {
        await using var host = CreateHost();
        Assert.Equal(HttpStatusCode.NoContent, await PostReport(host, Report(host, TestTenants.Alpha, TestTenants.AlphaPrincipal, cost: 8m)));
        await ExecuteAsync("DELETE FROM pet_preferences");
        await using (var work = await fixture.Application.BeginUnitOfWorkAsync(TestTenants.AlphaContext, Cancellation))
        {
            var saved = await work.Resolve<NixDispatcher>().SendAsync<SavePetSettings, PetSettingsResponse>(
                new(0, new PetSettings(true, Pet, [new(Pet, "Nix", "owl", "")], MonthlyBudgetUsd: 10m)), Cancellation);
            Assert.True(saved.IsSuccess, saved.IsFailure ? saved.Error.Message : "");
            await work.CommitAsync(Cancellation);
        }

        var pat = await host.TokenAsync(TestTenants.AlphaContext, admin: false);
        using var response = await host.SendAsync(HttpMethod.Get, "/api/v1/me/pets/usage", pat);
        using var body = await SiteHttpHost.JsonAsync(response);
        var budget = body.RootElement.GetProperty("budget");
        Assert.Equal(10m, budget.GetProperty("limitUsd").GetDecimal());
        Assert.Equal(8m, budget.GetProperty("spentUsd").GetDecimal());
        Assert.Equal(2m, budget.GetProperty("remainingUsd").GetDecimal());

        // 80% of the limit is spent, so the inbox holds exactly one notice however many turns follow.
        Assert.Equal(HttpStatusCode.NoContent, await PostReport(host, Report(host, TestTenants.Alpha, TestTenants.AlphaPrincipal, cost: 0.1m)));
        Assert.Equal(1L, await CountAsync("SELECT count(*) FROM notification WHERE title = 'Pet budget at 80%'"));

        using var refused = await host.SendAsync(HttpMethod.Get, "/api/v1/me/pets/usage?month=2026-13", pat);
        Assert.Equal(HttpStatusCode.UnprocessableEntity, refused.StatusCode);
    }

    [Theory]
    [InlineData("app", "chatgpt", 1)]
    [InlineData("app", "anthropic", -1)]
    public async Task A_report_with_a_bad_provider_or_count_is_refused(string source, string provider, int cost)
    {
        await using var host = CreateHost();
        var body = Report(host, TestTenants.Alpha, TestTenants.AlphaPrincipal, source, cost, provider);
        Assert.Equal(HttpStatusCode.BadRequest, await PostReport(host, body));
    }

    [Theory]
    [InlineData("")]
    [InlineData("forged")]
    public async Task A_report_without_a_ticket_Core_signed_is_refused_and_stores_nothing(string ticket)
    {
        await using var host = CreateHost();
        var body = new { ticket, provider = "anthropic", model = "m", inputTokens = 1, cacheReadTokens = 0, cacheWriteTokens = 0, outputTokens = 1, costUsd = 1m, startedAt = DateTimeOffset.UtcNow, durationMs = 1 };
        Assert.Equal(HttpStatusCode.Unauthorized, await PostReport(host, body));
        Assert.Equal(0L, await CountAsync("SELECT count(*) FROM pet_usage"));
    }

    [Fact]
    public async Task Reports_need_the_internal_secret()
    {
        await using var host = CreateHost();
        Assert.NotEqual(HttpStatusCode.NoContent, await PostReport(host, Report(host, TestTenants.Alpha, TestTenants.AlphaPrincipal), secret: false));
    }

    [Fact]
    public async Task Retention_removes_usage_older_than_thirteen_months()
    {
        await using var host = CreateHost();
        Assert.Equal(HttpStatusCode.NoContent, await PostReport(host, Report(host, TestTenants.Alpha, TestTenants.AlphaPrincipal)));
        await ExecuteAsync($"""
            INSERT INTO pet_usage (id, tenant_id, principal_id, pet_id, provider, model, source, input_tokens, cache_read_tokens,
                                   cache_write_tokens, output_tokens, started_at, duration_ms)
            SELECT gen_random_uuid(), '{TestTenants.Alpha}', '{TestTenants.AlphaPrincipal}', gen_random_uuid(), 'anthropic', 'm', 'app',
                   1, 0, 0, 1, now() - interval '14 months', 1
              FROM generate_series(1, 3);
            """);

        await using var scope = fixture.Application.CreateUnscopedScope();
        Assert.Equal(3, await scope.ServiceProvider.GetRequiredService<IRetentionStore>().PurgePetUsageAsync(500, Cancellation));
        Assert.Equal(1L, await CountAsync("SELECT count(*) FROM pet_usage"));
    }

    private async Task<long> CountAsync(string sql)
    {
        var connection = await fixture.OpenMigratorConnectionAsync();
        await using (connection.ConfigureAwait(false))
        {
            return await RawSql.CountAsync(connection, transaction: null, sql);
        }
    }

    private async Task ExecuteAsync(string sql)
    {
        var connection = await fixture.OpenMigratorConnectionAsync();
        await using (connection.ConfigureAwait(false))
        {
            _ = await RawSql.ExecuteAsync(connection, transaction: null, sql);
        }
    }
}
