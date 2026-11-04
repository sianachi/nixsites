using System.Net;
using System.Net.Http.Headers;
using System.Net.Http.Json;
using System.Security.Cryptography;
using System.Text.Json;
using Microsoft.AspNetCore.Mvc.Testing;
using Microsoft.Extensions.DependencyInjection;
using Nix.Abstractions.Workers;
using Nix.Authentication;
using Nix.Domain.Identity;
using Nix.Features.Tokens;
using Nix.Integration.Tests.Harness;
using Nix.Messaging;
using Nix.Persistence.RabbitMq;

namespace Nix.Integration.Tests.Persistence;

/// <summary>
/// Item locks through the real pipeline: tokens exchanged, the unit-of-work middleware recording
/// the credential, the lock routes, and the internal question the collaboration service asks.
/// </summary>
/// <remarks>
/// <para>
/// The persistence-level suite sets the credential by hand. This one proves the middleware does it:
/// two personal access tokens held by the same person are two credentials, so unlocking with one
/// leaves the other closed. If the middleware stopped recording a credential, every unlock here
/// would fail and so would this suite.
/// </para>
/// </remarks>
[Collection(PostgresSecondaryCollectionDefinition.Name)]
public sealed class ItemLockHttpTests : IAsyncLifetime
{
    private const string InternalSecret = "item-lock-http-internal-secret";
    private readonly NixPostgresFixture _fixture;
    private readonly WorkerCapabilityRegistry _capabilities = new();
    private WebApplicationFactory<Program> _factory = null!;
    private HttpClient _client = null!;

    public ItemLockHttpTests(NixPostgresFixture fixture) => _fixture = fixture;

    private static CancellationToken Cancellation => TestContext.Current.CancellationToken;

    private static string ItemPath => $"/api/v1/items/{M0SchemaSeed.Alpha.ItemId:D}";

    public async ValueTask InitializeAsync()
    {
        await _fixture.ResetAsync();
        await M0SchemaSeed.SeedBothTenantsAsync(_fixture);
        string signingKey;
        using (var key = ECDsa.Create(ECCurve.NamedCurves.nistP256))
        {
            signingKey = key.ExportECPrivateKeyPem();
        }

        _factory = new ConfiguredApplicationFactory(_capabilities, new Dictionary<string, string?>
        {
            ["ConnectionStrings:Nix"] = _fixture.ApplicationConnectionString,
            [InternalBoundaryMiddleware.SecretConfigurationKey] = InternalSecret,
            [SelfIssuedTokenService.IssuerConfigurationKey] = "https://core.item-lock-http.test",
            [SelfIssuedTokenService.AudienceConfigurationKey] = "nix",
            [SelfIssuedTokenService.KeyIdConfigurationKey] = "item-lock-http-key",
            [SelfIssuedTokenService.SigningKeyConfigurationKey] = signingKey,
            ["Nix:Collaboration:BaseUrl"] = "http://127.0.0.1:8100",
            ["Nix:ObjectStorage:Endpoint"] = "http://127.0.0.1:7070",
            ["Nix:ObjectStorage:Region"] = "us-east-1",
            ["Nix:ObjectStorage:Bucket"] = "nix-objects",
            ["Nix:ObjectStorage:AccessKey"] = "lock-access",
            ["Nix:ObjectStorage:SecretKey"] = "lock-secret",
        });
        _client = _factory.CreateClient();
        var now = DateTimeOffset.UtcNow;
        _capabilities.Replace(new WorkerCapabilityAdvertisement(
            Nix.Workers.ExportCapabilityAdvertiser.InstanceId,
            "export",
            now,
            now.AddMinutes(2),
            [new ExportFormatCapability(
                "pdf",
                "PDF",
                "pdf",
                "application/pdf",
                Lossless: false,
                DeclaredLoss: ["Interactive behavior is flattened."])]));
    }

    public async ValueTask DisposeAsync()
    {
        _client.Dispose();
        await _factory.DisposeAsync();
    }

    [Fact]
    public async Task Each_token_is_its_own_credential_and_the_collaboration_service_is_told_the_body_is_locked()
    {
        var mine = await AccessTokenAsync("lock-http-mine");
        var other = await AccessTokenAsync("lock-http-other");

        using (var locked = await SendAsync(HttpMethod.Put, $"{ItemPath}/lock", mine, new { password = "hunter22" }))
        {
            Assert.Equal(HttpStatusCode.NoContent, locked.StatusCode);
        }

        Assert.NotNull(await UnlockedUntilAsync(mine));
        Assert.Null(await UnlockedUntilAsync(other));

        using (var open = await InternalAuthzAsync(mine))
        {
            Assert.Equal(HttpStatusCode.OK, open.StatusCode);
        }

        using (var closed = await InternalAuthzAsync(other))
        {
            Assert.Equal(HttpStatusCode.Forbidden, closed.StatusCode);
            Assert.Equal("internal.body_locked", await ProblemCodeAsync(closed));
        }

        using (var unlocked = await SendAsync(HttpMethod.Post, $"{ItemPath}/unlock", other, new { password = "hunter22" }))
        {
            Assert.Equal(HttpStatusCode.OK, unlocked.StatusCode);
        }

        using (var nowOpen = await InternalAuthzAsync(other))
        {
            Assert.Equal(HttpStatusCode.OK, nowOpen.StatusCode);
        }
    }

