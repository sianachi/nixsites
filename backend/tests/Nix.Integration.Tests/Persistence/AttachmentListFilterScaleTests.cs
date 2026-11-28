using System.Globalization;
using System.Text;
using Nix.Integration.Tests.Harness;
using Nix.Persistence.Attachments;
using Npgsql;
using NpgsqlTypes;

namespace Nix.Integration.Tests.Persistence;

/// <summary>
/// The attachments page's statement on a workspace of 120,000 files, planned and run as the runtime
/// role under row-level security, for the filters that match only a few files.
/// </summary>
[Trait("Category", "PlanEvidence")]
[Collection(PostgresSecondaryCollectionDefinition.Name)]
public sealed class AttachmentListFilterScaleTests : IAsyncLifetime
{
    private const int Files = 120000;
    private static readonly SeedOnce Seeded = new();

    private readonly NixPostgresFixture _fixture;
    private readonly ITestOutputHelper _output;

    public AttachmentListFilterScaleTests(NixPostgresFixture fixture, ITestOutputHelper output)
    {
        _fixture = fixture;
        _output = output;
    }

    public ValueTask InitializeAsync() => new(Seeded.RunAsync(async () =>
    {
        await _fixture.ResetAsync();
        await M0SchemaSeed.SeedBothTenantsAsync(_fixture);
        await SeedCorpusAsync();
    }));

    public ValueTask DisposeAsync() => ValueTask.CompletedTask;

    [Theory]
    [InlineData("in_review")]
    [InlineData("revoked")]
    public async Task A_selective_state_reads_the_state_index_instead_of_resolving_every_file(string state)
    {
        var plan = await ExplainAsync(state, expiring: false, AttachmentStore.Statement);
        var start = AttachmentStore.Statement.IndexOf("AND (@state::text IS NULL OR EXISTS", StringComparison.Ordinal);
        var end = AttachmentStore.Statement.IndexOf("AND (@state::text IS NULL OR shown", StringComparison.Ordinal);
        var before = await ExplainAsync(state, expiring: false, AttachmentStore.Statement.Remove(start, end - start));
        _output.WriteLine("Without the prefilter:");
        _output.WriteLine(before);
        _output.WriteLine($"Attachments, {Files} files, state={state}, runtime role:");
        _output.WriteLine(plan);

        Assert.Contains("ix_file_version_state", plan, StringComparison.Ordinal);
        Assert.DoesNotContain("loops=120000", plan, StringComparison.Ordinal);
    }

    [Fact]
    public async Task The_state_prefilter_returns_the_same_files_as_the_shown_version_check_alone()
    {
        var withoutPrefilter = AttachmentStore.Statement.Replace(
            "wanted.state = @state::text))", "wanted.state = wanted.state))", StringComparison.Ordinal);
        Assert.NotEqual(AttachmentStore.Statement, withoutPrefilter);

        foreach (var state in new[] { "draft", "in_review", "approved", "revoked" })
        {
            var expected = await ListAsync(withoutPrefilter, state, limit: 100000);
            var actual = await ListAsync(AttachmentStore.Statement, state, limit: 100000);
            Assert.NotEmpty(expected);
            Assert.Equal(expected, actual);
        }
    }

    private async Task<List<Guid>> ListAsync(string statement, string state, int limit)
    {
        var connection = await _fixture.OpenApplicationConnectionAsync();
        await using (connection.ConfigureAwait(false))
        {
            var transaction = await connection.BeginTransactionAsync(TestContext.Current.CancellationToken);
            await using (transaction.ConfigureAwait(false))
            {
                var context = new NpgsqlCommand("SELECT set_config('nix.tenant_id', @tenant, true)", connection, transaction);
                await using (context.ConfigureAwait(false))
                {
                    context.Parameters.AddWithValue("tenant", M0SchemaSeed.Alpha.TenantId.ToString("D", CultureInfo.InvariantCulture));
                    await context.ExecuteNonQueryAsync(TestContext.Current.CancellationToken);
                }

#pragma warning disable CA2100 // Justification: the production statement; values reach it only as bound parameters.
                var command = new NpgsqlCommand(statement, connection, transaction);
#pragma warning restore CA2100
                await using (command.ConfigureAwait(false))
                {
                    AddParameters(command, state, expiring: false, limit);
                    var ids = new List<Guid>();
                    var reader = await command.ExecuteReaderAsync(TestContext.Current.CancellationToken);
                    await using (reader.ConfigureAwait(false))
                    {
                        while (await reader.ReadAsync(TestContext.Current.CancellationToken))
                        {
                            ids.Add(reader.GetGuid(0));
                        }
                    }

                    return ids;
                }
            }
        }
    }

