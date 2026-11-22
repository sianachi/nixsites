using System.Data.Common;
using System.Globalization;
using System.Text;
using Microsoft.EntityFrameworkCore.Diagnostics;
using Nix.Abstractions;
using Nix.Domain.Tenancy;
using Nix.Integration.Tests.Harness;
using Nix.Persistence;
using Nix.Persistence.Sql.Statements;
using Npgsql;
using NpgsqlTypes;

namespace Nix.Integration.Tests.Persistence;

/// <summary>
/// Plan evidence for the Trash page and the workspace list's storage total, planned as the
/// runtime role under row-level security on a corpus where the rows they want are a small part of
/// what the tenant holds.
/// </summary>
/// <remarks>
/// The Trash query is the real <see cref="IItemTree.ListDeletedAsync"/> command, captured from EF
/// Core and explained on its own connection and transaction, so how EF sends the lifecycle state
/// (literal or parameter) is part of the evidence: a partial index only serves a query the planner
/// can prove implies its predicate.
/// </remarks>
[Trait("Category", "PlanEvidence")]
[Collection(PostgresCollectionDefinition.Name)]
public sealed class TrashAndQuotaPlanEvidenceTests : IAsyncLifetime
{
    private const int ActiveItems = 60000;
    private const int DeletedItems = 600;
    private const int FileVersions = 60000;

    private readonly NixPostgresFixture _fixture;
    private readonly ITestOutputHelper _output;

    public TrashAndQuotaPlanEvidenceTests(NixPostgresFixture fixture, ITestOutputHelper output)
    {
        _fixture = fixture;
        _output = output;
    }

    public async ValueTask InitializeAsync()
    {
        await _fixture.ResetAsync();
        await M0SchemaSeed.SeedBothTenantsAsync(_fixture);
        await SeedCorpusAsync();
    }

    public ValueTask DisposeAsync() => ValueTask.CompletedTask;

    [Fact]
    public async Task The_trash_page_reads_the_partial_index_as_the_runtime_role()
    {
        var capture = new ExplainInterceptor(sql => sql.Contains("ORDER BY", StringComparison.Ordinal)
            && sql.Contains("last_modified_at", StringComparison.Ordinal)
            && sql.Contains("lifecycle_state", StringComparison.Ordinal));
        var application = NixPersistenceHost.Create(_fixture.ApplicationConnectionString, capture);
        await using (application.ConfigureAwait(false))
        {
            var work = await application.BeginUnitOfWorkAsync(
                TestTenants.AlphaContext,
                TestContext.Current.CancellationToken);
            await using (work.ConfigureAwait(false))
            {
                var page = await work.Resolve<IItemTree>().ListDeletedAsync(
                    WorkspaceId.From(TestTenants.AlphaWorkspace),
                    null,
                    null,
                    51,
                    TestContext.Current.CancellationToken);

                Assert.Equal(51, page.Count);
                var plan = Assert.IsType<string>(capture.Plan);
                _output.WriteLine("Trash page, {0} items ({1} deleted), runtime role:", ActiveItems + DeletedItems, DeletedItems);
                _output.WriteLine(capture.CommandText ?? string.Empty);
                _output.WriteLine(plan);

                Assert.Contains("ix_item_trash", plan, StringComparison.Ordinal);
                Assert.DoesNotContain("Seq Scan on item", plan, StringComparison.Ordinal);
                Assert.DoesNotContain("Sort", plan, StringComparison.Ordinal);
            }
        }
    }

    [Fact]
    public async Task The_workspace_storage_total_reads_the_covering_index_as_the_runtime_role()
    {
        var plan = await ExplainAsync(
            WorkspaceAdministrationSql.Detail,
            [Uuid("workspace_id", TestTenants.AlphaWorkspace)]);
        _output.WriteLine("Workspace detail storage total, {0} file versions, runtime role:", FileVersions);
        _output.WriteLine(plan);

        Assert.Contains("ix_file_version_workspace_bytes", plan, StringComparison.Ordinal);
        Assert.DoesNotContain("Seq Scan on file_version", plan, StringComparison.Ordinal);

        var list = await ExplainAsync(
            WorkspaceAdministrationSql.List,
            [TimestampNull("after_created_at"), UuidNull("after_id"), Integer("limit", 51)]);
        _output.WriteLine("Workspace list storage total, runtime role:");
        _output.WriteLine(list);
        Assert.Contains("ix_file_version_workspace_bytes", list, StringComparison.Ordinal);
        Assert.DoesNotContain("Seq Scan on file_version", list, StringComparison.Ordinal);
    }

    private async Task<string> ExplainAsync(string sql, IReadOnlyList<NpgsqlParameter> parameters)
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
                    context.Parameters.Add(Text("tenant", M0SchemaSeed.Alpha.TenantId.ToString("D", CultureInfo.InvariantCulture)));
                    context.Parameters.Add(Text("principal", M0SchemaSeed.Alpha.PrincipalId.ToString("D", CultureInfo.InvariantCulture)));
                    await context.ExecuteNonQueryAsync(TestContext.Current.CancellationToken);
                }

#pragma warning disable CA2100 // Justification: every statement is a production-owned static SQL constant.
                var command = new NpgsqlCommand("EXPLAIN (ANALYZE, BUFFERS) " + sql, connection, transaction);
