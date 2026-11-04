#pragma warning disable CA2000 // Justification: handlers and scripted clients live for one test; the scripted core is disposed by its using.
#pragma warning disable CA1861 // Justification: inline arrays are scripted responses built once per test.
using System.Net;
using System.Security.Cryptography;
using System.Text;
using System.Text.Json;
using Microsoft.Extensions.Options;
using Nix.Workers;

namespace Nix.Tests.Workers;

/// <summary>The object cleanup, template file copy and file publish jobs against a scripted Core and object store (ports of the Go handler tests).</summary>
public sealed class ImportFamilyHandlerTests
{
    private static readonly DateTimeOffset Now = new(2026, 9, 1, 12, 0, 0, TimeSpan.Zero);

    [Fact]
    public async Task Cleanup_deletes_only_the_capabilities_issued_for_the_exact_job()
    {
        var owner = Guid.NewGuid();
        var deleted = 0;
        using var core = new ScriptedCore((request, _) => Task.FromResult<HttpResponseMessage?>(request.RequestUri!.AbsolutePath switch
        {
            "/internal/worker-executions/object-cleanup" => ScriptedCore.Json(new { ownerKind = "file-upload", ownerId = owner, notBefore = Now, deleteUrls = new[] { "http://objects/one", "http://objects/two" }, nextOffset = (int?)null }),
            "/one" or "/two" when request.Method == HttpMethod.Delete => Count(ref deleted),
            _ => null,
        }));
        var clock = new FixedClock(Now.AddSeconds(1));
        var handler = new ObjectCleanupHandler(core.Core(), core.Objects(), clock);
        var payload = JsonSerializer.Serialize(new { ownerKind = "file-upload", ownerId = owner, notBefore = Now, objectKeys = new[] { "key-one", "key-two" } });

        var result = await handler.HandleAsync(ScriptedCore.Execution("object.cleanup", payload), TestContext.Current.CancellationToken);

        Assert.Equal(2, deleted);
        Assert.Equal(2, JsonDocument.Parse(result!).RootElement.GetProperty("deleted").GetInt32());
    }

    [Fact]
    public async Task Cleanup_waits_for_the_safety_delay()
    {
        using var core = new ScriptedCore((_, _) => Task.FromResult<HttpResponseMessage?>(null));
        var handler = new ObjectCleanupHandler(core.Core(), core.Objects(), new FixedClock(Now));
        var payload = JsonSerializer.Serialize(new { ownerKind = "document-import", ownerId = Guid.NewGuid(), notBefore = Now.AddMinutes(1), objectKeys = new[] { "key" } });

        var failure = await Assert.ThrowsAsync<WorkerJobException>(() => handler.HandleAsync(ScriptedCore.Execution("object.cleanup", payload), TestContext.Current.CancellationToken));

        Assert.Equal("cleanup_not_ready", failure.Code);
        Assert.True(failure.Retryable);
        Assert.Empty(core.Requests);
    }

    [Fact]
    public async Task Template_file_copy_verifies_and_acknowledges_each_transfer_only_after_verified_bytes()
    {
        var owner = Guid.NewGuid();
        var transfer = Guid.Parse("99999999-9999-4999-8999-999999999999");
        var bytes = Encoding.UTF8.GetBytes("%PDF-1.5\nfirst version");
        var digest = Convert.ToHexStringLower(SHA256.HashData(bytes));
        byte[]? uploaded = null;
        var acknowledged = new List<Guid>();
        using var core = new ScriptedCore(async (request, body) =>
        {
            var path = request.RequestUri!.AbsolutePath;
            if (path == $"/internal/worker-executions/template-file-transfers/{ScriptedCore.JobId:D}/plan")
            {
                return ScriptedCore.Json(new
                {
                    jobId = ScriptedCore.JobId,
                    ownerKind = "operation",
                    ownerId = owner,
                    transfers = new[] { new { transferId = transfer, sourceItemId = Guid.NewGuid(), targetItemId = Guid.NewGuid(), targetVersion = 1, downloadUrl = "http://objects/source", uploadUrl = "http://objects/target", verifyUrl = "http://objects/target", fileName = "brief.pdf", mediaType = "application/pdf", byteLength = bytes.Length, sha256 = digest, ready = false } },
                    observedAt = Now,
                    nextAfterTransferId = (Guid?)null,
                    complete = true,
                });
            }
            if (path == $"/internal/worker-executions/template-file-transfers/{ScriptedCore.JobId:D}/complete")
            {
                Assert.NotNull(uploaded);
                acknowledged.AddRange(JsonDocument.Parse(body).RootElement.GetProperty("transferIds").EnumerateArray().Select(id => id.GetGuid()));
                return ScriptedCore.Json(new { jobId = ScriptedCore.JobId, completed = true });
            }
            if (path == "/source")
            {
                return ScriptedCore.Bytes(bytes);
            }
            if (path == "/target" && request.Method == HttpMethod.Put)
            {
                Assert.Equal("*", request.Headers.GetValues("If-None-Match").Single());
                Assert.NotEmpty(request.Headers.GetValues("X-Amz-Checksum-Sha256"));
                uploaded = body;
                return ScriptedCore.Status(HttpStatusCode.NoContent);
            }
            if (path == "/target")
            {
                return uploaded is null ? ScriptedCore.Status(HttpStatusCode.NotFound) : ScriptedCore.Bytes(uploaded);
            }
            await Task.CompletedTask;
            return null;
        });
        var handler = new TemplateFileCopyHandler(core.Core(), core.Objects());

        var result = await handler.HandleAsync(ScriptedCore.Execution("template.files.copy", JsonSerializer.Serialize(new { ownerKind = "operation", ownerId = owner })), TestContext.Current.CancellationToken);

        Assert.Equal(bytes, uploaded);
        Assert.Equal([transfer], acknowledged);
        Assert.Equal(1, JsonDocument.Parse(result!).RootElement.GetProperty("transfersVerified").GetInt32());
    }

