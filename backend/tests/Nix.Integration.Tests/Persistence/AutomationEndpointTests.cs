using System.Net;
using System.Net.Http.Headers;
using System.Net.Http.Json;
using System.Security.Cryptography;
using System.Text.Json;
using Microsoft.AspNetCore.Mvc.Testing;
using Nix.Authentication;
using Nix.Domain.Identity;
using Nix.Features.Tokens;
using Nix.Integration.Tests.Harness;
using Nix.Messaging;

namespace Nix.Integration.Tests.Persistence;

/// <summary>
/// The automation routes at the wire: CRUD, compare-and-set, the refusal codes, the per-workspace
/// ceiling, and the Admin scope a personal access token needs to change a rule.
/// </summary>
[Collection(PostgresSecondaryCollectionDefinition.Name)]
public sealed class AutomationEndpointTests : IAsyncLifetime
{
    private const string PropertyTrigger = """{"type":"property_changed","key":"status","to":{"value":"done"}}""";
    private const string NotifyActions = """[{"type":"notify","title":"x","body":""}]""";
    private readonly NixPostgresFixture _fixture;
    private WebApplicationFactory<Program> _factory = null!;
    private HttpClient _client = null!;

    public AutomationEndpointTests(NixPostgresFixture fixture) => _fixture = fixture;

    private static CancellationToken Cancellation => TestContext.Current.CancellationToken;

    private static string Collection => $"/api/v1/workspaces/{TestTenants.AlphaWorkspace:D}/automations";

    public async ValueTask InitializeAsync()
    {
        await _fixture.ResetAsync();
        await M0SchemaSeed.SeedBothTenantsAsync(_fixture);
        var connection = await _fixture.OpenMigratorConnectionAsync();
        await using (connection.ConfigureAwait(false))
        {
            await RawSql.ExecuteAsync(connection, transaction: null, "DELETE FROM automation_rule");
        }

        string signingKey;
        using (var key = ECDsa.Create(ECCurve.NamedCurves.nistP256))
        {
            signingKey = key.ExportECPrivateKeyPem();
        }

        _factory = new ConfiguredApplicationFactory(new Dictionary<string, string?>
        {
            ["ConnectionStrings:Nix"] = _fixture.ApplicationConnectionString,
            ["Nix:Scheduling:Enabled"] = "false",
            [SelfIssuedTokenService.IssuerConfigurationKey] = "https://core.automation-http.test",
            [SelfIssuedTokenService.AudienceConfigurationKey] = "nix",
            [SelfIssuedTokenService.KeyIdConfigurationKey] = "automation-http-key",
            [SelfIssuedTokenService.SigningKeyConfigurationKey] = signingKey,
        });
        _client = _factory.CreateClient();
    }

    public async ValueTask DisposeAsync()
    {
        _client.Dispose();
        await _factory.DisposeAsync();
    }

