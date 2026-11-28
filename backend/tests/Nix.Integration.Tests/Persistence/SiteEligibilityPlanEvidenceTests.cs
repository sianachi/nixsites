using System.Globalization;
using System.Text;
using Nix.Integration.Tests.Harness;
using Nix.Persistence.Sql.Statements;
using Npgsql;
using NpgsqlTypes;

namespace Nix.Integration.Tests.Persistence;

/// <summary>
/// Plan evidence for the eligibility statement, which runs once per publish and is the
/// security-critical read of sites. It is explained as the runtime role under row-level security
/// against a corpus big enough that the planner has a real choice between walking the site's
/// subtree and scanning the tenant.
/// </summary>
/// <remarks>
/// The corpus, tenant Alpha: 3,000 pages in 30 sections under the site's root; 20,000 unrelated
/// items of the same tenant; 40 locked pages, 20 excluded sections, a dated collection of 500
/// posts, 200 of them future-dated; and every closure row. Each section page has a body of 50
/// updates and a snapshot every ten, the last at its head, with the head update of every other
/// page pruned, as retention does to a long-idle body. Tenant Beta: 2,000 items, so row security
/// has something to exclude.
/// </remarks>
[Trait("Category", "PlanEvidence")]
[Collection(PostgresCollectionDefinition.Name)]
public sealed class SiteEligibilityPlanEvidenceTests(NixPostgresFixture fixture, ITestOutputHelper output) : IAsyncLifetime
{
    private static readonly Guid SiteId = new("51e51e51-aaaa-4aaa-8aaa-51e51e51aaaa");
    private static readonly Guid Collection = new("c011c011-aaaa-4aaa-8aaa-c011c011aaaa");
    private static readonly Guid Image = new("1a6e1a6e-aaaa-4aaa-8aaa-1a6e1a6eaaaa");
    private static readonly Guid ImageVersion = new("1a6e1a6e-bbbb-4bbb-8bbb-1a6e1a6ebbbb");
    private static readonly Guid LiveBuild = new("b0b0b0b0-aaaa-4aaa-8aaa-b0b0b0b0aaaa");

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
    public async Task The_eligibility_statement_walks_the_sites_subtree_and_never_scans_the_tenant()
    {
        var plan = await ExplainAsRuntimeRoleAsync();
        output.WriteLine("Eligibility statement, 3,000 pages among 23,000 items of the tenant, runtime role:");
        output.WriteLine(plan);

        Assert.DoesNotContain("Seq Scan on item ", plan, StringComparison.Ordinal);
        Assert.DoesNotContain("Seq Scan on item_closure", plan, StringComparison.Ordinal);
        Assert.Matches("Index Scan using \"IX_item_(tenant_id|workspace_id)_parent_id", plan);
        Assert.Contains("Index Scan using \"PK_content_update\"", plan, StringComparison.Ordinal);
        Assert.Contains("Index Scan using \"PK_content_snapshot\"", plan, StringComparison.Ordinal);
        Assert.DoesNotContain("Seq Scan on content_update", plan, StringComparison.Ordinal);
        Assert.DoesNotContain("Seq Scan on content_snapshot", plan, StringComparison.Ordinal);
        Assert.Contains("Index", plan, StringComparison.Ordinal);
        Assert.Contains("Buffers:", plan, StringComparison.Ordinal);
        Assert.Contains("actual", plan, StringComparison.Ordinal);

        // The result is the right size too: 3,000 pages minus 40 locked, minus 20 excluded sections
        // of 100 pages each, plus the root, the 30 sections less the excluded ones, and 300 visible posts.
        var rows = await CountEligibleAsync();
        Assert.Equal(1 + (30 - 20) + ((30 - 20) * 100 - 40) + 1 + 300 + 1, rows);
    }

    private async Task<int> CountEligibleAsync()
    {
        var connection = await fixture.OpenApplicationConnectionAsync();
        await using (connection.ConfigureAwait(false))
        {
            var transaction = await connection.BeginTransactionAsync(Cancellation);
            await using (transaction.ConfigureAwait(false))
            {
                await ScopeAsync(connection, transaction);
                var command = new NpgsqlCommand($"SELECT count(*) FROM ({SiteEligibilitySql.EligiblePages}) AS eligible", connection, transaction);
                await using (command.ConfigureAwait(false))
                {
                    AddParameters(command);
                    return Convert.ToInt32(await command.ExecuteScalarAsync(Cancellation), CultureInfo.InvariantCulture);
                }
            }
        }
    }

