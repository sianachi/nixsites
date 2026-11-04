#pragma warning disable CA2025 // Justification: a scripted response is handed to the client, which disposes it after reading.
#pragma warning disable CA2000 // Justification: handlers and scripted clients live for one test; the scripted core is disposed by its using.
#pragma warning disable CA1861 // Justification: inline arrays are scripted responses built once per test.
using System.Net;
using System.Security.Cryptography;
using System.Text;
using System.Text.Json;
using Microsoft.Extensions.Options;
using Nix.Workers;
using Nix.Workers.Import;

namespace Nix.Tests.Workers;

/// <summary>The document and template import jobs against a scripted Core, Collab and object store (ports of the Go handler tests).</summary>
public sealed class ImportHandlerTests
{
    private static readonly Guid ImportId = Guid.Parse("11111111-1111-4111-8111-111111111111");
    private static readonly Guid WorkspaceId = Guid.Parse("22222222-2222-4222-8222-222222222222");
    private static readonly Guid RootTarget = Guid.Parse("77777777-7777-4777-8777-777777777777");
    private static readonly Guid ChildTarget = Guid.Parse("88888888-8888-4888-8888-888888888888");
    private static readonly Guid OperationId = Guid.Parse("55555555-5555-4555-8555-555555555555");
    private static readonly Guid TemplateId = Guid.Parse("66666666-6666-4666-8666-666666666666");
    private static readonly DateTimeOffset Later = DateTimeOffset.UtcNow.AddMinutes(1);
    private static readonly string Payload = JsonSerializer.Serialize(new { importId = ImportId });

    [Fact]
    public async Task Document_preview_downloads_parses_and_publishes_only_the_plan()
    {
        var source = Encoding.UTF8.GetBytes("one\r\ntwo");
        byte[]? plan = null;
        JsonElement completed = default;
        using var core = new ScriptedCore((request, body) =>
        {
            var path = request.RequestUri!.AbsolutePath;
            HttpResponseMessage? response = path switch
            {
                var p when p == $"/internal/worker-executions/imports/{ImportId:D}/preview" => ScriptedCore.Json(new { importId = ImportId, format = "txt", title = "Imported", fileName = "notes.txt", declaredMediaType = "text/plain", declaredByteLength = source.Length, sourceUrl = "http://objects/source", sourceDeleteUrl = "http://objects/source", planUploadUrl = "http://objects/plan", planDeleteUrl = "http://objects/plan", capabilityExpiresAt = Later }),
                "/source" => ScriptedCore.Bytes(source),
                "/plan" => Capture(out plan, body),
                var p when p == $"/internal/worker-executions/imports/{ImportId:D}/preview/complete" => CaptureJson(out completed, body),
                _ => null,
            };
            return Task.FromResult(response);
        });
        var handler = new DocumentImportHandler(core.Core(), core.Objects(), core.Collab(), Options.Create(new WorkerOptions()));

        var result = await handler.HandleAsync(ScriptedCore.Execution("import.preview.txt", Payload), TestContext.Current.CancellationToken);

        using var document = JsonDocument.Parse(result!);
        Assert.Equal(2, document.RootElement.GetProperty("items").GetInt32());
        Assert.NotNull(plan);
        Assert.Equal(plan.Length, completed.GetProperty("planByteLength").GetInt64());
        Assert.Equal(2, completed.GetProperty("itemCount").GetInt32());
        var decoded = ImportPlanner.Decode(plan, completed.GetProperty("planSha256").GetString()!, ImportFixtures.Limits);
        Assert.Equal("one\ntwo", decoded.Items[0].Body!.Text);
        Assert.Equal("source", decoded.Items[1].File!.SourceKind);
    }

