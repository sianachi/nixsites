using System.Globalization;
using Microsoft.EntityFrameworkCore;
using Microsoft.EntityFrameworkCore.Storage;
using Nix.Abstractions;
using Nix.Domain.Audit;
using Nix.Domain.Identity;
using Nix.Domain.Tenancy;
using Nix.Integration.Tests.Harness;
using Nix.Persistence;
using Npgsql;

namespace Nix.Integration.Tests.Persistence;

/// <summary>
/// Every table of the M0 schema isolates tenants, proved table by table against a real Postgres
/// holding two tenants' rows.
/// </summary>
/// <remarks>
/// <para>
/// The probe table proves the mechanism; this class proves the schema actually uses it. Those are
/// different claims, and the gap between them is exactly where a table added without a policy
/// would hide.
/// </para>
/// <para>
/// The theories run over <see cref="NixTables.TenantScoped"/> rather than over a list written
/// here. A separate test exhaustively classifies every database table as tenant-scoped or
/// capability-only, and the capability class proves forced RLS and no ambient access. Together they
/// mean a new table cannot be added without a checked security boundary - a list
/// maintained by hand next to the tables it describes would drift silently, which is the failure
/// this pair exists to prevent.
/// </para>
/// </remarks>
[Collection(PostgresSecondaryCollectionDefinition.Name)]
public sealed class M0SchemaIsolationTests : IAsyncLifetime
{
    private readonly NixPostgresFixture _fixture;

    public M0SchemaIsolationTests(NixPostgresFixture fixture) => _fixture = fixture;

    /// <summary>Every tenant-scoped table, for assertions made as the schema owner.</summary>
    public static TheoryData<string> TenantScopedTables
    {
        get
        {
            var tables = new TheoryData<string>();
            foreach (var table in NixTables.TenantScoped)
            {
                tables.Add(table);
            }

            return tables;
        }
    }

    /// <summary>
    /// The tenant-scoped tables the runtime role may read, for assertions made as that role.
    /// </summary>
    /// <remarks>
    /// <c>audit_event</c> is absent because the runtime role holds only INSERT on it, so a
    /// select-based isolation check would fail on the privilege before it ever reached the policy
    /// and would prove nothing either way. Its isolation is asserted through the one privilege it
    /// does have, in
    /// <see cref="A_tenant_cannot_insert_an_audit_event_belonging_to_another_tenant"/>.
    /// </remarks>
    public static TheoryData<string> RuntimeReadableTenantScopedTables
    {
        get
        {
            var tables = new TheoryData<string>();
            foreach (var table in NixTables.TenantScoped)
            {
                if (!string.Equals(table, NixTables.AuditEvent, StringComparison.Ordinal))
                {
                    tables.Add(table);
                }
            }

            return tables;
        }
    }

    /// <summary>The explicitly capability-only tables; identity is derived only through exact secret lookups.</summary>
    public static TheoryData<string> CapabilityOnlyTables
    {
        get
        {
            var tables = new TheoryData<string>();
            foreach (var table in NixTables.CapabilityOnly)
            {
                tables.Add(table);
            }

            return tables;
        }
    }

    private static CancellationToken Cancellation => TestContext.Current.CancellationToken;

    private static readonly SeedOnce Seeded = new();

    public ValueTask InitializeAsync() => new(Seeded.RunAsync(async () =>
    {
        await _fixture.ResetAsync();
        await M0SchemaSeed.SeedBothTenantsAsync(_fixture);
        await M0SchemaSeed.SeedItemLocksAsync(_fixture);
        await M0SchemaSeed.SeedContentVersionsAsync(_fixture);
        await M0SchemaSeed.SeedCurrentSchemaRowsAsync(_fixture);
        await M0SchemaSeed.SeedSitesAsync(_fixture);
    }));

    public ValueTask DisposeAsync() => ValueTask.CompletedTask;

