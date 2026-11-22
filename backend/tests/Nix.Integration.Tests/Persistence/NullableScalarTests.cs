using Nix.Integration.Tests.Harness;
using Nix.Persistence.Sql;
using Npgsql;

namespace Nix.Integration.Tests.Persistence;

/// <summary>
/// A scalar read never folds "no row" or SQL NULL into a default: both come back as null, on the
/// unit-of-work path and on the pooled path, and a real <c>false</c>, <c>0</c> or empty id stays
/// distinguishable from them.
/// </summary>
[Collection(PostgresSecondaryCollectionDefinition.Name)]
public sealed class NullableScalarTests : IAsyncLifetime
{
    private static readonly Guid SomeId = new("0f0f0f0f-0000-4000-8000-0f0f0f0f0f0f");
    private static readonly DateTimeOffset SomeInstant = new(2026, 1, 2, 3, 4, 5, TimeSpan.Zero);

    private readonly NixPostgresFixture _fixture;
    private NpgsqlDataSource _dataSource = null!;

    public NullableScalarTests(NixPostgresFixture fixture) => _fixture = fixture;

    private static CancellationToken Cancellation => TestContext.Current.CancellationToken;

    public async ValueTask InitializeAsync()
    {
        await _fixture.ResetAsync();
        _dataSource = NpgsqlDataSource.Create(_fixture.ApplicationConnectionString);
    }

    public async ValueTask DisposeAsync() => await _dataSource.DisposeAsync();

    [Fact]
    public async Task Pooled_path_returns_null_for_NULL_and_no_row_and_the_value_otherwise()
    {
        var pooled = new PooledSql(_dataSource);

        Assert.Null(await pooled.ScalarAsync<bool>("SELECT NULL::boolean", Cancellation));
        Assert.Null(await pooled.ScalarAsync<bool>("SELECT true WHERE false", Cancellation));
        Assert.False(await pooled.ScalarAsync<bool>("SELECT false", Cancellation));

        Assert.Null(await pooled.ScalarAsync<Guid>("SELECT NULL::uuid", Cancellation));
        Assert.Null(await pooled.ScalarAsync<Guid>("SELECT gen_random_uuid() WHERE false", Cancellation));
        Assert.Equal(Guid.Empty, await pooled.ScalarAsync<Guid>("SELECT '00000000-0000-0000-0000-000000000000'::uuid", Cancellation));
        Assert.Equal(SomeId, await pooled.ScalarAsync<Guid>($"SELECT '{SomeId}'::uuid", Cancellation));

        Assert.Null(await pooled.ScalarAsync<int>("SELECT NULL::int", Cancellation));
        Assert.Null(await pooled.ScalarAsync<int>("SELECT 1 WHERE false", Cancellation));
        Assert.Equal(0, await pooled.ScalarAsync<int>("SELECT 0", Cancellation));

        Assert.Null(await pooled.ScalarAsync<long>("SELECT NULL::bigint", Cancellation));
        Assert.Null(await pooled.ScalarAsync<long>("SELECT 1::bigint WHERE false", Cancellation));
        Assert.Equal(0L, await pooled.ScalarAsync<long>("SELECT 0::bigint", Cancellation));

        Assert.Null(await pooled.ScalarAsync<DateTimeOffset>("SELECT NULL::timestamptz", Cancellation));
        Assert.Null(await pooled.ScalarAsync<DateTimeOffset>("SELECT now() WHERE false", Cancellation));
        Assert.Equal(SomeInstant, await pooled.ScalarAsync<DateTimeOffset>("SELECT '2026-01-02 03:04:05+00'::timestamptz", Cancellation));
    }

    [Fact]
    public async Task Unit_of_work_path_returns_null_for_NULL_and_no_row_and_the_value_otherwise()
    {
        var work = await _fixture.Application.BeginUnitOfWorkAsync(TestTenants.AlphaContext, Cancellation);
        await using (work.ConfigureAwait(false))
        {
            var sql = work.Sql;

            Assert.Null(await sql.ScalarAsync<bool>("SELECT NULL::boolean", cancellationToken: Cancellation));
            Assert.Null(await sql.ScalarAsync<bool>("SELECT true WHERE false", cancellationToken: Cancellation));
            Assert.False(await sql.ScalarAsync<bool>("SELECT false", cancellationToken: Cancellation));

            Assert.Null(await sql.ScalarAsync<Guid>("SELECT NULL::uuid", cancellationToken: Cancellation));
            Assert.Null(await sql.ScalarAsync<Guid>("SELECT gen_random_uuid() WHERE false", cancellationToken: Cancellation));
            Assert.Equal(Guid.Empty, await sql.ScalarAsync<Guid>("SELECT '00000000-0000-0000-0000-000000000000'::uuid", cancellationToken: Cancellation));
            Assert.Equal(SomeId, await sql.ScalarAsync<Guid>($"SELECT '{SomeId}'::uuid", cancellationToken: Cancellation));

            Assert.Null(await sql.ScalarAsync<int>("SELECT NULL::int", cancellationToken: Cancellation));
            Assert.Null(await sql.ScalarAsync<int>("SELECT 1 WHERE false", cancellationToken: Cancellation));
            Assert.Equal(0, await sql.ScalarAsync<int>("SELECT 0", cancellationToken: Cancellation));

            Assert.Null(await sql.ScalarAsync<long>("SELECT NULL::bigint", cancellationToken: Cancellation));
            Assert.Null(await sql.ScalarAsync<long>("SELECT 1::bigint WHERE false", cancellationToken: Cancellation));
            Assert.Equal(0L, await sql.ScalarAsync<long>("SELECT 0::bigint", cancellationToken: Cancellation));

            Assert.Null(await sql.ScalarAsync<DateTimeOffset>("SELECT NULL::timestamptz", cancellationToken: Cancellation));
            Assert.Null(await sql.ScalarAsync<DateTimeOffset>("SELECT now() WHERE false", cancellationToken: Cancellation));
            Assert.Equal(SomeInstant, await sql.ScalarAsync<DateTimeOffset>("SELECT '2026-01-02 03:04:05+00'::timestamptz", cancellationToken: Cancellation));

            Assert.Null(await sql.ScalarRefAsync<string>("SELECT NULL::text", cancellationToken: Cancellation));
            Assert.Null(await sql.ScalarRefAsync<string>("SELECT 'x'::text WHERE false", cancellationToken: Cancellation));
            Assert.Equal(string.Empty, await sql.ScalarRefAsync<string>("SELECT ''::text", cancellationToken: Cancellation));
        }
    }

    [Fact]
    public async Task Pooled_path_carries_no_tenant_context_even_while_a_unit_of_work_is_open()
    {
        const string tenantSetting = "SELECT NULLIF(current_setting('nix.tenant_id', true), '')";
        var pooled = new PooledSql(_dataSource);

        var work = await _fixture.Application.BeginUnitOfWorkAsync(TestTenants.AlphaContext, Cancellation);
        await using (work.ConfigureAwait(false))
        {
            Assert.Equal(
                TestTenants.Alpha.ToString("D"),
                await work.Sql.ScalarRefAsync<string>(tenantSetting, cancellationToken: Cancellation));

            var seen = await pooled.RowsAsync(tenantSetting, static reader => reader.IsDBNull(0) ? null : reader.GetString(0), Cancellation);
            Assert.Equal([(string?)null], seen);
        }
    }
}
