using System.Net;
using System.Net.Http.Headers;
using System.Net.Http.Json;
using System.Security.Cryptography;
using System.Text.Json;
using Microsoft.AspNetCore.Mvc.Testing;
using Microsoft.Extensions.DependencyInjection;
using Microsoft.Extensions.DependencyInjection.Extensions;
using Nix.Abstractions;
using Nix.Abstractions.Files;
using Nix.Abstractions.Workers;
using Nix.Authentication;
using Nix.Domain.Files;
using Nix.Domain.Identity;
using Nix.Domain.Items;
using Nix.Domain.Tenancy;
using Nix.Features.Exports;
using Nix.Features.Items;
using Nix.Features.Tokens;
using Nix.Integration.Tests.Harness;
using Nix.Messaging;
using Nix.Persistence.Workers;
using Nix.Workers;

namespace Nix.Integration.Tests.Persistence;

/// <summary>
/// Export to a file item through Core's real routes and Postgres: the source note and revision
/// travel from the export request to the published file version, the worker routes open and
/// publish the upload, and every refusal happens before a job exists.
/// </summary>
[Collection(PostgresCollectionDefinition.Name)]
public sealed class ExportToFileTests : IAsyncLifetime
{
    private const string InternalSecret = "export-to-file-internal-secret";
    private const string Sha = "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa";
    private readonly NixPostgresFixture _fixture;
    private readonly WorkerCapabilityRegistry _capabilities = new();
    private readonly RecordingNamer _namer = new();
    private WebApplicationFactory<Program> _factory = null!;
    private HttpClient _client = null!;
    private (Guid AttemptId, string ObjectKey) _attempt;

