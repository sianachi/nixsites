using System.Net;
using System.Security.Cryptography;
using System.Text;
using System.Text.Json;
using Microsoft.AspNetCore.Hosting.Server;
using Microsoft.AspNetCore.Http.Features;
using Microsoft.Extensions.Configuration;
using Microsoft.Extensions.Options;
using Nix.Abstractions.Workers;
using Nix.Workers;
using Nix.Workers.Transfer;

namespace Nix.Tests.Workers;

/// <summary>
/// The export job against scripted Core, Collab and object-store endpoints: the bundle stream
/// becomes a create-only upload whose length and digest the result reports, and an upload that
/// already exists is verified rather than failed.
/// </summary>
public sealed class ExportJobHandlerTests
{
    private static readonly Guid JobId = Guid.Parse("40000000-0000-4000-8000-000000000001");
    private static readonly Guid AttemptId = Guid.Parse("40000000-0000-4000-8000-000000000002");
    private static readonly JsonSerializerOptions Web = new(JsonSerializerDefaults.Web);

    [Theory]
    [InlineData("markdown")]
    [InlineData("docx")]
    [InlineData("pdf")]
    public async Task A_document_export_uploads_the_rendered_bytes_create_only_and_reports_them(string format)
    {
        using var script = new Script(format, uploadStatus: HttpStatusCode.OK);
        var handler = Handler(script);

        var result = await handler.HandleAsync(Execution(format), TestContext.Current.CancellationToken);

        using var document = JsonDocument.Parse(result!);
        Assert.Equal(AttemptId, document.RootElement.GetProperty("attemptId").GetGuid());
        Assert.Equal(format, document.RootElement.GetProperty("format").GetString());
        Assert.Equal(1, document.RootElement.GetProperty("itemCount").GetInt32());
        Assert.Equal(script.Uploaded!.Length, document.RootElement.GetProperty("byteLength").GetInt64());
        Assert.Equal(Convert.ToHexStringLower(SHA256.HashData(script.Uploaded)), document.RootElement.GetProperty("sha256").GetString());
        Assert.Equal("*", script.UploadHeaders!["If-None-Match"]);
        Assert.Equal(Convert.ToBase64String(SHA256.HashData(script.Uploaded)), script.UploadHeaders["X-Amz-Checksum-Sha256"]);
        Assert.Contains("Workspace hierarchy and lifecycle metadata are not preserved", string.Join("\n", document.RootElement.GetProperty("loss").EnumerateArray().Select(loss => loss.GetString())), StringComparison.Ordinal);
        Assert.Equal(["no_access: A child you cannot read"], document.RootElement.GetProperty("omissions").EnumerateArray().Select(entry => entry.GetString()));
    }

    [Fact]
    public async Task An_existing_identical_result_is_accepted_without_a_second_upload()
    {
        using var script = new Script("markdown", uploadStatus: HttpStatusCode.PreconditionFailed);
        var handler = Handler(script);

        var result = await handler.HandleAsync(Execution("markdown"), TestContext.Current.CancellationToken);

        Assert.NotNull(result);
        Assert.True(script.ReadVerified);
    }

    [Fact]
    public async Task A_kind_that_does_not_match_the_payload_fails_permanently()
    {
        using var script = new Script("markdown", uploadStatus: HttpStatusCode.OK);
        var handler = Handler(script);
        var job = new DispatchedWorkerJob(JobId, Guid.NewGuid(), Guid.NewGuid(), Guid.NewGuid(), "export.pdf", Payload("markdown"), 1, false);

        var failure = await Assert.ThrowsAsync<WorkerJobException>(() => handler.HandleAsync(new WorkerExecution(job, "nix-api:test:export:1"), TestContext.Current.CancellationToken));

        Assert.Equal("export_kind_mismatch", failure.Code);
        Assert.False(failure.Retryable);
    }

    private static ExportJobHandler Handler(Script script)
    {
        var configuration = new ConfigurationBuilder().AddInMemoryCollection(new Dictionary<string, string?>
        {
            ["Nix:InternalSecret"] = "export-secret",
            ["Nix:Workers:LoopbackUrl"] = "http://core",
        }).Build();
        var options = Options.Create(new WorkerOptions());
#pragma warning disable CA2000 // Justification: the clients live as long as the test and share the scripted handler, which the test disposes.
        var core = new WorkerLoopbackClient(new SingleClientFactory(script), new NoServer(), configuration, options);
        return new ExportJobHandler(core, new ObjectTransfer(new HttpClient(script, disposeHandler: false), ["http://collab"]), new ObjectTransfer(new HttpClient(script, disposeHandler: false), ["http://objects"]), configuration, options);
#pragma warning restore CA2000
    }