    [Fact]
    public async Task Template_file_copy_fails_permanently_when_the_destination_holds_different_bytes()
    {
        var owner = Guid.NewGuid();
        var bytes = Encoding.UTF8.GetBytes("declared");
        using var core = new ScriptedCore((request, _) => Task.FromResult<HttpResponseMessage?>(request.RequestUri!.AbsolutePath switch
        {
            var path when path.EndsWith("/plan", StringComparison.Ordinal) => ScriptedCore.Json(new
            {
                jobId = ScriptedCore.JobId,
                ownerKind = "operation",
                ownerId = owner,
                transfers = new[] { new { transferId = Guid.Parse("99999999-9999-4999-8999-999999999999"), sourceItemId = Guid.NewGuid(), targetItemId = Guid.NewGuid(), targetVersion = 1, downloadUrl = "http://objects/source", uploadUrl = "http://objects/target", verifyUrl = "http://objects/target", fileName = "a.bin", mediaType = "application/octet-stream", byteLength = bytes.Length, sha256 = Convert.ToHexStringLower(SHA256.HashData(bytes)), ready = false } },
                observedAt = Now,
                nextAfterTransferId = (Guid?)null,
                complete = true,
            }),
            "/target" when request.Method == HttpMethod.Get => ScriptedCore.Bytes(Encoding.UTF8.GetBytes("other!!!")),
            _ => null,
        }));
        var handler = new TemplateFileCopyHandler(core.Core(), core.Objects());

        var failure = await Assert.ThrowsAsync<WorkerJobException>(() => handler.HandleAsync(ScriptedCore.Execution("template.files.copy", JsonSerializer.Serialize(new { ownerKind = "operation", ownerId = owner })), TestContext.Current.CancellationToken));

        Assert.Equal("template_file_copy_failed", failure.Code);
        Assert.False(failure.Retryable);
        Assert.DoesNotContain(core.Requests, request => request.Path.EndsWith("/complete", StringComparison.Ordinal));
    }

