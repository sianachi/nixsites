using System.Globalization;
using System.Text;
using Nix.Integration.Tests.Harness;
using Nix.Persistence.Calendar;
using Npgsql;
using NpgsqlTypes;

namespace Nix.Integration.Tests.Persistence;

/// <summary>
/// Plan evidence for calendar sync's three hot statements (ADR-0052 Amendment 1, plan section 8):
/// the dirty trigger's probe on every item write, the C3 push selection, and the log page. Each is
/// gathered as it runs - the definer probe as its owning role, the others as <c>nix_app</c> under
/// row security with the owner's session - against a corpus big enough that the planner has a
/// real choice.
/// </summary>
/// <remarks>
/// The corpus, tenant Alpha: 2,000 links, each over a container of its own; one of them (the hot
/// link) over a container of 20,000 events, 19,900 of them mapped and in sync, 100 changed since,
/// plus 1,000 tombstoned map rows; 60,000 log rows spread over 60 links; 40,000 unrelated items, 50
/// of them locked; and the closure rows of all of it. Tenant Beta: 5,000 items, so row security
/// has something to exclude.
/// </remarks>
[Trait("Category", "PlanEvidence")]
[Collection(PostgresCollectionDefinition.Name)]
public sealed class CalendarSyncPlanEvidenceTests(NixPostgresFixture fixture, ITestOutputHelper output) : IAsyncLifetime
{
    private static readonly Guid Connection = new("ca1e0000-1111-4111-8111-000000000001");
    private static readonly Guid HotLink = new("ca1e0000-1111-4111-8111-00000000000a");
    private static readonly Guid HotContainer = new("ca1e0000-1111-4111-8111-00000000000c");

    private static CancellationToken Cancellation => TestContext.Current.CancellationToken;

    private static readonly SeedOnce Seeded = new();

    public ValueTask InitializeAsync() => new(Seeded.RunAsync(async () =>
    {
        await fixture.ResetAsync();
        await M0SchemaSeed.SeedBothTenantsAsync(fixture);
        await SeedAsync();
    }));

    public ValueTask DisposeAsync() => ValueTask.CompletedTask;

    [Fact]
    public async Task The_dirty_probe_is_one_unique_index_lookup_and_the_trigger_costs_little_per_write()
    {
        // The probe as the trigger function runs it: SECURITY DEFINER, so as the migrator.
        var probe = await ExplainAsMigratorAsync($"""
            SELECT l.tenant_id, l.id FROM public.calendar_link l
             WHERE l.tenant_id = '{TestTenants.Alpha}'
               AND l.container_item_id IN ('{HotContainer}', NULL)
               AND l.status = 'active' AND l.direction = 'two_way'
             LIMIT 2
            """);
        output.WriteLine("Dirty probe:");
        output.WriteLine(probe);
        Assert.Contains("Index Scan using ux_calendar_link_container", probe, StringComparison.Ordinal);
        Assert.DoesNotContain("Seq Scan", probe, StringComparison.Ordinal);

        // A real write in the hot container, as the runtime role: the trigger's own time is on
        // the plan's trigger line.
        var write = await ExplainAsRuntimeRoleAsync($$"""
            UPDATE item SET properties = properties || '{"location":"Room 7"}'::jsonb, last_modified_at = now()
             WHERE tenant_id = '{{TestTenants.Alpha}}' AND id = (SELECT id FROM item WHERE parent_id = '{{HotContainer}}' ORDER BY seq LIMIT 1)
            """, rollback: true);
        output.WriteLine("Write in a linked container:");
        output.WriteLine(write);
        Assert.Contains("Trigger item_calendar_link_dirty", write, StringComparison.Ordinal);
    }

