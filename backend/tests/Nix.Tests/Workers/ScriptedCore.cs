#pragma warning disable CA2000 // Justification: the scripted clients share this handler for the life of the test, which disposes it.
using System.Net;
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
/// A scripted Core, Collab and object store for handler tests: one in-memory handler answers
/// every request, asserting the execution proof on worker routes the way the Go tests did.
/// </summary>
internal sealed class ScriptedCore : HttpMessageHandler
{
    public const string Secret = "worker-secret";
    private static readonly JsonSerializerOptions Web = new(JsonSerializerDefaults.Web);
    private readonly Func<HttpRequestMessage, byte[], Task<HttpResponseMessage?>> _script;

    public ScriptedCore(Func<HttpRequestMessage, byte[], Task<HttpResponseMessage?>> script)
    {
        this._script = script;
    }

    public static Guid JobId { get; } = Guid.Parse("40000000-0000-4000-8000-000000000001");

    public const string ExecutionId = "nix-api:test:import:1";

    public List<(string Method, string Path)> Requests { get; } = [];

    public static HttpResponseMessage Json(object body, HttpStatusCode status = HttpStatusCode.OK) => new(status)
    {
        Content = new StringContent(JsonSerializer.Serialize(body, Web), Encoding.UTF8, "application/json"),
    };

    public static HttpResponseMessage Problem(HttpStatusCode status, string code) => new(status)
    {
        Content = new StringContent($$"""{"code":"{{code}}","detail":"scripted"}""", Encoding.UTF8, "application/problem+json"),
    };

    public static HttpResponseMessage Bytes(byte[] body) => new(HttpStatusCode.OK) { Content = new ByteArrayContent(body) };

    public static HttpResponseMessage Status(HttpStatusCode status) => new(status);

    public static WorkerExecution Execution(string kind, string payload) =>
        new(new DispatchedWorkerJob(JobId, Guid.NewGuid(), Guid.NewGuid(), Guid.NewGuid(), kind, payload, 1, false), ExecutionId);

    /// <summary>A loopback client whose named client sends through this script.</summary>
    public WorkerLoopbackClient Core(WorkerOptions? options = null)
    {
        var configuration = new ConfigurationBuilder().AddInMemoryCollection(new Dictionary<string, string?>
        {
            ["Nix:InternalSecret"] = Secret,
            ["Nix:Workers:LoopbackUrl"] = "http://core",
        }).Build();
        return new WorkerLoopbackClient(new SingleClientFactory(this), new NoServer(), configuration, Options.Create(options ?? new WorkerOptions()));
    }

    public ObjectTransfer Objects() => new(new HttpClient(this, disposeHandler: false), ["http://objects"]);

    public CollabImportClient Collab(WorkerOptions? options = null) =>
        new(new HttpClient(this, disposeHandler: false), new Uri("http://collab"), Secret, Options.Create(options ?? new WorkerOptions()));

    protected override async Task<HttpResponseMessage> SendAsync(HttpRequestMessage request, CancellationToken cancellationToken)
    {
        var uri = request.RequestUri!;
        Requests.Add((request.Method.Method, uri.AbsolutePath));
        if (uri.AbsolutePath.StartsWith("/internal/", StringComparison.Ordinal))
        {
            Assert.Equal(Secret, request.Headers.GetValues("x-nix-internal-secret").Single());
            Assert.Equal(JobId.ToString("D"), request.Headers.GetValues("x-nix-worker-job-id").Single());
            Assert.Equal(ExecutionId, request.Headers.GetValues("x-nix-worker-execution-id").Single());
        }
        var body = request.Content is null ? [] : await request.Content.ReadAsByteArrayAsync(cancellationToken);
        return await _script(request, body) ?? new HttpResponseMessage(HttpStatusCode.NotFound);
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