    [Fact]
    public async Task File_publish_streams_opaque_bytes_create_only_and_publishes_through_core()
    {
        var upload = Guid.NewGuid();
        var body = new byte[] { (byte)'M', (byte)'Z', 0, 0, 1, 2, 3 }; // byte[]: an opaque executable header
        byte[]? immutable = null;
        JsonElement published = default;
        using var core = new ScriptedCore((request, content) =>
        {
            var path = request.RequestUri!.AbsolutePath;
            if (path == $"/internal/worker-executions/files/uploads/{upload:D}")
            {
                return Task.FromResult<HttpResponseMessage?>(ScriptedCore.Json(Inspection(upload, "photo.png", "image/png", body.Length)));
            }
            if (path == "/source")
            {
                return Task.FromResult<HttpResponseMessage?>(ScriptedCore.Bytes(body));
            }
            if (path == "/destination" && request.Method == HttpMethod.Put)
            {
                Assert.Equal("*", request.Headers.GetValues("If-None-Match").Single());
                Assert.False(request.Headers.Contains("X-Amz-Checksum-Sha256"));
                immutable = content;
                return Task.FromResult<HttpResponseMessage?>(ScriptedCore.Status(HttpStatusCode.NoContent));
            }
            if (path == $"/internal/worker-executions/files/uploads/{upload:D}/publish")
            {
                published = JsonDocument.Parse(content).RootElement.Clone();
                return Task.FromResult<HttpResponseMessage?>(ScriptedCore.Json(new { itemId = Guid.NewGuid(), workspaceId = Guid.NewGuid(), current = Version(), versions = new[] { Version() } }));
            }
            return Task.FromResult<HttpResponseMessage?>(null);
        });
        var handler = new FilePublishHandler(core.Core(), core.Objects(), Options.Create(new WorkerOptions { MaxInputBytes = 1024 }), new FixedClock(Now));

        var result = await handler.HandleAsync(ScriptedCore.Execution("file.publish", JsonSerializer.Serialize(new { uploadId = upload })), TestContext.Current.CancellationToken);

        Assert.Equal(body, immutable);
        Assert.Equal("application/octet-stream", published.GetProperty("detectedMediaType").GetString());
        Assert.False(published.GetProperty("previewable").GetBoolean());
        Assert.Equal(body.Length, published.GetProperty("byteLength").GetInt64());
        using var document = JsonDocument.Parse(result!);
        Assert.False(document.RootElement.GetProperty("declaredMediaTypeConsistent").GetBoolean());
        Assert.Equal("application/octet-stream", document.RootElement.GetProperty("detectedMediaType").GetString());
    }

    [Fact]
    public async Task File_publish_rejects_a_size_mismatch_without_deleting_anything()
    {
        var upload = Guid.NewGuid();
        var rejected = false;
        using var core = new ScriptedCore((request, _) =>
        {
            var path = request.RequestUri!.AbsolutePath;
            Assert.NotEqual(HttpMethod.Delete, request.Method);
            if (path == $"/internal/worker-executions/files/uploads/{upload:D}")
            {
                return Task.FromResult<HttpResponseMessage?>(ScriptedCore.Json(Inspection(upload, "file.bin", "application/octet-stream", 20)));
            }
            if (path == "/source")
            {
                return Task.FromResult<HttpResponseMessage?>(ScriptedCore.Bytes(Encoding.UTF8.GetBytes("short")));
            }
            if (path == $"/internal/worker-executions/files/uploads/{upload:D}/reject")
            {
                rejected = true;
                return Task.FromResult<HttpResponseMessage?>(ScriptedCore.Status(HttpStatusCode.NoContent));
            }
            return Task.FromResult<HttpResponseMessage?>(null);
        });
        var handler = new FilePublishHandler(core.Core(), core.Objects(), Options.Create(new WorkerOptions { MaxInputBytes = 1024 }), new FixedClock(Now));

        var failure = await Assert.ThrowsAsync<WorkerJobException>(() => handler.HandleAsync(ScriptedCore.Execution("file.publish", JsonSerializer.Serialize(new { uploadId = upload })), TestContext.Current.CancellationToken));

        Assert.Equal("files.size_mismatch", failure.Code);
        Assert.False(failure.Retryable);
        Assert.True(rejected);
    }

    private static object Inspection(Guid upload, string fileName, string mediaType, long length) => new
    {
        uploadId = upload,
        workspaceId = Guid.NewGuid(),
        status = "inspection_queued",
        fileName,
        declaredMediaType = mediaType,
        declaredByteLength = length,
        expiresAt = Now.AddMinutes(1),
        sourceUrl = "http://objects/source",
        sourceDeleteUrl = "http://objects/source",
        destinationUrl = "http://objects/destination",
        destinationUploadUrl = "http://objects/destination",
        destinationDeleteUrl = "http://objects/destination",
        capabilityExpiresAt = Now.AddMinutes(1),
        itemId = (Guid?)null,
    };

    private static object Version() => new { id = Guid.NewGuid(), current = true, version = 1, fileName = "f", mediaType = "application/octet-stream", byteLength = 7, sha256 = new string('0', 64), previewable = false, createdAt = Now };

    private sealed class FixedClock(DateTimeOffset now) : TimeProvider
    {
        public override DateTimeOffset GetUtcNow() => now;
    }

    private static HttpResponseMessage Count(ref int counter)
    {
        counter++;
        return ScriptedCore.Status(HttpStatusCode.NoContent);
    }
}