    [Fact]
    public async Task Document_commit_revalidates_stages_writes_bodies_and_finalizes()
    {
        var source = Encoding.UTF8.GetBytes("durable text");
        var sourceDigest = Convert.ToHexStringLower(SHA256.HashData(source));
        var plan = await ImportPlanner.ParseAsync(ImportFixtures.Source("notes.txt", "txt", source) with { Title = "Imported", FileName = "notes.txt", MediaType = "text/plain" }, ImportFixtures.Limits, TestContext.Current.CancellationToken);
        var (planBody, planDigest) = ImportPlanner.Encode(plan, 16 << 20);
        var fileSourceId = plan.Items.Single(item => item.File is not null).SourceId;
        JsonElement staged = default;
        JsonElement bodies = default;
        byte[]? published = null;
        var objectCompleted = false;
        var finalized = false;
        using var core = new ScriptedCore((request, body) =>
        {
            var path = request.RequestUri!.AbsolutePath;
            var prefix = $"/internal/worker-executions/imports/{ImportId:D}";
            HttpResponseMessage? response = null;
            if (path == prefix + "/commit")
            {
                response = ScriptedCore.Json(new { importId = ImportId, format = "txt", title = "Imported", fileName = "notes.txt", declaredMediaType = "text/plain", declaredByteLength = source.Length, planSha256 = planDigest, planByteLength = planBody.Length, sourceSha256 = sourceDigest, sourceUrl = "http://objects/source", sourceDeleteUrl = "http://objects/source", planUrl = "http://objects/plan", planDeleteUrl = "http://objects/plan", capabilityExpiresAt = Later });
            }
            else if (path == "/source")
            {
                response = ScriptedCore.Bytes(source);
            }
            else if (path == "/plan")
            {
                response = ScriptedCore.Bytes(planBody);
            }
            else if (path == "/source-version" && request.Method == HttpMethod.Put)
            {
                Assert.Equal("*", request.Headers.GetValues("If-None-Match").Single());
                Assert.Equal(Convert.ToBase64String(SHA256.HashData(source)), request.Headers.GetValues("X-Amz-Checksum-Sha256").Single());
                published = body;
                response = ScriptedCore.Status(HttpStatusCode.NoContent);
            }
            else if (path == prefix + "/stage")
            {
                staged = JsonDocument.Parse(body).RootElement.Clone();
                response = ScriptedCore.Json(new { importId = ImportId, rootItemId = RootTarget, items = new[] { new { sourceId = plan.Items[0].SourceId, targetItemId = RootTarget, itemType = "note", bodyRequired = true, objectReady = true }, new { sourceId = fileSourceId, targetItemId = ChildTarget, itemType = "file", bodyRequired = false, objectReady = false } }, fileTransfers = Array.Empty<object>() });
            }
            else if (path == prefix + "/objects/capability")
            {
                Assert.Contains("sourceId=" + fileSourceId, request.RequestUri.Query, StringComparison.Ordinal);
                response = ScriptedCore.Json(new { sourceId = fileSourceId, url = "http://objects/source-version", uploadUrl = "http://objects/source-version", deleteUrl = "http://objects/source-version", capabilityExpiresAt = Later });
            }
            else if (path == prefix + "/objects/complete")
            {
                objectCompleted = true;
                response = ScriptedCore.Status(HttpStatusCode.NoContent);
            }
            else if (path == $"/internal/imports/{ImportId:D}/bodies")
            {
                bodies = JsonDocument.Parse(body).RootElement.Clone();
                response = ScriptedCore.Json(new { written = 1 });
            }
            else if (path == prefix + "/finalize")
            {
                finalized = true;
                response = ScriptedCore.Json(new { id = ImportId, workspaceId = WorkspaceId, uploadId = Guid.NewGuid(), parentId = (Guid?)null, format = "txt", title = "Imported", status = "completed", previewOperationId = (Guid?)null, commitOperationId = (Guid?)null, itemCount = 2, assetCount = 0, loss = (object?)null, omissions = (object?)null, rootItemId = RootTarget, failureCode = (string?)null, expiresAt = Later, completedAt = Later });
            }
            return Task.FromResult(response);
        });
        var handler = new DocumentImportHandler(core.Core(), core.Objects(), core.Collab(), Options.Create(new WorkerOptions()));

        var result = await handler.HandleAsync(ScriptedCore.Execution("import.commit", Payload), TestContext.Current.CancellationToken);

        using var document = JsonDocument.Parse(result!);
        Assert.Equal(RootTarget, document.RootElement.GetProperty("rootItemId").GetGuid());
        Assert.True(finalized);
        Assert.True(objectCompleted);
        Assert.Equal(source, published);
        Assert.Equal(2, staged.GetProperty("items").GetArrayLength());
        Assert.True(staged.GetProperty("items")[0].GetProperty("bodyRequired").GetBoolean());
        var write = Assert.Single(bodies.GetProperty("writes").EnumerateArray());
        Assert.Equal("durable text", write.GetProperty("body").GetProperty("text").GetString());
    }