    [Fact]
    public async Task A_rule_is_created_read_listed_updated_with_compare_and_set_and_deleted()
    {
        var admin = await AccessTokenAsync("admin", [AccessTokenScopes.Read, AccessTokenScopes.Write, AccessTokenScopes.Admin]);

        using var created = await SendAsync(HttpMethod.Post, Collection, admin, Rule("Close out", PropertyTrigger));
        Assert.Equal(HttpStatusCode.Created, created.StatusCode);
        using var body = JsonDocument.Parse(await created.Content.ReadAsStringAsync(Cancellation));
        var id = body.RootElement.GetProperty("id").GetGuid();
        Assert.Equal(1, body.RootElement.GetProperty("revision").GetInt64());
        Assert.Equal("done", body.RootElement.GetProperty("trigger").GetProperty("to").GetProperty("value").GetString());
        Assert.Equal($"/api/v1/automations/{id:D}", created.Headers.Location?.OriginalString);

        using (var list = await SendAsync(HttpMethod.Get, Collection, admin))
        {
            using var listed = JsonDocument.Parse(await list.Content.ReadAsStringAsync(Cancellation));
            Assert.Equal(id, Assert.Single(listed.RootElement.GetProperty("items").EnumerateArray()).GetProperty("id").GetGuid());
        }

        using (var update = await SendAsync(HttpMethod.Put, $"/api/v1/automations/{id:D}", admin,
            new { expectedRevision = 1, rule = Rule("Renamed", PropertyTrigger) }))
        {
            Assert.Equal(HttpStatusCode.OK, update.StatusCode);
        }

        using (var stale = await SendAsync(HttpMethod.Put, $"/api/v1/automations/{id:D}", admin,
            new { expectedRevision = 1, rule = Rule("Again", PropertyTrigger) }))
        {
            Assert.Equal(HttpStatusCode.Conflict, stale.StatusCode);
            Assert.Equal("automation.conflict", await ProblemCodeAsync(stale));
        }

        using (var runs = await SendAsync(HttpMethod.Get, $"/api/v1/automations/{id:D}/runs", admin))
        {
            Assert.Equal(HttpStatusCode.OK, runs.StatusCode);
        }

        using (var deleted = await SendAsync(HttpMethod.Delete, $"/api/v1/automations/{id:D}", admin))
        {
            Assert.Equal(HttpStatusCode.NoContent, deleted.StatusCode);
        }

        using var gone = await SendAsync(HttpMethod.Get, $"/api/v1/automations/{id:D}", admin);
        Assert.Equal(HttpStatusCode.NotFound, gone.StatusCode);
        Assert.Equal("automation.not_found", await ProblemCodeAsync(gone));
    }

    [Fact]
    public async Task Malformed_and_unavailable_rules_get_their_own_422_codes()
    {
        var admin = await AccessTokenAsync("admin", [AccessTokenScopes.Read, AccessTokenScopes.Write, AccessTokenScopes.Admin]);

        using var invalid = await SendAsync(HttpMethod.Post, Collection, admin,
            Rule("Bad", """{"type":"schedule","freq":"hourly","interval":1,"time":"09:00"}"""));
        Assert.Equal(HttpStatusCode.UnprocessableEntity, invalid.StatusCode);
        Assert.Equal("automation.invalid", await ProblemCodeAsync(invalid));

        using var unavailable = await SendAsync(HttpMethod.Post, Collection, admin, new
        {
            name = "Later",
            enabled = true,
            trigger = JsonDocument.Parse(PropertyTrigger).RootElement,
            actions = JsonDocument.Parse("""[{"type":"create_from_template","templateId":"0199a000-0000-7000-8000-000000000001"}]""").RootElement,
        });
        Assert.Equal(HttpStatusCode.UnprocessableEntity, unavailable.StatusCode);
        Assert.Equal("automation.action_unavailable", await ProblemCodeAsync(unavailable));
    }

    [Fact]
    public async Task An_owner_keeps_at_most_fifty_rules_per_workspace()
    {
        var admin = await AccessTokenAsync("admin", [AccessTokenScopes.Read, AccessTokenScopes.Write, AccessTokenScopes.Admin]);
        var connection = await _fixture.OpenMigratorConnectionAsync();
        await using (connection.ConfigureAwait(false))
        {
            await RawSql.ExecuteAsync(connection, transaction: null, $"""
                INSERT INTO automation_rule (id, tenant_id, workspace_id, owner_principal_id, name, enabled, trigger_type, watch_key,
                                             trigger, conditions, actions, schema_version, revision, consecutive_failures, created_at, updated_at)
                SELECT gen_random_uuid(), '{TestTenants.Alpha}', '{TestTenants.AlphaWorkspace}', '{TestTenants.AlphaPrincipal}', 'r' || n, false,
                       'property_changed', 'status', '{PropertyTrigger}'::jsonb, '[]'::jsonb,
                       '{NotifyActions}'::jsonb, 1, 1, 0, now(), now()
                  FROM generate_series(1, 50) n;
                """);
        }

        using var refused = await SendAsync(HttpMethod.Post, Collection, admin, Rule("One more", PropertyTrigger));
        Assert.Equal(HttpStatusCode.UnprocessableEntity, refused.StatusCode);
        Assert.Equal("automation.limit_reached", await ProblemCodeAsync(refused));
    }