    [Fact]
    public async Task Refusals_carry_the_status_their_code_stands_for()
    {
        var token = await AccessTokenAsync("lock-http-refusals");

        using (var tooShort = await SendAsync(HttpMethod.Put, $"{ItemPath}/lock", token, new { password = "abc" }))
        {
            Assert.Equal(HttpStatusCode.BadRequest, tooShort.StatusCode);
            Assert.Equal("locks.password_invalid", await ProblemCodeAsync(tooShort));
        }

        using (var notLocked = await SendAsync(HttpMethod.Post, $"{ItemPath}/unlock", token, new { password = "hunter22" }))
        {
            Assert.Equal(HttpStatusCode.Conflict, notLocked.StatusCode);
            Assert.Equal("locks.not_locked", await ProblemCodeAsync(notLocked));
        }

        using (var _ = await SendAsync(HttpMethod.Put, $"{ItemPath}/lock", token, new { password = "hunter22" }))
        {
        }

        using (var wrong = await SendAsync(HttpMethod.Post, $"{ItemPath}/lock/remove", token, new { password = "nope!" }))
        {
            Assert.Equal(HttpStatusCode.Forbidden, wrong.StatusCode);
            Assert.Equal("locks.wrong_password", await ProblemCodeAsync(wrong));
        }

        using (var again = await SendAsync(HttpMethod.Put, $"{ItemPath}/lock", token, new { password = "second" }))
        {
            Assert.Equal(HttpStatusCode.Conflict, again.StatusCode);
            Assert.Equal("locks.already_locked", await ProblemCodeAsync(again));
        }

        using (var missing = await SendAsync(HttpMethod.Get, $"/api/v1/items/{Guid.NewGuid():D}/lock", token))
        {
            Assert.Equal(HttpStatusCode.NotFound, missing.StatusCode);
        }
    }

    /// <summary>
    /// A lock covers the locked item's children: its children list answers 423 to a credential that
    /// has not opened it, and a child's own lock state names the folder as the one to unlock.
    /// </summary>
    [Fact]
    public async Task A_locked_items_children_answer_locked_and_point_at_the_folder()
    {
        var mine = await AccessTokenAsync("lock-http-children-mine");
        var other = await AccessTokenAsync("lock-http-children-other");
        var childrenPath =
            $"/api/v1/workspaces/{M0SchemaSeed.Alpha.WorkspaceId:D}/items?parentId={M0SchemaSeed.Alpha.ItemId:D}";

        string childId;
        using (var created = await SendAsync(
            HttpMethod.Post,
            $"/api/v1/workspaces/{M0SchemaSeed.Alpha.WorkspaceId:D}/items",
            mine,
            new { type = "note", title = "Inside", parentId = M0SchemaSeed.Alpha.ItemId }))
        {
            Assert.Equal(HttpStatusCode.Created, created.StatusCode);
            using var body = JsonDocument.Parse(await created.Content.ReadAsStringAsync(Cancellation));
            childId = body.RootElement.GetProperty("id").GetString()!;
        }

        using (var _ = await SendAsync(HttpMethod.Put, $"{ItemPath}/lock", mine, new { password = "hunter22" }))
        {
        }

        using (var closed = await SendAsync(HttpMethod.Get, childrenPath, other))
        {
            Assert.Equal((HttpStatusCode)423, closed.StatusCode);
            Assert.Equal("items.locked", await ProblemCodeAsync(closed));
        }

        using (var open = await SendAsync(HttpMethod.Get, childrenPath, mine))
        {
            Assert.Equal(HttpStatusCode.OK, open.StatusCode);
        }

        using (var state = await SendAsync(HttpMethod.Get, $"/api/v1/items/{childId}/lock", other))
        {
            state.EnsureSuccessStatusCode();
            using var body = JsonDocument.Parse(await state.Content.ReadAsStringAsync(Cancellation));
            Assert.True(body.RootElement.GetProperty("locked").GetBoolean());
            Assert.False(body.RootElement.GetProperty("selfLocked").GetBoolean());
            Assert.Equal(
                M0SchemaSeed.Alpha.ItemId,
                body.RootElement.GetProperty("lockItemId").GetGuid());
        }
    }

