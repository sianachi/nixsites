using System.Net;
using System.Text;
using System.Text.Json;
using System.Text.Json.Nodes;
using Microsoft.AspNetCore.Hosting.Server;
using Microsoft.AspNetCore.Http.Features;
using Microsoft.Extensions.Configuration;
using Microsoft.Extensions.Options;
using Nix.Abstractions.Workers;
using Nix.Workers;
using Nix.Workers.Calendar;

namespace Nix.Tests.Workers;

/// <summary>
/// Replays the scenarios the Go worker recorded (<c>fixtures/parity/calendar/*.json</c>, written
/// by <c>TestRecordParityScenarios</c> before the Go calendar role was deleted) and requires the
/// same request sequence, bodies, result and error from the .NET handler.
/// </summary>
public sealed class CalendarSyncParityTests
{
    private const string CoreOrigin = "http://core";
    private const string ProviderOrigin = "http://provider";
    private static readonly string[] RecordedHeaders = ["Authorization", "If-Match", "Prefer", "X-Nix-Worker-Job-Id", "X-Nix-Worker-Execution-Id"];

    public static TheoryData<string> Scenarios()
    {
        var data = new TheoryData<string>();
        foreach (var file in Directory.GetFiles(FixtureDirectory(), "*.json").Order(StringComparer.Ordinal))
        {
            data.Add(Path.GetFileNameWithoutExtension(file));
        }
        return data;
    }

    [Theory]
    [MemberData(nameof(Scenarios))]
    public async Task The_dotnet_handler_issues_the_same_requests_as_the_go_worker(string scenario)
    {
        var fixture = JsonNode.Parse(await File.ReadAllTextAsync(Path.Combine(FixtureDirectory(), scenario + ".json"), TestContext.Current.CancellationToken))!.AsObject();
        using var script = new ScriptedHandler(fixture);
        using var server = new NoServer();
        using var googleHttp = new HttpClient(script, disposeHandler: false);
        using var graphHttp = new HttpClient(script, disposeHandler: false);
        var configuration = new ConfigurationBuilder().AddInMemoryCollection(new Dictionary<string, string?>
        {
            ["Nix:InternalSecret"] = "parity-secret",
            ["Nix:Workers:LoopbackUrl"] = CoreOrigin,
        }).Build();
        var core = new WorkerLoopbackClient(new SingleClientFactory(script), server, configuration, Options.Create(new WorkerOptions()));
        var providers = new Dictionary<string, ICalendarProvider>(StringComparer.Ordinal)
        {
            ["google"] = new GoogleCalendarClient(new CalendarTransport(googleHttp, ProviderOrigin)),
            ["microsoft"] = new GraphCalendarClient(new CalendarTransport(graphHttp, ProviderOrigin)),
        };
        var handler = new CalendarSyncHandler(core, providers);
        var execution = new WorkerExecution(
            new DispatchedWorkerJob(Guid.Parse("44444444-4444-4444-4444-444444444444"), Guid.NewGuid(), null, null, "calendar.sync", fixture["payload"]!.ToJsonString(), 1, false),
            "nix-parity:execution");

        string? result = null;
        WorkerJobException? error = null;
        try
        {
            result = await handler.HandleAsync(execution, TestContext.Current.CancellationToken);
        }
        catch (WorkerJobException exception)
        {
            error = exception;
        }

        var expected = fixture["expected"]!.AsObject();
        var expectedRequests = expected["requests"]!.AsArray().Select(node => Canonical(node!)).ToArray();
        var actualRequests = script.Requests.Select(Canonical).ToArray();
        Assert.Equal(expectedRequests, actualRequests);
        if (expected["error"] is JsonObject expectedError)
        {
            Assert.NotNull(error);
            Assert.Equal(expectedError["code"]!.GetValue<string>(), error.Code);
            Assert.Equal(expectedError["retryable"]!.GetValue<bool>(), error.Retryable);
        }
        else
        {
            Assert.Null(error);
            Assert.Equal(Canonical(expected["result"]!), Canonical(JsonNode.Parse(result!)!));
        }
        Assert.Equal(0, script.RemainingAnswers);
    }

    private static string FixtureDirectory()
    {
        var directory = new DirectoryInfo(AppContext.BaseDirectory);
        while (directory is not null && !File.Exists(Path.Combine(directory.FullName, "Nix.slnx")))
        {
            directory = directory.Parent;
        }
        return Path.Combine(directory!.FullName, "fixtures", "parity", "calendar");
    }