    private static void AddParameters(NpgsqlCommand command, string? state, bool expiring, int limit)
    {
        command.Parameters.Add(new NpgsqlParameter("tenant_id", NpgsqlDbType.Uuid) { Value = M0SchemaSeed.Alpha.TenantId });
        command.Parameters.Add(new NpgsqlParameter("workspace_id", NpgsqlDbType.Uuid) { Value = M0SchemaSeed.Alpha.WorkspaceId });
        command.Parameters.Add(new NpgsqlParameter("after", NpgsqlDbType.Uuid) { Value = DBNull.Value });
        command.Parameters.Add(new NpgsqlParameter("state", NpgsqlDbType.Text) { Value = (object?)state ?? DBNull.Value });
        command.Parameters.Add(new NpgsqlParameter("include_images", NpgsqlDbType.Boolean) { Value = true });
        command.Parameters.Add(new NpgsqlParameter("expiring", NpgsqlDbType.Boolean) { Value = expiring });
        command.Parameters.Add(new NpgsqlParameter("limit", NpgsqlDbType.Integer) { Value = limit });
        command.Parameters.Add(new NpgsqlParameter("closed_lock_ids", NpgsqlDbType.Array | NpgsqlDbType.Uuid) { Value = Array.Empty<Guid>() });
    }

    private async Task<string> ExplainAsync(string? state, bool expiring, string statement)
    {
        var connection = await _fixture.OpenApplicationConnectionAsync();
        await using (connection.ConfigureAwait(false))
        {
            var transaction = await connection.BeginTransactionAsync(TestContext.Current.CancellationToken);
            await using (transaction.ConfigureAwait(false))
            {
                var context = new NpgsqlCommand(
                    """
                    SELECT set_config('nix.tenant_id', @tenant, true),
                           set_config('nix.principal_id', @principal, true)
                    """,
                    connection,
                    transaction);
                await using (context.ConfigureAwait(false))
                {
                    context.Parameters.AddWithValue("tenant", M0SchemaSeed.Alpha.TenantId.ToString("D", CultureInfo.InvariantCulture));
                    context.Parameters.AddWithValue("principal", M0SchemaSeed.Alpha.PrincipalId.ToString("D", CultureInfo.InvariantCulture));
                    await context.ExecuteNonQueryAsync(TestContext.Current.CancellationToken);
                }

#pragma warning disable CA2100 // Justification: the statement is the production-owned static SQL constant.
                var command = new NpgsqlCommand("EXPLAIN (ANALYZE, BUFFERS) " + statement, connection, transaction);
#pragma warning restore CA2100
                await using (command.ConfigureAwait(false))
                {
                    AddParameters(command, state, expiring, 51);

                    var plan = new StringBuilder();
                    var reader = await command.ExecuteReaderAsync(TestContext.Current.CancellationToken);
                    await using (reader.ConfigureAwait(false))
                    {
                        while (await reader.ReadAsync(TestContext.Current.CancellationToken))
                        {
                            plan.AppendLine(reader.GetString(0));
                        }
                    }

                    return plan.ToString();
                }
            }
        }
    }

