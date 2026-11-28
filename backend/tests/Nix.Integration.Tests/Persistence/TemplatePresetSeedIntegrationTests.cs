using Nix.Integration.Tests.Harness;

namespace Nix.Integration.Tests.Persistence;

[Collection(PostgresSecondaryCollectionDefinition.Name)]
public sealed class TemplatePresetSeedIntegrationTests : IAsyncLifetime
{
    private const string WorkspaceSeed = """
        INSERT INTO tenant (tenant_id, name, isolation_mode, created_at)
        VALUES ('c0000000-0000-4000-8000-000000000001', 'Preset tenant', 'shared', now());

        INSERT INTO workspace
            (workspace_id, tenant_id, name, version_retention_days, coalesce_window_min,
             storage_quota_bytes, created_at)
        VALUES ('c1000000-0000-4000-8000-000000000001',
                'c0000000-0000-4000-8000-000000000001',
                'Preset workspace', 90, 10, 1073741824, now());

        INSERT INTO principal
            (principal_id, tenant_id, external_subject, kind, display_name, email, status,
             deprovisioned_at)
        VALUES ('c2000000-0000-4000-8000-000000000001',
                'c0000000-0000-4000-8000-000000000001',
                'preset-owner', 'user', 'Preset Owner', 'owner@example.test', 'active', NULL);

        INSERT INTO workspace_member
            (workspace_id, subject_type, subject_id, tenant_id, role, granted_by, granted_at)
        VALUES ('c1000000-0000-4000-8000-000000000001', 'principal',
                'c2000000-0000-4000-8000-000000000001',
                'c0000000-0000-4000-8000-000000000001', 'owner',
                'c2000000-0000-4000-8000-000000000001', now());
        """;

    private const string GroupWorkspaceSeed = """
        INSERT INTO tenant (tenant_id, name, isolation_mode, created_at)
        VALUES ('d0000000-0000-4000-8000-000000000001', 'Group preset tenant', 'shared', now());

        INSERT INTO workspace
            (workspace_id, tenant_id, name, version_retention_days, coalesce_window_min,
             storage_quota_bytes, created_at)
        VALUES ('d1000000-0000-4000-8000-000000000001',
                'd0000000-0000-4000-8000-000000000001',
                'Group preset workspace', 90, 10, 1073741824, now());

        INSERT INTO principal
            (principal_id, tenant_id, external_subject, kind, display_name, email, status,
             deprovisioned_at)
        VALUES ('d2000000-0000-4000-8000-000000000001',
                'd0000000-0000-4000-8000-000000000001',
                'group-preset-editor', 'user', 'Group Preset Editor',
                'group-editor@example.test', 'active', NULL);

        INSERT INTO principal_group (group_id, tenant_id, name, external_id)
        VALUES ('d3000000-0000-4000-8000-000000000001',
                'd0000000-0000-4000-8000-000000000001',
                'Preset Editors', 'preset-editors');

        INSERT INTO group_membership (group_id, principal_id, tenant_id, source)
        VALUES ('d3000000-0000-4000-8000-000000000001',
                'd2000000-0000-4000-8000-000000000001',
                'd0000000-0000-4000-8000-000000000001', 'directory');

        INSERT INTO workspace_member
            (workspace_id, subject_type, subject_id, tenant_id, role, granted_by, granted_at)
        VALUES ('d1000000-0000-4000-8000-000000000001', 'group',
                'd3000000-0000-4000-8000-000000000001',
                'd0000000-0000-4000-8000-000000000001', 'editor',
                'd2000000-0000-4000-8000-000000000001', now());
        """;

    private readonly NixPostgresFixture _fixture;

    public TemplatePresetSeedIntegrationTests(NixPostgresFixture fixture) => _fixture = fixture;

    public async ValueTask InitializeAsync() => await _fixture.ResetAsync();

    public ValueTask DisposeAsync() => ValueTask.CompletedTask;