    [Fact]
    public async Task Template_preview_parses_and_uploads_a_deterministic_plan()
    {
        var archive = ImportFixtures.TemplateArchive(ImportFixtures.TemplateProfile(true, true), includeChild: true, includeRootBody: true);
        var source = await File.ReadAllBytesAsync(archive.Path, TestContext.Current.CancellationToken);
        byte[]? uploaded = null;
        JsonElement completed = default;
        var rejected = false;
        using var core = new ScriptedCore((request, body) =>
        {
            var path = request.RequestUri!.AbsolutePath;
            HttpResponseMessage? response = null;
            if (path == $"/internal/worker-executions/template-imports/{ImportId:D}/preview")
            {
                response = ScriptedCore.Json(PreviewMetadata(source.Length));
            }
            else if (path == "/source")
            {
                response = ScriptedCore.Bytes(source);
            }
            else if (path == "/plan" && request.Method == HttpMethod.Put)
            {
                Assert.NotEmpty(request.Headers.GetValues("X-Nix-Content-SHA256"));
                uploaded = body;
                response = ScriptedCore.Status(HttpStatusCode.NoContent);
            }
            else if (path == $"/internal/worker-executions/template-imports/{ImportId:D}/preview/complete")
            {
                response = CaptureJson(out completed, body);
            }
            else if (path.EndsWith("/reject", StringComparison.Ordinal))
            {
                rejected = true;
                response = ScriptedCore.Status(HttpStatusCode.NoContent);
            }
            return Task.FromResult(response);
        });
        var handler = new TemplateImportHandler(core.Core(), core.Objects(), core.Collab(), Options.Create(new WorkerOptions()));

        var result = await handler.HandleAsync(ScriptedCore.Execution("template.preview", Payload), TestContext.Current.CancellationToken);

        using var document = JsonDocument.Parse(result!);
        Assert.False(rejected);
        Assert.Equal("team.project", document.RootElement.GetProperty("stableKey").GetString());
        Assert.Equal(2, document.RootElement.GetProperty("itemCount").GetInt32());
        Assert.NotNull(uploaded);
        Assert.Equal("team.project", completed.GetProperty("profile").GetProperty("key").GetString());
        Assert.Equal(uploaded.Length, completed.GetProperty("planByteLength").GetInt64());
        var plan = TemplatePlanner.Decode(uploaded, completed.GetProperty("planSha256").GetString()!, ImportFixtures.Limits);
        Assert.Equal(ImportFixtures.Root, plan.Items[1].ParentSourceId);
    }

    [Fact]
    public async Task Template_commit_revalidates_stages_writes_bodies_and_completes()
    {
        var archive = ImportFixtures.TemplateArchive(ImportFixtures.TemplateProfile(true, true), includeChild: true, includeRootBody: true);
        var source = await File.ReadAllBytesAsync(archive.Path, TestContext.Current.CancellationToken);
        var (planBody, planDigest) = TemplatePlanner.Encode(await TemplatePlanner.ParseAsync(archive, ImportFixtures.Limits, TestContext.Current.CancellationToken), 16 << 20);
        JsonElement staged = default;
        JsonElement bodies = default;
        JsonElement completion = default;
        using var core = new ScriptedCore((request, body) =>
        {
            var path = request.RequestUri!.AbsolutePath;
            var prefix = $"/internal/worker-executions/template-imports/{ImportId:D}";
            HttpResponseMessage? response = null;
            if (path == prefix + "/commit")
            {
                response = ScriptedCore.Json(CommitMetadata(source.Length, archive.Sha256, planBody.Length, planDigest));
            }
            else if (path == "/source")
            {
                response = ScriptedCore.Bytes(source);
            }
            else if (path == "/plan")
            {
                response = ScriptedCore.Bytes(planBody);
            }
            else if (path == prefix + "/stage")
            {
                staged = JsonDocument.Parse(body).RootElement.Clone();
                response = ScriptedCore.Json(new { importId = ImportId, operationId = OperationId, templateId = TemplateId, stableKey = "team.project", digest = archive.Sha256, unchanged = false, itemMappings = Mappings("note", "canvas"), bodyWrites = Mappings("note", "canvas"), fileTransfers = Array.Empty<object>() });
            }
            else if (path == prefix + "/bodies")
            {
                bodies = JsonDocument.Parse(body).RootElement.Clone();
                response = ScriptedCore.Json(new { writtenTargetItemIds = new[] { ChildTarget, RootTarget } });
            }
            else if (path == prefix + "/complete")
            {
                completion = JsonDocument.Parse(body).RootElement.Clone();
                response = ScriptedCore.Json(new { importId = ImportId, operationId = OperationId, templateId = TemplateId, stableKey = "team.project", digest = archive.Sha256, unchanged = false, itemCount = 2, bodyCount = 2, writtenTargetItemIds = new[] { ChildTarget, RootTarget } });
            }
            return Task.FromResult(response);
        });
        var handler = new TemplateImportHandler(core.Core(), core.Objects(), core.Collab(), Options.Create(new WorkerOptions()));

        var result = await handler.HandleAsync(ScriptedCore.Execution("template.commit", Payload), TestContext.Current.CancellationToken);

        using var document = JsonDocument.Parse(result!);
        Assert.Equal(TemplateId, document.RootElement.GetProperty("templateId").GetGuid());
        Assert.Equal(OperationId, document.RootElement.GetProperty("operationId").GetGuid());
        Assert.Equal("team.project", staged.GetProperty("profile").GetProperty("key").GetString());
        Assert.True(staged.GetProperty("items")[0].GetProperty("hasBody").GetBoolean());
        Assert.Equal(2, bodies.GetProperty("writes").GetArrayLength());
        Assert.Contains("prosemirror", bodies.GetProperty("writes")[0].GetProperty("body").GetRawText(), StringComparison.Ordinal);
        Assert.Equal(2, completion.GetProperty("writtenTargetItemIds").GetArrayLength());
    }