    private async Task SeedCorpusAsync()
    {
        var tenant = $"'{M0SchemaSeed.Alpha.TenantId:D}'::uuid";
        var workspace = $"'{M0SchemaSeed.Alpha.WorkspaceId:D}'::uuid";
        var principal = $"'{M0SchemaSeed.Alpha.PrincipalId:D}'::uuid";
        var root = $"'{M0SchemaSeed.Alpha.ItemId:D}'::uuid";
        var connection = await _fixture.OpenMigratorConnectionAsync();
        await using (connection.ConfigureAwait(false))
        {
            // Pause user triggers during the synthetic attachment load, keeping foreign keys active.
            // The batch restores the triggers atomically before runtime-role queries measure
            // attachment filtering with the complete corpus.
            await RawSql.ExecuteAsync(connection, null, $$"""
                ALTER TABLE item DISABLE TRIGGER USER;
                ALTER TABLE file_version DISABLE TRIGGER USER;
                ALTER TABLE file_body DISABLE TRIGGER USER;

                INSERT INTO item
                    (id, tenant_id, workspace_id, type, parent_id, seq, properties, lifecycle_state,
                     purge_after, created_by, last_modified_by, created_at, last_modified_at)
                SELECT md5('attach-plan-item-' || n)::uuid, {{tenant}}, {{workspace}}, 'file', {{root}},
                       100000 + n,
                       CASE WHEN n % 500 = 0
                            THEN jsonb_build_object('title', 'File ' || n, 'expiry', '2027-03-01', '$expiry_set_by', {{principal}}::text)
                            ELSE jsonb_build_object('title', 'File ' || n) END,
                       'active', NULL, {{principal}}, {{principal}}, now(), now()
                FROM generate_series(1, {{Files}}) n;

                INSERT INTO item_closure (descendant_id, ancestor_id, tenant_id, workspace_id, depth)
                SELECT id, id, tenant_id, workspace_id, 0 FROM item WHERE seq > 100000;
                INSERT INTO item_closure (descendant_id, ancestor_id, tenant_id, workspace_id, depth)
                SELECT id, {{root}}, tenant_id, workspace_id, 1 FROM item WHERE seq > 100000;

                INSERT INTO file_version
                    (file_version_id, tenant_id, workspace_id, item_id, version, object_key, file_name,
                     media_type, byte_length, sha256, previewable, created_by, created_at, state)
                SELECT md5('attach-plan-version-' || i.id || '-' || v)::uuid, {{tenant}}, {{workspace}}, i.id, v,
                       'files/plan/' || i.id || '/' || v, 'f.bin',
                       CASE WHEN i.seq % 5 = 0 THEN 'image/png' ELSE 'application/pdf' END, 10,
                       repeat('d', 64), false, {{principal}}, now(),
                       CASE WHEN v = CASE WHEN i.seq % 10 = 0 THEN 2 ELSE 1 END
                             THEN CASE WHEN i.seq % 200 = 0 THEN 'in_review'
                                       WHEN i.seq % 1000 = 7 THEN 'revoked'
                                       WHEN i.seq % 20 = 1 THEN 'approved'
                                       ELSE 'draft' END
                            ELSE 'draft' END
                FROM item i CROSS JOIN LATERAL generate_series(1, CASE WHEN i.seq % 10 = 0 THEN 2 ELSE 1 END) v
                WHERE i.seq > 100000;

                INSERT INTO file_body (item_id, tenant_id, workspace_id, current_version_id)
                SELECT i.id, {{tenant}}, {{workspace}},
                       md5('attach-plan-version-' || i.id || '-' || CASE WHEN i.seq % 10 = 0 THEN 2 ELSE 1 END)::uuid
                FROM item i
                WHERE i.seq > 100000;

                ALTER TABLE item ENABLE TRIGGER USER;
                ALTER TABLE file_version ENABLE TRIGGER USER;
                ALTER TABLE file_body ENABLE TRIGGER USER;

                ANALYZE item;
                ANALYZE item_closure;
                ANALYZE file_version;
                ANALYZE file_body;
                """, commandTimeoutSeconds: 600);

            Assert.Equal(0, await RawSql.CountAsync(connection, null, """
                SELECT count(*) FROM pg_trigger
                WHERE tgrelid IN ('item'::regclass, 'file_version'::regclass, 'file_body'::regclass)
                  AND NOT tgisinternal AND tgenabled = 'D'
                """));
            Assert.Equal(Files, await RawSql.CountAsync(connection, null, $$"""
                SELECT count(*) FROM item WHERE tenant_id = {{tenant}} AND seq > 100000
                """));
            Assert.Equal(Files, await RawSql.CountAsync(connection, null, $$"""
                SELECT count(*) FROM file_body body JOIN item ON item.id = body.item_id
                WHERE item.tenant_id = {{tenant}} AND item.seq > 100000
                """));
            Assert.Equal(Files + Files / 10, await RawSql.CountAsync(connection, null, $$"""
                SELECT count(*) FROM file_version version JOIN item ON item.id = version.item_id
                WHERE item.tenant_id = {{tenant}} AND item.seq > 100000
                """));
        }
    }
}
