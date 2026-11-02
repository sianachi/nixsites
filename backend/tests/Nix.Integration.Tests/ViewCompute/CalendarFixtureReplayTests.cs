using System.Collections.Specialized;
using System.Text.Json.Nodes;
using System.Web;
using Nix.Domain.Calendar;
using Nix.Domain.Primitives;
using Nix.Domain.Tenancy;
using Nix.Features.Calendar;
using Nix.Integration.Tests.Harness;
using Nix.Messaging;

namespace Nix.Integration.Tests.ViewCompute;

/// <summary>
/// Replays <c>packages/view-compute/fixtures/calendar/*.json</c> through Core's own calendar handler,
/// so the offline TypeScript port (<c>packages/view-compute/src/calendar</c>) cannot drift from it.
/// </summary>
/// <remarks>
/// The fixtures avoid two things Core's order does not pin down: ties between stored entries on one
/// value (broken by item id, which Core mints) and ties between series in different containers
/// (broken by sibling order, which is per parent).
/// </remarks>
[Collection(PostgresCollectionDefinition.Name)]
public sealed class CalendarFixtureReplayTests : IAsyncLifetime
{
    private readonly NixPostgresFixture _fixture;

    public CalendarFixtureReplayTests(NixPostgresFixture fixture) => _fixture = fixture;

    private static CancellationToken Cancellation => TestContext.Current.CancellationToken;

    public ValueTask InitializeAsync() => ValueTask.CompletedTask;

    public ValueTask DisposeAsync() => ValueTask.CompletedTask;

    [Fact]
    public async Task Every_calendar_fixture_matches_what_core_answers()
    {
        var fixtures = ViewComputeFixtures.Load("calendar");
        Assert.NotEmpty(fixtures);

        foreach (var fixture in fixtures)
        {
            await _fixture.ResetAsync();
            await M0SchemaSeed.SeedBothTenantsAsync(_fixture);

            FixtureIds ids;
            var seeding = await _fixture.Application.BeginUnitOfWorkAsync(TestTenants.AlphaContext, Cancellation);
            await using (seeding.ConfigureAwait(false))
            {
                ids = await ViewComputeFixtures.SeedAsync(
                    seeding.Resolve<NixDispatcher>(), WorkspaceId.From(TestTenants.AlphaWorkspace), fixture, Cancellation);
                await seeding.CommitAsync(Cancellation);
            }

            var path = ViewComputeFixtures.ToIds(fixture.Request["path"]!.GetValue<string>(), ids);
            var query = HttpUtility.ParseQueryString(path[(path.IndexOf('?', StringComparison.Ordinal) + 1)..]);

            Result<WorkspaceCalendarResults> result;
            var reading = await _fixture.Application.BeginUnitOfWorkAsync(TestTenants.AlphaContext, Cancellation);
            await using (reading.ConfigureAwait(false))
            {
                result = await reading.Resolve<NixDispatcher>()
                    .QueryAsync<GetWorkspaceCalendar, Result<WorkspaceCalendarResults>>(
                        new GetWorkspaceCalendar(ids.Workspace, query["from"]!, query["to"]!),
                        Cancellation);
            }

            var answer = ViewComputeFixtures.ToKeys(Answer(result, ids, query), ids);
            Assert.True(
                JsonNode.DeepEquals(fixture.Expected, answer),
                $"{fixture.Name}: expected {fixture.Expected.ToJsonString()} but Core answered {answer?.ToJsonString()}");
        }
    }

    /// <summary>Core's HTTP answer for the handler's result, in the fixture's expected shape.</summary>
    private static JsonObject Answer(Result<WorkspaceCalendarResults> result, FixtureIds ids, NameValueCollection query)
    {
        if (result.IsFailure)
        {
            return new JsonObject
            {
                ["status"] = result.Error.Code == "calendar.invalid_window" ? 400 : 404,
                ["code"] = result.Error.Code,
                ["detail"] = result.Error.Message,
            };
        }

        var found = result.Value;
        var entries = new JsonArray();
        foreach (var row in found.Entries)
        {
            var entry = row.Entry;
            entries.Add(new JsonObject
            {
                ["itemId"] = entry.ItemId.Value.ToString(),
                ["title"] = entry.Title,
                ["containerId"] = entry.ContainerId.Value.ToString(),
                ["containerTitle"] = entry.ContainerTitle,
                ["dateProperty"] = entry.DateProperty,
                ["value"] = entry.Value,
                ["kind"] = entry.Kind == CalendarEntryKind.Date ? "date" : "timestamp",
                ["generated"] = row.Generated,
                ["completed"] = row.Completed,
                ["endProperty"] = entry.EndProperty,
                ["endValue"] = entry.EndValue,
            });
        }

        var unplaceable = new JsonArray();
        foreach (var container in found.UnplaceableContainers)
        {
            unplaceable.Add(Unplaceable(container.ContainerId.Value, container.ContainerTitle, "no_date_property", null, null));
        }

        foreach (var candidate in found.UnplaceableCandidates)
        {
            var item = candidate.Candidate;
            unplaceable.Add(Unplaceable(
                item.ContainerId.Value, item.ContainerTitle, candidate.Reason, item.ItemId.Value, item.ItemTitle));
        }

        return new JsonObject
        {
            ["status"] = 200,
            ["body"] = new JsonObject
            {
                ["workspaceId"] = ids.Workspace.Value.ToString(),
                ["from"] = query["from"],
                ["to"] = query["to"],
                ["entries"] = entries,
                ["unplaceable"] = unplaceable,
                ["entryLimit"] = found.EntryLimit,
                ["entriesTruncated"] = found.EntriesTruncated,
                ["seriesTruncated"] = found.SeriesTruncated,
            },
        };
    }

    private static JsonObject Unplaceable(Guid containerId, string? containerTitle, string reason, Guid? itemId, string? itemTitle) =>
        new()
        {
            ["containerId"] = containerId.ToString(),
            ["containerTitle"] = containerTitle,
            ["reason"] = reason,
            ["itemId"] = itemId?.ToString(),
            ["itemTitle"] = itemTitle,
        };
}
