using System.Globalization;
using Nix.Abstractions;
using Nix.Domain.Items;
using Nix.Domain.Tenancy;
using Nix.Integration.Tests.Harness;

namespace Nix.Integration.Tests.Persistence;

/// <summary>Recurring calendar candidates honor derived item visibility inside their bulk read.</summary>
[Collection(PostgresSecondaryCollectionDefinition.Name)]
public sealed class RecurrenceCandidateAuthorizationTests : IAsyncLifetime
{
    private static readonly Guid DeletedAncestor = new("1ecaff00-1111-4111-8111-1ecaff000001");
    private static readonly Guid HiddenContainer = new("1ecaff00-1111-4111-8111-1ecaff000002");
    private static readonly Guid HiddenChild = new("1ecaff00-1111-4111-8111-1ecaff000003");
    private static readonly Guid VisibleContainer = new("1ecaff00-1111-4111-8111-1ecaff000004");
    private static readonly Guid VisibleChild = new("1ecaff00-1111-4111-8111-1ecaff000005");

    private readonly NixPostgresFixture _fixture;

    public RecurrenceCandidateAuthorizationTests(NixPostgresFixture fixture) => _fixture = fixture;

    private static CancellationToken Cancellation => TestContext.Current.CancellationToken;

    public async ValueTask InitializeAsync()
    {
        await _fixture.ResetAsync();
        await M0SchemaSeed.SeedBothTenantsAsync(_fixture);
        await SeedCandidatesAsync();
    }

    public ValueTask DisposeAsync() => ValueTask.CompletedTask;

    [Theory]
    [InlineData("deleted", false)]
    [InlineData("purged", false)]
    [InlineData("provisioning", false)]
    [InlineData("active", true)]
    public async Task A_recurring_child_below_a_non_visible_ancestor_is_omitted_before_the_limit(
        string ancestorLifecycle,
        bool templateOwned)
    {
        await SetAncestorBoundaryAsync(ancestorLifecycle, templateOwned);

        var work = await _fixture.Application.BeginUnitOfWorkAsync(TestTenants.AlphaContext, Cancellation);
        await using (work.ConfigureAwait(false))
        {
            var candidates = await work.Resolve<IRecurrenceCandidates>().ReadAsync(
                WorkspaceId.From(M0SchemaSeed.Alpha.WorkspaceId),
                [WorkspaceId.From(M0SchemaSeed.Alpha.WorkspaceId)],
                "2026-03-01",
                "2026-03-31",
                candidateLimit: 1,
                Cancellation);

            var visible = Assert.Single(candidates);
            Assert.Equal(ItemId.From(VisibleChild), visible.ItemId);
            Assert.DoesNotContain(candidates, candidate => candidate.ItemId == ItemId.From(HiddenChild));
        }
    }

    [Fact]
    public async Task Another_tenant_cannot_read_recurring_candidates_even_with_a_forged_workspace_set()
    {
        var work = await _fixture.Application.BeginUnitOfWorkAsync(TestTenants.BetaContext, Cancellation);
        await using (work.ConfigureAwait(false))
        {
            var alpha = WorkspaceId.From(M0SchemaSeed.Alpha.WorkspaceId);
            var candidates = await work.Resolve<IRecurrenceCandidates>().ReadAsync(
                alpha,
                [alpha],
                "2026-03-01",
                "2026-03-31",
                candidateLimit: 10,
                Cancellation);

            Assert.Empty(candidates);
        }
    }