    [Fact]
    public async Task The_push_selection_reads_each_side_once_and_looks_up_only_pending_deletes()
    {
        var plan = await ExplainAsRuntimeRoleAsync(
            CalendarSyncStore.PushCandidatesSql,
            rollback: true,
            new NpgsqlParameter<Guid>("tenant_id", NpgsqlDbType.Uuid) { TypedValue = TestTenants.Alpha },
            new NpgsqlParameter<Guid>("workspace_id", NpgsqlDbType.Uuid) { TypedValue = TestTenants.AlphaWorkspace },
            new NpgsqlParameter<Guid>("link_id", NpgsqlDbType.Uuid) { TypedValue = HotLink },
            new NpgsqlParameter<Guid>("container_id", NpgsqlDbType.Uuid) { TypedValue = HotContainer },
            new NpgsqlParameter<int>("limit", NpgsqlDbType.Integer) { TypedValue = 200 });
        output.WriteLine("C3 push selection, 20,000 children, 100 changed:");
        output.WriteLine(plan);

        // One pass over each side, hashed together - never a probe of the map per child, nor of
        // the item table per map row: only the rows that are not an active child of the container
        // are looked up by primary key. The map side reads the link's rows, which in this corpus
        // are nearly the whole table, so a sequential read of it is the planner's right choice.
        Assert.Contains("Hash Full Join", plan, StringComparison.Ordinal);
        Assert.Contains("IX_item_tenant_id_parent_id", plan, StringComparison.Ordinal);
        Assert.DoesNotContain("Seq Scan on item ", plan, StringComparison.Ordinal);

        // The lock predicate runs only for the rows that survive the filter, and reaches the
        // closure through an index - here from the tenant's 50 locks down their subtrees.
        Assert.Contains("Anti Join", plan, StringComparison.Ordinal);
        Assert.DoesNotContain("Seq Scan on item_closure", plan, StringComparison.Ordinal);
        Assert.DoesNotContain("loops=20000", plan, StringComparison.Ordinal);
        Assert.Contains("rows=100 loops=1", plan, StringComparison.Ordinal);
    }

    [Fact]
    public async Task The_log_page_walks_its_index_with_no_sort()
    {
        var plan = await ExplainAsRuntimeRoleAsync(
            CalendarSyncStore.LogPageSql,
            rollback: true,
            new NpgsqlParameter<Guid>("tenant_id", NpgsqlDbType.Uuid) { TypedValue = TestTenants.Alpha },
            new NpgsqlParameter<Guid>("link_id", NpgsqlDbType.Uuid) { TypedValue = HotLink },
            new NpgsqlParameter<int>("limit", NpgsqlDbType.Integer) { TypedValue = 51 });
        output.WriteLine("Log page:");
        output.WriteLine(plan);

        Assert.Contains("Index Scan using ix_calendar_sync_log_link_at", plan, StringComparison.Ordinal);
        Assert.DoesNotContain("Sort", plan, StringComparison.Ordinal);
    }