    /// <summary>Sorted keys, compact: the same canonical form the recorder wrote.</summary>
    private static string Canonical(JsonNode node)
    {
        var builder = new StringBuilder();
        Write(node, builder);
        return builder.ToString();

        static void Write(JsonNode? node, StringBuilder builder)
        {
            switch (node)
            {
                case JsonObject obj:
                    builder.Append('{');
                    var first = true;
                    foreach (var (key, value) in obj.OrderBy(pair => pair.Key, StringComparer.Ordinal))
                    {
                        if (!first)
                        {
                            builder.Append(',');
                        }
                        first = false;
                        builder.Append(JsonSerializer.Serialize(key)).Append(':');
                        Write(value, builder);
                    }
                    builder.Append('}');
                    break;
                case JsonArray array:
                    builder.Append('[');
                    for (var index = 0; index < array.Count; index++)
                    {
                        if (index > 0)
                        {
                            builder.Append(',');
                        }
                        Write(array[index], builder);
                    }
                    builder.Append(']');
                    break;
                case null:
                    builder.Append("null");
                    break;
                default:
                    builder.Append(node.ToJsonString());
                    break;
            }
        }
    }

    /// <summary>Answers Core and provider requests from the fixture's script, recording each one the way the Go recorder did.</summary>
    private sealed class ScriptedHandler(JsonObject fixture) : HttpMessageHandler
    {
        private readonly Queue<JsonObject> _answers = new(fixture["provider"]?.AsArray().Select(node => node!.AsObject()) ?? []);

        public List<JsonObject> Requests { get; } = [];

        public int RemainingAnswers => _answers.Count;

        protected override async Task<HttpResponseMessage> SendAsync(HttpRequestMessage request, CancellationToken cancellationToken)
        {
            var isProvider = request.RequestUri!.GetLeftPart(UriPartial.Authority) == ProviderOrigin;
            var record = new JsonObject
            {
                ["to"] = isProvider ? "provider" : "core",
                ["method"] = request.Method.Method,
                ["path"] = request.RequestUri.PathAndQuery.Replace(ProviderOrigin, "{provider}", StringComparison.Ordinal),
            };
            var headers = new JsonObject();
            foreach (var name in RecordedHeaders)
            {
                if (request.Headers.TryGetValues(name, out var values))
                {
                    headers[name] = string.Join(",", values);
                }
            }
            record["headers"] = headers;
            record["body"] = request.Content is null
                ? null
                : JsonNode.Parse((await request.Content.ReadAsStringAsync(cancellationToken)).Replace(ProviderOrigin, "{provider}", StringComparison.Ordinal));
            Requests.Add(record);

            if (isProvider)
            {
                Assert.True(_answers.Count > 0, $"unscripted provider request {request.Method} {request.RequestUri}");
                var answer = _answers.Dequeue();
                return Json((HttpStatusCode)answer["status"]!.GetValue<int>(), answer["body"]);
            }

            var path = request.RequestUri.AbsolutePath;
            if (path.EndsWith("/session", StringComparison.Ordinal))
            {
                return fixture["sessionStatus"]?.GetValue<int>() is > 0 and var sessionStatus
                    ? Problem((HttpStatusCode)sessionStatus, fixture["sessionCode"]!.GetValue<string>())
                    : Json(HttpStatusCode.OK, fixture["session"]);
            }
            if (path.EndsWith("/pull", StringComparison.Ordinal))
            {
                return fixture["pullStatus"]?.GetValue<int>() is > 0 and var pullStatus
                    ? Problem((HttpStatusCode)pullStatus, fixture["pullCode"]!.GetValue<string>())
                    : Json(HttpStatusCode.OK, fixture["pull"]);
            }
            if (path.EndsWith("/changes", StringComparison.Ordinal))
            {
                return Json(HttpStatusCode.OK, fixture["changes"]);
            }
            return new HttpResponseMessage(HttpStatusCode.NoContent);
        }

        private static HttpResponseMessage Json(HttpStatusCode status, JsonNode? body)
        {
            var response = new HttpResponseMessage(status);
            if (body is not null)
            {
                response.Content = new StringContent(body.ToJsonString().Replace("{provider}", ProviderOrigin, StringComparison.Ordinal), Encoding.UTF8, "application/json");
            }
            return response;
        }

        private static HttpResponseMessage Problem(HttpStatusCode status, string code) => new(status)
        {
            Content = new StringContent($"{{\"code\":\"{code}\"}}", Encoding.UTF8, "application/problem+json"),
        };
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