    private async Task SeedCandidatesAsync()
    {
        var tenant = RawSql.Literal(M0SchemaSeed.Alpha.TenantId);
        var workspace = RawSql.Literal(M0SchemaSeed.Alpha.WorkspaceId);
        var principal = RawSql.Literal(M0SchemaSeed.Alpha.PrincipalId);

        var sql = $$"""
            INSERT INTO item
                (id, tenant_id, workspace_id, type, parent_id, seq, properties, views,
                 lifecycle_state, recurrence, purge_after, created_by, last_modified_by,
                 created_at, last_modified_at)
            VALUES
                ({{RawSql.Literal(DeletedAncestor)}}, {{tenant}}, {{workspace}}, 'note', NULL, 1000,
                 '{"title":"Deleted ancestor"}'::jsonb, NULL, 'deleted', NULL, NULL,
                 {{principal}}, {{principal}}, now(), now()),
                ({{RawSql.Literal(HiddenContainer)}}, {{tenant}}, {{workspace}}, 'note',
                 {{RawSql.Literal(DeletedAncestor)}}, 2000, '{"title":"Hidden calendar"}'::jsonb,
                 '{"views":[{"id":"v1","kind":"calendar","name":"Due","dateProperty":"due_date"}]}'::jsonb,
                 'active', NULL, NULL, {{principal}}, {{principal}}, now(), now()),
                ({{RawSql.Literal(HiddenChild)}}, {{tenant}}, {{workspace}}, 'note',
                 {{RawSql.Literal(HiddenContainer)}}, 3000,
                 '{"title":"Hidden series","due_date":"2026-03-02"}'::jsonb, NULL,
                 'active', '{"freq":"daily","interval":1}'::jsonb, NULL,
                 {{principal}}, {{principal}}, now(), now()),
                ({{RawSql.Literal(VisibleContainer)}}, {{tenant}}, {{workspace}}, 'note', NULL, 4000,
                 '{"title":"Visible calendar"}'::jsonb,
                 '{"views":[{"id":"v1","kind":"calendar","name":"Due","dateProperty":"due_date"}]}'::jsonb,
                 'active', NULL, NULL, {{principal}}, {{principal}}, now(), now()),
                ({{RawSql.Literal(VisibleChild)}}, {{tenant}}, {{workspace}}, 'note',
                 {{RawSql.Literal(VisibleContainer)}}, 5000,
                 '{"title":"Visible series","due_date":"2026-03-03"}'::jsonb, NULL,
                 'active', '{"freq":"daily","interval":1}'::jsonb, NULL,
                 {{principal}}, {{principal}}, now(), now());

            INSERT INTO item_closure
                (descendant_id, ancestor_id, tenant_id, workspace_id, depth)
            VALUES
                ({{RawSql.Literal(DeletedAncestor)}}, {{RawSql.Literal(DeletedAncestor)}}, {{tenant}}, {{workspace}}, 0),
                ({{RawSql.Literal(HiddenContainer)}}, {{RawSql.Literal(HiddenContainer)}}, {{tenant}}, {{workspace}}, 0),
                ({{RawSql.Literal(HiddenContainer)}}, {{RawSql.Literal(DeletedAncestor)}}, {{tenant}}, {{workspace}}, 1),
                ({{RawSql.Literal(HiddenChild)}}, {{RawSql.Literal(HiddenChild)}}, {{tenant}}, {{workspace}}, 0),
                ({{RawSql.Literal(HiddenChild)}}, {{RawSql.Literal(HiddenContainer)}}, {{tenant}}, {{workspace}}, 1),
                ({{RawSql.Literal(HiddenChild)}}, {{RawSql.Literal(DeletedAncestor)}}, {{tenant}}, {{workspace}}, 2),
                ({{RawSql.Literal(VisibleContainer)}}, {{RawSql.Literal(VisibleContainer)}}, {{tenant}}, {{workspace}}, 0),
                ({{RawSql.Literal(VisibleChild)}}, {{RawSql.Literal(VisibleChild)}}, {{tenant}}, {{workspace}}, 0),
                ({{RawSql.Literal(VisibleChild)}}, {{RawSql.Literal(VisibleContainer)}}, {{tenant}}, {{workspace}}, 1);
            """;

        var connection = await _fixture.OpenMigratorConnectionAsync();
        await using (connection.ConfigureAwait(false))
        {
            await RawSql.ExecuteAsync(connection, transaction: null, sql);
        }
    }

    private async Task SetAncestorBoundaryAsync(string lifecycle, bool templateOwned)
    {
        var template = templateOwned ? RawSql.Literal(M0SchemaSeed.Alpha.TemplateId) : "NULL";
        var source = templateOwned ? RawSql.Literal(DeletedAncestor) : "NULL";

        var connection = await _fixture.OpenMigratorConnectionAsync();
        await using (connection.ConfigureAwait(false))
        {
            await RawSql.ExecuteAsync(
                connection,
                transaction: null,
                $$"""
                  UPDATE item
                     SET lifecycle_state = '{{lifecycle}}',
                         template_id = {{template}},
                         template_source_id = {{source}}
                   WHERE id = {{RawSql.Literal(DeletedAncestor)}};
                  """);
        }
    }
}
