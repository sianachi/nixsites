using System.Globalization;
using System.Text.Json;
using System.Text.Json.Nodes;
using System.Web;
using Nix.Abstractions;
using Nix.Domain.Items;
using Nix.Domain.Primitives;
using Nix.Domain.Tenancy;
using Nix.Features.Habits;
using Nix.Integration.Tests.Harness;
using Nix.Messaging;

namespace Nix.Integration.Tests.ViewCompute;

/// <summary>
/// The habit golden fixtures (<c>packages/view-compute/fixtures/habit</c>) replayed through Core's
/// own <see cref="HabitTrackerHandler"/>, so the offline TypeScript port cannot drift from it.
/// </summary>
[Collection(PostgresSecondaryCollectionDefinition.Name)]
public sealed class HabitFixtureReplayTests : IAsyncLifetime
{
    private readonly NixPostgresFixture _fixture;
    private static CancellationToken Cancellation => TestContext.Current.CancellationToken;

    public HabitFixtureReplayTests(NixPostgresFixture fixture) => _fixture = fixture;

    public ValueTask InitializeAsync() => ValueTask.CompletedTask;

    public ValueTask DisposeAsync() => ValueTask.CompletedTask;

    [Fact]
    public async Task Core_answers_every_habit_fixture_as_recorded()
    {
        var fixtures = ViewComputeFixtures.Load("habit");
        Assert.NotEmpty(fixtures);
        var mismatches = new List<string>();
        foreach (var fixture in fixtures)
        {
            await _fixture.ResetAsync();
            await M0SchemaSeed.SeedBothTenantsAsync(_fixture);
            var work = await _fixture.Application.BeginUnitOfWorkAsync(TestTenants.AlphaContext, Cancellation);
            await using (work.ConfigureAwait(false))
            {
                var ids = await ViewComputeFixtures.SeedAsync(
                    work.Resolve<NixDispatcher>(), WorkspaceId.From(M0SchemaSeed.Alpha.WorkspaceId), fixture, Cancellation);
                var actual = (JsonObject)ViewComputeFixtures.ToKeys(await AnswerAsync(work, fixture, ids), ids)!;
                if (!ReplayCompare.Same(ReplayCompare.Normalised(actual), ReplayCompare.Normalised(fixture.Expected)))
                {
                    mismatches.Add($"{fixture.Name}\n  expected {fixture.Expected.ToJsonString()}\n  actual   {actual.ToJsonString()}");
                }
            }
        }

        Assert.True(mismatches.Count == 0, string.Join("\n", mismatches));
    }

    private static async Task<JsonObject> AnswerAsync(NixUnitOfWork work, ViewComputeFixture fixture, FixtureIds ids)
    {
        var request = new Uri("https://nix.test" + ViewComputeFixtures.ToIds(fixture.Request["path"]!.GetValue<string>(), ids));
        var query = HttpUtility.ParseQueryString(request.Query);
        var itemId = Guid.Parse(request.AbsolutePath.Split('/')[4]);
        var handler = new HabitTrackerHandler(
            work.Resolve<IItemTree>(), work.Resolve<IPermissionResolver>(), work.Resolve<IItemLocks>(),
            work.Resolve<IHabitLock>(), work.Resolve<NixDispatcher>(), new FixtureClock(fixture.Now));
        var result = await handler.HandleAsync(
            new ReadHabitTracker(ItemId.From(itemId), Day(query["from"]), Day(query["to"])), Cancellation);
        if (result.IsSuccess)
        {
            return new JsonObject
            {
                ["status"] = 200,
                ["body"] = JsonSerializer.SerializeToNode(result.Value, ReplayCompare.Wire),
            };
        }

        var code = result.Error.Code;
        var status = code.EndsWith("not_found", StringComparison.Ordinal) ? 404
            : code is "items.locked" ? 423
            : code is "habits.not_configured" or "habits.history_locked" or "habits.invalid_history" or "items.lifecycle_conflict" ? 409 : 422;
        return new JsonObject { ["status"] = status, ["code"] = code, ["detail"] = result.Error.Message };
    }

    private static DateOnly? Day(string? text) =>
        string.IsNullOrEmpty(text) ? null : DateOnly.ParseExact(text, "yyyy-MM-dd", CultureInfo.InvariantCulture);
}

/// <summary>A clock that reads the fixture's <c>now</c>.</summary>
internal sealed class FixtureClock(DateTimeOffset now) : TimeProvider
{
    public override DateTimeOffset GetUtcNow() => now;
}

/// <summary>How a fixture's recorded answer is compared with Core's.</summary>
internal static class ReplayCompare
{
    public static readonly JsonSerializerOptions Wire = new(JsonSerializerDefaults.Web);

    /// <summary>
    /// Drops <c>position</c>: it is the item's sibling sequence, sparse and assigned by the database
    /// in Core, and the fixture's index in the offline copy. Order, not value, is what the figures use.
    /// </summary>
    public static JsonNode? Normalised(JsonNode? node)
    {
        switch (node)
        {
            case JsonObject obj:
                var copy = new JsonObject();
                foreach (var (key, value) in obj)
                {
                    if (key != "position")
                    {
                        copy[key] = Normalised(value);
                    }
                }

                return copy;
            case JsonArray array:
                return new JsonArray(array.Select(Normalised).ToArray());
            default:
                return node?.DeepClone();
        }
    }

    /// <summary>Structural equality; numbers compare as doubles because Core writes 28-digit decimals.</summary>
    public static bool Same(JsonNode? left, JsonNode? right)
    {
        switch (left, right)
        {
            case (null, null):
                return true;
            case (JsonObject a, JsonObject b):
                return a.Count == b.Count && a.All(pair => b.ContainsKey(pair.Key) && Same(pair.Value, b[pair.Key]));
            case (JsonArray a, JsonArray b):
                return a.Count == b.Count && a.Zip(b).All(pair => Same(pair.First, pair.Second));
            case (JsonValue a, JsonValue b) when a.GetValueKind() == JsonValueKind.Number && b.GetValueKind() == JsonValueKind.Number:
                var (x, y) = (a.GetValue<double>(), b.GetValue<double>());
                return Math.Abs(x - y) <= 1e-9 * Math.Max(1, Math.Abs(x));
            case (null, _) or (_, null):
                return false;
            default:
                return JsonNode.DeepEquals(left, right);
        }
    }
}
