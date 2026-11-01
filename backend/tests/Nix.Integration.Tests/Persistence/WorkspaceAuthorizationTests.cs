using System.Globalization;
using Nix.Abstractions;
using Nix.Domain.Items;
using Nix.Domain.Primitives;
using Nix.Domain.Tenancy;
using Nix.Features.Internal;
using Nix.Features.Items;
using Nix.Integration.Tests.Harness;
using Nix.Messaging;
using Npgsql;

namespace Nix.Integration.Tests.Persistence;

/// <summary>
/// Membership decides what a principal can reach, and a principal who was granted nothing reaches
/// nothing.
/// </summary>
/// <remarks>
/// <para>
/// Row-level security proves that one tenant cannot see another's rows. It says nothing whatsoever
/// about two principals inside the same tenant, and until the permission resolver landed the answer
/// was that any authenticated principal could read every workspace their tenant owned. These tests
/// are the ones that would have caught that, so they are written from the refused side first: the
/// assertions that matter are the empty ones.
/// </para>
/// <para>
/// Everything runs through the use cases rather than the port, because the use case is where the
/// decision is taken. A test that called <see cref="IPermissionResolver"/> directly would prove the
/// resolver answers correctly while leaving open the only question worth asking — whether anybody
/// bothers to consult it.
/// </para>
/// </remarks>
[Collection(PostgresSecondaryCollectionDefinition.Name)]
public sealed class WorkspaceAuthorizationTests : IAsyncLifetime
{
    /// <summary>A principal of the first tenant holding no grant of any kind.</summary>
    private static readonly Guid Outsider = new("1000000a-1111-4111-8111-1000000a0001");

    /// <summary>A member of the workspace, admitted as a viewer.</summary>
    private static readonly Guid Viewer = new("1000000a-1111-4111-8111-1000000a0002");

    /// <summary>A principal admitted only through a group that holds an editor grant.</summary>
    private static readonly Guid GroupMember = new("1000000a-1111-4111-8111-1000000a0003");

    /// <summary>A tenant administrator who was never added to the workspace.</summary>
    private static readonly Guid Administrator = new("1000000a-1111-4111-8111-1000000a0004");

    /// <summary>A member whose stored role this build does not recognise.</summary>
    private static readonly Guid FutureRoleHolder = new("1000000a-1111-4111-8111-1000000a0005");

    /// <summary>The group carrying the editor grant.</summary>
    private static readonly Guid EditorGroup = new("1000000a-1111-4111-8111-1000000a0006");

    private readonly NixPostgresFixture _fixture;

    public WorkspaceAuthorizationTests(NixPostgresFixture fixture) => _fixture = fixture;

    private static CancellationToken Cancellation => TestContext.Current.CancellationToken;

    private static WorkspaceId AlphaWorkspace => WorkspaceId.From(M0SchemaSeed.Alpha.WorkspaceId);

    private static ItemId AlphaItem => ItemId.From(M0SchemaSeed.Alpha.ItemId);

    public async ValueTask InitializeAsync()
    {
        await _fixture.ResetAsync();
        await M0SchemaSeed.SeedBothTenantsAsync(_fixture);
        await SeedPrincipalsAsync();
    }

    public ValueTask DisposeAsync() => ValueTask.CompletedTask;

    [Fact]
    public async Task A_principal_who_is_not_a_member_sees_none_of_the_workspace()
    {
        var work = await _fixture.Application.BeginUnitOfWorkAsync(ContextFor(Outsider), Cancellation);
        await using (work.ConfigureAwait(false))
        {
            var dispatcher = work.Resolve<NixDispatcher>();
            var listing = await dispatcher.QueryAsync<ListItems, Result<IReadOnlyList<Item>>>(
                new ListItems(AlphaWorkspace, null, false, null, 50),
                Cancellation);

            Assert.True(listing.IsFailure);
            Assert.Equal("workspaces.not_found", listing.Error.Code);

            // The item exists, is in this principal's own tenant, and is therefore visible to
            // row-level security. Only the membership check keeps it out of the answer.
            var read = await dispatcher.QueryAsync<GetItem, Result<Item>>(new GetItem(AlphaItem), Cancellation);

            Assert.True(read.IsFailure);
            Assert.Equal("items.not_found", read.Error.Code);
        }
    }

    [Fact]
    public async Task A_principal_who_is_not_a_member_cannot_create_in_the_workspace()
    {
        var work = await _fixture.Application.BeginUnitOfWorkAsync(ContextFor(Outsider), Cancellation);
        await using (work.ConfigureAwait(false))
        {
            var dispatcher = work.Resolve<NixDispatcher>();
            var created = await dispatcher.SendAsync<CreateItem, Item>(
                new CreateItem(AlphaWorkspace, "note", "Trespass", null, null),
                Cancellation);

            Assert.True(created.IsFailure);
            Assert.Equal("workspaces.not_found", created.Error.Code);
        }
    }