    [Theory]
    [MemberData(nameof(RuntimeReadableTenantScopedTables))]
    public async Task Each_tenant_scoped_table_shows_a_tenant_only_its_own_row(string table)
    {
        // Every table is seeded for both tenants. Some tables, such as the durable outbox, grow as
        // a consequence of seeding other rows, so isolation must not depend on an exact row count.
        var alphaRows = await ReadVisibleTenantIdsAsync(table, TestTenants.AlphaContext);
        var betaRows = await ReadVisibleTenantIdsAsync(table, TestTenants.BetaContext);

        Assert.NotEmpty(alphaRows);
        Assert.NotEmpty(betaRows);
        Assert.All(alphaRows, tenantId => Assert.Equal(TestTenants.Alpha, tenantId));
        Assert.All(betaRows, tenantId => Assert.Equal(TestTenants.Beta, tenantId));
    }

    [Theory]
    [MemberData(nameof(RuntimeReadableTenantScopedTables))]
    public async Task Each_tenant_scoped_table_hides_every_row_from_a_session_with_no_tenant(string table)
    {
        // current_setting(..., true) yields NULL when unset, the comparison yields NULL, and no
        // row qualifies. An unscoped session must see nothing rather than everything.
        var connection = await _fixture.OpenApplicationConnectionAsync();
        await using (connection.ConfigureAwait(false))
        {
            var visible = await RawSql.CountAsync(connection, transaction: null, $"SELECT count(*) FROM {table}");
            Assert.Equal(0, visible);
        }
    }

    [Theory]
    [MemberData(nameof(TenantScopedTables))]
    public async Task Each_tenant_scoped_table_carries_a_policy_with_both_using_and_with_check(string table)
    {
        // Read from the catalogue rather than from the migration that was supposed to have
        // written it. USING alone would hide the other tenant's rows on read while still
        // permitting an insert that plants a row under their id.
        var connection = await _fixture.OpenMigratorConnectionAsync();
        await using (connection.ConfigureAwait(false))
        {
            var policies = await RawSql.TextListAsync(
                connection,
                $"""
                SELECT coalesce(qual, '(none)') || ' | ' || coalesce(with_check, '(none)')
                FROM pg_policies
                WHERE schemaname = 'public' AND tablename = '{table}'
                """);

            var policy = Assert.Single(policies);
            Assert.DoesNotContain("(none)", policy, StringComparison.Ordinal);

            // Both halves must consult the session setting; a policy that hard-coded a tenant or
            // compared the column to itself would still be two non-null expressions.
            var mentions = policy.Split("nix.tenant_id", StringSplitOptions.None).Length - 1;
            Assert.Equal(2, mentions);
        }
    }

    [Fact]
    public async Task The_security_classification_names_every_table_the_database_actually_has()
    {
        var connection = await _fixture.OpenMigratorConnectionAsync();
        await using (connection.ConfigureAwait(false))
        {
            var actual = await RawSql.TextListAsync(
                connection,
                """
                SELECT c.relname
                FROM pg_class c
                JOIN pg_namespace n ON n.oid = c.relnamespace
                WHERE n.nspname = 'public'
                  AND c.relkind = 'r'
                  AND c.relname NOT LIKE '\_\_%'
                  AND c.relname <> 'rls_probe'
                ORDER BY c.relname
                """);

            Assert.Empty(NixTables.TenantScoped.Intersect(NixTables.CapabilityOnly, StringComparer.Ordinal));
            var classified = NixTables.TenantScoped.Concat(NixTables.CapabilityOnly).ToArray();
            Assert.Equal(classified.Length, classified.Distinct(StringComparer.Ordinal).Count());
            Assert.Equal(classified.Order(StringComparer.Ordinal), actual);
        }
    }

