using System.Globalization;
using Nix.Domain.Time;
using Nix.Integration.Tests.Harness;
using Npgsql;

namespace Nix.Integration.Tests.Persistence;

/// <summary>
/// <c>DatePeriods.Start</c> agrees with Postgres's <c>date_trunc</c> for every period it shares.
/// </summary>
/// <remarks>
/// The query engine may truncate in SQL where a chart folds in the application, and the two must
/// land every day on the same period key - a week that starts on a different day in each would put
/// one item in two weeks. Eight years of days cover every weekday at every month, quarter and year
/// boundary, a leap day, and the ISO weeks that straddle New Year.
/// </remarks>
[Collection(PostgresSecondaryCollectionDefinition.Name)]
public sealed class DatePeriodsParityTests
{
    private readonly NixPostgresFixture _fixture;

    public DatePeriodsParityTests(NixPostgresFixture fixture) => _fixture = fixture;

    [Theory]
    [InlineData("week", DatePeriod.Week)]
    [InlineData("month", DatePeriod.Month)]
    [InlineData("quarter", DatePeriod.Quarter)]
    [InlineData("year", DatePeriod.Year)]
    public async Task Every_period_start_matches_date_trunc(string field, DatePeriod period)
    {
        var mismatches = new List<string>();
        var checkedDays = 0;

        var connection = await _fixture.OpenMigratorConnectionAsync();
        await using (connection.ConfigureAwait(false))
        {
            var command = new NpgsqlCommand(
                """
                SELECT day::date, date_trunc(@field, day)::date
                FROM generate_series(date '2019-12-20', date '2028-01-10', interval '1 day') AS day
                """,
                connection);
            await using (command.ConfigureAwait(false))
            {
                command.Parameters.AddWithValue("field", field);

                var reader = await command.ExecuteReaderAsync(TestContext.Current.CancellationToken);
                await using (reader.ConfigureAwait(false))
                {
                    while (await reader.ReadAsync(TestContext.Current.CancellationToken))
                    {
                        var day = await reader.GetFieldValueAsync<DateOnly>(0, TestContext.Current.CancellationToken);
                        var truncated = await reader.GetFieldValueAsync<DateOnly>(1, TestContext.Current.CancellationToken);
                        checkedDays++;

                        if (DatePeriods.Start(day, period) != truncated)
                        {
                            mismatches.Add(string.Create(
                                CultureInfo.InvariantCulture,
                                $"{day:yyyy-MM-dd}: {DatePeriods.Start(day, period):yyyy-MM-dd} vs {truncated:yyyy-MM-dd}"));
                        }
                    }
                }
            }
        }

        Assert.True(checkedDays > 2900);
        Assert.Empty(mismatches);
    }
}