    [Fact]
    public async Task A_member_sees_the_workspace()
    {
        var work = await _fixture.Application.BeginUnitOfWorkAsync(TestTenants.AlphaContext, Cancellation);
        await using (work.ConfigureAwait(false))
        {
            var dispatcher = work.Resolve<NixDispatcher>();
            var listing = await dispatcher.QueryAsync<ListItems, Result<IReadOnlyList<Item>>>(
                new ListItems(AlphaWorkspace, null, false, null, 50),
                Cancellation);

            Assert.True(listing.IsSuccess);
            Assert.Contains(listing.Value, item => item.Id == AlphaItem);
        }
    }

    [Fact]
    public async Task A_viewer_may_read_the_workspace_but_not_write_to_it()
    {
        var work = await _fixture.Application.BeginUnitOfWorkAsync(ContextFor(Viewer), Cancellation);
        await using (work.ConfigureAwait(false))
        {
            var dispatcher = work.Resolve<NixDispatcher>();
            var read = await dispatcher.QueryAsync<GetItem, Result<Item>>(new GetItem(AlphaItem), Cancellation);
            Assert.True(read.IsSuccess);

            var created = await dispatcher.SendAsync<CreateItem, Item>(
                new CreateItem(AlphaWorkspace, "note", "Not mine to write", null, null),
                Cancellation);
            Assert.True(created.IsFailure);

            var renamed = await dispatcher.SendAsync<RenameItem, Item>(
                new RenameItem(AlphaItem, "Renamed by a reader"),
                Cancellation);
            Assert.True(renamed.IsFailure);
        }
    }

    [Fact]
    public async Task Membership_through_a_group_grants_what_the_group_holds()
    {
        var work = await _fixture.Application.BeginUnitOfWorkAsync(ContextFor(GroupMember), Cancellation);
        await using (work.ConfigureAwait(false))
        {
            var dispatcher = work.Resolve<NixDispatcher>();

            // Never named in workspace_member; admitted entirely by being in a group that is.
            var read = await dispatcher.QueryAsync<GetItem, Result<Item>>(new GetItem(AlphaItem), Cancellation);
            Assert.True(read.IsSuccess);

            var created = await dispatcher.SendAsync<CreateItem, Item>(
                new CreateItem(AlphaWorkspace, "note", "Written through a group", null, null),
                Cancellation);
            Assert.True(created.IsSuccess);
        }
    }

    [Fact]
    public async Task A_tenant_administrator_cannot_reach_a_workspace_they_were_never_added_to()
    {
        var work = await _fixture.Application.BeginUnitOfWorkAsync(ContextFor(Administrator), Cancellation);
        await using (work.ConfigureAwait(false))
        {
            var permissions = work.Resolve<IPermissionResolver>();
            Assert.True(await permissions.IsTenantAdministratorAsync(Cancellation));
            Assert.DoesNotContain(AlphaWorkspace, await permissions.ReadableWorkspacesAsync(Cancellation));

            var dispatcher = work.Resolve<NixDispatcher>();
            var read = await dispatcher.QueryAsync<GetItem, Result<Item>>(new GetItem(AlphaItem), Cancellation);
            Assert.True(read.IsFailure);

            var body = await dispatcher.QueryAsync<GetItemAuthorization, Result<ItemAuthorization>>(
                new GetItemAuthorization(AlphaItem), Cancellation);
            Assert.True(body.IsFailure);

            var created = await dispatcher.SendAsync<CreateItem, Item>(
                new CreateItem(AlphaWorkspace, "note", "Administered", null, null),
                Cancellation);
            Assert.True(created.IsFailure);
        }
    }

    [Fact]
    public async Task Tenant_administration_does_not_make_absent_or_cross_tenant_workspaces_exist()
    {
        var work = await _fixture.Application.BeginUnitOfWorkAsync(
            ContextFor(Administrator),
            Cancellation);
        await using (work.ConfigureAwait(false))
        {
            var permissions = work.Resolve<IPermissionResolver>();
            Assert.False(await permissions.CanManageWorkspaceAsync(AlphaWorkspace, Cancellation));
            Assert.False(await permissions.CanReadWorkspaceAsync(
                WorkspaceId.From(Guid.NewGuid()),
                Cancellation));
            Assert.False(await permissions.CanReadWorkspaceAsync(
                WorkspaceId.From(M0SchemaSeed.Beta.WorkspaceId),
                Cancellation));
        }
    }