    [Theory]
    [MemberData(nameof(CapabilityOnlyTables))]
    public async Task Each_capability_only_table_forces_RLS_with_no_policies_or_ambient_grants(string table)
    {
        var connection = await _fixture.OpenMigratorConnectionAsync();
        await using (connection.ConfigureAwait(false))
        {
            Assert.Equal(1, await RawSql.CountAsync(connection, null, $"""
                SELECT count(*) FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace
                 WHERE n.nspname = 'public' AND c.relname = '{table}' AND c.relrowsecurity AND c.relforcerowsecurity
                """));
            Assert.Equal(0, await RawSql.CountAsync(connection, null, $"SELECT count(*) FROM pg_policies WHERE schemaname = 'public' AND tablename = '{table}'"));
            var grants = await RawSql.TextListAsync(connection, $"""
                SELECT grantee || ':' || privilege_type FROM information_schema.table_privileges
                 WHERE table_schema = 'public' AND table_name = '{table}'
                   AND grantee IN ('PUBLIC', 'nix_app', 'nix_collab') ORDER BY grantee, privilege_type
                """);
            Assert.Empty(grants);
            Assert.Empty(NixTables.ExpectedApplicationPrivileges[table]);
        }
    }

    [Theory]
    [MemberData(nameof(CapabilityOnlyTables))]
    public async Task Each_capability_only_table_refuses_direct_access_even_inside_an_active_tenant(string table)
    {
        foreach (var actor in new[] { TestTenants.AlphaContext, TestTenants.BetaContext })
        {
            var work = await _fixture.Application.BeginUnitOfWorkAsync(actor, Cancellation);
            await using (work.ConfigureAwait(false))
            {
                var connection = (NpgsqlConnection)work.DbContext.Database.GetDbConnection();
                var transaction = (NpgsqlTransaction)work.Transaction.GetDbTransaction();
                var failure = await Assert.ThrowsAsync<PostgresException>(() => RawSql.CountAsync(connection, transaction, $"SELECT count(*) FROM {table}"));
                Assert.Equal(PostgresErrorCodes.InsufficientPrivilege, failure.SqlState);
            }
        }

        var anonymous = await _fixture.OpenApplicationConnectionAsync();
        await using (anonymous.ConfigureAwait(false))
        {
            var failure = await Assert.ThrowsAsync<PostgresException>(() => RawSql.CountAsync(anonymous, null, $"SELECT count(*) FROM {table}"));
            Assert.Equal(PostgresErrorCodes.InsufficientPrivilege, failure.SqlState);
        }
    }

    [Fact]
    public async Task A_tenant_cannot_insert_an_audit_event_belonging_to_another_tenant()
    {
        // audit_event is insert-only for the runtime role, so INSERT is where its policy has to be
        // proved. Both directions are asserted: the write this tenant is entitled to must succeed,
        // or a policy that simply refused everything would pass the half that matters.
        var work = await _fixture.Application.BeginUnitOfWorkAsync(TestTenants.AlphaContext, Cancellation);
        await using (work.ConfigureAwait(false))
        {
            var connection = (NpgsqlConnection)work.DbContext.Database.GetDbConnection();
            var transaction = (NpgsqlTransaction)work.Transaction.GetDbTransaction();

            var refused = await Assert.ThrowsAsync<PostgresException>(
                async () => await RawSql.ExecuteAsync(
                    connection,
                    transaction,
                    AuditEventInsertFor(TestTenants.Beta, M0SchemaSeed.Beta)));

            Assert.Equal(PostgresErrorCodes.InsufficientPrivilege, refused.SqlState);
        }

        var ownWork = await _fixture.Application.BeginUnitOfWorkAsync(TestTenants.AlphaContext, Cancellation);
        await using (ownWork.ConfigureAwait(false))
        {
            var connection = (NpgsqlConnection)ownWork.DbContext.Database.GetDbConnection();
            var transaction = (NpgsqlTransaction)ownWork.Transaction.GetDbTransaction();

            var written = await RawSql.ExecuteAsync(
                connection,
                transaction,
                AuditEventInsertFor(TestTenants.Alpha, M0SchemaSeed.Alpha));

            Assert.Equal(1, written);
        }
    }

