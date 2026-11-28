using System.Reflection;
using System.Text.Json;
using System.Text.Json.Nodes;
using System.Text.Json.Serialization;
using Microsoft.AspNetCore.Http;
using Microsoft.AspNetCore.Http.HttpResults;
using Nix.Domain.Tenancy;
using Nix.Features.Query;
using Nix.Integration.Tests.Harness;
using Nix.Messaging;

namespace Nix.Integration.Tests.ViewCompute;

/// <summary>
/// Replays <c>packages/view-compute/fixtures/query/*.json</c> through Core's own query endpoints
/// (the real route handlers, called directly), so the offline TypeScript port is held to what Core
/// answers. Record the expected answers with <c>NIX_FIXTURE_RECORD=1</c>; never write them by hand.
/// </summary>
[Collection(PostgresSecondaryCollectionDefinition.Name)]
public sealed class QueryFixtureReplayTests : IAsyncLifetime
{
    private static readonly Assembly Core = typeof(RunItemQuery).Assembly;
    private readonly NixPostgresFixture _fixture;

    public QueryFixtureReplayTests(NixPostgresFixture fixture) => _fixture = fixture;

    private static CancellationToken Cancellation => TestContext.Current.CancellationToken;

    // "query" fixtures run against the plain mirror source; "query/ctx" ones also need the caller's
    // principal, zone and readable workspaces, which the TypeScript side supplies in its own test.
    private static readonly string[] Slices = ["query", "query/ctx"];

    public static TheoryData<string, string> Names()
    {
        var data = new TheoryData<string, string>();
        foreach (var slice in Slices)
        {
            foreach (var fixture in ViewComputeFixtures.Load(slice))
            {
                data.Add(slice, fixture.Name);
            }
        }

        return data;
    }

    public async ValueTask InitializeAsync()
    {
        await ViewComputeFixtures.PrepareAsync(_fixture);
    }

    public ValueTask DisposeAsync() => ValueTask.CompletedTask;

    [Theory]
    [MemberData(nameof(Names))]
    public async Task Core_answers_the_fixture(string slice, string name)
    {
        var fixture = ViewComputeFixtures.Load(slice).Single(candidate => candidate.Name == name);

        var work = await _fixture.Application.BeginUnitOfWorkAsync(TestTenants.AlphaContext, Cancellation);
        await using (work.ConfigureAwait(false))
        {
            var dispatcher = work.Resolve<NixDispatcher>();
            var ids = await ViewComputeFixtures.SeedAsync(
                dispatcher, WorkspaceId.From(TestTenants.AlphaWorkspace), fixture, Cancellation, _fixture.Application.Clock);

            var path = ViewComputeFixtures.ToIds(fixture.Request["path"]!.GetValue<string>(), ids);
            var body = fixture.Request["body"] is { } sent ? ViewComputeFixtures.ToIds(sent.ToJsonString(), ids) : null;
            var answer = await AskAsync(dispatcher, fixture.Request["method"]!.GetValue<string>(), path, body);

            ViewComputeFixtures.Verify(fixture, ViewComputeFixtures.ToKeys(answer, ids));
        }
    }

    private static async Task<JsonNode> AskAsync(NixDispatcher dispatcher, string method, string path, string? body)
    {
        var uri = new Uri(new Uri("https://nix.test"), path);
        var segments = uri.AbsolutePath.Split('/', StringSplitOptions.RemoveEmptyEntries);
        var context = new DefaultHttpContext();
        context.Request.Path = uri.AbsolutePath;
        var json = (JsonSerializerContext)Core.GetType("Nix.Serialization.QueryJsonContext")!
            .GetProperty("Default", BindingFlags.Static | BindingFlags.Public)!.GetValue(null)!;

        // /api/v1/items/{id}/query  |  /api/v1/workspaces/{id}/query[/aggregate]
        var id = Guid.Parse(segments[3]);
        object[] arguments;
        string endpoint;
        if (method == "GET")
        {
            var query = System.Web.HttpUtility.ParseQueryString(uri.Query);
            endpoint = "RunItemQueryEndpoint";
            arguments = [id, query["view"]!, query["today"]!, context, dispatcher];
        }
        else
        {
            var aggregate = segments.Length > 5;
            endpoint = aggregate ? "AggregateWorkspaceQueryEndpoint" : "RunWorkspaceQueryEndpoint";
            var requestType = Core.GetType(aggregate ? "Nix.Features.Query.WorkspaceAggregateRequest" : "Nix.Features.Query.WorkspaceQueryRequest")!;
            arguments = [id, JsonSerializer.Deserialize(body ?? "{}", requestType, json)!, context, dispatcher];
        }

        var handle = Core.GetType("Nix.Features.Query." + endpoint)!
            .GetMethod("Handle", BindingFlags.Static | BindingFlags.NonPublic | BindingFlags.Public)!;
        var task = (Task)handle.Invoke(null, arguments)!;
        await task.ConfigureAwait(false);
        var union = task.GetType().GetProperty("Result")!.GetValue(task)!;
        var result = (IResult)union.GetType().GetProperty("Result")!.GetValue(union)!;

        if (result is ProblemHttpResult problem)
        {
            return new JsonObject
            {
                ["status"] = problem.ProblemDetails.Status,
                ["code"] = problem.ProblemDetails.Extensions["code"]?.ToString(),
                ["detail"] = problem.ProblemDetails.Detail,
            };
        }

        var value = result.GetType().GetProperty("Value")!.GetValue(result)!;
        return new JsonObject
        {
            ["status"] = 200,
            ["body"] = JsonNode.Parse(JsonSerializer.Serialize(value, value.GetType(), json)),
        };
    }
}
