using System.Globalization;
using Nix.Domain.Items;
using Nix.Domain.Primitives;
using Nix.Domain.Tenancy;
using Nix.Features.Internal;
using Nix.Features.Items;
using Nix.Integration.Tests.Harness;
using Nix.Messaging;

namespace Nix.Integration.Tests.Persistence;

/// <summary>
/// The internal authorization surface answers exactly what the collaboration service needs and
/// nothing an outsider could use: a readable item yields its facts, everything else is one
/// uniform "not found".
/// </summary>
/// <remarks>
/// These run through the use cases, the same way the endpoint dispatches them, because the
/// refusals are decisions the handlers take. The HTTP boundary in front (shared secret, forwarded
/// token) is covered in the unit suite - what a live database adds here is row-level security and
/// the membership rows the resolver reads.
/// </remarks>
[Collection(PostgresCollectionDefinition.Name)]
public sealed class InternalAuthorizationTests : IAsyncLifetime
{
    /// <summary>A principal of the first tenant holding no grant of any kind.</summary>
    private static readonly Guid Outsider = new("3000000a-3333-4333-8333-3000000a0001");

    /// <summary>A member of the workspace, admitted as a viewer.</summary>
    private static readonly Guid Viewer = new("3000000a-3333-4333-8333-3000000a0002");

    private readonly NixPostgresFixture _fixture;

    public InternalAuthorizationTests(NixPostgresFixture fixture) => _fixture = fixture;

    private static CancellationToken Cancellation => TestContext.Current.CancellationToken;

    private static ItemId AlphaItem => ItemId.From(M0SchemaSeed.Alpha.ItemId);

    public async ValueTask InitializeAsync()
    {
        await _fixture.ResetAsync();
        await M0SchemaSeed.SeedBothTenantsAsync(_fixture);
        await SeedPrincipalsAsync();
    }

    public ValueTask DisposeAsync() => ValueTask.CompletedTask;

    [Fact]
    public async Task An_editor_is_told_they_may_write_and_which_body_kind_the_item_carries()
    {
        var work = await _fixture.Application.BeginUnitOfWorkAsync(TestTenants.AlphaContext, Cancellation);
        await using (work.ConfigureAwait(false))
        {
            var dispatcher = work.Resolve<NixDispatcher>();
            var answer = await dispatcher.QueryAsync<GetItemAuthorization, Result<ItemAuthorization>>(
                new GetItemAuthorization(AlphaItem),
                Cancellation);

            Assert.True(answer.IsSuccess);
            Assert.True(answer.Value.CanWrite);
            Assert.Equal(M0SchemaSeed.Alpha.TenantId, answer.Value.TenantId.Value);
            Assert.Equal(M0SchemaSeed.Alpha.WorkspaceId, answer.Value.WorkspaceId.Value);
            Assert.Equal(M0SchemaSeed.Alpha.PrincipalId, answer.Value.PrincipalId.Value);

            // The body kind is the item's own type, verbatim - the seed's legacy 'folder' included.
            // Dispatching on it is the consumer's business; reporting it truthfully is this one's.
            Assert.Equal("folder", answer.Value.BodyKind);
        }
    }

    [Fact]
    public async Task A_viewer_may_open_the_item_but_is_told_they_may_not_write_it()
    {
        var work = await _fixture.Application.BeginUnitOfWorkAsync(ContextFor(Viewer), Cancellation);
        await using (work.ConfigureAwait(false))
        {
            var dispatcher = work.Resolve<NixDispatcher>();
            var answer = await dispatcher.QueryAsync<GetItemAuthorization, Result<ItemAuthorization>>(
                new GetItemAuthorization(AlphaItem),
                Cancellation);

            Assert.True(answer.IsSuccess);
            Assert.False(answer.Value.CanWrite);
        }
    }

    [Fact]
    public async Task A_principal_with_no_grant_hears_not_found_rather_than_forbidden()
    {
        var work = await _fixture.Application.BeginUnitOfWorkAsync(ContextFor(Outsider), Cancellation);
        await using (work.ConfigureAwait(false))
        {
            var dispatcher = work.Resolve<NixDispatcher>();
            var answer = await dispatcher.QueryAsync<GetItemAuthorization, Result<ItemAuthorization>>(
                new GetItemAuthorization(AlphaItem),
                Cancellation);

            Assert.True(answer.IsFailure);
            Assert.Equal("internal.not_found", answer.Error.Code);
        }
    }

    [Fact]
    public async Task Another_tenant_cannot_learn_whether_the_item_exists()
    {
        var work = await _fixture.Application.BeginUnitOfWorkAsync(TestTenants.BetaContext, Cancellation);
        await using (work.ConfigureAwait(false))
        {
            var dispatcher = work.Resolve<NixDispatcher>();
            var answer = await dispatcher.QueryAsync<GetItemAuthorization, Result<ItemAuthorization>>(
                new GetItemAuthorization(AlphaItem),
                Cancellation);

            Assert.True(answer.IsFailure);
            Assert.Equal("internal.not_found", answer.Error.Code);
        }
    }

