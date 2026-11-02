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
    private static readonly JsonSerializerOptions Wire = new(JsonSerializerDefaults.Web);
    private static CancellationToken Cancellation => TestContext.Current.CancellationToken;

    public HabitFixtureReplayTests(NixPostgresFixture fixture) => _fixture = fixture;

    public static TheoryData<string> Names()
    {
        var data = new TheoryData<string>();
        foreach (var fixture in ViewComputeFixtures.Load("habit"))
        {
            data.Add(fixture.Name);
        }

        return data;
    }

    public async ValueTask InitializeAsync() => await ViewComputeFixtures.PrepareAsync(_fixture);

    public ValueTask DisposeAsync() => ValueTask.CompletedTask;

    [Theory]
    [MemberData(nameof(Names))]
    public async Task Core_answers_the_fixture(string name)
    {
        var fixture = ViewComputeFixtures.Load("habit").Single(candidate => candidate.Name == name);
        var work = await _fixture.Application.BeginUnitOfWorkAsync(TestTenants.AlphaContext, Cancellation);
        await using (work.ConfigureAwait(false))
        {
            var clock = _fixture.Application.Clock;
            var ids = await ViewComputeFixtures.SeedAsync(
                work.Resolve<NixDispatcher>(), WorkspaceId.From(TestTenants.AlphaWorkspace), fixture, Cancellation, clock);
            clock.Pin(fixture.Now);
            try
            {
                ViewComputeFixtures.Verify(fixture, ViewComputeFixtures.ToKeys(await AnswerAsync(work, fixture, ids, clock), ids));
            }
            finally
            {
                clock.Unpin();
            }
        }
    }

    private static async Task<JsonObject> AnswerAsync(NixUnitOfWork work, ViewComputeFixture fixture, FixtureIds ids, TimeProvider clock)
    {
        var request = new Uri("https://nix.test" + ViewComputeFixtures.ToIds(fixture.Request["path"]!.GetValue<string>(), ids));
        var query = HttpUtility.ParseQueryString(request.Query);
        var itemId = Guid.Parse(request.AbsolutePath.Split('/')[4]);
        var handler = new HabitTrackerHandler(
            work.Resolve<IItemTree>(), work.Resolve<IPermissionResolver>(), work.Resolve<IItemLocks>(),
            work.Resolve<IHabitLock>(), work.Resolve<NixDispatcher>(), clock);
        var result = await handler.HandleAsync(
            new ReadHabitTracker(ItemId.From(itemId), Day(query["from"]), Day(query["to"])), Cancellation);
        if (result.IsSuccess)
        {
            return new JsonObject
            {
                ["status"] = 200,
                ["body"] = JsonSerializer.SerializeToNode(result.Value, Wire),
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
