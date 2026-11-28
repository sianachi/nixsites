using System.Data;
using System.Data.Common;
using System.Globalization;
using System.Text;
using System.Text.RegularExpressions;
using Microsoft.AspNetCore.Http;
using Microsoft.EntityFrameworkCore.Diagnostics;
using Nix.Abstractions;
using Nix.Abstractions.Workers;
using Nix.Authentication;
using Nix.Domain.Identity;
using Nix.Domain.Items;
using Nix.Domain.Tenancy;
using Nix.Integration.Tests.Harness;
using Nix.Persistence;
using Npgsql;
using NpgsqlTypes;

namespace Nix.Integration.Tests.Persistence;

/// <summary>
/// Plan evidence for the lifecycle-derived visibility check on every point item read.
/// </summary>
/// <remarks>
/// The corpus combines 3,200 ordinary rows per tenant with a 64-level path. The point read must
/// find the item by primary key, walk that descendant's closure range, and probe its ancestors by
/// index while row-level security is active. A sequential closure scan here would put the size of
/// the workspace on every editor open and collaboration authorization handshake. The test
/// intercepts the real <see cref="IItemTree.FindAsync"/> command and explains it on the same
/// runtime-role connection and transaction, so changes to EF filters or projection cannot drift
/// away from the evidence.
/// </remarks>
[Trait("Category", "PlanEvidence")]
[Collection(PostgresCollectionDefinition.Name)]
public sealed class ItemVisibilityPlanEvidenceTests : IAsyncLifetime
{
    private const int CorpusSizePerTenant = 3200;
    private const int ChainDepth = 64;

    private readonly NixPostgresFixture _fixture;
    private readonly ITestOutputHelper _output;

    public ItemVisibilityPlanEvidenceTests(NixPostgresFixture fixture, ITestOutputHelper output)
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
    public async Task A_deep_visible_item_uses_the_descendant_and_ancestor_indexes_as_the_runtime_role()
    {
        var planCapture = new ExplainQueryInterceptor("ItemTree.FindAsync");
        var application = NixPersistenceHost.Create(
            _fixture.ApplicationConnectionString,
            planCapture);
        await using (application.ConfigureAwait(false))
        {
            var work = await application.BeginUnitOfWorkAsync(
                TestTenants.AlphaContext,
                TestContext.Current.CancellationToken);
            await using (work.ConfigureAwait(false))
            {
                var item = await work.Resolve<IItemTree>().FindAsync(
                    ItemId.From(ChainItem(ChainDepth)),
                    TestContext.Current.CancellationToken);

                Assert.NotNull(item);

                var text = Assert.IsType<string>(planCapture.Plan);
                _output.WriteLine(
                    "Visible point read, {0} rows per tenant and depth {1}, runtime role:",
                    CorpusSizePerTenant,
                    ChainDepth);
                _output.WriteLine(text);

                Assert.Contains("CTE path", text, StringComparison.Ordinal);
                Assert.Matches(
                    new Regex(
                        "Bitmap Index Scan on \"IX_item_closure_tenant_id_descendant_id\""
                        + "[^\\r\\n]*rows=65 loops=1",
                        RegexOptions.CultureInvariant),
                    text);
                Assert.Matches(
                    new Regex(
                        "Bitmap Heap Scan on item_closure edge[^\\r\\n]*rows=64 loops=1",
                        RegexOptions.CultureInvariant),
                    text);
                Assert.Matches(
                    new Regex(
                        "Index Scan using \"AK_item_tenant_id_id\" on item ancestor"
                        + "[^\\r\\n]*loops=64",
                        RegexOptions.CultureInvariant),
                    text);
                Assert.Matches(
                    new Regex(
                        "Index Scan using \"AK_item_tenant_id_id\" on item subject"
                        + "[^\\r\\n]*rows=1 loops=1",
                        RegexOptions.CultureInvariant),
                    text);
                Assert.DoesNotContain("never executed", text, StringComparison.Ordinal);
                Assert.DoesNotContain("Seq Scan on item_closure", text, StringComparison.Ordinal);
                Assert.DoesNotContain("Seq Scan on item", text, StringComparison.Ordinal);
                Assert.Contains("actual", text, StringComparison.Ordinal);
            }
        }
    }

