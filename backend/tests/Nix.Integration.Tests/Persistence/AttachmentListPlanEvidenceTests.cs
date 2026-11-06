using System.Globalization;
using System.Text;
using Nix.Features.Attachments;
using Nix.Integration.Tests.Harness;
using Npgsql;
using NpgsqlTypes;

namespace Nix.Integration.Tests.Persistence;

/// <summary>
/// The attachments statement against 5,000 files (2,500 with a second, approved version), planned
/// and executed as the runtime role under row-level security. The plan goes to the test output;
/// the assertions hold that file_version is never read whole and that a page walks file_body in key order.
/// </summary>
[Trait("Category", "PlanEvidence")]
[Collection(PostgresCollectionDefinition.Name)]
public sealed class AttachmentListPlanEvidenceTests(NixPostgresFixture fixture, ITestOutputHelper output) : IAsyncLifetime
{
    private const string SeedFile = "(SELECT n, md5('i' || n)::uuid AS item_id, md5('a' || n)::uuid AS v1, md5('b' || n)::uuid AS v2 FROM generate_series(1, 5000) AS n) AS seed_file";

    public async ValueTask InitializeAsync()
    {
        await fixture.ResetAsync();
        await M0SchemaSeed.SeedBothTenantsAsync(fixture);

        var tenant = $"'{M0SchemaSeed.Alpha.TenantId}'::uuid";
        var workspace = $"'{M0SchemaSeed.Alpha.WorkspaceId}'::uuid";
        var principal = $"'{M0SchemaSeed.Alpha.PrincipalId}'::uuid";
        var sql = $$"""
            INSERT INTO item (id, tenant_id, workspace_id, type, parent_id, seq, properties, lifecycle_state,
                              purge_after, created_by, last_modified_by, created_at, last_modified_at)
            SELECT item_id, {{tenant}}, {{workspace}}, 'file', NULL, 500000 + n,
                   jsonb_build_object('title', 'File ' || n), 'active', NULL, {{principal}}, {{principal}}, now(), now()
            FROM {{SeedFile}};

            INSERT INTO item_closure (descendant_id, ancestor_id, tenant_id, workspace_id, depth)
            SELECT item_id, item_id, {{tenant}}, {{workspace}}, 0 FROM {{SeedFile}};

            INSERT INTO file_version (file_version_id, tenant_id, workspace_id, item_id, version, object_key, file_name,
                                      media_type, byte_length, sha256, previewable, created_by, created_at, state)
            SELECT v1, {{tenant}}, {{workspace}}, item_id, 1, 'files/plan/' || v1, 'f' || n,
                   CASE WHEN n % 5 = 0 THEN 'image/png' ELSE 'application/pdf' END, 4, repeat('d', 64), false,
                   {{principal}}, now(), 'draft'
            FROM {{SeedFile}};

            INSERT INTO file_version (file_version_id, tenant_id, workspace_id, item_id, version, object_key, file_name,
                                      media_type, byte_length, sha256, previewable, created_by, created_at, state)
            SELECT v2, {{tenant}}, {{workspace}}, item_id, 2, 'files/plan/' || v2, 'f' || n,
                   CASE WHEN n % 5 = 0 THEN 'image/png' ELSE 'application/pdf' END, 4, repeat('e', 64), false,
                   {{principal}}, now(), 'approved'
            FROM {{SeedFile}} WHERE n % 2 = 0;

            INSERT INTO file_body (item_id, tenant_id, workspace_id, current_version_id)
            SELECT item_id, {{tenant}}, {{workspace}}, CASE WHEN n % 2 = 0 THEN v2 ELSE v1 END FROM {{SeedFile}};
            """;

        var connection = await fixture.OpenApplicationConnectionAsync();
        await using (connection.ConfigureAwait(false))
        {
            var transaction = await connection.BeginTransactionAsync(TestContext.Current.CancellationToken);
            await using (transaction.ConfigureAwait(false))
            {
                await SetTenantAsync(connection, transaction);
                await RawSql.ExecuteAsync(connection, transaction, sql, commandTimeoutSeconds: 120);
                await transaction.CommitAsync(TestContext.Current.CancellationToken);
            }
        }

        // A bulk load has no statistics yet; autovacuum would have analysed it in production.
        var admin = await fixture.OpenSuperuserConnectionAsync();
        await using (admin.ConfigureAwait(false))
        {
            await RawSql.ExecuteAsync(admin, null, "ANALYZE item; ANALYZE item_closure; ANALYZE file_version; ANALYZE file_body;");
        }
    }