    /// <summary>
    /// Trashing marks only the trashed item, so trash must withhold one under a closed lock the
    /// way the children listing does, rather than list its title to every reader.
    /// </summary>
    [Fact]
    public async Task Trash_withholds_an_item_trashed_inside_a_lock_the_reader_has_not_opened()
    {
        var mine = await AccessTokenAsync("lock-http-trash-mine");
        var other = await AccessTokenAsync("lock-http-trash-other");
        var trashPath = $"/api/v1/workspaces/{M0SchemaSeed.Alpha.WorkspaceId:D}/items/trash";

        string childId;
        using (var created = await SendAsync(
            HttpMethod.Post,
            $"/api/v1/workspaces/{M0SchemaSeed.Alpha.WorkspaceId:D}/items",
            mine,
            new { type = "note", title = "Trashed inside", parentId = M0SchemaSeed.Alpha.ItemId }))
        {
            Assert.Equal(HttpStatusCode.Created, created.StatusCode);
            using var body = JsonDocument.Parse(await created.Content.ReadAsStringAsync(Cancellation));
            childId = body.RootElement.GetProperty("id").GetString()!;
        }

        using (var locked = await SendAsync(HttpMethod.Put, $"{ItemPath}/lock", mine, new { password = "hunter22" }))
        {
            Assert.Equal(HttpStatusCode.NoContent, locked.StatusCode);
        }

        using (var deleted = await SendAsync(HttpMethod.Delete, $"/api/v1/items/{childId}", mine))
        {
            Assert.True(deleted.IsSuccessStatusCode, $"Delete answered {deleted.StatusCode}.");
        }

        Assert.Contains(childId, await TrashIdsAsync(mine));
        Assert.DoesNotContain(childId, await TrashIdsAsync(other));

        async Task<List<string>> TrashIdsAsync(string token)
        {
            using var response = await SendAsync(HttpMethod.Get, trashPath, token);
            response.EnsureSuccessStatusCode();
            using var body = JsonDocument.Parse(await response.Content.ReadAsStringAsync(Cancellation));
            return [.. body.RootElement.GetProperty("items").EnumerateArray().Select(item => item.GetProperty("id").GetString()!)];
        }
    }

    /// <summary>
    /// An export copies bodies out of Nix, and runs under a delegation that can hold no unlock, so
    /// one that would include a locked body is refused before a job exists.
    /// </summary>
    [Fact]
    public async Task An_export_that_would_include_a_locked_body_is_refused_up_front()
    {
        var token = await AccessTokenAsync("lock-http-export");
        using (var _ = await SendAsync(HttpMethod.Put, $"{ItemPath}/lock", token, new { password = "hunter22" }))
        {
        }

        using var begin = await SendAsync(
            HttpMethod.Post,
            "/api/v1/exports",
            token,
            new
            {
                itemId = M0SchemaSeed.Alpha.ItemId,
                format = "pdf",
                scope = "subtree",
                idempotencyKey = "lock-http-export",
            });

        Assert.Equal(HttpStatusCode.Conflict, begin.StatusCode);
        Assert.Equal("exports.item_locked", await ProblemCodeAsync(begin));
    }

    private async Task<string?> UnlockedUntilAsync(string token)
    {
        using var response = await SendAsync(HttpMethod.Get, $"{ItemPath}/lock", token);
        response.EnsureSuccessStatusCode();
        using var body = JsonDocument.Parse(await response.Content.ReadAsStringAsync(Cancellation));
        var until = body.RootElement.GetProperty("unlockedUntil");
        return until.ValueKind == JsonValueKind.Null ? null : until.GetString();
    }

    private async Task<HttpResponseMessage> InternalAuthzAsync(string bearer)
    {
        using var request = new HttpRequestMessage(
            HttpMethod.Get,
            $"/internal/authz/items/{M0SchemaSeed.Alpha.ItemId:D}");
        request.Headers.Authorization = new AuthenticationHeaderValue("Bearer", bearer);
        request.Headers.TryAddWithoutValidation(InternalBoundaryMiddleware.SecretHeaderName, InternalSecret);
        return await _client.SendAsync(request, Cancellation);
    }

    private async Task<string> AccessTokenAsync(string name)
    {
        await using var work = await _fixture.Application.BeginUnitOfWorkAsync(
            TestTenants.AlphaContext,
            Cancellation);
        var result = await work.Resolve<NixDispatcher>().SendAsync<CreateAccessToken, IssuedAccessToken>(
            new CreateAccessToken(name, [AccessTokenScopes.Read, AccessTokenScopes.Write], 1),
            Cancellation);
        Assert.True(result.IsSuccess, result.IsFailure ? result.Error.Message : string.Empty);
        await work.CommitAsync(Cancellation);
        using var exchange = await _client.PostAsJsonAsync(
            "/public/v1/auth/token",
            new { token = result.Value.Secret },
            Cancellation);
        exchange.EnsureSuccessStatusCode();
        using var body = JsonDocument.Parse(await exchange.Content.ReadAsStringAsync(Cancellation));
        return body.RootElement.GetProperty("accessToken").GetString()!;
    }

    private async Task<HttpResponseMessage> SendAsync(
        HttpMethod method,
        string path,
        string bearer,
        object? body = null)
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

    private sealed class ConfiguredApplicationFactory(
        WorkerCapabilityRegistry capabilities,
        Dictionary<string, string?> settings) : WebApplicationFactory<Program>
    {
        protected override void ConfigureWebHost(Microsoft.AspNetCore.Hosting.IWebHostBuilder builder)
        {
            foreach (var (key, value) in settings)
            {
                builder.UseSetting(key, value);
            }

            builder.ConfigureServices(services => services.AddSingleton<IWorkerCapabilityRegistry>(capabilities));
        }
    }
}