    [Theory]
    [MemberData(nameof(RuntimeReadableTenantScopedTables))]
    public async Task A_tenant_cannot_write_a_row_belonging_to_another_tenant(string table)
    {
        // The WITH CHECK half, exercised the cheapest way that reaches every table: take the row
        // this tenant can see and try to relabel it as the other tenant's. The policy must refuse
        // rather than hand the row over.
        //
        var work = await _fixture.Application.BeginUnitOfWorkAsync(TestTenants.AlphaContext, Cancellation);
        await using (work.ConfigureAwait(false))
        {
            var beta = TestTenants.Beta.ToString("D", CultureInfo.InvariantCulture);
            var connection = (NpgsqlConnection)work.DbContext.Database.GetDbConnection();
            var transaction = (NpgsqlTransaction)work.Transaction.GetDbTransaction();

            var crossTenantWrite = table == NixTables.WorkspaceInvitation
                ? $"""
                    INSERT INTO workspace_invitation
                        (invitation_id, tenant_id, workspace_id, email_normalized, role,
                         invited_by_principal_id, status, invited_at)
                    VALUES ('40404040-4040-4040-8040-404040404040'::uuid,
                            '{beta}'::uuid, '{M0SchemaSeed.Beta.WorkspaceId:D}'::uuid,
                            'cross-tenant@example.test', 'viewer',
                            '{M0SchemaSeed.Beta.PrincipalId:D}'::uuid, 'pending', now())
                    """
                : $"UPDATE {table} SET tenant_id = '{beta}'::uuid";
            var failure = await Assert.ThrowsAsync<PostgresException>(
                async () => await RawSql.ExecuteAsync(
                    connection,
                    transaction,
                    crossTenantWrite));

            // The invitation case uses an INSERT so the RLS WITH CHECK is observed directly;
            // every tenant-scoped table must produce the same runtime-role refusal.
            Assert.Equal(PostgresErrorCodes.InsufficientPrivilege, failure.SqlState);
        }
    }

    [Theory]
    [MemberData(nameof(TenantScopedTables))]
    public async Task Each_table_grants_the_runtime_role_exactly_the_privileges_the_matrix_allows(string table)
    {
        // Asserted against the declared matrix rather than against "whatever full DML looks like",
        // because the database seed's ALTER DEFAULT PRIVILEGES makes grants fail open: a table a
        // migration forgets to narrow arrives readable and writable by the application. Comparing
        // against an expectation stated per table is what turns that default into a failure.
        var expected = NixTables.ExpectedApplicationPrivileges[table];

        var connection = await _fixture.OpenApplicationConnectionAsync();
        await using (connection.ConfigureAwait(false))
        {
            var granted = await RawSql.TextListAsync(
                connection,
                $"""
                SELECT privilege_type
                FROM information_schema.table_privileges
                WHERE table_schema = 'public'
                  AND table_name = '{table}'
                  AND grantee = 'nix_app'
                ORDER BY privilege_type
                """);

            Assert.Equal(expected, granted);
        }
    }

    [Fact]
    public void The_privilege_matrix_names_every_security_classified_table()
    {
        // The theory above indexes into the matrix, so a table missing from it would throw rather
        // than fail readably. This says which one.
        var classified = NixTables.TenantScoped.Concat(NixTables.CapabilityOnly).Order(StringComparer.Ordinal);
        Assert.Equal(classified, NixTables.ExpectedApplicationPrivileges.Keys.Order(StringComparer.Ordinal));
    }