    [Fact]
    public async Task Template_commit_replays_a_durable_result_without_touching_capabilities()
    {
        using var core = new ScriptedCore((request, _) =>
        {
            Assert.Equal($"/internal/worker-executions/template-imports/{ImportId:D}/commit", request.RequestUri!.AbsolutePath);
            return Task.FromResult<HttpResponseMessage?>(ScriptedCore.Json(new
            {
                importId = ImportId,
                workspaceId = WorkspaceId,
                origin = "user",
                managedSource = (string?)null,
                idempotencyKey = "template:test",
                fileName = "project.nix",
                declaredMediaType = "application/x-nix-template",
                declaredByteLength = 0,
                planSha256 = new string('a', 64),
                planByteLength = 1,
                sourceSha256 = new string('a', 64),
                sourceUrl = (string?)null,
                sourceDeleteUrl = (string?)null,
                planUrl = (string?)null,
                planUploadUrl = (string?)null,
                planDeleteUrl = (string?)null,
                capabilityExpiresAt = (DateTimeOffset?)null,
                completedResult = new { importId = ImportId, operationId = OperationId, templateId = TemplateId, stableKey = "team.project", digest = new string('a', 64), unchanged = false, itemCount = 2, bodyCount = 2, writtenTargetItemIds = new[] { RootTarget, ChildTarget } },
            }));
        });
        var handler = new TemplateImportHandler(core.Core(), core.Objects(), core.Collab(), Options.Create(new WorkerOptions()));

        var result = await handler.HandleAsync(ScriptedCore.Execution("template.commit", Payload), TestContext.Current.CancellationToken);

        Assert.Single(core.Requests);
        Assert.Equal(2, JsonDocument.Parse(result!).RootElement.GetProperty("bodyCount").GetInt32());
    }

    [Theory]
    [InlineData(HttpStatusCode.ServiceUnavailable, null, true, false)]
    [InlineData(HttpStatusCode.Conflict, "worker.execution_refused", true, false)]
    [InlineData(HttpStatusCode.Conflict, "templates.pending_revision", false, true)]
    public async Task Template_core_failures_retry_or_reject_by_status_and_code(HttpStatusCode status, string? code, bool retryable, bool rejects)
    {
        var rejected = false;
        using var core = new ScriptedCore((request, _) =>
        {
            if (request.RequestUri!.AbsolutePath.EndsWith("/reject", StringComparison.Ordinal))
            {
                rejected = true;
                return Task.FromResult<HttpResponseMessage?>(ScriptedCore.Status(HttpStatusCode.NoContent));
            }
            return Task.FromResult<HttpResponseMessage?>(code is null ? ScriptedCore.Status(status) : ScriptedCore.Problem(status, code));
        });
        var handler = new TemplateImportHandler(core.Core(), core.Objects(), core.Collab(), Options.Create(new WorkerOptions()));

        var failure = await Assert.ThrowsAsync<WorkerJobException>(() => handler.HandleAsync(ScriptedCore.Execution("template.preview", Payload), TestContext.Current.CancellationToken));

        Assert.Equal(retryable, failure.Retryable);
        Assert.Equal(rejects, rejected);
    }