#pragma warning restore CA2100
                await using (command.ConfigureAwait(false))
                {
                    command.Parameters.Add(Uuid("tenant_id", M0SchemaSeed.Alpha.TenantId));
                    command.Parameters.Add(Uuid("principal_id", M0SchemaSeed.Alpha.PrincipalId));
                    foreach (var parameter in parameters)
                    {
                        command.Parameters.Add(parameter);
                    }

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
        var tenant = RawSql.Literal(M0SchemaSeed.Alpha.TenantId);
        var workspace = RawSql.Literal(M0SchemaSeed.Alpha.WorkspaceId);
        var principal = RawSql.Literal(M0SchemaSeed.Alpha.PrincipalId);
        var connection = await _fixture.OpenMigratorConnectionAsync();
        await using (connection.ConfigureAwait(false))
        {
            await RawSql.ExecuteAsync(connection, null, $$"""
                -- Four more workspaces, so the indexes hold rows that are not the caller's.
                INSERT INTO workspace
                    (workspace_id, tenant_id, name, version_retention_days,
                     coalesce_window_min, storage_quota_bytes, created_at)
                SELECT md5('trash-quota-workspace-' || n)::uuid, {{tenant}}, 'Other ' || n,
                       90, 10, 10737418240, now()
                FROM generate_series(1, 4) n;

                INSERT INTO item
                    (id, tenant_id, workspace_id, type, parent_id, seq, properties, lifecycle_state,
                     purge_after, created_by, last_modified_by, created_at, last_modified_at)
                SELECT md5('trash-quota-item-' || n)::uuid, {{tenant}},
                       CASE WHEN n % 5 = 0 THEN md5('trash-quota-workspace-' || (n % 4 + 1))::uuid
                            ELSE {{workspace}} END,
                       'file', NULL, 100000 + n, jsonb_build_object('title', 'File ' || n),
                       CASE WHEN n <= {{DeletedItems}} * 5 / 4 AND n % 5 <> 0 THEN 'deleted' ELSE 'active' END,
                       NULL, {{principal}}, {{principal}}, now(),
                       now() - (n || ' seconds')::interval
                FROM generate_series(1, {{ActiveItems + DeletedItems}}) n;

                INSERT INTO file_version
                    (file_version_id, tenant_id, workspace_id, item_id, version, object_key, file_name,
                     media_type, byte_length, sha256, previewable, created_by, created_at)
                SELECT md5('trash-quota-version-' || i.id)::uuid, i.tenant_id, i.workspace_id, i.id, 1,
                       'files/plan/' || i.id, 'f.bin', 'application/octet-stream', 1000 + i.seq % 97,
                       repeat('d', 64), false, {{principal}}, now()
                FROM item i
                WHERE i.seq >= 100000 AND i.seq < 100000 + {{FileVersions}};

                ANALYZE item;
                ANALYZE file_version;
                """, commandTimeoutSeconds: 300);

        }
    }

    private static NpgsqlParameter Uuid(string name, Guid value) => new(name, NpgsqlDbType.Uuid) { Value = value };

    private static NpgsqlParameter UuidNull(string name) => new(name, NpgsqlDbType.Uuid) { Value = DBNull.Value };

    private static NpgsqlParameter TimestampNull(string name) => new(name, NpgsqlDbType.TimestampTz) { Value = DBNull.Value };

    private static NpgsqlParameter Integer(string name, int value) => new(name, NpgsqlDbType.Integer) { Value = value };

    private static NpgsqlParameter Text(string name, string value) => new(name, NpgsqlDbType.Text) { Value = value };

    private sealed class ExplainInterceptor(Func<string, bool> matches) : DbCommandInterceptor
    {
        public string? Plan { get; private set; }

        public string? CommandText { get; private set; }

        public override async ValueTask<InterceptionResult<DbDataReader>> ReaderExecutingAsync(
            DbCommand command,
            CommandEventData eventData,
            InterceptionResult<DbDataReader> result,
            CancellationToken cancellationToken = default)
        {
            ArgumentNullException.ThrowIfNull(command);

            if (Plan is null && matches(command.CommandText))
            {
                CommandText = command.CommandText;
                Plan = await ExplainAsync(command, cancellationToken);
            }

            return await base.ReaderExecutingAsync(command, eventData, result, cancellationToken);
        }

        private static async Task<string> ExplainAsync(DbCommand command, CancellationToken cancellationToken)
        {
            if (command.Connection is not NpgsqlConnection connection
                || command.Transaction is not NpgsqlTransaction transaction)
            {
                throw new InvalidOperationException(
                    "The captured production query must use the Npgsql runtime-role transaction.");
            }

            // Justification: the statement is the exact parameterized command EF Core generated for
            // the production query, chosen by a fixed predicate; no caller-controlled text is added.
#pragma warning disable CA2100 // Review SQL queries for security vulnerabilities
            var explain = new NpgsqlCommand("EXPLAIN (ANALYZE, BUFFERS) " + command.CommandText, connection, transaction);
#pragma warning restore CA2100
            await using (explain.ConfigureAwait(false))
            {
                foreach (DbParameter parameter in command.Parameters)
                {
                    var source = (NpgsqlParameter)parameter;
                    var copy = new NpgsqlParameter
                    {
                        ParameterName = source.ParameterName,
                        Value = source.Value,
                        Size = source.Size,
                    };
                    if (source.NpgsqlDbType != NpgsqlDbType.Unknown)
                    {
                        copy.NpgsqlDbType = source.NpgsqlDbType;
                    }
                    else
                    {
                        copy.DbType = source.DbType;
                    }

                    explain.Parameters.Add(copy);
                }

                var plan = new StringBuilder();
                var reader = await explain.ExecuteReaderAsync(cancellationToken);
                await using (reader.ConfigureAwait(false))
                {
                    while (await reader.ReadAsync(cancellationToken))
                    {
                        plan.AppendLine(reader.GetString(0));
                    }
                }

                return plan.ToString();
            }
        }
    }
}