    private async Task SeedAsync()
    {
        var tenant = Literal(TestTenants.Alpha);
        var workspace = Literal(TestTenants.AlphaWorkspace);
        var principal = Literal(TestTenants.AlphaPrincipal);
        var sql = $$"""
            INSERT INTO calendar_connection (tenant_id, id, principal_id, provider, account_subject, account_email, status, scopes, created_at, updated_at)
            VALUES ({{tenant}}, {{Literal(Connection)}}, {{principal}}, 'google', 'plan-subject', 'plan@example.test', 'active', '', now(), now());

            -- 2,000 containers and a link over each (the hot one among them).
            INSERT INTO item (id, tenant_id, workspace_id, type, parent_id, seq, properties, lifecycle_state, created_by, last_modified_by, created_at, last_modified_at)
            SELECT CASE WHEN n = 1 THEN {{Literal(HotContainer)}} ELSE gen_random_uuid() END, {{tenant}}, {{workspace}}, 'folder', NULL,
                   500000 + n, jsonb_build_object('title', 'Calendar ' || n), 'active', {{principal}}, {{principal}}, now(), now()
              FROM generate_series(1, 2000) n;
            INSERT INTO calendar_link (tenant_id, id, principal_id, connection_id, workspace_id, container_item_id, external_calendar_id,
                                       name, direction, window_past_days, window_future_days, status, revision, created_at, updated_at)
            SELECT {{tenant}}, CASE WHEN i.id = {{Literal(HotContainer)}} THEN {{Literal(HotLink)}} ELSE gen_random_uuid() END, {{principal}},
                   {{Literal(Connection)}}, {{workspace}}, i.id, 'cal-' || i.seq, 'Calendar', 'two_way', 30, 365, 'active', 1, now(), now()
              FROM item i WHERE i.tenant_id = {{tenant}} AND i.seq BETWEEN 500001 AND 502000;

            -- The hot container's 20,000 events, and 40,000 unrelated items elsewhere.
            INSERT INTO item (id, tenant_id, workspace_id, type, parent_id, seq, properties, lifecycle_state, created_by, last_modified_by, created_at, last_modified_at)
            SELECT gen_random_uuid(), {{tenant}}, {{workspace}}, 'note', {{Literal(HotContainer)}}, n,
                   jsonb_build_object('title', 'Event ' || n, 'start', to_char(date '2026-09-01' + (n % 300), 'YYYY-MM-DD'), 'location', 'Room ' || (n % 40)),
                   'active', {{principal}}, {{principal}}, now() - interval '2 days', now() - interval '2 days' + (n % 1000) * interval '1 second'
              FROM generate_series(1, 20000) n;
            INSERT INTO item (id, tenant_id, workspace_id, type, parent_id, seq, properties, lifecycle_state, created_by, last_modified_by, created_at, last_modified_at)
            SELECT gen_random_uuid(), {{tenant}}, {{workspace}}, 'note', NULL, 600000 + n, jsonb_build_object('title', 'Other ' || n),
                   'active', {{principal}}, {{principal}}, now(), now()
              FROM generate_series(1, 40000) n;
            INSERT INTO item (id, tenant_id, workspace_id, type, parent_id, seq, properties, lifecycle_state, created_by, last_modified_by, created_at, last_modified_at)
            SELECT gen_random_uuid(), {{Literal(TestTenants.Beta)}}, {{Literal(TestTenants.BetaWorkspace)}}, 'note', NULL, 700000 + n,
                   jsonb_build_object('title', 'Other tenant ' || n), 'active', {{Literal(TestTenants.BetaPrincipal)}}, {{Literal(TestTenants.BetaPrincipal)}}, now(), now()
              FROM generate_series(1, 5000) n;

            -- Refresh the bulk corpus before closure foreign-key checks can reuse a plan
            -- made for the tiny initial seed. The final analyses still govern plan evidence.
            ANALYZE item;

            -- The closure the item writes would have kept: a self edge for every item above, the
            -- hot container's edge to each of its events, and 50 locks elsewhere in the tenant, so
            -- the push selection's lock probe meets a closure of realistic size.
            INSERT INTO item_closure (tenant_id, workspace_id, ancestor_id, descendant_id, depth)
            SELECT tenant_id, workspace_id, id, id, 0 FROM item
             WHERE (tenant_id = {{tenant}} AND (seq BETWEEN 1 AND 20000 OR seq BETWEEN 500001 AND 502000 OR seq BETWEEN 600001 AND 640000))
                OR (tenant_id = {{Literal(TestTenants.Beta)}} AND seq BETWEEN 700001 AND 705000)
            ON CONFLICT DO NOTHING;
            INSERT INTO item_closure (tenant_id, workspace_id, ancestor_id, descendant_id, depth)
            SELECT tenant_id, workspace_id, parent_id, id, 1 FROM item
             WHERE tenant_id = {{tenant}} AND parent_id = {{Literal(HotContainer)}}
            ON CONFLICT DO NOTHING;
            INSERT INTO item_lock (item_id, tenant_id, password_hash, locked_by, locked_at)
            SELECT id, tenant_id, 'pbkdf2-sha256$1$AAAAAAAAAAAAAAAAAAAAAA==$AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA=', {{principal}}, now()
              FROM item WHERE tenant_id = {{tenant}} AND seq BETWEEN 600001 AND 600050;

            -- 19,900 mapped and in sync; the last 100 by seq changed since their sync.
            INSERT INTO calendar_event_map (tenant_id, id, link_id, principal_id, item_id, external_event_id, external_version,
                                            nix_version, last_synced_hash, push_failures, created_at, updated_at)
            SELECT {{tenant}}, gen_random_uuid(), {{Literal(HotLink)}}, {{principal}}, i.id, 'evt-' || i.seq, 'v1',
                   CASE WHEN i.seq > 19900 THEN i.last_modified_at - interval '1 hour' ELSE i.last_modified_at END,
                   sha256(convert_to(i.id::text, 'UTF8')), 0, now(), now()
              FROM item i WHERE i.tenant_id = {{tenant}} AND i.parent_id = {{Literal(HotContainer)}};
            INSERT INTO calendar_event_map (tenant_id, id, link_id, principal_id, item_id, external_event_id, push_failures, deleted_at, created_at, updated_at)
            SELECT {{tenant}}, gen_random_uuid(), {{Literal(HotLink)}}, {{principal}}, gen_random_uuid(), 'gone-' || n, 0, now() - interval '3 days', now(), now()
              FROM generate_series(1, 1000) n;

            -- 60,000 log rows over 60 links, 1,000 of them the hot link's.
            INSERT INTO calendar_sync_log (tenant_id, id, link_id, principal_id, at, direction, action, detail)
            SELECT {{tenant}}, gen_random_uuid(), l.id, {{principal}}, now() - (n * interval '1 minute'), 'pull', 'updated', 'updated'
              FROM (SELECT id FROM calendar_link WHERE tenant_id = {{tenant}} ORDER BY (id = {{Literal(HotLink)}}) DESC, id LIMIT 60) l,
                   generate_series(1, 1000) n;

            ANALYZE item;
            ANALYZE item_closure;
            ANALYZE item_lock;
            ANALYZE calendar_link;
            ANALYZE calendar_event_map;
            ANALYZE calendar_sync_log;
            """;
        var connection = await fixture.OpenMigratorConnectionAsync();
        await using (connection.ConfigureAwait(false))
        {
            await RawSql.ExecuteAsync(connection, transaction: null, sql, commandTimeoutSeconds: 300);
        }
    }