    [Fact]
    public async Task Template_invalid_archive_is_rejected_as_terminal()
    {
        var source = Encoding.UTF8.GetBytes("not a zip archive");
        string? rejection = null;
        using var core = new ScriptedCore((request, body) =>
        {
            var path = request.RequestUri!.AbsolutePath;
            HttpResponseMessage? response = null;
            if (path == $"/internal/worker-executions/template-imports/{ImportId:D}/preview")
            {
                response = ScriptedCore.Json(PreviewMetadata(source.Length));
            }
            else if (path == "/source")
            {
                response = ScriptedCore.Bytes(source);
            }
            else if (path.EndsWith("/reject", StringComparison.Ordinal))
            {
                rejection = JsonDocument.Parse(body).RootElement.GetProperty("code").GetString();
                response = ScriptedCore.Status(HttpStatusCode.NoContent);
            }
            return Task.FromResult(response);
        });
        var handler = new TemplateImportHandler(core.Core(), core.Objects(), core.Collab(), Options.Create(new WorkerOptions()));

        var failure = await Assert.ThrowsAsync<WorkerJobException>(() => handler.HandleAsync(ScriptedCore.Execution("template.preview", Payload), TestContext.Current.CancellationToken));

        Assert.Equal("template_archive_invalid", failure.Code);
        Assert.False(failure.Retryable);
        Assert.Equal("template_archive_invalid", rejection);
    }

    [Theory]
    [InlineData("template.preview")]
    [InlineData("template.commit")]
    public async Task Cancelled_template_jobs_send_nothing(string kind)
    {
        using var core = new ScriptedCore((_, _) => Task.FromResult<HttpResponseMessage?>(ScriptedCore.Status(HttpStatusCode.InternalServerError)));
        var handler = new TemplateImportHandler(core.Core(), core.Objects(), core.Collab(), Options.Create(new WorkerOptions()));
        using var cancelled = new CancellationTokenSource();
        await cancelled.CancelAsync();

        await Assert.ThrowsAnyAsync<OperationCanceledException>(() => handler.HandleAsync(ScriptedCore.Execution(kind, Payload), cancelled.Token));

        Assert.Empty(core.Requests);
    }

    private static object PreviewMetadata(long sourceBytes) => new
    {
        importId = ImportId,
        workspaceId = WorkspaceId,
        origin = "user",
        managedSource = (string?)null,
        idempotencyKey = "template:test",
        fileName = "project.nix",
        declaredMediaType = "application/x-nix-template",
        declaredByteLength = sourceBytes,
        sourceUrl = "http://objects/source",
        sourceDeleteUrl = "http://objects/source/delete",
        planUploadUrl = "http://objects/plan",
        planDeleteUrl = "http://objects/plan/delete",
        capabilityExpiresAt = Later,
    };

    private static object CommitMetadata(long sourceBytes, string sourceSha, long planBytes, string planSha) => new
    {
        importId = ImportId,
        workspaceId = WorkspaceId,
        origin = "user",
        managedSource = (string?)null,
        idempotencyKey = "template:test",
        fileName = "project.nix",
        declaredMediaType = "application/x-nix-template",
        declaredByteLength = sourceBytes,
        planSha256 = planSha,
        planByteLength = planBytes,
        sourceSha256 = sourceSha,
        sourceUrl = "http://objects/source",
        sourceDeleteUrl = "http://objects/source/delete",
        planUrl = "http://objects/plan",
        planUploadUrl = "http://objects/plan/upload",
        planDeleteUrl = "http://objects/plan/delete",
        capabilityExpiresAt = Later,
        completedResult = (object?)null,
    };

    private static object[] Mappings(string rootType, string childType) =>
    [
        new { sourceId = ImportFixtures.Root, targetItemId = RootTarget, itemType = rootType },
        new { sourceId = ImportFixtures.Child, targetItemId = ChildTarget, itemType = childType },
    ];

    private static HttpResponseMessage Capture(out byte[] target, byte[] body)
    {
        target = body;
        return ScriptedCore.Status(HttpStatusCode.NoContent);
    }

    private static HttpResponseMessage CaptureJson(out JsonElement target, byte[] body)
    {
        target = JsonDocument.Parse(body).RootElement.Clone();
        return ScriptedCore.Status(HttpStatusCode.NoContent);
    }
}