    [Fact]
    public async Task The_image_check_probes_the_files_ancestors_and_never_scans_the_tenant()
    {
        var plan = await ExplainAsRuntimeRoleAsync(SiteEligibilitySql.EligibleFile, file: true);
        output.WriteLine("Image eligibility, one image three levels under the root, runtime role:");
        output.WriteLine(plan);

        Assert.DoesNotContain("Seq Scan on item ", plan, StringComparison.Ordinal);
        Assert.DoesNotContain("Seq Scan on item_closure", plan, StringComparison.Ordinal);
        Assert.DoesNotContain("never executed", plan, StringComparison.Ordinal);
        Assert.Contains("rows=1 loops=1)", plan.Split('\n')[0], StringComparison.Ordinal);
    }

    [Fact]
    public async Task The_withheld_dated_post_report_stays_in_the_sites_subtree()
    {
        var plan = await ExplainAsRuntimeRoleAsync(SiteEligibilitySql.WithheldDatedPosts, withheld: true);
        output.WriteLine("Withheld dated posts, 200 scheduled posts among 23,000 tenant items, runtime role:");
        output.WriteLine(plan);

        Assert.DoesNotContain("Seq Scan on item ", plan, StringComparison.Ordinal);
        Assert.DoesNotContain("Seq Scan on item_closure", plan, StringComparison.Ordinal);
        Assert.Matches("Index Scan using \"IX_item_(tenant_id|workspace_id)_parent_id", plan);
        Assert.Contains("Buffers:", plan, StringComparison.Ordinal);
    }

    [Fact]
    public async Task The_republish_planner_reads_each_sites_subtree_by_index()
    {
        // The planner's statement, lifted out of the SECURITY DEFINER function as installed, with
        // its two arguments bound; explained as the migrator, which is what the function runs as.
        var connection = await fixture.OpenMigratorConnectionAsync();
        await using (connection.ConfigureAwait(false))
        {
            await RawSql.ExecuteAsync(connection, transaction: null, $"""
                INSERT INTO site_build (tenant_id, id, site_id, status, job_id, publisher_id, origin, idempotency_key, header,
                                        page_count, file_count, total_bytes, loss, created_at, activated_at)
                VALUES ('{TestTenants.Alpha}', '{LiveBuild}', '{SiteId}', 'live', gen_random_uuid(), '{TestTenants.AlphaPrincipal}',
                        'manual', 'plan', jsonb_build_object(), 1, 0, 0, '[]'::jsonb, now() - interval '1 day', now() - interval '1 day');
                UPDATE site SET status = 'published', live_build_id = '{LiveBuild}', republish_mode = 'auto',
                                auto_principal_id = '{TestTenants.AlphaPrincipal}' WHERE id = '{SiteId}';
                ANALYZE site; ANALYZE site_build;
                """);
            var source = (await RawSql.TextListAsync(connection, "SELECT prosrc FROM pg_proc WHERE proname = 'nix_site_rebuild_candidates'")).Single();
            var start = source.IndexOf("RETURN QUERY", StringComparison.Ordinal) + "RETURN QUERY".Length;
            var body = source[start..source.LastIndexOf(';')]
                .Replace("p_now", "now()", StringComparison.Ordinal)
                .Replace("p_limit", "500", StringComparison.Ordinal);
            var plan = string.Join('\n', await RawSql.TextListAsync(connection, "EXPLAIN (ANALYZE, BUFFERS) " + body));
            output.WriteLine("Republish candidates, one auto site over 3,800 pages among 23,000 items:");
            output.WriteLine(plan);

            Assert.DoesNotContain("Seq Scan on item ", plan, StringComparison.Ordinal);
            Assert.DoesNotContain("Seq Scan on item_closure", plan, StringComparison.Ordinal);
            Assert.Contains("Buffers:", plan, StringComparison.Ordinal);
        }
    }