    [Fact]
    public async Task Content_is_read_only_for_the_api_and_writable_by_the_collaboration_service()
    {
        // The split is the whole point of having a third role. An update can only be validated by
        // applying it, which needs a CRDT runtime the API does not have - so the API serves content
        // and never authors it, and a bug in the API cannot corrupt a document.
        //
        // Asserted in both directions: read-only that is actually read-write is a boundary that
        // does not exist, and read-write that is actually read-only is a service that cannot work.
        var connection = await _fixture.OpenMigratorConnectionAsync();
        await using (connection.ConfigureAwait(false))
        {
            var split = new[]
            {
                NixTables.ContentDoc,
                NixTables.ContentUpdate,
                NixTables.ContentSnapshot,

                // The same split, one step further along: an edge and a search vector are read out
                // of a materialised document, and materialising one needs the CRDT runtime only
                // the collaboration service has.
                NixTables.ItemLink,
                NixTables.ItemSearch,
                NixTables.ItemChunk,
            };

            foreach (var table in split)
            {
                var application = await RawSql.TextListAsync(
                    connection,
                    $"""
                    SELECT privilege_type FROM information_schema.table_privileges
                    WHERE table_schema = 'public' AND table_name = '{table}'
                      AND grantee = '{NixDatabaseRoles.Application}'
                    ORDER BY privilege_type
                    """);

                var collaboration = await RawSql.TextListAsync(
                    connection,
                    $"""
                    SELECT privilege_type FROM information_schema.table_privileges
                    WHERE table_schema = 'public' AND table_name = '{table}'
                      AND grantee = '{NixDatabaseRoles.Collaboration}'
                    ORDER BY privilege_type
                    """);

                Assert.Equal(["SELECT"], application);
                Assert.Equal(["DELETE", "INSERT", "SELECT", "UPDATE"], collaboration);
            }
        }
    }

    [Fact]
    public async Task The_runtime_role_may_update_only_a_site_build_s_lifecycle_columns()
    {
        // The header, page count, publisher, job and idempotency key are what a worker was told
        // to publish; only the columns its seal, activation and retirement move are writable.
        var connection = await _fixture.OpenMigratorConnectionAsync();
        await using (connection.ConfigureAwait(false))
        {
            var updatable = await RawSql.TextListAsync(
                connection,
                $"""
                SELECT column_name FROM information_schema.column_privileges
                WHERE table_schema = 'public' AND table_name = '{NixTables.SiteBuild}'
                  AND grantee = '{NixDatabaseRoles.Application}' AND privilege_type = 'UPDATE'
                ORDER BY column_name
                """);

            Assert.Equal(
                ["activated_at", "build_index_sha256", "file_count", "loss", "purge_id", "sealed_at", "status", "total_bytes"],
                updatable);
        }
    }

    [Fact]
    public async Task The_collaboration_role_can_test_an_item_s_existence_and_read_nothing_else_about_it()
    {
        // The links migration grants this role SELECT on item, which looks like a hole in the
        // split until you read which columns. It needs one question answered - "is this reference
        // pointing at an item that exists?" - because without it a stale link fails a foreign key
        // and takes a document's whole snapshot down with it.
        //
        // Granted column by column, the answer to that question is all it can get. A title, a
        // body, a parent and a workspace stay unreadable, which matters because the service holds
        // documents for every tenant on one process and has no business reading items at all.
        var connection = await _fixture.OpenMigratorConnectionAsync();
        await using (connection.ConfigureAwait(false))
        {
            var readable = await RawSql.TextListAsync(
                connection,
                $"""
                SELECT column_name FROM information_schema.column_privileges
                WHERE table_schema = 'public' AND table_name = '{NixTables.Item}'
                  AND grantee = '{NixDatabaseRoles.Collaboration}' AND privilege_type = 'SELECT'
                ORDER BY column_name
                """);

            Assert.Equal(["id", NixTables.TenantIdColumn], readable);

            // And the table-level grant stays absent, or the column grants would be decoration.
            var wholeTable = await RawSql.TextListAsync(
                connection,
                $"""
                SELECT privilege_type FROM information_schema.table_privileges
                WHERE table_schema = 'public' AND table_name = '{NixTables.Item}'
                  AND grantee = '{NixDatabaseRoles.Collaboration}'
                """);

            Assert.Empty(wholeTable);
        }
    }

    [Fact]
    public async Task The_collaboration_role_cannot_bypass_row_level_security_either()
    {
        // A third role is a third chance to get this wrong. The isolation policies are only a
        // boundary while every role that reaches these tables is subject to them.
        var connection = await _fixture.OpenMigratorConnectionAsync();
        await using (connection.ConfigureAwait(false))
        {
            var canBypass = await RawSql.BooleanAsync(
                connection,
                $"SELECT rolbypassrls FROM pg_roles WHERE rolname = '{NixDatabaseRoles.Collaboration}'");

            Assert.False(canBypass);
        }
    }

