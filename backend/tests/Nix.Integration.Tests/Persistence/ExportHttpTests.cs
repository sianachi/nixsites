using System.Net;
using System.Net.Http.Headers;
using System.Net.Http.Json;
using System.Security.Cryptography;
using System.Text.Json;
using Microsoft.AspNetCore.Mvc.Testing;
using Microsoft.Extensions.DependencyInjection;
using Nix.Abstractions;
using Nix.Abstractions.Files;
using Nix.Abstractions.Workers;
using Nix.Authentication;
using Nix.Domain.Files;
using Nix.Domain.Identity;
using Nix.Domain.Items;
using Nix.Domain.Tenancy;
using Nix.Features.Items;
using Nix.Features.Tokens;
using Nix.Integration.Tests.Harness;
using Nix.Messaging;
using Nix.Persistence.ObjectStorage;
using Nix.Persistence.RabbitMq;
using Nix.Persistence.Workers;

namespace Nix.Integration.Tests.Persistence;

[Collection(PostgresCollectionDefinition.Name)]
public sealed class ExportHttpTests : IAsyncLifetime
{
    private const string InternalSecret = "export-http-internal-secret";
    private readonly NixPostgresFixture _fixture;
    private readonly WorkerCapabilityRegistry _capabilities = new();
    private WebApplicationFactory<Program> _factory = null!;
    private HttpClient _client = null!;

    public ExportHttpTests(NixPostgresFixture fixture) => _fixture = fixture;

    private static CancellationToken Cancellation => TestContext.Current.CancellationToken;