    private async Task<string> ExplainAsRuntimeRoleAsync(
        string statement = SiteEligibilitySql.EligiblePages, bool file = false, bool withheld = false)
    {
        var connection = await fixture.OpenApplicationConnectionAsync();
        await using (connection.ConfigureAwait(false))
        {
            var transaction = await connection.BeginTransactionAsync(Cancellation);
            await using (transaction.ConfigureAwait(false))
            {
                await ScopeAsync(connection, transaction);
#pragma warning disable CA2100 // Justification: the statement is this codebase's own constant; values reach it only as bound parameters.
                var command = new NpgsqlCommand("EXPLAIN (ANALYZE, BUFFERS) " + statement, connection, transaction);
#pragma warning restore CA2100
                await using (command.ConfigureAwait(false))
                {
                    AddParameters(command);
                    if (file)
                    {
                        command.Parameters.Add(new NpgsqlParameter<Guid>("file_item_id", NpgsqlDbType.Uuid) { TypedValue = Image });
                    }
                    if (withheld)
                    {
                        command.Parameters.Add(new NpgsqlParameter<int>("limit", NpgsqlDbType.Integer) { TypedValue = 129 });
                    }

                    var plan = new StringBuilder();
                    var reader = await command.ExecuteReaderAsync(Cancellation);
                    await using (reader.ConfigureAwait(false))
                    {
                        while (await reader.ReadAsync(Cancellation))
                        {
                            plan.AppendLine(reader.GetString(0));
                        }
                    }

                    await transaction.RollbackAsync(Cancellation);
                    return plan.ToString();
                }
            }
        }
    }

    private static async Task ScopeAsync(NpgsqlConnection connection, NpgsqlTransaction transaction) =>
        await RawSql.ExecuteAsync(
            connection,
            transaction,
            $"SELECT set_config('nix.tenant_id', '{TestTenants.Alpha}', true), set_config('nix.principal_id', '{TestTenants.AlphaPrincipal}', true)");

    private static void AddParameters(NpgsqlCommand command)
    {
        command.Parameters.Add(new NpgsqlParameter<Guid>("tenant_id", NpgsqlDbType.Uuid) { TypedValue = TestTenants.Alpha });
        command.Parameters.Add(new NpgsqlParameter<Guid>("workspace_id", NpgsqlDbType.Uuid) { TypedValue = TestTenants.AlphaWorkspace });
        command.Parameters.Add(new NpgsqlParameter<Guid>("root_id", NpgsqlDbType.Uuid) { TypedValue = M0SchemaSeed.Alpha.ItemId });
        command.Parameters.Add(new NpgsqlParameter<Guid>("site_id", NpgsqlDbType.Uuid) { TypedValue = SiteId });
        command.Parameters.Add(new NpgsqlParameter<DateTimeOffset>("now", NpgsqlDbType.TimestampTz) { TypedValue = DateTimeOffset.UtcNow });
    }

