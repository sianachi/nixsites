using System.Collections.Immutable;
using System.Globalization;
using Nix.Abstractions;
using Nix.Domain.Items;
using Nix.Domain.Query;
using Nix.Domain.Templates;
using Nix.Domain.Tenancy;
using Nix.Domain.Views;
using Nix.Integration.Tests.Harness;
using Nix.Persistence.Templates;

namespace Nix.Integration.Tests.Persistence;

/// <summary>
/// Hidden template envelopes have two deliberately narrow escape hatches: Collab may hydrate the
/// exact staged bodies named by an unfinished operation, and the template catalog may read active
/// revisions. Neither permission may turn those envelopes into ordinary workspace content.
/// </summary>
[Collection(PostgresSecondaryCollectionDefinition.Name)]
public sealed class TemplateBoundarySecurityIntegrationTests : IAsyncLifetime
{
    private static readonly Guid HiddenActiveRoot = new("a1000000-1111-4111-8111-a10000000001");
    private static readonly Guid HiddenActiveChild = new("a1000000-1111-4111-8111-a10000000002");
    private static readonly Guid HiddenProvisioningRoot = new("a1000000-1111-4111-8111-a10000000003");
    private static readonly Guid HiddenProvisioningChild = new("a1000000-1111-4111-8111-a10000000004");
    private static readonly Guid ExistingPriorChild = new("a1000000-1111-4111-8111-a10000000005");
    private static readonly Guid ApplicationBodylessTarget = new("a1000000-1111-4111-8111-a10000000006");
    private static readonly Guid ApplicationBodyTarget = new("a1000000-1111-4111-8111-a10000000007");
    private static readonly Guid OperationBodylessTarget = new("a1000000-1111-4111-8111-a10000000008");
    private static readonly Guid OperationBodyTarget = new("a1000000-1111-4111-8111-a10000000009");
    private static readonly Guid OperationActiveTarget = new("a1000000-1111-4111-8111-a1000000000a");

    private static readonly Guid ActiveRootSource = new("a2000000-1111-4111-8111-a20000000001");
    private static readonly Guid ActiveChildSource = new("a2000000-1111-4111-8111-a20000000002");
    private static readonly Guid ProvisioningRootSource = new("a2000000-1111-4111-8111-a20000000003");
    private static readonly Guid ProvisioningChildSource = new("a2000000-1111-4111-8111-a20000000004");

    private readonly NixPostgresFixture _fixture;

    public TemplateBoundarySecurityIntegrationTests(NixPostgresFixture fixture) => _fixture = fixture;

    private static CancellationToken Cancellation => TestContext.Current.CancellationToken;

    private static WorkspaceId Workspace => WorkspaceId.From(M0SchemaSeed.Alpha.WorkspaceId);

    public async ValueTask InitializeAsync()
    {
        await _fixture.ResetAsync();
        await M0SchemaSeed.SeedBothTenantsAsync(_fixture);
        await SeedTemplateBoundaryAsync();
    }

    public ValueTask DisposeAsync() => ValueTask.CompletedTask;

    [Fact]
    public async Task Staging_authorization_writes_only_new_body_bearing_provisioning_targets()
    {
        var work = await _fixture.Application.BeginUnitOfWorkAsync(TestTenants.AlphaContext, Cancellation);
        await using (work.ConfigureAwait(false))
        {
            var store = work.Resolve<TemplateStore>();
            var applicationId = M0SchemaSeed.Alpha.TemplateApplicationId;
            var operationId = M0SchemaSeed.Alpha.TemplateOperationId;

            await AssertWriteAsync(store, applicationId, M0SchemaSeed.Alpha.ItemId, expected: false);
            await AssertWriteAsync(store, applicationId, ExistingPriorChild, expected: false);
            await AssertWriteAsync(store, applicationId, ApplicationBodylessTarget, expected: false);
            await AssertWriteAsync(store, applicationId, ApplicationBodyTarget, expected: true);
            await AssertWriteAsync(store, applicationId, HiddenActiveRoot, expected: false);

            await AssertWriteAsync(store, operationId, OperationBodylessTarget, expected: false);
            await AssertWriteAsync(store, operationId, OperationActiveTarget, expected: false);
            await AssertWriteAsync(store, operationId, OperationBodyTarget, expected: true);
            await AssertWriteAsync(store, operationId, HiddenActiveRoot, expected: false);
        }
    }