    [Fact]
    public async Task Export_subtree_delegation_uses_point_indexes_as_the_runtime_role()
    {
        var planCapture = new ExplainQueryInterceptor(
            "WorkerExportDelegationPolicy.AuthorizesTargetAsync");
        var application = NixPersistenceHost.Create(
            _fixture.ApplicationConnectionString,
            planCapture);
        await using (application.ConfigureAwait(false))
        {
            var work = await application.BeginUnitOfWorkAsync(
                TestTenants.AlphaContext,
                TestContext.Current.CancellationToken);
            await using (work.ConfigureAwait(false))
            {
                var target = ChainItem(ChainDepth);
                var http = new DefaultHttpContext();
                http.Request.Method = HttpMethods.Get;
                http.Request.Path = $"/api/v1/items/{target:D}";
                var token = new ValidatedWorkerExecutionToken(
                    TenantId.From(TestTenants.Alpha),
                    PrincipalId.From(TestTenants.AlphaPrincipal),
                    Guid.NewGuid(),
                    M0SchemaSeed.Alpha.ItemId,
                    TestTenants.AlphaWorkspace,
                    "subtree",
                    "plan-evidence");
                var execution = new WorkerExecutionAuthorization(
                    TestTenants.Alpha,
                    TestTenants.AlphaWorkspace,
                    TestTenants.AlphaPrincipal,
                    "export.pdf");

                var authorized = await WorkerExportDelegationPolicy.AuthorizesTargetAsync(
                    http.Request,
                    token,
                    execution,
                    work.Resolve<NixDbContext>(),
                    TestContext.Current.CancellationToken);

                Assert.True(authorized);
                var text = Assert.IsType<string>(planCapture.Plan);
                _output.WriteLine(
                    "Export subtree authorization, {0} rows per tenant and depth {1}, runtime role:",
                    CorpusSizePerTenant,
                    ChainDepth);
                _output.WriteLine(text);
                Assert.Contains("Index Scan using \"PK_item_closure\"", text, StringComparison.Ordinal);
                Assert.Contains(
                    "Index Scan using \"AK_item_tenant_id_id\"",
                    text,
                    StringComparison.Ordinal);
                Assert.DoesNotContain("Seq Scan on item_closure", text, StringComparison.Ordinal);
                Assert.DoesNotContain("Seq Scan on item", text, StringComparison.Ordinal);
                Assert.Contains("actual", text, StringComparison.Ordinal);
                Assert.Contains("Buffers:", text, StringComparison.Ordinal);
            }
        }
    }

    private async Task SeedCorpusAsync()
    {
        var alphaTenant = RawSql.Literal(M0SchemaSeed.Alpha.TenantId);
        var alphaWorkspace = RawSql.Literal(M0SchemaSeed.Alpha.WorkspaceId);
        var alphaPrincipal = RawSql.Literal(M0SchemaSeed.Alpha.PrincipalId);
        var alphaRoot = RawSql.Literal(M0SchemaSeed.Alpha.ItemId);
        var betaTenant = RawSql.Literal(M0SchemaSeed.Beta.TenantId);
        var betaWorkspace = RawSql.Literal(M0SchemaSeed.Beta.WorkspaceId);
        var betaPrincipal = RawSql.Literal(M0SchemaSeed.Beta.PrincipalId);

        var sql = $$"""
            INSERT INTO item
                (id, tenant_id, workspace_id, type, parent_id, seq, properties, lifecycle_state,
                 purge_after, created_by, last_modified_by, created_at, last_modified_at)
            SELECT gen_random_uuid(), {{alphaTenant}}, {{alphaWorkspace}}, 'note', {{alphaRoot}},
                   100000 + n,
                   jsonb_build_object('title', 'Alpha bulk ' || n), 'active', NULL,
                   {{alphaPrincipal}}, {{alphaPrincipal}}, now(), now()
            FROM generate_series(1, {{CorpusSizePerTenant}}) AS n;

            INSERT INTO item
                (id, tenant_id, workspace_id, type, parent_id, seq, properties, lifecycle_state,
                 purge_after, created_by, last_modified_by, created_at, last_modified_at)
            SELECT gen_random_uuid(), {{betaTenant}}, {{betaWorkspace}}, 'note', NULL, 100000 + n,
                   jsonb_build_object('title', 'Beta bulk ' || n), 'active', NULL,
                   {{betaPrincipal}}, {{betaPrincipal}}, now(), now()
            FROM generate_series(1, {{CorpusSizePerTenant}}) AS n;

            INSERT INTO item
                (id, tenant_id, workspace_id, type, parent_id, seq, properties, lifecycle_state,
                 purge_after, created_by, last_modified_by, created_at, last_modified_at)
            SELECT ('aaaaaaaa-aaaa-4aaa-8aaa-' || lpad(n::text, 12, '0'))::uuid,
                   {{alphaTenant}},
                   {{alphaWorkspace}},
                   'note',
                   CASE WHEN n = 1
                        THEN {{alphaRoot}}
                        ELSE ('aaaaaaaa-aaaa-4aaa-8aaa-' || lpad((n - 1)::text, 12, '0'))::uuid
                   END,
                   200000 + n,
                   jsonb_build_object('title', 'Chain ' || n),
                   'active',
                   NULL,
                   {{alphaPrincipal}},
                   {{alphaPrincipal}},
                   now(),
                   now()
            FROM generate_series(1, {{ChainDepth}}) AS n;

            INSERT INTO item_closure (descendant_id, ancestor_id, tenant_id, workspace_id, depth)
            SELECT id, id, tenant_id, workspace_id, 0
            FROM item
            WHERE seq >= 100000;

            INSERT INTO item_closure (descendant_id, ancestor_id, tenant_id, workspace_id, depth)
            SELECT id, {{alphaRoot}}, tenant_id, workspace_id, 1
            FROM item
            WHERE tenant_id = {{alphaTenant}}
              AND seq >= 100000
              AND seq < 200000;

            WITH RECURSIVE chain AS (
                SELECT child.id AS descendant_id,
                       parent.id AS ancestor_id,
                       1 AS depth
                FROM item AS child
                JOIN item AS parent
                  ON parent.tenant_id = child.tenant_id
                 AND parent.id = child.parent_id
                WHERE child.tenant_id = {{alphaTenant}}
                  AND child.seq >= 200000

                UNION ALL

                SELECT chain.descendant_id,
                       parent.id AS ancestor_id,
                       chain.depth + 1
                FROM chain
                JOIN item AS current
                  ON current.tenant_id = {{alphaTenant}}
                 AND current.id = chain.ancestor_id
                JOIN item AS parent
                  ON parent.tenant_id = current.tenant_id
                 AND parent.id = current.parent_id
            )
            INSERT INTO item_closure (descendant_id, ancestor_id, tenant_id, workspace_id, depth)
            SELECT descendant_id, ancestor_id, {{alphaTenant}}, {{alphaWorkspace}}, depth
            FROM chain;

            ANALYZE item;
            ANALYZE item_closure;
            """;

        var connection = await _fixture.OpenMigratorConnectionAsync();
        await using (connection.ConfigureAwait(false))
        {
            await RawSql.ExecuteAsync(connection, transaction: null, sql);
        }
    }