    [Fact]
    public async Task A_role_this_build_does_not_recognise_cannot_be_stored()
    {
        var connection = await _fixture.OpenMigratorConnectionAsync();
        await using (connection.ConfigureAwait(false))
        {
            var failure = await Assert.ThrowsAsync<PostgresException>(
                async () => await RawSql.ExecuteAsync(
                    connection,
                    null,
                    $"""
                    INSERT INTO workspace_member
                        (workspace_id, subject_type, subject_id, tenant_id, role,
                         granted_by, granted_at)
                    VALUES ({Literal(M0SchemaSeed.Alpha.WorkspaceId)}, 'principal',
                            {Literal(FutureRoleHolder)}, {Literal(M0SchemaSeed.Alpha.TenantId)},
                            'archivist', {Literal(M0SchemaSeed.Alpha.PrincipalId)}, now());
                    """));
            Assert.Equal(PostgresErrorCodes.CheckViolation, failure.SqlState);
        }
    }

    [Fact]
    public async Task An_administrator_of_one_tenant_is_not_an_administrator_of_another()
    {
        // The seeded Beta principal is an administrator of Beta. Asked inside Alpha's session it
        // must answer no - which is a question about the tenant parameter, not about the policies,
        // and would pass wrongly if the statement resolved the grant by principal alone.
        var context = TestTenants.ContextFor(
            TestTenants.Alpha,
            M0SchemaSeed.Alpha.WorkspaceId,
            M0SchemaSeed.Beta.PrincipalId);

        var work = await _fixture.Application.BeginUnitOfWorkAsync(context, Cancellation);
        await using (work.ConfigureAwait(false))
        {
            Assert.False(await work.Resolve<IPermissionResolver>().IsTenantAdministratorAsync(Cancellation));

            var dispatcher = work.Resolve<NixDispatcher>();
            var listing = await dispatcher.QueryAsync<ListItems, Result<IReadOnlyList<Item>>>(
                new ListItems(AlphaWorkspace, null, false, null, 50),
                Cancellation);

            Assert.True(listing.IsFailure);
        }
    }

    private static Nix.Abstractions.NixSessionContext ContextFor(Guid principalId) =>
        TestTenants.ContextFor(M0SchemaSeed.Alpha.TenantId, M0SchemaSeed.Alpha.WorkspaceId, principalId);

    private async Task SeedPrincipalsAsync()
    {
        var tenant = Literal(M0SchemaSeed.Alpha.TenantId);
        var workspace = Literal(M0SchemaSeed.Alpha.WorkspaceId);
        var granter = Literal(M0SchemaSeed.Alpha.PrincipalId);

        var sql = $"""
            INSERT INTO principal
                (principal_id, tenant_id, external_subject, kind, display_name, email, status,
                 deprovisioned_at)
            VALUES
                ({Literal(Outsider)}, {tenant}, 'alpha-outsider', 'user', 'Outsider',
                 'outsider@example.test', 'active', NULL),
                ({Literal(Viewer)}, {tenant}, 'alpha-viewer', 'user', 'Viewer',
                 'viewer@example.test', 'active', NULL),
                ({Literal(GroupMember)}, {tenant}, 'alpha-group-member', 'user', 'Group member',
                 'grouped@example.test', 'active', NULL),
                ({Literal(Administrator)}, {tenant}, 'alpha-administrator', 'user', 'Administrator',
                 'administrator@example.test', 'active', NULL),
                ({Literal(FutureRoleHolder)}, {tenant}, 'alpha-future-role', 'user', 'Future role',
                 'future@example.test', 'active', NULL);

            INSERT INTO principal_group (group_id, tenant_id, name, external_id)
            VALUES ({Literal(EditorGroup)}, {tenant}, 'Alpha editors', 'alpha-editors');

            INSERT INTO group_membership (group_id, principal_id, tenant_id, source)
            VALUES ({Literal(EditorGroup)}, {Literal(GroupMember)}, {tenant}, 'directory');

            INSERT INTO workspace_member
                (workspace_id, subject_type, subject_id, tenant_id, role, granted_by, granted_at)
            VALUES
                ({workspace}, 'principal', {Literal(Viewer)}, {tenant}, 'viewer', {granter}, now()),
                ({workspace}, 'group', {Literal(EditorGroup)}, {tenant}, 'editor', {granter}, now());

            INSERT INTO tenant_role
                (tenant_id, subject_type, subject_id, role, granted_by, granted_at)
            VALUES ({tenant}, 'principal', {Literal(Administrator)}, 'admin', {granter}, now());
            """;

        var connection = await _fixture.OpenMigratorConnectionAsync();
        await using (connection.ConfigureAwait(false))
        {
            await RawSql.ExecuteAsync(connection, transaction: null, sql);
        }
    }

    private static string Literal(Guid value) =>
        $"'{value.ToString("D", CultureInfo.InvariantCulture)}'::uuid";
}