    private static WorkerExecution Execution(string format) =>
        new(new DispatchedWorkerJob(JobId, Guid.NewGuid(), Guid.NewGuid(), Guid.NewGuid(), "export." + format, Payload(format), 1, false), "nix-api:test:export:1");

    private static string Payload(string format) => JsonSerializer.Serialize(new
    {
        itemId = "0a000000-0000-4000-8000-000000000001",
        workspaceId = "0c000000-0000-4000-8000-000000000001",
        format,
        scope = "subtree",
        title = "Plan",
        extension = format == "markdown" ? "md" : format,
        mediaType = Nix.Workers.Export.ExportWriters.ContentType(format),
        declaredLoss = Array.Empty<string>(),
        includeComments = false,
        pageSize = "a4",
    });

    private sealed class Script(string format, HttpStatusCode uploadStatus) : HttpMessageHandler
    {
        private readonly byte[] stream = File.ReadAllBytes(Path.Combine(FixtureRoot(), "shared-render", "stream.ndjson"));

        public byte[]? Uploaded { get; private set; }

        public Dictionary<string, string>? UploadHeaders { get; private set; }

        public bool ReadVerified { get; private set; }

        protected override async Task<HttpResponseMessage> SendAsync(HttpRequestMessage request, CancellationToken cancellationToken)
        {
            var uri = request.RequestUri!;
            var path = uri.AbsolutePath;
            if (uri.Host == "collab")
            {
                Assert.Equal("Bearer delegated-token", request.Headers.Authorization!.ToString());
                Assert.Equal("export-secret", request.Headers.GetValues("X-Nix-Internal-Secret").Single());
                return new HttpResponseMessage(HttpStatusCode.OK) { Content = new ByteArrayContent(stream) };
            }
            if (uri.Host == "objects")
            {
                if (request.Method == HttpMethod.Put)
                {
                    Uploaded = await request.Content!.ReadAsByteArrayAsync(cancellationToken);
                    UploadHeaders = request.Headers.Concat(request.Content.Headers).ToDictionary(pair => pair.Key, pair => string.Join(",", pair.Value), StringComparer.OrdinalIgnoreCase);
                    return new HttpResponseMessage(uploadStatus);
                }
                if (request.Method == HttpMethod.Get)
                {
                    ReadVerified = true;
                    return new HttpResponseMessage(HttpStatusCode.OK) { Content = new ByteArrayContent(Uploaded!) };
                }
                return new HttpResponseMessage(HttpStatusCode.NoContent);
            }
            Assert.Equal(JobId.ToString("D"), request.Headers.GetValues("x-nix-worker-job-id").Single());
            if (path == $"/internal/worker-executions/exports/{JobId:D}")
            {
                return Json(new { exportId = JobId, format, sourceUrl = "http://collab/documents/x/bundles?shape=render", bearerToken = "delegated-token", delegationExpiresAt = DateTimeOffset.UtcNow.AddMinutes(10) });
            }
            if (path == $"/internal/worker-executions/exports/{JobId:D}/destination")
            {
                return Json(new
                {
                    exportId = JobId,
                    attemptId = AttemptId,
                    format,
                    objectKey = $"exports/results/t/{JobId:D}/{AttemptId:D}.{(format == "markdown" ? "md" : format)}",
                    uploadUrl = "http://objects/upload",
                    readUrl = "http://objects/read",
                    deleteUrl = "http://objects/delete",
                    capabilityExpiresAt = DateTimeOffset.UtcNow.AddMinutes(10),
                });
            }
            return new HttpResponseMessage(HttpStatusCode.NotFound);
        }

        private static HttpResponseMessage Json(object body) => new(HttpStatusCode.OK)
        {
            Content = new StringContent(JsonSerializer.Serialize(body, Web), Encoding.UTF8, "application/json"),
        };
    }

    private static string FixtureRoot()
    {
        var directory = new DirectoryInfo(AppContext.BaseDirectory);
        while (directory is not null && !File.Exists(Path.Combine(directory.FullName, "Nix.slnx")))
        {
            directory = directory.Parent;
        }
        return Path.Combine(directory!.FullName, "fixtures", "parity", "export");
    }

    private sealed class SingleClientFactory(HttpMessageHandler handler) : IHttpClientFactory
    {
        public HttpClient CreateClient(string name) => new(handler, disposeHandler: false);
    }

    private sealed class NoServer : IServer
    {
        public IFeatureCollection Features { get; } = new FeatureCollection();

        public void Dispose()
        {
        }

        public Task StartAsync<TContext>(IHttpApplication<TContext> application, CancellationToken cancellationToken) where TContext : notnull => Task.CompletedTask;

        public Task StopAsync(CancellationToken cancellationToken) => Task.CompletedTask;
    }
}