    private static Guid ChainItem(int depth) =>
        Guid.Parse($"aaaaaaaa-aaaa-4aaa-8aaa-{depth.ToString("D12", CultureInfo.InvariantCulture)}");

    private sealed class ExplainQueryInterceptor(string marker) : DbCommandInterceptor
    {
        public string? Plan { get; private set; }

        public override async ValueTask<InterceptionResult<DbDataReader>> ReaderExecutingAsync(
            DbCommand command,
            CommandEventData eventData,
            InterceptionResult<DbDataReader> result,
            CancellationToken cancellationToken = default)
        {
            ArgumentNullException.ThrowIfNull(command);

            if (Plan is null
                && command.CommandText.Contains(marker, StringComparison.Ordinal))
            {
                Plan = await ExplainAsync(command, cancellationToken);
            }

            return await base.ReaderExecutingAsync(
                command,
                eventData,
                result,
                cancellationToken);
        }

        private static async Task<string> ExplainAsync(
            DbCommand command,
            CancellationToken cancellationToken)
        {
            if (command.Connection is not NpgsqlConnection connection
                || command.Transaction is not NpgsqlTransaction transaction)
            {
                throw new InvalidOperationException(
                    "The captured production query must use the Npgsql runtime-role transaction.");
            }

            // Justification: the statement is the exact parameterized command generated by EF Core for
            // ItemTree.FindAsync, selected by a fixed TagWith marker; no caller-controlled text is added.
#pragma warning disable CA2100 // Review SQL queries for security vulnerabilities
            var explain = new NpgsqlCommand(
                "EXPLAIN (ANALYZE, BUFFERS) " + command.CommandText,
                connection,
                transaction);
#pragma warning restore CA2100 // Review SQL queries for security vulnerabilities
            await using (explain.ConfigureAwait(false))
            {
                foreach (DbParameter parameter in command.Parameters)
                {
                    if (parameter is not NpgsqlParameter source)
                    {
                        throw new InvalidOperationException(
                            "The captured production query contained a non-Npgsql parameter.");
                    }

                    explain.Parameters.Add(Copy(source));
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

        private static NpgsqlParameter Copy(NpgsqlParameter source)
        {
            var copy = new NpgsqlParameter
            {
                ParameterName = source.ParameterName,
                Direction = source.Direction,
                IsNullable = source.IsNullable,
                Size = source.Size,
                Precision = source.Precision,
                Scale = source.Scale,
                Value = source.Value,
            };

            if (source.NpgsqlDbType != NpgsqlDbType.Unknown)
            {
                copy.NpgsqlDbType = source.NpgsqlDbType;
            }
            else
            {
                copy.DbType = source.DbType;
            }

            return copy;
        }
    }
}