    private async Task<string> ExplainAsMigratorAsync(string sql)
    {
        var connection = await fixture.OpenMigratorConnectionAsync();
        await using (connection.ConfigureAwait(false))
        {
            return string.Join('\n', await RawSql.TextListAsync(connection, "EXPLAIN (ANALYZE, BUFFERS) " + sql));
        }
    }

    private async Task<string> ExplainAsRuntimeRoleAsync(string sql, bool rollback, params NpgsqlParameter[] parameters)
    {
        var connection = await fixture.OpenApplicationConnectionAsync();
        await using (connection.ConfigureAwait(false))
        {
            var transaction = await connection.BeginTransactionAsync(Cancellation);
            await using (transaction.ConfigureAwait(false))
            {
                var context = new NpgsqlCommand(
                    "SELECT set_config('nix.tenant_id', @tenant, true), set_config('nix.principal_id', @principal, true)",
                    connection,
                    transaction);
                await using (context.ConfigureAwait(false))
                {
                    context.Parameters.Add(new NpgsqlParameter("tenant", NpgsqlDbType.Text) { Value = TestTenants.Alpha.ToString("D", CultureInfo.InvariantCulture) });
                    context.Parameters.Add(new NpgsqlParameter("principal", NpgsqlDbType.Text) { Value = TestTenants.AlphaPrincipal.ToString("D", CultureInfo.InvariantCulture) });
                    await context.ExecuteNonQueryAsync(Cancellation);
                }

#pragma warning disable CA2100 // Justification: the statements are this codebase's own constants; values reach them only as bound parameters or fixed test literals.
                var command = new NpgsqlCommand("EXPLAIN (ANALYZE, BUFFERS) " + sql, connection, transaction);
#pragma warning restore CA2100
                await using (command.ConfigureAwait(false))
                {
                    command.Parameters.AddRange(parameters);
                    var plan = new StringBuilder();
                    var reader = await command.ExecuteReaderAsync(Cancellation);
                    await using (reader.ConfigureAwait(false))
                    {
                        while (await reader.ReadAsync(Cancellation))
                        {
                            plan.AppendLine(reader.GetString(0));
                        }
                    }

                    if (rollback)
                    {
                        await transaction.RollbackAsync(Cancellation);
                    }

                    return plan.ToString();
                }
            }
        }
    }

    private static string Literal(Guid value) => $"'{value:D}'";
}