    [Fact]
    public async Task Hidden_active_and_provisioning_template_items_never_enter_ordinary_read_surfaces()
    {
        var hidden = new HashSet<ItemId>
        {
            ItemId.From(HiddenActiveRoot),
            ItemId.From(HiddenActiveChild),
            ItemId.From(HiddenProvisioningRoot),
            ItemId.From(HiddenProvisioningChild),
            ItemId.From(ApplicationBodylessTarget),
            ItemId.From(ApplicationBodyTarget),
            ItemId.From(OperationBodylessTarget),
            ItemId.From(OperationBodyTarget),
            ItemId.From(OperationActiveTarget),
        };

        var work = await _fixture.Application.BeginUnitOfWorkAsync(TestTenants.AlphaContext, Cancellation);
        await using (work.ConfigureAwait(false))
        {
            var tree = work.Resolve<IItemTree>();
            Assert.Null(await tree.FindAsync(ItemId.From(HiddenActiveRoot), Cancellation));
            Assert.Null(await tree.FindAsync(ItemId.From(HiddenProvisioningRoot), Cancellation));

            var roots = await tree.ListChildrenAsync(
                Workspace,
                parentId: null,
                includeDeleted: true,
                afterSeq: null,
                limit: 100,
                Cancellation);
            Assert.DoesNotContain(roots, item => hidden.Contains(item.Id));

            var search = await work.Resolve<IItemSearch>().FindAsync(
                "vaultcanary",
                [Workspace],
                limit: 100,
                petSourcesOnly: false,
                Cancellation);
            Assert.DoesNotContain(search, item => hidden.Contains(item.Id));

            var graph = await work.Resolve<IWorkspaceGraph>().ReadAsync(
                Workspace,
                [Workspace],
                nodeLimit: 100,
                linkLimit: 100,
                Cancellation);
            Assert.DoesNotContain(graph.Nodes, node => hidden.Contains(node.Id));
            Assert.DoesNotContain(
                graph.Links,
                link => hidden.Contains(link.SourceId) || hidden.Contains(link.TargetId));

            var calendar = await work.Resolve<IWorkspaceCalendar>().ReadAsync(
                Workspace,
                [Workspace],
                "2026-08-01",
                "2026-08-31",
                entryLimit: 100,
                Cancellation);
            Assert.DoesNotContain(calendar.Entries, entry => hidden.Contains(entry.ItemId));
            Assert.DoesNotContain(calendar.Unplaceable, entry => hidden.Contains(entry.ContainerId));

            var query = await work.Resolve<IItemQuery>().RunAsync(
                ItemId.From(M0SchemaSeed.Alpha.ItemId),
                ImmutableArray<FilterRule>.Empty,
                QueryOrder.Recency,
                new DateOnly(2026, 8, 16),
                [Workspace],
                limit: 100,
                Cancellation);
            Assert.DoesNotContain(query.Items, item => hidden.Contains(item.Id));

            var shelf = work.Resolve<IBookmarkShelf>();
            var countBefore = await shelf.CountAsync(Cancellation);
            Assert.False(await shelf.KeepAsync(ItemId.From(HiddenActiveRoot), [Workspace], Cancellation));
            Assert.False(await shelf.KeepAsync(ItemId.From(HiddenProvisioningRoot), [Workspace], Cancellation));
            Assert.DoesNotContain(await shelf.ListAsync([Workspace], Cancellation), item => hidden.Contains(item.ItemId));
            Assert.Equal(countBefore, await shelf.CountAsync(Cancellation));
        }
    }