    [Fact]
    public async Task An_audit_event_written_through_the_context_reaches_the_table()
    {
        // The runtime role holds INSERT on audit_event and nothing else, and insert-without-select
        // is exactly where EF bites: a store-generated property, or a provider that appends
        // RETURNING, turns the audit write into a privilege error. Raw SQL would not exercise
        // that, so this goes through NixDbContext the way the audit pipeline will.
        var work = await _fixture.Application.BeginUnitOfWorkAsync(TestTenants.AlphaContext, Cancellation);
        await using (work.ConfigureAwait(false))
        {
            work.DbContext.AuditEvents.Add(new AuditEvent
            {
                Id = AuditEventId.Create(),
                TenantId = TenantId.From(TestTenants.Alpha),
                WorkspaceId = WorkspaceId.From(TestTenants.AlphaWorkspace),
                ActorId = PrincipalId.From(TestTenants.AlphaPrincipal),
                Action = "item.viewed",
                SubjectId = M0SchemaSeed.Alpha.ItemId,
                SubjectType = "item",
                OccurredAt = DateTimeOffset.UtcNow,
            });

            await work.DbContext.SaveChangesAsync(Cancellation);
            await work.CommitAsync(Cancellation);
        }

        // Read back as the migrator, because the role that wrote it deliberately cannot.
        var migrator = await _fixture.OpenMigratorConnectionAsync();
        await using (migrator.ConfigureAwait(false))
        {
            var written = await RawSql.CountAsync(
                migrator,
                transaction: null,
                $"SELECT count(*) FROM {NixTables.AuditEvent} WHERE action = 'item.viewed'");

            Assert.Equal(1, written);
        }
    }

    [Fact]
    public async Task Reading_audit_events_through_the_context_is_refused()
    {
        // The other half of insert-only, stated so that the day someone widens the grant to make a
        // query work, this fails and asks them to justify it.
        var work = await _fixture.Application.BeginUnitOfWorkAsync(TestTenants.AlphaContext, Cancellation);
        await using (work.ConfigureAwait(false))
        {
            var failure = await Assert.ThrowsAsync<PostgresException>(
                async () => await work.DbContext.AuditEvents.CountAsync(Cancellation));

            Assert.Equal(PostgresErrorCodes.InsufficientPrivilege, failure.SqlState);
        }
    }

    private static string AuditEventInsertFor(Guid tenantId, M0TenantRows rows)
    {
        var tenant = tenantId.ToString("D", CultureInfo.InvariantCulture);
        var workspace = rows.WorkspaceId.ToString("D", CultureInfo.InvariantCulture);
        var principal = rows.PrincipalId.ToString("D", CultureInfo.InvariantCulture);
        var item = rows.ItemId.ToString("D", CultureInfo.InvariantCulture);

        return $"""
            INSERT INTO {NixTables.AuditEvent}
                (event_id, tenant_id, workspace_id, actor_id, on_behalf_of, action, subject_id,
                 subject_type, before, after, actor_ip, occurred_at)
            VALUES (gen_random_uuid(), '{tenant}'::uuid, '{workspace}'::uuid, '{principal}'::uuid,
                    NULL, 'item.viewed', '{item}'::uuid, 'item', NULL, NULL, NULL, now())
            """;
    }

    private async Task<IReadOnlyList<Guid>> ReadVisibleTenantIdsAsync(string table, NixSessionContext context)
    {
        var work = await _fixture.Application.BeginUnitOfWorkAsync(context, Cancellation);
        await using (work.ConfigureAwait(false))
        {
            var connection = (NpgsqlConnection)work.DbContext.Database.GetDbConnection();
            var transaction = (NpgsqlTransaction)work.Transaction.GetDbTransaction();

            return await RawSql.GuidListAsync(
                connection,
                transaction,
                $"SELECT {NixTables.TenantIdColumn} FROM {table} ORDER BY 1");
        }
    }
}
