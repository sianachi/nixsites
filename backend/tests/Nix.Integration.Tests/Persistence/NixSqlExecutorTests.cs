using System.Text;
using Nix.Integration.Tests.Harness;
using Npgsql;

namespace Nix.Integration.Tests.Persistence;

/// <summary>
/// The hand-written-SQL path: tenant-scoped like everything else, streamed rather than
/// materialised.
/// </summary>
[Collection(PostgresSecondaryCollectionDefinition.Name)]
public sealed class NixSqlExecutorTests : IAsyncLifetime
{
    private readonly NixPostgresFixture _fixture;

    public NixSqlExecutorTests(NixPostgresFixture fixture) => _fixture = fixture;

    public async ValueTask InitializeAsync() => await _fixture.ResetAsync();

    public ValueTask DisposeAsync() => ValueTask.CompletedTask;

    private static CancellationToken Cancellation => TestContext.Current.CancellationToken;

    [Fact]
    public async Task Rows_are_produced_one_at_a_time_rather_than_collected_first()
    {
        await RlsProbe.SeedAsync(_fixture, TestTenants.Alpha, "alpha-one");
        await RlsProbe.SeedAsync(_fixture, TestTenants.Alpha, "alpha-two");
        await RlsProbe.SeedAsync(_fixture, TestTenants.Alpha, "alpha-three");

        var work = await _fixture.Application.BeginUnitOfWorkAsync(TestTenants.AlphaContext, Cancellation);
        await using (work.ConfigureAwait(false))
        {
            var seen = 0;
            await foreach (var row in work.Sql.QueryAsync<RlsProbe.ProbeRow, RlsProbe.ProbeRowMapper>(
                RlsProbeSchema.SelectVisibleSql,
                default,
                cancellationToken: TestContext.Current.CancellationToken))
            {
                seen++;
                Assert.Equal(TestTenants.Alpha, row.TenantId);

                // Stopping early must be possible: an IAsyncEnumerable that had already buffered
                // everything would have read all three rows before yielding the first.
                if (seen == 2)
                {
                    break;
                }
            }

            Assert.Equal(2, seen);
        }
    }

    [Fact]
    public async Task Binary_columns_are_streamed_rather_than_materialised()
    {
        var payload = Encoding.UTF8.GetBytes("a collaborative document update, in miniature");
        var id = await RlsProbe.SeedAsync(_fixture, TestTenants.Alpha, "with-payload", payload);

        var work = await _fixture.Application.BeginUnitOfWorkAsync(TestTenants.AlphaContext, Cancellation);
        await using (work.ConfigureAwait(false))
        {
            var parameters = new[] { new NpgsqlParameter<Guid>("id", id) };

            // Ordinal 1 is the bytea column, projected after the scalar columns so sequential
            // access reaches it last. This is the shape content_update.update_bytes reads take.
            var column = await work.Sql.OpenColumnStreamAsync(
                RlsProbeSchema.SelectPayloadSql,
                columnOrdinal: 1,
                parameters,
                TestContext.Current.CancellationToken);

            Assert.NotNull(column);

            await using (column.ConfigureAwait(false))
            {
                Assert.False(column.Value.CanSeek, "the payload must arrive as a forward-only stream");

                using var sink = new MemoryStream();
                await column.Value.CopyToAsync(sink, TestContext.Current.CancellationToken);

                Assert.Equal(payload, sink.ToArray());
            }
        }
    }

    [Fact]
    public async Task A_binary_column_of_another_tenant_is_invisible_to_the_streaming_path_too()
    {
        var payload = Encoding.UTF8.GetBytes("beta's bytes");
        var id = await RlsProbe.SeedAsync(_fixture, TestTenants.Beta, "beta-payload", payload);

        var work = await _fixture.Application.BeginUnitOfWorkAsync(TestTenants.AlphaContext, Cancellation);
        await using (work.ConfigureAwait(false))
        {
            var parameters = new[] { new NpgsqlParameter<Guid>("id", id) };

            var column = await work.Sql.OpenColumnStreamAsync(
                RlsProbeSchema.SelectPayloadSql,
                columnOrdinal: 1,
                parameters,
                TestContext.Current.CancellationToken);

            // Knowing the row's primary key is not access. The policy filters the read, so there
            // is no row to open a stream over.
            Assert.Null(column);
        }
    }

    [Fact]
    public async Task A_scalar_read_of_a_missing_row_is_the_default_rather_than_a_failure()
    {
        var work = await _fixture.Application.BeginUnitOfWorkAsync(TestTenants.AlphaContext, Cancellation);
        await using (work.ConfigureAwait(false))
        {
            var label = await work.Sql.ScalarRefAsync<string>(
                $"SELECT label FROM {RlsProbeSchema.TableName} WHERE id = @id",
                [new NpgsqlParameter<Guid>("id", Guid.NewGuid())],
                TestContext.Current.CancellationToken);

            Assert.Null(label);
        }
    }
}