    public async ValueTask InitializeAsync()
    {
        await _fixture.ResetAsync();
        await M0SchemaSeed.SeedBothTenantsAsync(_fixture);
        string signingKey;
        using (var key = ECDsa.Create(ECCurve.NamedCurves.nistP256))
        {
            signingKey = key.ExportECPrivateKeyPem();
        }
        _factory = new ConfiguredApplicationFactory(
            _capabilities,
            new Dictionary<string, string?>
            {
                ["ConnectionStrings:Nix"] = _fixture.ApplicationConnectionString,
                [InternalBoundaryMiddleware.SecretConfigurationKey] = InternalSecret,
                [SelfIssuedTokenService.IssuerConfigurationKey] = "https://core.export-http.test",
                [SelfIssuedTokenService.AudienceConfigurationKey] = "nix",
                [SelfIssuedTokenService.KeyIdConfigurationKey] = "export-http-key",
                [SelfIssuedTokenService.SigningKeyConfigurationKey] = signingKey,
                ["Nix:Collaboration:BaseUrl"] = "http://127.0.0.1:8100",
                ["Nix:ObjectStorage:Endpoint"] = "http://127.0.0.1:7070",
                ["Nix:ObjectStorage:Region"] = "us-east-1",
                ["Nix:ObjectStorage:Bucket"] = "nix-objects",
                ["Nix:ObjectStorage:AccessKey"] = "export-access",
                ["Nix:ObjectStorage:SecretKey"] = "export-secret",
            });
        _client = _factory.CreateClient();
        var now = DateTimeOffset.UtcNow;
        _capabilities.Replace(new WorkerCapabilityAdvertisement(
            "export-http-worker",
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
    public async Task Export_advertisement_execution_delegation_and_download_form_one_durable_flow()
    {
        var exportRoot = await CreateItemAsync("Export root", M0SchemaSeed.Alpha.ItemId);
        var exportedChild = await CreateItemAsync("Exported child", exportRoot);
        var unrelatedItem = await CreateItemAsync("Unrelated item", M0SchemaSeed.Alpha.ItemId);
        var token = await AccessTokenAsync();
        using var formats = await SendAsync(HttpMethod.Get, "/api/v1/exports/formats", token);
        formats.EnsureSuccessStatusCode();
        using (var catalog = JsonDocument.Parse(await formats.Content.ReadAsStringAsync(Cancellation)))
        {
            Assert.Equal("pdf", Assert.Single(catalog.RootElement.GetProperty("formats").EnumerateArray())
                .GetProperty("format").GetString());
        }

        using var begin = await SendAsync(
            HttpMethod.Post,
            "/api/v1/exports",
            token,
            new
            {
                itemId = exportRoot,
                format = "pdf",
                scope = "subtree",
                idempotencyKey = "export-http-flow",
            });
        Assert.Equal(HttpStatusCode.Accepted, begin.StatusCode);
        using var accepted = JsonDocument.Parse(await begin.Content.ReadAsStringAsync(Cancellation));
        var exportId = accepted.RootElement.GetProperty("id").GetGuid();
        Assert.Equal("queued", accepted.RootElement.GetProperty("status").GetString());

        const string execution = "export-http-worker:019946d1-fbc1-7d99-9ce7-1c721b406ff0";
        await using var scope = _fixture.Application.CreateUnscopedScope();
        var dispatch = scope.ServiceProvider.GetRequiredService<WorkerDispatchStore>();
        Assert.NotNull(await dispatch.ClaimJobAsync(exportId, execution, 60, Cancellation));

        var imageId = await CreateImageAsync();
        using var image = await InternalAsync(HttpMethod.Get,
            $"/internal/worker-executions/exports/{exportId:D}/images/{imageId:D}", exportId, execution);
        image.EnsureSuccessStatusCode();
        using (var imageBody = JsonDocument.Parse(await image.Content.ReadAsStringAsync(Cancellation)))
        {
            Assert.Equal("image/png", imageBody.RootElement.GetProperty("mediaType").GetString());
            Assert.Equal(12, imageBody.RootElement.GetProperty("byteLength").GetInt64());
            Assert.Contains("X-Amz-Signature", imageBody.RootElement.GetProperty("url").GetString(), StringComparison.Ordinal);
        }
        // A captured Mermaid diagram: an SVG the worker draws itself, so it needs no preview.
        var diagramId = await CreateImageAsync("image/svg+xml", previewable: false);
        using var diagram = await InternalAsync(HttpMethod.Get,
            $"/internal/worker-executions/exports/{exportId:D}/images/{diagramId:D}", exportId, execution);
        diagram.EnsureSuccessStatusCode();
        var textId = await CreateImageAsync("text/plain", previewable: false);
        using var text = await InternalAsync(HttpMethod.Get,
            $"/internal/worker-executions/exports/{exportId:D}/images/{textId:D}", exportId, execution);
        Assert.Equal(HttpStatusCode.NotFound, text.StatusCode);
        using var foreignImage = await InternalAsync(HttpMethod.Get,
            $"/internal/worker-executions/exports/{exportId:D}/images/{M0SchemaSeed.Beta.ItemId:D}", exportId, execution);
        Assert.Equal(HttpStatusCode.NotFound, foreignImage.StatusCode);
        using var staleImage = await InternalAsync(HttpMethod.Get,
            $"/internal/worker-executions/exports/{exportId:D}/images/{imageId:D}", exportId, "stale-execution");
        Assert.Equal(HttpStatusCode.Conflict, staleImage.StatusCode);

        using var source = await InternalAsync(
            HttpMethod.Get,
            $"/internal/worker-executions/exports/{exportId:D}",
            exportId,
            execution);
        source.EnsureSuccessStatusCode();
        using var sourceBody = JsonDocument.Parse(await source.Content.ReadAsStringAsync(Cancellation));
        var delegated = sourceBody.RootElement.GetProperty("bearerToken").GetString();
        Assert.NotNull(delegated);
        Assert.StartsWith(
            $"http://127.0.0.1:8100/documents/{exportRoot:D}/bundles?scope=subtree&exportedAt=",
            sourceBody.RootElement.GetProperty("sourceUrl").GetString(),
            StringComparison.Ordinal);

        using var readable = await InternalBearerAsync(
            HttpMethod.Get,
            $"/internal/authz/items/{exportRoot:D}",
            delegated!);
        Assert.Equal(HttpStatusCode.OK, readable.StatusCode);
        using (var authorization = JsonDocument.Parse(await readable.Content.ReadAsStringAsync(Cancellation)))
        {
            Assert.False(authorization.RootElement.GetProperty("canWrite").GetBoolean());
        }
        using var broaderRead = await SendAsync(
            HttpMethod.Get,
            $"/api/v1/items/{exportRoot:D}",
            delegated!);
        Assert.Equal(HttpStatusCode.OK, broaderRead.StatusCode);
        using var descendantRead = await SendAsync(
            HttpMethod.Get,
            $"/api/v1/items/{exportedChild:D}",
            delegated!);
        Assert.Equal(HttpStatusCode.OK, descendantRead.StatusCode);
        using var childrenRead = await SendAsync(
            HttpMethod.Get,
            $"/api/v1/workspaces/{M0SchemaSeed.Alpha.WorkspaceId:D}/items?parentId={exportRoot:D}",
            delegated!);
        Assert.Equal(HttpStatusCode.OK, childrenRead.StatusCode);
        using var unrelatedRead = await SendAsync(
            HttpMethod.Get,
            $"/api/v1/items/{unrelatedItem:D}",
            delegated!);
        Assert.Equal(HttpStatusCode.Forbidden, unrelatedRead.StatusCode);
        Assert.Equal("auth.insufficient_scope", await ProblemCodeAsync(unrelatedRead));
        using var otherTenantRead = await SendAsync(
            HttpMethod.Get,
            $"/api/v1/items/{M0SchemaSeed.Beta.ItemId:D}",
            delegated!);
        Assert.Equal(HttpStatusCode.Forbidden, otherTenantRead.StatusCode);
        using var forbiddenWrite = await SendAsync(
            HttpMethod.Patch,
            $"/api/v1/items/{exportRoot:D}",
            delegated!,
            new { title = "Must not change" });
        Assert.Equal(HttpStatusCode.Forbidden, forbiddenWrite.StatusCode);
        Assert.Equal("auth.insufficient_scope", await ProblemCodeAsync(forbiddenWrite));

        using var destination = await InternalAsync(
            HttpMethod.Get,
            $"/internal/worker-executions/exports/{exportId:D}/destination?byteLength=100&sha256={new string('a', 64)}",
            exportId,
            execution);
        destination.EnsureSuccessStatusCode();
        using var destinationBody = JsonDocument.Parse(await destination.Content.ReadAsStringAsync(Cancellation));
        var attemptId = destinationBody.RootElement.GetProperty("attemptId").GetGuid();
        var objectKey = destinationBody.RootElement.GetProperty("objectKey").GetString();
        Assert.Equal(
            $"exports/results/{TestTenants.Alpha:D}/{exportId:D}/{attemptId:D}.pdf",
            objectKey);

        var result = JsonSerializer.Serialize(new
        {
            attemptId,
            format = "pdf",
            objectKey,
            itemCount = 1,
            omittedCount = 0,
            byteLength = 100,
            sha256 = new string('a', 64),
            loss = Array.Empty<string>(),
            omissions = Array.Empty<string>(),
        });
        Assert.True(await dispatch.FinishJobAsync(
            exportId,
            execution,
            succeeded: true,
            retryable: false,
            result,
            errorCode: null,
            errorDetail: null,
            Cancellation));

        using var revoked = await InternalBearerAsync(
            HttpMethod.Get,
            $"/internal/authz/items/{exportRoot:D}",
            delegated!);
        Assert.Equal(HttpStatusCode.Unauthorized, revoked.StatusCode);
        Assert.Equal("auth.token_revoked", await ProblemCodeAsync(revoked));

        using var status = await SendAsync(HttpMethod.Get, $"/api/v1/exports/{exportId:D}", token);
        status.EnsureSuccessStatusCode();
        using (var completed = JsonDocument.Parse(await status.Content.ReadAsStringAsync(Cancellation)))
        {
            Assert.Equal("completed", completed.RootElement.GetProperty("status").GetString());
            Assert.True(completed.RootElement.GetProperty("downloadReady").GetBoolean());
        }
        using var download = await SendAsync(
            HttpMethod.Get,
            $"/api/v1/exports/{exportId:D}/download",
            token);
        download.EnsureSuccessStatusCode();
        using var capability = JsonDocument.Parse(await download.Content.ReadAsStringAsync(Cancellation));
        Assert.Contains(
            $"/{exportId:D}/{attemptId:D}.pdf",
            capability.RootElement.GetProperty("url").GetString(),
            StringComparison.Ordinal);
    }

    [Fact]
    public async Task Export_state_is_hidden_after_the_actor_loses_workspace_access()
    {
        var token = await AccessTokenAsync();
        using var begin = await SendAsync(
            HttpMethod.Post,
            "/api/v1/exports",
            token,
            new
            {
                itemId = M0SchemaSeed.Alpha.ItemId,
                format = "pdf",
                scope = "item",
                idempotencyKey = "export-http-revoked",
            });
        Assert.Equal(HttpStatusCode.Accepted, begin.StatusCode);
        using var accepted = JsonDocument.Parse(await begin.Content.ReadAsStringAsync(Cancellation));
        var exportId = accepted.RootElement.GetProperty("id").GetGuid();

        var connection = await _fixture.OpenMigratorConnectionAsync();
        await using (connection.ConfigureAwait(false))
        {
            await RawSql.ExecuteAsync(
                connection,
                transaction: null,
                $"""
                DELETE FROM tenant_role
                WHERE tenant_id = '{TestTenants.Alpha:D}'::uuid
                  AND subject_id = '{TestTenants.AlphaPrincipal:D}'::uuid;
                DELETE FROM workspace_member
                WHERE tenant_id = '{TestTenants.Alpha:D}'::uuid
                  AND workspace_id = '{TestTenants.AlphaWorkspace:D}'::uuid
                  AND subject_id = '{TestTenants.AlphaPrincipal:D}'::uuid;
                """);
        }

        using var status = await SendAsync(HttpMethod.Get, $"/api/v1/exports/{exportId:D}", token);
        Assert.Equal(HttpStatusCode.NotFound, status.StatusCode);
        using var cancel = await SendAsync(HttpMethod.Post, $"/api/v1/exports/{exportId:D}/cancel", token);
        Assert.Equal(HttpStatusCode.NotFound, cancel.StatusCode);
        using var download = await SendAsync(HttpMethod.Get, $"/api/v1/exports/{exportId:D}/download", token);
        Assert.Equal(HttpStatusCode.NotFound, download.StatusCode);
    }

    [Fact]
    public async Task Export_idempotency_replays_the_original_durable_contract()
    {
        var itemId = await CreateItemAsync("Replay original", M0SchemaSeed.Alpha.ItemId);
        var token = await AccessTokenAsync();
        using var first = await SendAsync(
            HttpMethod.Post,
            "/api/v1/exports",
            token,
            new
            {
                itemId,
                format = "pdf",
                scope = "item",
                idempotencyKey = "export-http-replay",
            });
        Assert.Equal(HttpStatusCode.Accepted, first.StatusCode);
        using var original = JsonDocument.Parse(await first.Content.ReadAsStringAsync(Cancellation));
        var originalId = original.RootElement.GetProperty("id").GetGuid();
        var originalFileName = original.RootElement.GetProperty("fileName").GetString();
        var originalMediaType = original.RootElement.GetProperty("mediaType").GetString();
        var originalLoss = original.RootElement.GetProperty("loss")
            .EnumerateArray()
            .Select(entry => entry.GetString())
            .ToArray();

        using var rename = await SendAsync(
            HttpMethod.Patch,
            $"/api/v1/items/{itemId:D}",
            token,
            new { title = "Replay renamed" });
        rename.EnsureSuccessStatusCode();
        var now = DateTimeOffset.UtcNow.AddSeconds(1);
        _capabilities.Replace(new WorkerCapabilityAdvertisement(
            "export-http-worker",
            "export",
            now,
            now.AddMinutes(2),
            [new ExportFormatCapability(
                "pdf",
                "Revised PDF",
                "pdf",
                "application/pdf",
                Lossless: false,
                DeclaredLoss: ["A newly advertised loss must not rewrite an existing job."])]));

        using var replay = await SendAsync(
            HttpMethod.Post,
            "/api/v1/exports",
            token,
            new
            {
                itemId,
                format = "pdf",
                scope = "item",
                idempotencyKey = "export-http-replay",
            });
        Assert.Equal(HttpStatusCode.Accepted, replay.StatusCode);
        using var replayed = JsonDocument.Parse(await replay.Content.ReadAsStringAsync(Cancellation));
        Assert.Equal(originalId, replayed.RootElement.GetProperty("id").GetGuid());
        Assert.Equal(originalFileName, replayed.RootElement.GetProperty("fileName").GetString());
        Assert.Equal(originalMediaType, replayed.RootElement.GetProperty("mediaType").GetString());
        Assert.Equal(
            originalLoss,
            replayed.RootElement.GetProperty("loss")
                .EnumerateArray()
                .Select(entry => entry.GetString())
                .ToArray());

        using var conflict = await SendAsync(
            HttpMethod.Post,
            "/api/v1/exports",
            token,
            new
            {
                itemId,
                format = "pdf",
                scope = "subtree",
                idempotencyKey = "export-http-replay",
            });
        Assert.Equal(HttpStatusCode.Conflict, conflict.StatusCode);
        Assert.Equal("exports.idempotency_conflict", await ProblemCodeAsync(conflict));
    }

    private async Task<Guid> CreateImageAsync(string mediaType = "image/png", bool previewable = true)
    {
        await using var work = await _fixture.Application.BeginUnitOfWorkAsync(TestTenants.AlphaContext, Cancellation);
        var files = work.Resolve<IFileStore>();
        var upload = Assert.IsType<FileUploadRecord>(await files.BeginAsync(
            new BeginFileUpload(WorkspaceId.From(M0SchemaSeed.Alpha.WorkspaceId), null, null,
                "figure", mediaType, 12, "export-image-" + mediaType), Cancellation));
        Assert.NotNull(await files.QueueInspectionAsync(FileUploadId.From(upload.Id), Cancellation));
        var file = Assert.IsType<FileRecord>(await files.CompleteAsync(
            new CompleteFileUpload(FileUploadId.From(upload.Id), mediaType, 12, new string('a', 64),
                Previewable: previewable, PixelWidth: previewable ? 4 : null, PixelHeight: previewable ? 2 : null), Cancellation));
        await work.CommitAsync(Cancellation);
        return file.ItemId;
    }

    private async Task<Guid> CreateItemAsync(string title, Guid parentId)
    {
        await using var work = await _fixture.Application.BeginUnitOfWorkAsync(
            TestTenants.AlphaContext,
            Cancellation);
        var result = await work.Resolve<NixDispatcher>().SendAsync<CreateItem, Item>(
            new CreateItem(
                WorkspaceId.From(TestTenants.AlphaWorkspace),
                "note",
                title,
                ItemId.From(parentId),
                Properties: null),
            Cancellation);
        Assert.True(result.IsSuccess, result.IsFailure ? result.Error.Message : string.Empty);
        await work.CommitAsync(Cancellation);
        return result.Value.Id.Value;
    }

    private async Task<string> AccessTokenAsync()
    {
        await using var work = await _fixture.Application.BeginUnitOfWorkAsync(
            TestTenants.AlphaContext,
            Cancellation);
        var result = await work.Resolve<NixDispatcher>().SendAsync<CreateAccessToken, IssuedAccessToken>(
            new CreateAccessToken(
                "export-http",
                [AccessTokenScopes.Read, AccessTokenScopes.Write],
                1),
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

    private async Task<HttpResponseMessage> InternalAsync(
        HttpMethod method,
        string path,
        Guid jobId,
        string execution)
    {
        using var request = new HttpRequestMessage(method, path);
        request.Headers.TryAddWithoutValidation(InternalBoundaryMiddleware.SecretHeaderName, InternalSecret);
        request.Headers.TryAddWithoutValidation(WorkerExecutionMiddleware.JobHeaderName, jobId.ToString("D"));
        request.Headers.TryAddWithoutValidation(WorkerExecutionMiddleware.ExecutionHeaderName, execution);
        return await _client.SendAsync(request, Cancellation);
    }

    private async Task<HttpResponseMessage> InternalBearerAsync(
        HttpMethod method,
        string path,
        string bearer)
    {
        using var request = new HttpRequestMessage(method, path);
        request.Headers.Authorization = new AuthenticationHeaderValue("Bearer", bearer);
        request.Headers.TryAddWithoutValidation(InternalBoundaryMiddleware.SecretHeaderName, InternalSecret);
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