    [Fact]
    public async Task A_deleted_parent_hides_its_active_child_from_collaboration_authorization()
    {
        var work = await _fixture.Application.BeginUnitOfWorkAsync(TestTenants.AlphaContext, Cancellation);
        await using (work.ConfigureAwait(false))
        {
            var dispatcher = work.Resolve<NixDispatcher>();
            var created = await dispatcher.SendAsync<CreateItem, Item>(
                new CreateItem(
                    WorkspaceId.From(M0SchemaSeed.Alpha.WorkspaceId),
                    "note",
                    "Hidden child",
                    AlphaItem,
                    null),
                Cancellation);
            Assert.True(created.IsSuccess);

            var deleted = await dispatcher.SendAsync<DeleteItem, ItemId>(
                new DeleteItem(AlphaItem), Cancellation);
            Assert.True(deleted.IsSuccess);

            var answer = await dispatcher.QueryAsync<GetItemAuthorization, Result<ItemAuthorization>>(
                new GetItemAuthorization(created.Value.Id),
                Cancellation);

            Assert.True(answer.IsFailure);
            Assert.Equal("internal.not_found", answer.Error.Code);
        }
    }

    [Fact]
    public async Task A_touch_bumps_the_modification_stamp_without_changing_anything_else()
    {
        var work = await _fixture.Application.BeginUnitOfWorkAsync(TestTenants.AlphaContext, Cancellation);
        await using (work.ConfigureAwait(false))
        {
            var dispatcher = work.Resolve<NixDispatcher>();

            var before = await dispatcher.QueryAsync<GetItem, Result<Item>>(new GetItem(AlphaItem), Cancellation);
            Assert.True(before.IsSuccess);

            var touched = await dispatcher.SendAsync<TouchItem, ItemId>(new TouchItem(AlphaItem), Cancellation);
            Assert.True(touched.IsSuccess);

            var after = await dispatcher.QueryAsync<GetItem, Result<Item>>(new GetItem(AlphaItem), Cancellation);
            Assert.True(after.IsSuccess);
            Assert.True(after.Value.LastModifiedAt > before.Value.LastModifiedAt);
            Assert.Equal(M0SchemaSeed.Alpha.PrincipalId, after.Value.LastModifiedBy.Value);
            Assert.Equal(before.Value.Type, after.Value.Type);
            Assert.Equal(before.Value.Seq, after.Value.Seq);
            Assert.Equal(before.Value.Properties, after.Value.Properties);
        }
    }

    [Fact]
    public async Task A_viewer_cannot_claim_to_have_modified_the_body()
    {
        var work = await _fixture.Application.BeginUnitOfWorkAsync(ContextFor(Viewer), Cancellation);
        await using (work.ConfigureAwait(false))
        {
            var dispatcher = work.Resolve<NixDispatcher>();

            var touched = await dispatcher.SendAsync<TouchItem, ItemId>(new TouchItem(AlphaItem), Cancellation);

            Assert.True(touched.IsFailure);
            Assert.Equal("internal.not_found", touched.Error.Code);
        }
    }

    private static Nix.Abstractions.NixSessionContext ContextFor(Guid principalId) =>
        TestTenants.ContextFor(M0SchemaSeed.Alpha.TenantId, M0SchemaSeed.Alpha.WorkspaceId, principalId);

    private async Task SeedPrincipalsAsync()
    {
        var tenant = RawSql.Literal(M0SchemaSeed.Alpha.TenantId);
        var workspace = RawSql.Literal(M0SchemaSeed.Alpha.WorkspaceId);
        var granter = RawSql.Literal(M0SchemaSeed.Alpha.PrincipalId);

        var sql = $"""
            INSERT INTO principal
                (principal_id, tenant_id, external_subject, kind, display_name, email, status,
                 deprovisioned_at)
            VALUES
                ({RawSql.Literal(Outsider)}, {tenant}, 'alpha-internal-outsider', 'user', 'Outsider',
                 'internal-outsider@example.test', 'active', NULL),
                ({RawSql.Literal(Viewer)}, {tenant}, 'alpha-internal-viewer', 'user', 'Viewer',
                 'internal-viewer@example.test', 'active', NULL);

            INSERT INTO workspace_member
                (workspace_id, subject_type, subject_id, tenant_id, role, granted_by, granted_at)
            VALUES ({workspace}, 'principal', {RawSql.Literal(Viewer)}, {tenant}, 'viewer', {granter}, now());
            """;

        var connection = await _fixture.OpenMigratorConnectionAsync();
        await using (connection.ConfigureAwait(false))
        {
            await RawSql.ExecuteAsync(connection, transaction: null, sql);
        }
    }
}