    [Fact]
    public async Task A_write_scoped_token_may_read_automations_but_changing_one_needs_admin()
    {
        var writer = await AccessTokenAsync("writer", [AccessTokenScopes.Read, AccessTokenScopes.Write]);

        using var list = await SendAsync(HttpMethod.Get, Collection, writer);
        Assert.Equal(HttpStatusCode.OK, list.StatusCode);

        using var create = await SendAsync(HttpMethod.Post, Collection, writer, Rule("Nope", PropertyTrigger));
        Assert.Equal(HttpStatusCode.Forbidden, create.StatusCode);

        var admin = await AccessTokenAsync("admin", [AccessTokenScopes.Read, AccessTokenScopes.Write, AccessTokenScopes.Admin]);
        using var created = await SendAsync(HttpMethod.Post, Collection, admin, Rule("Yes", PropertyTrigger));
        Assert.Equal(HttpStatusCode.Created, created.StatusCode);
        using var body = JsonDocument.Parse(await created.Content.ReadAsStringAsync(Cancellation));
        var id = body.RootElement.GetProperty("id").GetGuid();

        foreach (var (method, path) in new[]
        {
            (HttpMethod.Post, $"/api/v1/automations/{id:D}/run"),
            (HttpMethod.Post, $"/api/v1/automations/{id:D}/test"),
            (HttpMethod.Delete, $"/api/v1/automations/{id:D}"),
        })
        {
            using var refused = await SendAsync(method, path, writer, method == HttpMethod.Delete ? null : new { itemId = (Guid?)null });
            Assert.Equal(HttpStatusCode.Forbidden, refused.StatusCode);
        }

        using var read = await SendAsync(HttpMethod.Get, $"/api/v1/automations/{id:D}", writer);
        Assert.Equal(HttpStatusCode.OK, read.StatusCode);
    }

    private static object Rule(string name, string trigger) => new
    {
        name,
        enabled = true,
        scopeItemId = (Guid?)null,
        trigger = JsonDocument.Parse(trigger).RootElement,
        conditions = JsonDocument.Parse("[]").RootElement,
        actions = JsonDocument.Parse("""[{"type":"notify","title":"Done: {item.title}"}]""").RootElement,
    };

    private async Task<string> AccessTokenAsync(string name, string[] scopes)
    {
        await using var work = await _fixture.Application.BeginUnitOfWorkAsync(TestTenants.AlphaContext, Cancellation);
        var result = await work.Resolve<NixDispatcher>().SendAsync<CreateAccessToken, IssuedAccessToken>(
            new CreateAccessToken(name, scopes, 1), Cancellation);
        Assert.True(result.IsSuccess, result.IsFailure ? result.Error.Message : string.Empty);
        await work.CommitAsync(Cancellation);
        using var exchange = await _client.PostAsJsonAsync("/public/v1/auth/token", new { token = result.Value.Secret }, Cancellation);
        exchange.EnsureSuccessStatusCode();
        using var body = JsonDocument.Parse(await exchange.Content.ReadAsStringAsync(Cancellation));
        return body.RootElement.GetProperty("accessToken").GetString()!;
    }

    private async Task<HttpResponseMessage> SendAsync(HttpMethod method, string path, string bearer, object? body = null)
    {
        using var request = new HttpRequestMessage(method, path);
        request.Headers.Authorization = new AuthenticationHeaderValue("Bearer", bearer);
        if (body is not null)
        {
            request.Content = JsonContent.Create(body);
        }

        return await _client.SendAsync(request, Cancellation);
    }

    private static async Task<string?> ProblemCodeAsync(HttpResponseMessage response)
    {
        using var document = JsonDocument.Parse(await response.Content.ReadAsStringAsync(Cancellation));
        return document.RootElement.GetProperty("code").GetString();
    }
}