    [Fact]
    public async Task Migrating_an_empty_database_then_seeding_a_workspace_provisions_presets_idempotently()
    {
        var connection = await _fixture.OpenMigratorConnectionAsync();
        await using (connection.ConfigureAwait(false))
        {
            Assert.Equal(0, await RawSql.CountAsync(
                connection,
                transaction: null,
                "SELECT count(*) FROM workspace_template"));

            await RawSql.ExecuteAsync(connection, transaction: null, WorkspaceSeed);

            Assert.Equal(0, await RawSql.CountAsync(
                connection,
                transaction: null,
                "SELECT count(*) FROM workspace_template"));

            var presetSql = await File.ReadAllTextAsync(PresetSeedPath(), TestContext.Current.CancellationToken);
            await RawSql.ExecuteAsync(connection, transaction: null, presetSql);
            await RawSql.ExecuteAsync(connection, transaction: null, presetSql);

            Assert.Equal(3, await RawSql.CountAsync(
                connection,
                transaction: null,
                "SELECT count(*) FROM workspace_template WHERE origin = 'seed' AND state = 'active'"));
            Assert.Equal(3, await RawSql.CountAsync(
                connection,
                transaction: null,
                "SELECT count(*) FROM item WHERE template_id IS NOT NULL"));
            Assert.Equal(3, await RawSql.CountAsync(
                connection,
                transaction: null,
                "SELECT count(*) FROM item_closure WHERE depth = 0"));

            var keys = await RawSql.TextListAsync(
                connection,
                "SELECT stable_key FROM workspace_template ORDER BY stable_key");
            Assert.Equal(["seed.calendar", "seed.kanban", "seed.list"], keys);

            Assert.Equal(3, await RawSql.CountAsync(
                connection,
                transaction: null,
                "SELECT count(*) FROM workspace_template WHERE root_item_id IS NOT NULL"));

            var identities = await RawSql.GuidListAsync(
                connection,
                transaction: null,
                """
                SELECT template_id FROM workspace_template WHERE origin = 'seed'
                UNION ALL
                SELECT id FROM item WHERE template_id IS NOT NULL
                UNION ALL
                SELECT template_source_id FROM item WHERE template_id IS NOT NULL
                """);
            Assert.Equal(9, identities.Count);
            RfcUuidAssert.Version4(identities);
        }
    }

    [Fact]
    public async Task A_workspace_with_only_group_membership_receives_presets_from_its_active_editor()
    {
        var connection = await _fixture.OpenMigratorConnectionAsync();
        await using (connection.ConfigureAwait(false))
        {
            await RawSql.ExecuteAsync(connection, transaction: null, GroupWorkspaceSeed);

            Assert.Equal(0, await RawSql.CountAsync(
                connection,
                transaction: null,
                "SELECT count(*) FROM workspace_member WHERE subject_type = 'principal'"));

            var presetSql = await File.ReadAllTextAsync(PresetSeedPath(), TestContext.Current.CancellationToken);
            await RawSql.ExecuteAsync(connection, transaction: null, presetSql);

            Assert.Equal(3, await RawSql.CountAsync(
                connection,
                transaction: null,
                "SELECT count(*) FROM workspace_template WHERE origin = 'seed' AND state = 'active'"));
            Assert.Equal(3, await RawSql.CountAsync(
                connection,
                transaction: null,
                "SELECT count(*) FROM item WHERE template_id IS NOT NULL"));

            var actors = await RawSql.GuidListAsync(
                connection,
                transaction: null,
                """
                SELECT created_by FROM workspace_template
                UNION
                SELECT created_by FROM item WHERE template_id IS NOT NULL
                """);
            Assert.Equal(
                [Guid.Parse("d2000000-0000-4000-8000-000000000001")],
                actors);

            var identities = await RawSql.GuidListAsync(
                connection,
                transaction: null,
                """
                SELECT template_id FROM workspace_template WHERE origin = 'seed'
                UNION ALL
                SELECT id FROM item WHERE template_id IS NOT NULL
                UNION ALL
                SELECT template_source_id FROM item WHERE template_id IS NOT NULL
                """);
            Assert.Equal(9, identities.Count);
            RfcUuidAssert.Version4(identities);
        }
    }

    private static string PresetSeedPath()
    {
        var directory = new DirectoryInfo(AppContext.BaseDirectory);
        while (directory is not null)
        {
            var solution = Path.Combine(directory.FullName, "Nix.slnx");
            if (File.Exists(solution))
            {
                return Path.Combine(directory.FullName, "deploy", "seed", "seed_template_presets.sql");
            }

            directory = directory.Parent;
        }

        throw new InvalidOperationException(
            $"No Nix.slnx above {AppContext.BaseDirectory}, so the preset seed could not be found.");
    }
}
