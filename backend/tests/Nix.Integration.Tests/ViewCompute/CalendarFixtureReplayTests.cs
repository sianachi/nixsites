using System.Collections.Specialized;
using System.Globalization;
using System.Text.Json.Nodes;
using System.Web;
using Nix.Domain.Calendar;
using Nix.Domain.Items;
using Nix.Features.Recurrence;
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
/// Record expected answers with <c>NIX_FIXTURE_RECORD=1</c>. The fixtures avoid two things Core's order does not pin down: ties between stored entries on one
/// value (broken by item id, which Core mints) and ties between series in different containers
/// (broken by sibling order, which is per parent).
/// </remarks>
[Collection(PostgresSecondaryCollectionDefinition.Name)]
public sealed class CalendarFixtureReplayTests : IAsyncLifetime
{
    private readonly NixPostgresFixture _fixture;

    public CalendarFixtureReplayTests(NixPostgresFixture fixture) => _fixture = fixture;

    private static CancellationToken Cancellation => TestContext.Current.CancellationToken;

    public static TheoryData<string> Names()
    {
        var data = new TheoryData<string>();
        foreach (var fixture in ViewComputeFixtures.Load("calendar"))
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
        var fixture = ViewComputeFixtures.Load("calendar").Single(candidate => candidate.Name == name);

        var work = await _fixture.Application.BeginUnitOfWorkAsync(TestTenants.AlphaContext, Cancellation);
        await using (work.ConfigureAwait(false))
        {
            var dispatcher = work.Resolve<NixDispatcher>();
            var ids = await ViewComputeFixtures.SeedAsync(
                dispatcher, WorkspaceId.From(TestTenants.AlphaWorkspace), fixture, Cancellation, _fixture.Application.Clock);

            // The rule request carries no completion state, so a fixture's "complete" days go through Core's own command.
            foreach (var node in fixture.Items)
            {
                if (node!["complete"] is not JsonArray days)
                {
                    continue;
                }

                foreach (var day in days)
                {
                    var done = await dispatcher.SendAsync<CompleteRecurrenceOccurrence, Item>(
                        new CompleteRecurrenceOccurrence(
                            ids.ByKey[node["key"]!.GetValue<string>()],
                            DateOnly.ParseExact(day!.GetValue<string>(), "yyyy-MM-dd", CultureInfo.InvariantCulture)),
                        Cancellation);
                    Assert.True(done.IsSuccess, done.IsFailure ? done.Error.Message : null);
                }
            }

            var path = ViewComputeFixtures.ToIds(fixture.Request["path"]!.GetValue<string>(), ids);
            var query = HttpUtility.ParseQueryString(path[(path.IndexOf('?', StringComparison.Ordinal) + 1)..]);

            var result = await dispatcher.QueryAsync<GetWorkspaceCalendar, Result<WorkspaceCalendarResults>>(
                new GetWorkspaceCalendar(ids.Workspace, query["from"]!, query["to"]!),
                Cancellation);

            ViewComputeFixtures.Verify(fixture, ViewComputeFixtures.ToKeys(Answer(result, ids, query), ids));
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