    private async Task SeedAsync()
    {
        var tenant = $"'{TestTenants.Alpha}'::uuid";
        var workspace = $"'{TestTenants.AlphaWorkspace}'::uuid";
        var principal = $"'{TestTenants.AlphaPrincipal}'::uuid";
        var root = $"'{M0SchemaSeed.Alpha.ItemId}'::uuid";
        var beta = $"'{TestTenants.Beta}'::uuid";
        var betaWorkspace = $"'{TestTenants.BetaWorkspace}'::uuid";
        var betaPrincipal = $"'{TestTenants.BetaPrincipal}'::uuid";
        var sql = $$"""
            -- 30 sections under the root.
            CREATE TEMP TABLE section AS
            SELECT gen_random_uuid() AS id, n FROM generate_series(1, 30) AS n;
            INSERT INTO item (id, tenant_id, workspace_id, type, parent_id, seq, properties, lifecycle_state, created_by, last_modified_by, created_at, last_modified_at)
            SELECT id, {{tenant}}, {{workspace}}, 'folder', {{root}}, n * 100, jsonb_build_object('title', 'Section ' || n), 'active', {{principal}}, {{principal}}, now(), now() FROM section;
            INSERT INTO item_closure (descendant_id, ancestor_id, tenant_id, workspace_id, depth)
            SELECT id, id, {{tenant}}, {{workspace}}, 0 FROM section
            UNION ALL SELECT id, {{root}}, {{tenant}}, {{workspace}}, 1 FROM section;

            -- 100 pages in each.
            CREATE TEMP TABLE page AS
            SELECT gen_random_uuid() AS id, section.id AS section_id, p AS n FROM section, generate_series(1, 100) AS p;
            INSERT INTO item (id, tenant_id, workspace_id, type, parent_id, seq, properties, lifecycle_state, created_by, last_modified_by, created_at, last_modified_at)
            SELECT id, {{tenant}}, {{workspace}}, 'note', section_id, n * 100, jsonb_build_object('title', 'Page ' || n), 'active', {{principal}}, {{principal}}, now(), now() FROM page;
            INSERT INTO item_closure (descendant_id, ancestor_id, tenant_id, workspace_id, depth)
            SELECT id, id, {{tenant}}, {{workspace}}, 0 FROM page
            UNION ALL SELECT id, section_id, {{tenant}}, {{workspace}}, 1 FROM page
            UNION ALL SELECT id, {{root}}, {{tenant}}, {{workspace}}, 2 FROM page;

            -- A body for each page: 50 updates and a snapshot every ten, the head update of every
            -- other page pruned so the snapshot fallback runs.
            CREATE TEMP TABLE body AS SELECT gen_random_uuid() AS doc_id, id AS item_id, n FROM page;
            INSERT INTO content_doc (doc_id, tenant_id, item_id, workspace_id, schema_version, head_seq, created_at)
            SELECT doc_id, {{tenant}}, item_id, {{workspace}}, 1, 50, now() FROM body;
            INSERT INTO content_update (doc_id, seq, tenant_id, update_bytes, actor_id, client_id, created_at)
            SELECT doc_id, s, {{tenant}}, '\x0102'::bytea, {{principal}}, 'plan-client', now()
            FROM body, generate_series(1, 50) AS s WHERE s < 50 OR n % 2 = 0;
            INSERT INTO content_snapshot (doc_id, seq, tenant_id, yjs_state, prosemirror_json, plaintext, created_at)
            SELECT doc_id, s * 10, {{tenant}}, '\x0102'::bytea, NULL, 'body', now() FROM body, generate_series(1, 5) AS s;

            -- A dated collection of 500 posts, 200 of them in the future.
            INSERT INTO item (id, tenant_id, workspace_id, type, parent_id, seq, properties, lifecycle_state, created_by, last_modified_by, created_at, last_modified_at)
            VALUES ('{{Collection}}', {{tenant}}, {{workspace}}, 'folder', {{root}}, 99000, jsonb_build_object('title', 'Blog'), 'active', {{principal}}, {{principal}}, now(), now());
            INSERT INTO item_closure (descendant_id, ancestor_id, tenant_id, workspace_id, depth) VALUES
                ('{{Collection}}', '{{Collection}}', {{tenant}}, {{workspace}}, 0), ('{{Collection}}', {{root}}, {{tenant}}, {{workspace}}, 1);
            CREATE TEMP TABLE post AS SELECT gen_random_uuid() AS id, n FROM generate_series(1, 500) AS n;
            INSERT INTO item (id, tenant_id, workspace_id, type, parent_id, seq, properties, lifecycle_state, created_by, last_modified_by, created_at, last_modified_at)
            SELECT id, {{tenant}}, {{workspace}}, 'note', '{{Collection}}', n * 100,
                   jsonb_build_object('title', 'Post ' || n, 'published', CASE WHEN n <= 300 THEN '2026-01-01' ELSE '2999-01-01' END),
                   'active', {{principal}}, {{principal}}, now(), now() FROM post;
            INSERT INTO item_closure (descendant_id, ancestor_id, tenant_id, workspace_id, depth)
            SELECT id, id, {{tenant}}, {{workspace}}, 0 FROM post
            UNION ALL SELECT id, '{{Collection}}'::uuid, {{tenant}}, {{workspace}}, 1 FROM post
            UNION ALL SELECT id, {{root}}, {{tenant}}, {{workspace}}, 2 FROM post;

            -- Unrelated items of the same tenant, and another tenant's.
            CREATE TEMP TABLE noise AS SELECT gen_random_uuid() AS id, n FROM generate_series(1, 20000) AS n;
            INSERT INTO item (id, tenant_id, workspace_id, type, parent_id, seq, properties, lifecycle_state, created_by, last_modified_by, created_at, last_modified_at)
            SELECT id, {{tenant}}, {{workspace}}, 'note', NULL, 200000 + n, jsonb_build_object('title', 'Noise ' || n), 'active', {{principal}}, {{principal}}, now(), now() FROM noise;
            INSERT INTO item_closure (descendant_id, ancestor_id, tenant_id, workspace_id, depth) SELECT id, id, {{tenant}}, {{workspace}}, 0 FROM noise;
            CREATE TEMP TABLE beta_noise AS SELECT gen_random_uuid() AS id, n FROM generate_series(1, 2000) AS n;
            INSERT INTO item (id, tenant_id, workspace_id, type, parent_id, seq, properties, lifecycle_state, created_by, last_modified_by, created_at, last_modified_at)
            SELECT id, {{beta}}, {{betaWorkspace}}, 'note', NULL, 200000 + n, jsonb_build_object('title', 'Beta ' || n), 'active', {{betaPrincipal}}, {{betaPrincipal}}, now(), now() FROM beta_noise;
            INSERT INTO item_closure (descendant_id, ancestor_id, tenant_id, workspace_id, depth) SELECT id, id, {{beta}}, {{betaWorkspace}}, 0 FROM beta_noise;

            -- The site, its dated collection, 20 excluded sections and 40 locked pages.
            INSERT INTO site (tenant_id, id, workspace_id, root_item_id, slug, layout, settings, republish_mode, debounce_seconds, status, created_by, created_at, updated_at)
            VALUES ({{tenant}}, '{{SiteId}}', {{workspace}}, {{root}}, 'plan-evidence', 'docs', jsonb_build_object(), 'manual', 300, 'draft', {{principal}}, now(), now());
            INSERT INTO site_dated_collection (tenant_id, site_id, item_id, date_property) VALUES ({{tenant}}, '{{SiteId}}', '{{Collection}}', 'published');
            INSERT INTO site_exclusion (tenant_id, site_id, item_id) SELECT {{tenant}}, '{{SiteId}}', id FROM section WHERE n <= 20;
            INSERT INTO item_lock (item_id, tenant_id, password_hash, locked_by, locked_at)
            SELECT id, {{tenant}}, 'pbkdf2-sha256$1$AAAAAAAAAAAAAAAAAAAAAA==$AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA=', {{principal}}, now()
            FROM page WHERE section_id IN (SELECT id FROM section WHERE n > 20) AND n <= 4;

            -- One image under an eligible page (section 25, page 50), three levels below the root.
            INSERT INTO item (id, tenant_id, workspace_id, type, parent_id, seq, properties, lifecycle_state, created_by, last_modified_by, created_at, last_modified_at)
            SELECT '{{Image}}', {{tenant}}, {{workspace}}, 'file', page.id, 1, jsonb_build_object('title', 'pic.png'), 'active', {{principal}}, {{principal}}, now(), now()
            FROM page JOIN section ON section.id = page.section_id WHERE section.n = 25 AND page.n = 50;
            INSERT INTO item_closure (descendant_id, ancestor_id, tenant_id, workspace_id, depth)
            SELECT '{{Image}}'::uuid, ancestor_id, {{tenant}}, {{workspace}}, depth + 1
            FROM item_closure WHERE descendant_id = (SELECT parent_id FROM item WHERE id = '{{Image}}')
            UNION ALL SELECT '{{Image}}'::uuid, '{{Image}}'::uuid, {{tenant}}, {{workspace}}, 0;
            INSERT INTO file_version (file_version_id, tenant_id, workspace_id, item_id, version, object_key, file_name, media_type, byte_length, sha256, previewable, created_by, created_at)
            VALUES ('{{ImageVersion}}', {{tenant}}, {{workspace}}, '{{Image}}', 1, 'files/plan/pic', 'pic.png', 'image/png', 10, repeat('e', 64), true, {{principal}}, now());
            INSERT INTO file_body (item_id, tenant_id, workspace_id, current_version_id) VALUES ('{{Image}}', {{tenant}}, {{workspace}}, '{{ImageVersion}}');

            ANALYZE item;
            ANALYZE item_closure;
            ANALYZE item_lock;
            ANALYZE content_doc;
            ANALYZE content_update;
            ANALYZE content_snapshot;
            ANALYZE site_exclusion;
            ANALYZE site_dated_collection;
            """;
        var connection = await fixture.OpenMigratorConnectionAsync();
        await using (connection.ConfigureAwait(false))
        {
            await RawSql.ExecuteAsync(connection, transaction: null, sql, commandTimeoutSeconds: 300);
        }
    }
}