    public ExportToFileTests(NixPostgresFixture fixture) => _fixture = fixture;

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
            _namer,
            new Dictionary<string, string?>
            {
                ["ConnectionStrings:Nix"] = _fixture.ApplicationConnectionString,
                [InternalBoundaryMiddleware.SecretConfigurationKey] = InternalSecret,
                [SelfIssuedTokenService.IssuerConfigurationKey] = "https://core.export-file.test",
                [SelfIssuedTokenService.AudienceConfigurationKey] = "nix",
                [SelfIssuedTokenService.KeyIdConfigurationKey] = "export-file-key",
                [SelfIssuedTokenService.SigningKeyConfigurationKey] = signingKey,
                ["Nix:Collaboration:BaseUrl"] = "http://127.0.0.1:8100",
                ["Nix:ObjectStorage:Endpoint"] = "http://127.0.0.1:7070",
                ["Nix:ObjectStorage:Region"] = "us-east-1",
                ["Nix:ObjectStorage:Bucket"] = "nix-objects",
                ["Nix:ObjectStorage:AccessKey"] = "export-access",
                ["Nix:ObjectStorage:SecretKey"] = "export-secret",
                // The test plays the export worker itself, so the in-process hosts must not lease its jobs.
                ["Nix:Workers:Families:0"] = "notify",
            });
        _client = _factory.CreateClient();
        var now = DateTimeOffset.UtcNow;
        _capabilities.Replace(new WorkerCapabilityAdvertisement(
            Nix.Workers.ExportCapabilityAdvertiser.InstanceId,
            "export",
            now,
            now.AddMinutes(2),
            [
                new ExportFormatCapability("pdf", "PDF", "pdf", "application/pdf", Lossless: false, DeclaredLoss: []),
                new ExportFormatCapability("nix", "Nix archive", "nix", "application/vnd.nix.archive", Lossless: true, DeclaredLoss: []),
            ]));
    }

    public async ValueTask DisposeAsync()
    {
        _client.Dispose();
        await _factory.DisposeAsync();
    }

    [Fact]
    public async Task A_note_exported_to_a_new_child_file_records_its_source_and_revision_through_publication()
    {
        var note = await CreateNoteAsync("Quarterly plan", headSeq: 5);
        var token = await AccessTokenAsync();

        var exportId = await BeginAsync(token, note, "export-file-new");

        // The revision is named for the caller before the job exists, and the worker reads exactly that revision.
        var named = Assert.Single(_namer.Calls);
        Assert.Equal((note, 5L, token), (named.ItemId, named.Seq, named.Bearer));
        Assert.StartsWith("Exported to PDF", named.Name, StringComparison.Ordinal);
        const string execution = "export-file-worker:019946d1-fbc1-7d99-9ce7-1c721b406ff0";
        await ClaimAsync(exportId, execution);
        using var source = await InternalAsync(HttpMethod.Get, $"/internal/worker-executions/exports/{exportId:D}", exportId, execution);
        source.EnsureSuccessStatusCode();
        using (var sourceBody = JsonDocument.Parse(await source.Content.ReadAsStringAsync(Cancellation)))
        {
            Assert.Contains("&atSeq=5", sourceBody.RootElement.GetProperty("sourceUrl").GetString(), StringComparison.Ordinal);
        }

        var uploadId = await UploadAndPublishAsync(exportId, execution);

        // file.publish is queued exactly once, for this upload.
        Assert.Equal(1, await CountAsync($"SELECT count(*) FROM worker_job WHERE kind = 'file.publish' AND idempotency_key = 'file.publish:{uploadId:D}'"));
        Assert.Equal(note.ToString("D"), await TextAsync($"SELECT source_item_id::text FROM file_upload WHERE upload_id = '{uploadId}'"));
        Assert.Equal("5", await TextAsync($"SELECT source_seq::text FROM file_upload WHERE upload_id = '{uploadId}'"));

        var file = await CompleteUploadAsync(uploadId);

        Assert.Equal(note, (await ParentOfAsync(file.ItemId)));
        Assert.Equal(1, file.Current.Version);
        Assert.Equal(note.ToString("D"), await TextAsync($"SELECT source_item_id::text FROM file_version WHERE file_version_id = '{file.Current.Id}'"));
        Assert.Equal("5", await TextAsync($"SELECT source_seq::text FROM file_version WHERE file_version_id = '{file.Current.Id}'"));
        Assert.Equal("draft", await TextAsync($"SELECT state FROM file_version WHERE file_version_id = '{file.Current.Id}'"));
        Assert.Equal(file.Current.Id.ToString("D"), await TextAsync($"SELECT published_version_id::text FROM file_upload WHERE upload_id = '{uploadId}'"));

        using var status = await SendAsync(HttpMethod.Get, $"/api/v1/files/uploads/{uploadId:D}", token);
        status.EnsureSuccessStatusCode();
        using (var statusBody = JsonDocument.Parse(await status.Content.ReadAsStringAsync(Cancellation)))
        {
            Assert.Equal(file.Current.Id, statusBody.RootElement.GetProperty("publishedVersionId").GetGuid());
        }

        await FinishAsync(exportId, execution);
        using var export = await SendAsync(HttpMethod.Get, $"/api/v1/exports/{exportId:D}", token);
        export.EnsureSuccessStatusCode();
        using (var exportBody = JsonDocument.Parse(await export.Content.ReadAsStringAsync(Cancellation)))
        {
            Assert.Equal("completed", exportBody.RootElement.GetProperty("status").GetString());
            Assert.Equal(uploadId, exportBody.RootElement.GetProperty("uploadId").GetGuid());
            Assert.False(exportBody.RootElement.GetProperty("downloadReady").GetBoolean());
        }
        using var download = await SendAsync(HttpMethod.Get, $"/api/v1/exports/{exportId:D}/download", token);
        Assert.Equal(HttpStatusCode.Conflict, download.StatusCode);
    }

    [Fact]
    public async Task A_second_export_to_a_named_file_adds_a_version_to_that_file()
    {
        var note = await CreateNoteAsync("Versioned plan", headSeq: 9);
        var target = await CreateFileAsync("plan.pdf");
        var token = await AccessTokenAsync();
        var exportId = await BeginAsync(token, note, "export-file-target", target);
        const string execution = "export-file-worker:019946d1-fbc1-7d99-9ce7-1c721b406ff1";
        await ClaimAsync(exportId, execution);

        var uploadId = await UploadAndPublishAsync(exportId, execution);
        var file = await CompleteUploadAsync(uploadId);

        Assert.Equal(target, file.ItemId);
        Assert.Equal(2, file.Current.Version);
        Assert.Equal(2, file.Versions.Count);
        Assert.Equal("9", await TextAsync($"SELECT source_seq::text FROM file_version WHERE file_version_id = '{file.Current.Id}'"));
        // The first version carries no source: only exports record one.
        Assert.Null(await TextAsync($"SELECT source_seq::text FROM file_version WHERE item_id = '{target}' AND version = 1"));
    }

    [Fact]
    public async Task A_publication_that_is_not_an_export_still_returns_its_published_version()
    {
        var fileId = await CreateFileAsync("plain.pdf");
        var uploadRow = await TextAsync($"SELECT upload_id::text FROM file_upload WHERE published_item_id = '{fileId}'");
        Assert.NotNull(uploadRow);
        Assert.NotNull(await TextAsync($"SELECT published_version_id::text FROM file_upload WHERE upload_id = '{uploadRow}'"));
        var token = await AccessTokenAsync();
        using var status = await SendAsync(HttpMethod.Get, $"/api/v1/files/uploads/{uploadRow}", token);
        status.EnsureSuccessStatusCode();
        using var body = JsonDocument.Parse(await status.Content.ReadAsStringAsync(Cancellation));
        Assert.NotEqual(JsonValueKind.Null, body.RootElement.GetProperty("publishedVersionId").ValueKind);
    }

    [Fact]
    public async Task A_nix_archive_cannot_be_saved_as_a_file()
    {
        var note = await CreateNoteAsync("Archive", headSeq: 1);
        var refused = await RefusedAsync(await AccessTokenAsync(), new { itemId = note, format = "nix", scope = "item", idempotencyKey = "export-file-nix", toFile = true });
        Assert.Equal((HttpStatusCode.BadRequest, "exports.format_not_file"), refused);
    }

    [Fact]
    public async Task A_locked_note_is_refused()
    {
        var note = await CreateNoteAsync("Locked", headSeq: 1);
        await SqlAsync($"INSERT INTO item_lock (item_id, tenant_id, password_hash, locked_by, locked_at) VALUES ('{note}', '{TestTenants.Alpha}', 'pbkdf2-sha256$1$AAAAAAAAAAAAAAAAAAAAAA==$AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA=', '{TestTenants.AlphaPrincipal}', now())");
        var refused = await RefusedAsync(await AccessTokenAsync(), new { itemId = note, format = "pdf", scope = "item", idempotencyKey = "export-file-locked", toFile = true });
        Assert.Equal((HttpStatusCode.Conflict, "exports.item_locked"), refused);
        Assert.Empty(_namer.Calls);
    }

    [Fact]
    public async Task A_note_that_refuses_children_is_refused_unless_a_target_file_is_named()
    {
        var note = await CreateNoteAsync("Closed", headSeq: 1);
        await using (var work = await _fixture.Application.BeginUnitOfWorkAsync(TestTenants.AlphaContext, Cancellation))
        {
            var protection = await work.Resolve<NixDispatcher>().SendAsync<SetItemProtection, Item>(new SetItemProtection(ItemId.From(note), null, true), Cancellation);
            Assert.True(protection.IsSuccess);
            await work.CommitAsync(Cancellation);
        }
        var token = await AccessTokenAsync();

        var refused = await RefusedAsync(token, new { itemId = note, format = "pdf", scope = "item", idempotencyKey = "export-file-closed", toFile = true });
        Assert.Equal((HttpStatusCode.Conflict, "exports.no_children"), refused);

        var target = await CreateFileAsync("closed.pdf");
        using var withTarget = await SendAsync(HttpMethod.Post, "/api/v1/exports", token, new { itemId = note, format = "pdf", scope = "item", idempotencyKey = "export-file-closed-target", toFile = true, targetItemId = target });
        Assert.Equal(HttpStatusCode.Accepted, withTarget.StatusCode);
    }

    [Fact]
    public async Task A_target_that_is_not_a_file_in_the_workspace_is_refused()
    {
        var note = await CreateNoteAsync("Source", headSeq: 1);
        var other = await CreateNoteAsync("Not a file", headSeq: 1);
        var token = await AccessTokenAsync();

        var wrongType = await RefusedAsync(token, new { itemId = note, format = "pdf", scope = "item", idempotencyKey = "export-file-wrong-type", toFile = true, targetItemId = other });
        Assert.Equal((HttpStatusCode.BadRequest, "exports.target_invalid"), wrongType);

        var foreign = await RefusedAsync(token, new { itemId = note, format = "pdf", scope = "item", idempotencyKey = "export-file-foreign", toFile = true, targetItemId = M0SchemaSeed.Beta.ItemId });
        Assert.Equal((HttpStatusCode.BadRequest, "exports.target_invalid"), foreign);
    }

    [Fact]
    public async Task A_plain_export_is_unchanged_by_the_file_fields()
    {
        var note = await CreateNoteAsync("Plain", headSeq: 3);
        var token = await AccessTokenAsync();
        var exportId = await BeginAsync(token, note, "export-file-plain", toFile: false);

        Assert.Empty(_namer.Calls);
        using var status = await SendAsync(HttpMethod.Get, $"/api/v1/exports/{exportId:D}", token);
        using var body = JsonDocument.Parse(await status.Content.ReadAsStringAsync(Cancellation));
        Assert.Equal(JsonValueKind.Null, body.RootElement.GetProperty("uploadId").ValueKind);
        const string execution = "export-file-worker:019946d1-fbc1-7d99-9ce7-1c721b406ff2";
        await ClaimAsync(exportId, execution);
        using var source = await InternalAsync(HttpMethod.Get, $"/internal/worker-executions/exports/{exportId:D}", exportId, execution);
        using var sourceBody = JsonDocument.Parse(await source.Content.ReadAsStringAsync(Cancellation));
        Assert.DoesNotContain("atSeq", sourceBody.RootElement.GetProperty("sourceUrl").GetString(), StringComparison.Ordinal);
        using var destination = await InternalAsync(HttpMethod.Get, $"/internal/worker-executions/exports/{exportId:D}/destination?byteLength=12&sha256={Sha}", exportId, execution);
        using var destinationBody = JsonDocument.Parse(await destination.Content.ReadAsStringAsync(Cancellation));
        Assert.StartsWith("exports/results/", destinationBody.RootElement.GetProperty("objectKey").GetString(), StringComparison.Ordinal);
        using var publish = await InternalAsync(HttpMethod.Post, $"/internal/worker-executions/exports/{exportId:D}/publish?byteLength=12&sha256={Sha}", exportId, execution);
        Assert.Equal(HttpStatusCode.Conflict, publish.StatusCode);
    }

    private async Task<Guid> BeginAsync(string token, Guid note, string key, Guid? target = null, bool toFile = true)
    {
        using var begin = await SendAsync(HttpMethod.Post, "/api/v1/exports", token, new { itemId = note, format = "pdf", scope = "item", idempotencyKey = key, toFile, targetItemId = target });
        Assert.Equal(HttpStatusCode.Accepted, begin.StatusCode);
        using var body = JsonDocument.Parse(await begin.Content.ReadAsStringAsync(Cancellation));
        return body.RootElement.GetProperty("id").GetGuid();
    }

    private async Task<(HttpStatusCode Status, string? Code)> RefusedAsync(string token, object body)
    {
        using var response = await SendAsync(HttpMethod.Post, "/api/v1/exports", token, body);
        using var document = JsonDocument.Parse(await response.Content.ReadAsStringAsync(Cancellation));
        return (response.StatusCode, document.RootElement.TryGetProperty("code", out var code) ? code.GetString() : null);
    }

    private async Task ClaimAsync(Guid exportId, string execution)
    {
        await using var scope = _fixture.Application.CreateUnscopedScope();
        var dispatch = scope.ServiceProvider.GetRequiredService<WorkerDispatchStore>();
        Assert.NotNull(await dispatch.ClaimJobAsync(exportId, execution, 60, Cancellation));
    }

    /// <summary>Plays the worker's two Core calls and returns the upload the export opened.</summary>
    private async Task<Guid> UploadAndPublishAsync(Guid exportId, string execution)
    {
        using var destination = await InternalAsync(HttpMethod.Get, $"/internal/worker-executions/exports/{exportId:D}/destination?byteLength=12&sha256={Sha}", exportId, execution);
        destination.EnsureSuccessStatusCode();
        using var body = JsonDocument.Parse(await destination.Content.ReadAsStringAsync(Cancellation));
        _attempt = (body.RootElement.GetProperty("attemptId").GetGuid(), body.RootElement.GetProperty("objectKey").GetString()!);
        var uploadId = Guid.Parse((await TextAsync($"SELECT upload_id::text FROM file_upload WHERE idempotency_key = 'export-file:{exportId:D}:{Sha}'"))!);
        // The bytes go to the upload's own object; the reported key keeps the export-result shape the database validates.
        Assert.Contains(uploadId.ToString("D"), body.RootElement.GetProperty("uploadUrl").GetString(), StringComparison.Ordinal);
        Assert.StartsWith("exports/results/", _attempt.ObjectKey, StringComparison.Ordinal);
        using var publish = await InternalAsync(HttpMethod.Post, $"/internal/worker-executions/exports/{exportId:D}/publish?byteLength=12&sha256={Sha}", exportId, execution);
        Assert.Equal(HttpStatusCode.NoContent, publish.StatusCode);
        return uploadId;
    }

    private async Task FinishAsync(Guid exportId, string execution)
    {
        await using var scope = _fixture.Application.CreateUnscopedScope();
        var dispatch = scope.ServiceProvider.GetRequiredService<WorkerDispatchStore>();
        var result = JsonSerializer.Serialize(new
        {
            attemptId = _attempt.AttemptId,
            format = "pdf",
            objectKey = _attempt.ObjectKey,
            itemCount = 1,
            omittedCount = 0,
            byteLength = 12,
            sha256 = Sha,
            loss = Array.Empty<string>(),
            omissions = Array.Empty<string>(),
        });
        Assert.True(await dispatch.FinishJobAsync(exportId, execution, succeeded: true, retryable: false, result, errorCode: null, errorDetail: null, Cancellation));
    }

    /// <summary>What the file.publish job ends in: the store completes the upload.</summary>
    private async Task<FileRecord> CompleteUploadAsync(Guid uploadId)
    {
        await using var work = await _fixture.Application.BeginUnitOfWorkAsync(TestTenants.AlphaContext, Cancellation);
        var file = Assert.IsType<FileRecord>(await work.Resolve<IFileStore>().CompleteAsync(
            new CompleteFileUpload(FileUploadId.From(uploadId), "application/pdf", 12, Sha, Previewable: false, PixelWidth: null, PixelHeight: null),
            Cancellation));
        await work.CommitAsync(Cancellation);
        return file;
    }

    private async Task<Guid> CreateFileAsync(string name)
    {
        await using var work = await _fixture.Application.BeginUnitOfWorkAsync(TestTenants.AlphaContext, Cancellation);
        var files = work.Resolve<IFileStore>();
        var upload = Assert.IsType<FileUploadRecord>(await files.BeginAsync(
            new BeginFileUpload(WorkspaceId.From(M0SchemaSeed.Alpha.WorkspaceId), null, null, name, "application/pdf", 12, "export-file-seed-" + name), Cancellation));
        Assert.NotNull(await files.QueueInspectionAsync(FileUploadId.From(upload.Id), Cancellation));
        var file = Assert.IsType<FileRecord>(await files.CompleteAsync(
            new CompleteFileUpload(FileUploadId.From(upload.Id), "application/pdf", 12, Sha, Previewable: false, PixelWidth: null, PixelHeight: null), Cancellation));
        await work.CommitAsync(Cancellation);
        return file.ItemId;
    }

    private async Task<Guid> CreateNoteAsync(string title, long headSeq)
    {
        Guid id;
        await using (var work = await _fixture.Application.BeginUnitOfWorkAsync(TestTenants.AlphaContext, Cancellation))
        {
            var result = await work.Resolve<NixDispatcher>().SendAsync<CreateItem, Item>(
                new CreateItem(WorkspaceId.From(TestTenants.AlphaWorkspace), "note", title, ItemId.From(M0SchemaSeed.Alpha.ItemId), Properties: null),
                Cancellation);
            Assert.True(result.IsSuccess, result.IsFailure ? result.Error.Message : string.Empty);
            await work.CommitAsync(Cancellation);
            id = result.Value.Id.Value;
        }
        await SqlAsync($"INSERT INTO content_doc (doc_id, tenant_id, item_id, workspace_id, schema_version, head_seq, created_at) VALUES (gen_random_uuid(), '{TestTenants.Alpha}', '{id}', '{TestTenants.AlphaWorkspace}', 1, {headSeq}, now())");
        return id;
    }

    private async Task<Guid> ParentOfAsync(Guid itemId) => Guid.Parse((await TextAsync($"SELECT parent_id::text FROM item WHERE id = '{itemId}'"))!);

    private async Task SqlAsync(string sql)
    {
        var connection = await _fixture.OpenMigratorConnectionAsync();
        await using (connection.ConfigureAwait(false))
        {
            await RawSql.ExecuteAsync(connection, transaction: null, sql);
        }
    }

    private async Task<string?> TextAsync(string sql)
    {
        var connection = await _fixture.OpenMigratorConnectionAsync();
        await using (connection.ConfigureAwait(false))
        {
            return await RawSql.TextAsync(connection, transaction: null, sql);
        }
    }

    private async Task<long> CountAsync(string sql)
    {
        var connection = await _fixture.OpenMigratorConnectionAsync();
        await using (connection.ConfigureAwait(false))
        {
            return await RawSql.CountAsync(connection, transaction: null, sql);
        }
    }

    private async Task<string> AccessTokenAsync()
    {
        await using var work = await _fixture.Application.BeginUnitOfWorkAsync(TestTenants.AlphaContext, Cancellation);
        var result = await work.Resolve<NixDispatcher>().SendAsync<CreateAccessToken, IssuedAccessToken>(
            new CreateAccessToken("export-file", [AccessTokenScopes.Read, AccessTokenScopes.Write], 1),
            Cancellation);
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

    private async Task<HttpResponseMessage> InternalAsync(HttpMethod method, string path, Guid jobId, string execution)
    {
        using var request = new HttpRequestMessage(method, path);
        request.Headers.TryAddWithoutValidation(InternalBoundaryMiddleware.SecretHeaderName, InternalSecret);
        request.Headers.TryAddWithoutValidation(WorkerExecutionMiddleware.JobHeaderName, jobId.ToString("D"));
        request.Headers.TryAddWithoutValidation(WorkerExecutionMiddleware.ExecutionHeaderName, execution);
        return await _client.SendAsync(request, Cancellation);
    }

    private sealed record NamerCall(Guid ItemId, long Seq, string Name, string Bearer);

    private sealed class RecordingNamer : IExportRevisionNamer
    {
        public List<NamerCall> Calls { get; } = [];

        public ValueTask<bool> EnsureNamedAsync(Guid itemId, long seq, string name, string bearer, CancellationToken cancellationToken)
        {
            Calls.Add(new NamerCall(itemId, seq, name, bearer));
            return ValueTask.FromResult(true);
        }
    }

    private sealed class ConfiguredApplicationFactory(
        WorkerCapabilityRegistry capabilities,
        IExportRevisionNamer namer,
        Dictionary<string, string?> settings) : WebApplicationFactory<Program>
    {
        protected override void ConfigureWebHost(Microsoft.AspNetCore.Hosting.IWebHostBuilder builder)
        {
            foreach (var (key, value) in settings)
            {
                builder.UseSetting(key, value);
            }
            builder.ConfigureServices(services =>
            {
                services.AddSingleton<IWorkerCapabilityRegistry>(capabilities);
                services.RemoveAll<IExportRevisionNamer>();
                services.AddSingleton(namer);
            });
        }
    }
}