    private static async Task AssertWriteAsync(
        TemplateStore store,
        Guid operationId,
        Guid itemId,
        bool expected)
    {
        var result = await store.AuthorizeOperationItemAsync(
            operationId,
            ItemId.From(itemId),
            Cancellation);

        Assert.True(result.IsSuccess, result.IsSuccess ? string.Empty : result.Error.Message);
        Assert.Equal(expected, result.Value.CanWrite);
    }

    private async Task SeedTemplateBoundaryAsync()
    {
        var tenant = RawSql.Literal(M0SchemaSeed.Alpha.TenantId);
        var workspace = RawSql.Literal(M0SchemaSeed.Alpha.WorkspaceId);
        var principal = RawSql.Literal(M0SchemaSeed.Alpha.PrincipalId);
        var template = RawSql.Literal(M0SchemaSeed.Alpha.TemplateId);
        var operation = RawSql.Literal(M0SchemaSeed.Alpha.TemplateOperationId);
        var application = RawSql.Literal(M0SchemaSeed.Alpha.TemplateApplicationId);
        var ordinaryRoot = RawSql.Literal(M0SchemaSeed.Alpha.ItemId);

        var sql = $$"""
            UPDATE workspace_template
               SET root_item_id = {{RawSql.Literal(HiddenActiveRoot)}},
                   pending_root_item_id = {{RawSql.Literal(HiddenProvisioningRoot)}},
                   state = 'active'
             WHERE template_id = {{template}};

            INSERT INTO item
                (id, tenant_id, workspace_id, type, parent_id, seq, properties, views,
                 template_id, template_source_id, lifecycle_state, purge_after, created_by,
                 last_modified_by, created_at, last_modified_at)
            VALUES
                ({{RawSql.Literal(HiddenActiveRoot)}}, {{tenant}}, {{workspace}}, 'note', NULL, 100,
                 '{"title":"vaultcanary active calendar"}'::jsonb,
                 '{"views":[{"id":"calendar","kind":"calendar","name":"Calendar","dateProperty":"due"}]}'::jsonb,
                 {{template}}, {{RawSql.Literal(ActiveRootSource)}}, 'active', NULL, {{principal}}, {{principal}}, now(), now()),
                ({{RawSql.Literal(HiddenActiveChild)}}, {{tenant}}, {{workspace}}, 'note',
                 {{RawSql.Literal(HiddenActiveRoot)}}, 200,
                 '{"title":"vaultcanary active child","due":"2026-08-16"}'::jsonb, NULL,
                 {{template}}, {{RawSql.Literal(ActiveChildSource)}}, 'active', NULL, {{principal}}, {{principal}}, now(), now()),
                ({{RawSql.Literal(HiddenProvisioningRoot)}}, {{tenant}}, {{workspace}}, 'note', NULL, 300,
                 '{"title":"vaultcanary provisioning calendar"}'::jsonb,
                 '{"views":[{"id":"calendar","kind":"calendar","name":"Calendar","dateProperty":"due"}]}'::jsonb,
                 {{template}}, {{RawSql.Literal(ProvisioningRootSource)}}, 'provisioning', NULL, {{principal}}, {{principal}}, now(), now()),
                ({{RawSql.Literal(HiddenProvisioningChild)}}, {{tenant}}, {{workspace}}, 'note',
                 {{RawSql.Literal(HiddenProvisioningRoot)}}, 400,
                 '{"title":"vaultcanary provisioning child","due":"2026-08-17"}'::jsonb, NULL,
                 {{template}}, {{RawSql.Literal(ProvisioningChildSource)}}, 'provisioning', NULL, {{principal}}, {{principal}}, now(), now()),
                ({{RawSql.Literal(ExistingPriorChild)}}, {{tenant}}, {{workspace}}, 'note', {{ordinaryRoot}}, 500,
                 '{"title":"Existing prior child"}'::jsonb, NULL, NULL, NULL, 'active', NULL,
                 {{principal}}, {{principal}}, now(), now()),
                ({{RawSql.Literal(ApplicationBodylessTarget)}}, {{tenant}}, {{workspace}}, 'note', {{ordinaryRoot}}, 600,
                 '{"title":"Application bodyless target"}'::jsonb, NULL, NULL, NULL, 'provisioning', NULL,
                 {{principal}}, {{principal}}, now(), now()),
                ({{RawSql.Literal(ApplicationBodyTarget)}}, {{tenant}}, {{workspace}}, 'note', {{ordinaryRoot}}, 700,
                 '{"title":"Application body target"}'::jsonb, NULL, NULL, NULL, 'provisioning', NULL,
                 {{principal}}, {{principal}}, now(), now()),
                ({{RawSql.Literal(OperationBodylessTarget)}}, {{tenant}}, {{workspace}}, 'note', NULL, 800,
                 '{"title":"Operation bodyless target"}'::jsonb, NULL, {{template}},
                 {{RawSql.Literal(Guid.Parse("a2000000-1111-4111-8111-a20000000008"))}}, 'provisioning', NULL,
                 {{principal}}, {{principal}}, now(), now()),
                ({{RawSql.Literal(OperationBodyTarget)}}, {{tenant}}, {{workspace}}, 'note', NULL, 900,
                 '{"title":"Operation body target"}'::jsonb, NULL, {{template}},
                 {{RawSql.Literal(Guid.Parse("a2000000-1111-4111-8111-a20000000009"))}}, 'provisioning', NULL,
                 {{principal}}, {{principal}}, now(), now()),
                ({{RawSql.Literal(OperationActiveTarget)}}, {{tenant}}, {{workspace}}, 'note', NULL, 1000,
                 '{"title":"Operation active target"}'::jsonb, NULL, {{template}},
                 {{RawSql.Literal(Guid.Parse("a2000000-1111-4111-8111-a2000000000a"))}}, 'active', NULL,
                 {{principal}}, {{principal}}, now(), now());

            INSERT INTO item_closure (tenant_id, workspace_id, ancestor_id, descendant_id, depth)
            VALUES
                ({{tenant}}, {{workspace}}, {{RawSql.Literal(HiddenActiveRoot)}}, {{RawSql.Literal(HiddenActiveRoot)}}, 0),
                ({{tenant}}, {{workspace}}, {{RawSql.Literal(HiddenActiveChild)}}, {{RawSql.Literal(HiddenActiveChild)}}, 0),
                ({{tenant}}, {{workspace}}, {{RawSql.Literal(HiddenActiveRoot)}}, {{RawSql.Literal(HiddenActiveChild)}}, 1),
                ({{tenant}}, {{workspace}}, {{RawSql.Literal(HiddenProvisioningRoot)}}, {{RawSql.Literal(HiddenProvisioningRoot)}}, 0),
                ({{tenant}}, {{workspace}}, {{RawSql.Literal(HiddenProvisioningChild)}}, {{RawSql.Literal(HiddenProvisioningChild)}}, 0),
                ({{tenant}}, {{workspace}}, {{RawSql.Literal(HiddenProvisioningRoot)}}, {{RawSql.Literal(HiddenProvisioningChild)}}, 1),
                ({{tenant}}, {{workspace}}, {{RawSql.Literal(ExistingPriorChild)}}, {{RawSql.Literal(ExistingPriorChild)}}, 0),
                ({{tenant}}, {{workspace}}, {{ordinaryRoot}}, {{RawSql.Literal(ExistingPriorChild)}}, 1),
                ({{tenant}}, {{workspace}}, {{RawSql.Literal(ApplicationBodylessTarget)}}, {{RawSql.Literal(ApplicationBodylessTarget)}}, 0),
                ({{tenant}}, {{workspace}}, {{ordinaryRoot}}, {{RawSql.Literal(ApplicationBodylessTarget)}}, 1),
                ({{tenant}}, {{workspace}}, {{RawSql.Literal(ApplicationBodyTarget)}}, {{RawSql.Literal(ApplicationBodyTarget)}}, 0),
                ({{tenant}}, {{workspace}}, {{ordinaryRoot}}, {{RawSql.Literal(ApplicationBodyTarget)}}, 1),
                ({{tenant}}, {{workspace}}, {{RawSql.Literal(OperationBodylessTarget)}}, {{RawSql.Literal(OperationBodylessTarget)}}, 0),
                ({{tenant}}, {{workspace}}, {{RawSql.Literal(OperationBodyTarget)}}, {{RawSql.Literal(OperationBodyTarget)}}, 0),
                ({{tenant}}, {{workspace}}, {{RawSql.Literal(OperationActiveTarget)}}, {{RawSql.Literal(OperationActiveTarget)}}, 0);

            UPDATE template_application_item
               SET source_item_id = {{RawSql.Literal(HiddenActiveRoot)}},
                   item_type = 'note',
                   body_required = true
             WHERE application_id = {{application}};

            INSERT INTO template_application_item
                (application_id, template_source_id, tenant_id, source_item_id, item_type,
                 target_item_id, is_root, created, body_required)
            VALUES
                ({{application}}, {{RawSql.Literal(ActiveChildSource)}}, {{tenant}}, {{RawSql.Literal(HiddenActiveChild)}},
                 'note', {{RawSql.Literal(ExistingPriorChild)}}, false, false, true),
                ({{application}}, {{RawSql.Literal(ProvisioningRootSource)}}, {{tenant}}, {{RawSql.Literal(HiddenProvisioningRoot)}},
                 'note', {{RawSql.Literal(ApplicationBodylessTarget)}}, false, true, false),
                ({{application}}, {{RawSql.Literal(ProvisioningChildSource)}}, {{tenant}}, {{RawSql.Literal(HiddenProvisioningChild)}},
                 'note', {{RawSql.Literal(ApplicationBodyTarget)}}, false, true, true);

            UPDATE template_operation_item
               SET source_item_id = {{RawSql.Literal(HiddenActiveRoot)}},
                   target_item_id = {{RawSql.Literal(OperationBodyTarget)}},
                   item_type = 'note',
                   body_required = true
             WHERE operation_id = {{operation}};

            INSERT INTO template_operation_item
                (operation_id, template_source_id, tenant_id, source_item_id, target_item_id,
                 item_type, body_required)
            VALUES
                ({{operation}}, {{RawSql.Literal(ActiveChildSource)}}, {{tenant}}, {{RawSql.Literal(HiddenActiveChild)}},
                 {{RawSql.Literal(OperationBodylessTarget)}}, 'note', false),
                ({{operation}}, {{RawSql.Literal(ProvisioningRootSource)}}, {{tenant}}, {{RawSql.Literal(HiddenProvisioningRoot)}},
                 {{RawSql.Literal(OperationActiveTarget)}}, 'note', true);

            INSERT INTO item_search (tenant_id, item_id, seq, updated_at, body_vector)
            VALUES
                ({{tenant}}, {{RawSql.Literal(HiddenActiveRoot)}}, 1, now(), to_tsvector('english', 'vaultcanary active root')),
                ({{tenant}}, {{RawSql.Literal(HiddenActiveChild)}}, 1, now(), to_tsvector('english', 'vaultcanary active child')),
                ({{tenant}}, {{RawSql.Literal(HiddenProvisioningRoot)}}, 1, now(), to_tsvector('english', 'vaultcanary provisioning root')),
                ({{tenant}}, {{RawSql.Literal(HiddenProvisioningChild)}}, 1, now(), to_tsvector('english', 'vaultcanary provisioning child'));

            INSERT INTO item_link (tenant_id, source_item_id, target_item_id, occurrences, seq)
            VALUES
                ({{tenant}}, {{RawSql.Literal(HiddenActiveRoot)}}, {{RawSql.Literal(HiddenActiveChild)}}, 1, 1),
                ({{tenant}}, {{RawSql.Literal(HiddenProvisioningRoot)}}, {{RawSql.Literal(HiddenProvisioningChild)}}, 1, 1);
            """;

        var connection = await _fixture.OpenMigratorConnectionAsync();
        await using (connection.ConfigureAwait(false))
        {
            await RawSql.ExecuteAsync(connection, transaction: null, sql);
        }
    }
}