    public ValueTask DisposeAsync() => ValueTask.CompletedTask;

    [Fact]
    public async Task A_page_of_the_newest_files_reads_no_table_whole()
    {
        var plan = await ExplainAsync(approvedOnly: false);
        output.WriteLine("First page, no filter, 5,000 files, runtime role:");
        output.WriteLine(plan);
        var filtered = await ExplainAsync(approvedOnly: true);
        output.WriteLine("First page, state=approved:");
        output.WriteLine(filtered);

        Assert.Contains("actual", plan, StringComparison.Ordinal);
        Assert.DoesNotContain("Seq Scan on file_version", plan, StringComparison.Ordinal);

        // The shared hidden-ancestor predicate may read the closure once (ItemVisibilitySql.NoHiddenAncestor
        // documents that plan); the page itself must stop after its 51 rows, walking file_body in key order.
        Assert.Contains("Index Scan Backward using \"AK_file_body_tenant_id_item_id\"", plan, StringComparison.Ordinal);
    }

    private static async Task SetTenantAsync(NpgsqlConnection connection, NpgsqlTransaction transaction)
    {
        var context = new NpgsqlCommand("SELECT set_config('nix.tenant_id', @tenant, true)", connection, transaction);
        await using (context.ConfigureAwait(false))
        {
            context.Parameters.Add(new NpgsqlParameter("tenant", NpgsqlDbType.Text)
            {
                Value = M0SchemaSeed.Alpha.TenantId.ToString("D", CultureInfo.InvariantCulture),
            });
            await context.ExecuteNonQueryAsync(TestContext.Current.CancellationToken);
        }
    }

    private async Task<string> ExplainAsync(bool approvedOnly)
    {
        var connection = await fixture.OpenApplicationConnectionAsync();
        await using (connection.ConfigureAwait(false))
        {
            var transaction = await connection.BeginTransactionAsync(TestContext.Current.CancellationToken);
            await using (transaction.ConfigureAwait(false))
            {
                await SetTenantAsync(connection, transaction);

#pragma warning disable CA2100 // Justification: the production statement; values reach it only as bound parameters.
                var command = new NpgsqlCommand("EXPLAIN (ANALYZE, BUFFERS) " + ListAttachmentsHandler.Statement, connection, transaction);
#pragma warning restore CA2100
                await using (command.ConfigureAwait(false))
                {
                    command.Parameters.Add(new NpgsqlParameter("tenant_id", NpgsqlDbType.Uuid) { Value = M0SchemaSeed.Alpha.TenantId });
                    command.Parameters.Add(new NpgsqlParameter("workspace_id", NpgsqlDbType.Uuid) { Value = M0SchemaSeed.Alpha.WorkspaceId });
                    command.Parameters.Add(new NpgsqlParameter("after", NpgsqlDbType.Uuid) { Value = DBNull.Value });
                    command.Parameters.Add(new NpgsqlParameter("state", NpgsqlDbType.Text) { Value = approvedOnly ? "approved" : DBNull.Value });
                    command.Parameters.Add(new NpgsqlParameter("include_images", NpgsqlDbType.Boolean) { Value = false });
                    command.Parameters.Add(new NpgsqlParameter("expiring", NpgsqlDbType.Boolean) { Value = false });
                    command.Parameters.Add(new NpgsqlParameter("limit", NpgsqlDbType.Integer) { Value = 51 });
                    command.Parameters.Add(new NpgsqlParameter("closed_lock_ids", NpgsqlDbType.Array | NpgsqlDbType.Uuid) { Value = Array.Empty<Guid>() });

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
}
