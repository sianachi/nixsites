using System.Globalization;
using System.Text.Json;
using System.Text.Json.Nodes;
using System.Web;
using Nix.Abstractions;
using Nix.Domain.Finance;
using Nix.Domain.Items;
using Nix.Domain.Primitives;
using Nix.Domain.Tenancy;
using Nix.Features.Finance;
using Nix.Integration.Tests.Harness;
using Nix.Messaging;

namespace Nix.Integration.Tests.ViewCompute;

/// <summary>
/// The finance golden fixtures (<c>packages/view-compute/fixtures/finance</c>) replayed through
/// Core's own finance read handlers, so the offline TypeScript port cannot drift from them.
/// </summary>
[Collection(PostgresCollectionDefinition.Name)]
public sealed class FinanceFixtureReplayTests : IAsyncLifetime
{
    private readonly NixPostgresFixture _fixture;
    private static CancellationToken Cancellation => TestContext.Current.CancellationToken;

    public FinanceFixtureReplayTests(NixPostgresFixture fixture) => _fixture = fixture;

    public ValueTask InitializeAsync() => ValueTask.CompletedTask;

    public ValueTask DisposeAsync() => ValueTask.CompletedTask;

    [Fact]
    public async Task Core_answers_every_finance_fixture_as_recorded()
    {
        var fixtures = ViewComputeFixtures.Load("finance");
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
        var parts = request.AbsolutePath.Split('/');
        var item = ItemId.From(Guid.Parse(parts[4]));
        var rest = parts.Skip(6).ToArray();
        var query = HttpUtility.ParseQueryString(request.Query);
        var clock = new FixtureClock(fixture.Now);
        var loader = work.Resolve<FinanceLoader>();
        var reports = new FinanceReportHandler(loader, clock);

        // The endpoints parse a month before they ask a handler anything.
        var invalid = new NixError("finance.invalid_month", "Months are written yyyy-MM.");
        YearMonth? month = null, from = null, to = null;
        var monthsOk = rest switch
        {
        ["accounts"] or ["dashboard"] or ["transactions"] => Month(query["month"], out month),
            ["budget"] => Month(query["from"], out from) && Month(query["to"], out to),
            ["months", var named] => YearMonth.TryParse(named, out var parsedMonth) && (month = parsedMonth) is not null,
            _ => true,
        };
        if (!monthsOk)
        {
            return Refused(invalid);
        }

        switch (rest)
        {
            case []:
                return Answer(await new FinanceSetupHandler(loader, work.Resolve<IFinanceLock>(), work.Resolve<NixDispatcher>(), clock)
                    .HandleAsync(new ReadFinance(item), Cancellation));
            case ["accounts"]:
                return Answer(await reports.HandleAsync(new ReadFinanceAccounts(item, month), Cancellation));
            case ["accounts", var loan, "loan"]:
                return Answer(await reports.HandleAsync(
                    new ReadLoanSchedule(item, Guid.Parse(loan), Decimal(query["overpayment"])), Cancellation));
            case ["transactions"]:
                return Answer(await reports.HandleAsync(
                    new ListFinanceTransactions(
                        item, month, Id(query["accountId"]), Id(query["lineId"]), query["unassigned"] == "true",
                        Whole(query["limit"]) ?? 0, Day(query["from"]), Day(query["to"]), query["search"], query["source"],
                        Decimal(query["minAmount"]), Decimal(query["maxAmount"]), Whole(query["offset"]) ?? 0, Id(query["transactionId"])),
                    Cancellation));
            case ["budget"]:
                return Answer(await reports.HandleAsync(new ReadBudgetGrid(item, from, to, Id(query["accountId"])), Cancellation));
            case ["cashflow"]:
                return Answer(await reports.HandleAsync(new ReadCashFlow(item), Cancellation));
            case ["dashboard"]:
                return Answer(await reports.HandleAsync(new ReadFinanceDashboard(item, month), Cancellation));
            case ["months", _]:
                return Answer(await reports.HandleAsync(new ReadFinanceMonth(item, month!.Value), Cancellation));
            default:
                throw new InvalidOperationException($"No finance read for {fixture.Name}.");
        }
    }

    private static JsonObject Answer<T>(Result<T> result) =>
        result.IsSuccess
            ? new JsonObject { ["status"] = 200, ["body"] = JsonSerializer.SerializeToNode(result.Value, ReplayCompare.Wire) }
            : Refused(result.Error);

    private static JsonObject Refused(NixError error)
    {
        var status = error.Code.EndsWith("not_found", StringComparison.Ordinal) ? 404
            : error.Code is "items.locked" ? 423
            : error.Code is "finance.not_configured" or "finance.month_closed" or "finance.limit" or "items.lifecycle_conflict" ? 409
            : 422;
        return new JsonObject { ["status"] = status, ["code"] = error.Code, ["detail"] = error.Message };
    }

    private static bool Month(string? text, out YearMonth? month)
    {
        month = null;
        if (string.IsNullOrEmpty(text))
        {
            return true;
        }

        if (!YearMonth.TryParse(text, out var parsed))
        {
            return false;
        }

        month = parsed;
        return true;
    }

    private static Guid? Id(string? text) => string.IsNullOrEmpty(text) ? null : Guid.Parse(text);

    private static int? Whole(string? text) => string.IsNullOrEmpty(text) ? null : int.Parse(text, CultureInfo.InvariantCulture);

    private static decimal? Decimal(string? text) => string.IsNullOrEmpty(text) ? null : decimal.Parse(text, CultureInfo.InvariantCulture);

    private static DateOnly? Day(string? text) =>
        string.IsNullOrEmpty(text) ? null : DateOnly.ParseExact(text, "yyyy-MM-dd", CultureInfo.InvariantCulture);
}
