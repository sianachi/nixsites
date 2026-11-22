using System.Globalization;
using Nix.Integration.Tests.Harness;
using Npgsql;

namespace Nix.Integration.Tests.Persistence;

/// <summary>
/// The schema's second isolation mechanism: a reference from one tenant's row to another's cannot
/// be written, because every tenant-scoped foreign key is composite on <c>tenant_id</c>.
/// </summary>
/// <remarks>
/// <para>
/// Row-level security is not enough on its own here, and this is the subtle part. Postgres
/// evaluates referential integrity checks with the referenced table's owner privileges and does
/// not apply row-level security to them. So a plain <c>parent_id -> item(id)</c> constraint is
/// satisfied by <i>any</i> item, including one belonging to another customer - the policy's
/// <c>WITH CHECK</c> only asserts that the row being written carries this tenant's id, never that
/// the row it points at does.
/// </para>
/// <para>
/// Every one of these attempts is made as the migrator, which holds <c>BYPASSRLS</c>. That is
/// deliberate: it strips row-level security out of the picture entirely, so what is left when the
/// insert fails is the foreign key and nothing else. Run as the application role, these would fail
/// for the wrong reason and prove nothing about the constraint.
/// </para>
/// </remarks>
[Collection(PostgresSecondaryCollectionDefinition.Name)]
public sealed class CrossTenantReferenceTests : IAsyncLifetime
{
    private readonly NixPostgresFixture _fixture;

    public CrossTenantReferenceTests(NixPostgresFixture fixture) => _fixture = fixture;

    /// <summary>
    /// One attempt per composite foreign key: a row in Alpha whose reference points into Beta.
    /// </summary>
    public static TheoryData<string, string> CrossTenantWrites => new()
    {
        {
            "item.parent_id",
            $"""
            INSERT INTO item
                (id, tenant_id, workspace_id, type, parent_id, seq, properties, lifecycle_state,
                 purge_after, created_by, last_modified_by, created_at, last_modified_at)
            VALUES ({NewId()}, {Alpha}, {AlphaWorkspace}, 'folder', {BetaItem}, 2000, NULL,
                    'active', NULL, {AlphaPrincipal}, {AlphaPrincipal}, now(), now())
            """
        },
        {
            "item.workspace_id",
            $"""
            INSERT INTO item
                (id, tenant_id, workspace_id, type, parent_id, seq, properties, lifecycle_state,
                 purge_after, created_by, last_modified_by, created_at, last_modified_at)
            VALUES ({NewId()}, {Alpha}, {BetaWorkspace}, 'folder', NULL, 2000, NULL,
                    'active', NULL, {AlphaPrincipal}, {AlphaPrincipal}, now(), now())
            """
        },
        {
            "acl_entry.item_id",
            $"""
            INSERT INTO acl_entry
                (acl_entry_id, item_id, tenant_id, workspace_id, subject_type, subject_id, role,
                 effect, breaks_inheritance)
            VALUES ({NewId()}, {BetaItem}, {Alpha}, {AlphaWorkspace}, 'principal',
                    {AlphaPrincipal}, 'editor', 'allow', false)
            """
        },
        {
            "item_closure.ancestor_id",
            $"""
            INSERT INTO item_closure (descendant_id, ancestor_id, tenant_id, workspace_id, depth)
            VALUES ({AlphaItem}, {BetaItem}, {Alpha}, {AlphaWorkspace}, 1)
            """
        },
        {
            "item_closure.descendant_id",
            $"""
            INSERT INTO item_closure (descendant_id, ancestor_id, tenant_id, workspace_id, depth)
            VALUES ({BetaItem}, {AlphaItem}, {Alpha}, {AlphaWorkspace}, 1)
            """
        },
        {
            "group_membership.principal_id",
            $"""
            INSERT INTO group_membership (group_id, principal_id, tenant_id, source)
            VALUES ({AlphaGroup}, {BetaPrincipal}, {Alpha}, 'directory')
            """
        },
        {
            "group_membership.group_id",
            $"""
            INSERT INTO group_membership (group_id, principal_id, tenant_id, source)
            VALUES ({BetaGroup}, {AlphaPrincipal}, {Alpha}, 'directory')
            """
        },
        {
            "workspace_member.workspace_id",
            $"""
            INSERT INTO workspace_member
                (workspace_id, subject_type, subject_id, tenant_id, role, granted_by, granted_at)
            VALUES ({BetaWorkspace}, 'principal', {AlphaPrincipal}, {Alpha}, 'editor',
                    {AlphaPrincipal}, now())
            """
        },
    };

    private static string Alpha => RawSql.Literal(M0SchemaSeed.Alpha.TenantId);

    private static string AlphaWorkspace => RawSql.Literal(M0SchemaSeed.Alpha.WorkspaceId);

    private static string AlphaPrincipal => RawSql.Literal(M0SchemaSeed.Alpha.PrincipalId);

    private static string AlphaGroup => RawSql.Literal(M0SchemaSeed.Alpha.GroupId);

    private static string AlphaItem => RawSql.Literal(M0SchemaSeed.Alpha.ItemId);

    private static string BetaWorkspace => RawSql.Literal(M0SchemaSeed.Beta.WorkspaceId);

    private static string BetaPrincipal => RawSql.Literal(M0SchemaSeed.Beta.PrincipalId);

    private static string BetaGroup => RawSql.Literal(M0SchemaSeed.Beta.GroupId);

    private static string BetaItem => RawSql.Literal(M0SchemaSeed.Beta.ItemId);

    public async ValueTask InitializeAsync()
    {
        await _fixture.ResetAsync();
        await M0SchemaSeed.SeedBothTenantsAsync(_fixture);
    }

    public ValueTask DisposeAsync() => ValueTask.CompletedTask;

    [Theory]
    [MemberData(nameof(CrossTenantWrites))]
    public async Task A_reference_into_another_tenant_is_refused_by_the_foreign_key(
        string reference,
        string sql)
    {
        Assert.False(string.IsNullOrWhiteSpace(reference));

        var connection = await _fixture.OpenMigratorConnectionAsync();
        await using (connection.ConfigureAwait(false))
        {
            var failure = await Assert.ThrowsAsync<PostgresException>(
                async () => await RawSql.ExecuteAsync(connection, transaction: null, sql));

            Assert.Equal(PostgresErrorCodes.ForeignKeyViolation, failure.SqlState);
        }
    }

    [Fact]
    public async Task The_same_reference_within_one_tenant_is_accepted()
    {
        // Without this, every assertion above would also pass against a schema that refused all
        // writes - which is a different bug with the same symptom.
        var connection = await _fixture.OpenMigratorConnectionAsync();
        await using (connection.ConfigureAwait(false))
        {
            var written = await RawSql.ExecuteAsync(
                connection,
                transaction: null,
                $"""
                INSERT INTO item
                    (id, tenant_id, workspace_id, type, parent_id, seq, properties,
                     lifecycle_state, purge_after, created_by, last_modified_by, created_at,
                     last_modified_at)
                VALUES ({NewId()}, {Alpha}, {AlphaWorkspace}, 'folder', {AlphaItem}, 2000, NULL,
                        'active', NULL, {AlphaPrincipal}, {AlphaPrincipal}, now(), now())
                """);

            Assert.Equal(1, written);
        }
    }

    private static string NewId() => "gen_random_uuid()";
}
