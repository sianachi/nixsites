using Microsoft.EntityFrameworkCore;
using Microsoft.EntityFrameworkCore.Infrastructure;
using Microsoft.EntityFrameworkCore.Migrations;
using Microsoft.EntityFrameworkCore.Storage;
using Microsoft.Extensions.DependencyInjection;
using Nix.Abstractions;
using Nix.Domain.Identity;
using Nix.Domain.Tenancy;
using Nix.Integration.Tests.Harness;
using Nix.Persistence;
using Npgsql;

namespace Nix.Integration.Tests.Persistence;

[Collection(PostgresCollectionDefinition.Name)]
public sealed class IdentityFoundationIntegrationTests : IAsyncLifetime
{
    private readonly NixPostgresFixture _fixture;

    public IdentityFoundationIntegrationTests(NixPostgresFixture fixture) => _fixture = fixture;

    private static CancellationToken Cancellation => TestContext.Current.CancellationToken;

    public async ValueTask InitializeAsync()
    {
        await _fixture.ResetAsync();
        await M0SchemaSeed.SeedBothTenantsAsync(_fixture);
    }

    public ValueTask DisposeAsync() => ValueTask.CompletedTask;

    [Fact]
    public async Task Provider_resolution_returns_the_exact_jit_registration()
    {
        var scope = _fixture.Application.CreateUnscopedScope();
        await using (scope.ConfigureAwait(false))
        {
            var directory = scope.ServiceProvider.GetRequiredService<IIdentityDirectory>();
            var registration = await directory.ResolveProviderAsync(
                "https://issuer.alpha.test",
                "nix-api",
                Cancellation);

            Assert.NotNull(registration);
            Assert.Equal(M0SchemaSeed.Alpha.ProviderId, registration.ProviderId.Value);
            Assert.False(registration.JitProvisioningEnabled);
            Assert.Equal(new Uri("https://issuer.alpha.test/userinfo"), registration.UserInfoUri);
        }
    }

    [Fact]
    public async Task External_resolution_is_issuer_qualified_and_core_resolution_uses_principal_id()
    {
        var scope = _fixture.Application.CreateUnscopedScope();
        await using (scope.ConfigureAwait(false))
        {
            var directory = scope.ServiceProvider.GetRequiredService<IIdentityDirectory>();
            var tenant = TenantId.From(M0SchemaSeed.Alpha.TenantId);

            var external = await directory.FindExternalPrincipalAsync(
                tenant,
                "https://issuer.alpha.test",
                "alpha-subject",
                Cancellation);
            var wrongIssuer = await directory.FindExternalPrincipalAsync(
                tenant,
                "https://other.example.test",
                "alpha-subject",
                Cancellation);
            var core = await directory.FindPrincipalByIdAsync(
                tenant,
                PrincipalId.From(M0SchemaSeed.Alpha.PrincipalId),
                Cancellation);

            Assert.Equal(M0SchemaSeed.Alpha.PrincipalId, external?.Id.Value);
            Assert.Null(wrongIssuer);
            Assert.Equal(M0SchemaSeed.Alpha.PrincipalId, core?.Id.Value);
        }
    }

    [Fact]
    public async Task Two_issuers_may_use_the_same_subject_without_colliding()
    {
        var connection = await _fixture.OpenMigratorConnectionAsync();
        await using (connection.ConfigureAwait(false))
        {
            var inserted = await RawSql.ExecuteAsync(
                connection,
                transaction: null,
                $"""
                INSERT INTO principal
                    (principal_id, tenant_id, external_issuer, external_subject, kind,
                     display_name, email_verified, status)
                VALUES ('30303030-3333-4333-8333-303030303030'::uuid,
                        '{M0SchemaSeed.Alpha.TenantId:D}'::uuid,
                        'https://second.alpha.test', 'alpha-subject', 'user',
                        'second issuer user', false, 'active');
                """);

            Assert.Equal(1, inserted);
        }
    }

    [Fact]
    public async Task Enabling_jit_without_userinfo_is_refused_by_the_database()
    {
        var connection = await _fixture.OpenMigratorConnectionAsync();
        await using (connection.ConfigureAwait(false))
        {
            var failure = await Assert.ThrowsAsync<PostgresException>(
                async () => await RawSql.ExecuteAsync(
                    connection,
                    transaction: null,
                    $"""
                    UPDATE identity_provider
                       SET userinfo_uri = NULL,
                           jit_provisioning_enabled = true
                     WHERE provider_id = '{M0SchemaSeed.Alpha.ProviderId:D}'::uuid;
                    """));

            Assert.Equal(PostgresErrorCodes.CheckViolation, failure.SqlState);
        }
    }

    [Fact]
    public async Task New_identity_provider_registrations_enable_jit_by_default()
    {
        var connection = await _fixture.OpenMigratorConnectionAsync();
        await using (connection.ConfigureAwait(false))
        {
            await RawSql.ExecuteAsync(
                connection,
                transaction: null,
                $"""
                INSERT INTO identity_provider
                    (provider_id, tenant_id, issuer, audience, jwks_uri,
                     allowed_algorithms, enabled, userinfo_uri)
                VALUES ('31313131-3131-4131-8131-313131313131'::uuid,
                        '{M0SchemaSeed.Alpha.TenantId:D}'::uuid,
                        'https://default-jit.alpha.test', 'default-jit-web',
                        'https://default-jit.alpha.test/oauth/v2/keys',
                        ARRAY['RS256']::text[], true,
                        'https://default-jit.alpha.test/oidc/v1/userinfo');
                """);

            var enabled = await RawSql.BooleanAsync(
                connection,
                """
                SELECT jit_provisioning_enabled
                  FROM identity_provider
                 WHERE provider_id = '31313131-3131-4131-8131-313131313131'::uuid;
                """);

            Assert.True(enabled);
        }
    }

    [Fact]
    public async Task Invitation_state_requires_the_matching_transition_fields()
    {
        var connection = await _fixture.OpenMigratorConnectionAsync();
        await using (connection.ConfigureAwait(false))
        {
            var failure = await Assert.ThrowsAsync<PostgresException>(
                async () => await RawSql.ExecuteAsync(
                    connection,
                    transaction: null,
                    $"""
                    UPDATE workspace_invitation
                       SET status = 'accepted'
                     WHERE invitation_id = '{M0SchemaSeed.Alpha.InvitationId:D}'::uuid;
                    """));

            Assert.Equal(PostgresErrorCodes.CheckViolation, failure.SqlState);
        }
    }

    [Fact]
    public async Task One_principal_cannot_own_two_personal_workspaces()
    {
        var connection = await _fixture.OpenMigratorConnectionAsync();
        await using (connection.ConfigureAwait(false))
        {
            await RawSql.ExecuteAsync(
                connection,
                transaction: null,
                $"""
                UPDATE workspace
                   SET personal_owner_principal_id = '{M0SchemaSeed.Alpha.PrincipalId:D}'::uuid
                 WHERE workspace_id = '{M0SchemaSeed.Alpha.WorkspaceId:D}'::uuid;
                """);

            var failure = await Assert.ThrowsAsync<PostgresException>(
                async () => await RawSql.ExecuteAsync(
                    connection,
                    transaction: null,
                    $"""
                    INSERT INTO workspace
                        (workspace_id, tenant_id, name, personal_owner_principal_id,
                         version_retention_days, coalesce_window_min, storage_quota_bytes, created_at)
                    VALUES ('40404040-4444-4444-8444-404040404040'::uuid,
                            '{M0SchemaSeed.Alpha.TenantId:D}'::uuid, 'duplicate personal',
                            '{M0SchemaSeed.Alpha.PrincipalId:D}'::uuid, 90, 10, 10737418240, now());
                    """));

            Assert.Equal(PostgresErrorCodes.UniqueViolation, failure.SqlState);
        }
    }

    [Fact]
    public async Task Identity_bounds_and_role_vocabularies_are_database_invariants()
    {
        await AssertCheckViolationAsync($"""
            UPDATE identity_provider SET userinfo_uri = ''
             WHERE provider_id = '{M0SchemaSeed.Alpha.ProviderId:D}'::uuid;
            """);
        await AssertCheckViolationAsync($"""
            UPDATE identity_provider SET userinfo_uri = repeat('ü', 1025)
             WHERE provider_id = '{M0SchemaSeed.Alpha.ProviderId:D}'::uuid;
            """);
        await AssertCheckViolationAsync($"""
            UPDATE principal SET email_verified = false, email_normalized = 'alpha@example.test'
             WHERE principal_id = '{M0SchemaSeed.Alpha.PrincipalId:D}'::uuid;
            """);
        await AssertCheckViolationAsync($"""
            UPDATE principal SET email_verified = true, email_normalized = NULL
             WHERE principal_id = '{M0SchemaSeed.Alpha.PrincipalId:D}'::uuid;
            """);
        await AssertCheckViolationAsync($"""
            UPDATE principal SET email_normalized = ''
             WHERE principal_id = '{M0SchemaSeed.Alpha.PrincipalId:D}'::uuid;
            """);
        await AssertCheckViolationAsync($"""
            UPDATE acl_entry SET role = 'administrator'
             WHERE acl_entry_id = '{M0SchemaSeed.Alpha.AclEntryId:D}'::uuid;
            """);
    }

    [Fact]
    public async Task Invitation_identity_is_immutable_and_terminal_under_the_runtime_role()
    {
        var tenantImmutable = await _fixture.Application.BeginUnitOfWorkAsync(
            TestTenants.AlphaContext,
            Cancellation);
        await using (tenantImmutable.ConfigureAwait(false))
        {
            var failure = await Assert.ThrowsAsync<PostgresException>(
                async () => await RawSql.ExecuteAsync(
                    (NpgsqlConnection)tenantImmutable.DbContext.Database.GetDbConnection(),
                    (NpgsqlTransaction)tenantImmutable.Transaction.GetDbTransaction(),
                    $"""
                    UPDATE workspace_invitation
                       SET tenant_id = '{M0SchemaSeed.Beta.TenantId:D}'::uuid
                     WHERE invitation_id = '{M0SchemaSeed.Alpha.InvitationId:D}'::uuid;
                    """));
            Assert.Equal(PostgresErrorCodes.CheckViolation, failure.SqlState);
            Assert.Contains("identity is immutable", failure.MessageText, StringComparison.Ordinal);
        }

        var immutable = await _fixture.Application.BeginUnitOfWorkAsync(TestTenants.AlphaContext, Cancellation);
        await using (immutable.ConfigureAwait(false))
        {
            var failure = await Assert.ThrowsAsync<PostgresException>(
                async () => await RawSql.ExecuteAsync(
                    (NpgsqlConnection)immutable.DbContext.Database.GetDbConnection(),
                    (NpgsqlTransaction)immutable.Transaction.GetDbTransaction(),
                    $"""
                    UPDATE workspace_invitation SET email_normalized = 'changed@example.test'
                     WHERE invitation_id = '{M0SchemaSeed.Alpha.InvitationId:D}'::uuid;
                    """));
            Assert.Equal(PostgresErrorCodes.CheckViolation, failure.SqlState);
        }

        var accept = await _fixture.Application.BeginUnitOfWorkAsync(TestTenants.AlphaContext, Cancellation);
        await using (accept.ConfigureAwait(false))
        {
            await RawSql.ExecuteAsync(
                (NpgsqlConnection)accept.DbContext.Database.GetDbConnection(),
                (NpgsqlTransaction)accept.Transaction.GetDbTransaction(),
                $"""
                UPDATE workspace_invitation
                   SET status = 'accepted', accepted_at = now(),
                       accepted_by_principal_id = '{M0SchemaSeed.Alpha.PrincipalId:D}'::uuid
                 WHERE invitation_id = '{M0SchemaSeed.Alpha.InvitationId:D}'::uuid;
                """);
            await accept.CommitAsync(Cancellation);
        }

        var terminal = await _fixture.Application.BeginUnitOfWorkAsync(TestTenants.AlphaContext, Cancellation);
        await using (terminal.ConfigureAwait(false))
        {
            var failure = await Assert.ThrowsAsync<PostgresException>(
                async () => await RawSql.ExecuteAsync(
                    (NpgsqlConnection)terminal.DbContext.Database.GetDbConnection(),
                    (NpgsqlTransaction)terminal.Transaction.GetDbTransaction(),
                    $"""
                    UPDATE workspace_invitation
                       SET status = 'revoked', accepted_at = NULL,
                           accepted_by_principal_id = NULL, revoked_at = now()
                     WHERE invitation_id = '{M0SchemaSeed.Alpha.InvitationId:D}'::uuid;
                    """));
            Assert.Equal(PostgresErrorCodes.CheckViolation, failure.SqlState);
        }
    }

    [Fact]
    public async Task New_workspace_foreign_keys_preserve_the_tenant_on_every_reference()
    {
        var connection = await _fixture.OpenMigratorConnectionAsync();
        await using (connection.ConfigureAwait(false))
        {
            var owner = await Assert.ThrowsAsync<PostgresException>(
                async () => await RawSql.ExecuteAsync(
                    connection,
                    null,
                    $"""
                    UPDATE workspace
                       SET personal_owner_principal_id = '{M0SchemaSeed.Beta.PrincipalId:D}'::uuid
                     WHERE workspace_id = '{M0SchemaSeed.Alpha.WorkspaceId:D}'::uuid;
                    """));
            Assert.Equal(PostgresErrorCodes.ForeignKeyViolation, owner.SqlState);

            var invitation = await Assert.ThrowsAsync<PostgresException>(
                async () => await RawSql.ExecuteAsync(
                    connection,
                    null,
                    $"""
                    INSERT INTO workspace_invitation
                        (invitation_id, tenant_id, workspace_id, email_normalized, role,
                         invited_by_principal_id, status, invited_at)
                    VALUES ('81818181-1111-4111-8111-818181818181',
                            '{M0SchemaSeed.Alpha.TenantId:D}', '{M0SchemaSeed.Beta.WorkspaceId:D}',
                            'cross@example.test', 'viewer', '{M0SchemaSeed.Alpha.PrincipalId:D}',
                            'pending', now());
                    """));
            Assert.Equal(PostgresErrorCodes.ForeignKeyViolation, invitation.SqlState);

            var inviter = await Assert.ThrowsAsync<PostgresException>(
                async () => await RawSql.ExecuteAsync(
                    connection,
                    null,
                    $"""
                    INSERT INTO workspace_invitation
                        (invitation_id, tenant_id, workspace_id, email_normalized, role,
                         invited_by_principal_id, status, invited_at)
                    VALUES ('82828282-1111-4111-8111-828282828282',
                            '{M0SchemaSeed.Alpha.TenantId:D}', '{M0SchemaSeed.Alpha.WorkspaceId:D}',
                            'cross-inviter@example.test', 'viewer',
                            '{M0SchemaSeed.Beta.PrincipalId:D}', 'pending', now());
                    """));
            Assert.Equal(PostgresErrorCodes.ForeignKeyViolation, inviter.SqlState);

            var accepter = await Assert.ThrowsAsync<PostgresException>(
                async () => await RawSql.ExecuteAsync(
                    connection,
                    null,
                    $"""
                    UPDATE workspace_invitation
                       SET status = 'accepted', accepted_at = now(),
                           accepted_by_principal_id = '{M0SchemaSeed.Beta.PrincipalId:D}'::uuid
                     WHERE invitation_id = '{M0SchemaSeed.Alpha.InvitationId:D}'::uuid;
                    """));
            Assert.Equal(PostgresErrorCodes.ForeignKeyViolation, accepter.SqlState);
        }
    }

    [Fact]
    public async Task Resolver_functions_are_narrow_security_definer_surfaces()
    {
        var connection = await _fixture.OpenMigratorConnectionAsync();
        await using (connection.ConfigureAwait(false))
        {
            var definitions = await RawSql.TextListAsync(
                connection,
                """
                SELECT p.proname || '|' || owner.rolname || '|' || p.prosecdef::text || '|'
                    || coalesce(array_to_string(p.proconfig, ','), '') || '|'
                    || has_function_privilege('public', p.oid, 'EXECUTE')::text || '|'
                    || has_function_privilege('nix_app', p.oid, 'EXECUTE')::text
                  FROM pg_proc p
                  JOIN pg_namespace n ON n.oid = p.pronamespace
                  JOIN pg_roles owner ON owner.oid = p.proowner
                 WHERE n.nspname = 'public'
                   AND p.proname IN (
                       'nix_resolve_identity_provider',
                       'nix_resolve_external_principal',
                       'nix_resolve_principal_by_id')
                 ORDER BY p.proname
                """);

            Assert.Equal(
                [
                    "nix_resolve_external_principal|nix_migrator|true|search_path=public, pg_temp|false|true",
                    "nix_resolve_identity_provider|nix_migrator|true|search_path=public, pg_temp|false|true",
                    "nix_resolve_principal_by_id|nix_migrator|true|search_path=public, pg_temp|false|true",
                ],
                definitions);
        }
    }

    [Fact]
    public async Task Workspace_hot_query_indexes_have_the_frozen_key_order()
    {
        var connection = await _fixture.OpenMigratorConnectionAsync();
        await using (connection.ConfigureAwait(false))
        {
            var definitions = await RawSql.TextListAsync(
                connection,
                """
                SELECT indexname || '|' || indexdef
                  FROM pg_indexes
                 WHERE schemaname = 'public'
                   AND indexname IN ('ix_workspace_list', 'ix_workspace_member_actor_reach',
                                     'ix_workspace_member_history', 'ix_workspace_member_direct_owner')
                 ORDER BY indexname
                """);

            Assert.Contains(
                definitions,
                value => value.Contains("(tenant_id, subject_type, subject_id, workspace_id) INCLUDE (role)", StringComparison.Ordinal));
            Assert.Contains(
                definitions,
                value => value.Contains("(tenant_id, workspace_id, subject_id)", StringComparison.Ordinal));
            Assert.Contains(
                definitions,
                value => value.Contains("(tenant_id, workspace_id, granted_at DESC, subject_type, subject_id)", StringComparison.Ordinal));
            Assert.Contains(
                definitions,
                value => value.Contains("(tenant_id, created_at DESC, workspace_id DESC)", StringComparison.Ordinal));
        }
    }

    [Fact]
    public async Task Actual_seed_repairs_personal_ownership_on_a_rerun()
    {
        var seedPath = FindRepositoryFile("deploy", "seed", "seed_application_data.sql");
        await _fixture.ExecuteApplicationSeedAsync(seedPath, Cancellation);

        var connection = await _fixture.OpenMigratorConnectionAsync();
        await using (connection.ConfigureAwait(false))
        {
            await RawSql.ExecuteAsync(
                connection,
                null,
                """
                UPDATE workspace_member
                   SET role = 'viewer'
                 WHERE workspace_id = 'a1000000-0000-4000-8000-000000000001'::uuid
                   AND subject_type = 'principal'
                   AND subject_id = 'a2000000-0000-4000-8000-000000000001'::uuid;
                UPDATE workspace
                   SET personal_owner_principal_id = NULL
                 WHERE workspace_id = 'a1000000-0000-4000-8000-000000000001'::uuid;
                """);
        }

        await _fixture.ExecuteApplicationSeedAsync(seedPath, Cancellation);

        var verify = await _fixture.OpenMigratorConnectionAsync();
        await using (verify.ConfigureAwait(false))
        {
            var values = await RawSql.TextListAsync(
                verify,
                """
                SELECT member.role || '|' || workspace.personal_owner_principal_id::text
                  FROM workspace
                  JOIN workspace_member member
                    ON member.workspace_id = workspace.workspace_id
                   AND member.subject_type = 'principal'
                   AND member.subject_id = 'a2000000-0000-4000-8000-000000000001'::uuid
                 WHERE workspace.workspace_id = 'a1000000-0000-4000-8000-000000000001'::uuid
                """);

            Assert.Equal(
                ["owner|a2000000-0000-4000-8000-000000000001"],
                values);
        }
    }

    [Fact]
    public async Task Upgrade_backfills_the_seeded_administrator_without_renaming_the_workspace()
    {
        await _fixture.ResetAsync();
        var options = new DbContextOptionsBuilder<NixDbContext>()
            .UseNpgsql(_fixture.MigratorConnectionString)
            .Options;
        var context = new NixDbContext(options);
        await using (context.ConfigureAwait(false))
        {
            var migrator = context.GetService<IMigrator>();
            await migrator.MigrateAsync("20260821194634_TaskSemantics", Cancellation);
            try
            {
                var connection = await _fixture.OpenMigratorConnectionAsync();
                await using (connection.ConfigureAwait(false))
                {
                    await RawSql.ExecuteAsync(
                        connection,
                        transaction: null,
                        """
                        INSERT INTO tenant (tenant_id, name, isolation_mode, created_at)
                        VALUES
                            ('a0000000-0000-4000-8000-000000000001', 'production', 'shared', now()),
                            ('c0000000-0000-4000-8000-000000000001', 'internal', 'shared', now());
                        INSERT INTO workspace
                            (workspace_id, tenant_id, name, version_retention_days,
                             coalesce_window_min, storage_quota_bytes, created_at)
                        VALUES ('a1000000-0000-4000-8000-000000000001',
                                'a0000000-0000-4000-8000-000000000001',
                                'Existing production name', 90, 10, 10737418240, now());
                        INSERT INTO principal
                            (principal_id, tenant_id, external_subject, kind, display_name,
                             status, can_manage_templates)
                        VALUES
                            ('a2000000-0000-4000-8000-000000000001',
                             'a0000000-0000-4000-8000-000000000001',
                             'real-admin-subject', 'user', 'Administrator', 'active', false),
                            ('a2000000-0000-4000-8000-000000000004',
                             'a0000000-0000-4000-8000-000000000001',
                             'template-service-subject', 'service', 'Template boot', 'active', true),
                            ('a2000000-0000-4000-8000-000000000005',
                             'a0000000-0000-4000-8000-000000000001',
                             'not-a-prefix-contract', 'service', 'Public form', 'active', false),
                            ('c2000000-0000-4000-8000-000000000001',
                             'c0000000-0000-4000-8000-000000000001',
                             'internal-user', 'user', 'Internal user', 'active', false),
                            ('c2000000-0000-4000-8000-000000000002',
                             'c0000000-0000-4000-8000-000000000001',
                             'internal-service', 'service', 'Internal service', 'active', false);
                        INSERT INTO identity_provider
                            (provider_id, tenant_id, issuer, audience, jwks_uri,
                             allowed_algorithms, enabled)
                        VALUES ('a4000000-0000-4000-8000-000000000001',
                                'a0000000-0000-4000-8000-000000000001',
                                'https://sso.production.test', 'web',
                                'https://sso.production.test/keys', ARRAY['RS256'], true);
                        INSERT INTO workspace_member
                            (workspace_id, subject_type, subject_id, tenant_id, role,
                             granted_by, granted_at)
                        VALUES ('a1000000-0000-4000-8000-000000000001', 'principal',
                                'a2000000-0000-4000-8000-000000000001',
                                'a0000000-0000-4000-8000-000000000001', 'viewer',
                                'a2000000-0000-4000-8000-000000000001', now());
                        INSERT INTO item
                            (id, tenant_id, workspace_id, type, parent_id, seq, lifecycle_state,
                             created_by, last_modified_by, created_at, last_modified_at)
                        VALUES ('a6000000-0000-4000-8000-000000000001',
                                'a0000000-0000-4000-8000-000000000001',
                                'a1000000-0000-4000-8000-000000000001', 'note', NULL, 1000,
                                'active', 'a2000000-0000-4000-8000-000000000001',
                                'a2000000-0000-4000-8000-000000000001', now(), now());
                        INSERT INTO public_form_link
                            (id, tenant_id, workspace_id, item_id, view_id, nonce,
                             submission_principal_id, published_by, published_at)
                        VALUES ('a7000000-0000-4000-8000-000000000001',
                                'a0000000-0000-4000-8000-000000000001',
                                'a1000000-0000-4000-8000-000000000001',
                                'a6000000-0000-4000-8000-000000000001', 'form', 'nonce',
                                'a2000000-0000-4000-8000-000000000005',
                                'a2000000-0000-4000-8000-000000000001', now());
                        """);
                }

                await migrator.MigrateAsync(targetMigration: null, cancellationToken: Cancellation);

                var verify = await _fixture.OpenMigratorConnectionAsync();
                await using (verify.ConfigureAwait(false))
                {
                    var values = await RawSql.TextListAsync(
                        verify,
                        """
                        SELECT name || '|' || external_issuer || '|' || personal_owner_principal_id::text
                          FROM workspace
                          JOIN principal ON principal.principal_id = workspace.personal_owner_principal_id
                         WHERE workspace.workspace_id = 'a1000000-0000-4000-8000-000000000001'
                        """);

                    Assert.Equal(
                        ["Existing production name|https://sso.production.test|a2000000-0000-4000-8000-000000000001"],
                        values);

                    var principals = await RawSql.TextListAsync(
                        verify,
                        """
                        SELECT principal_id::text || '|' || coalesce(external_issuer, '(internal)')
                          FROM principal
                         WHERE tenant_id = 'a0000000-0000-4000-8000-000000000001'::uuid
                         ORDER BY principal_id
                        """);
                    Assert.Equal(
                        [
                            "a2000000-0000-4000-8000-000000000001|https://sso.production.test",
                            "a2000000-0000-4000-8000-000000000004|https://sso.production.test",
                            "a2000000-0000-4000-8000-000000000005|(internal)",
                        ],
                        principals);

                    var internalPrincipals = await RawSql.TextListAsync(
                        verify,
                        """
                        SELECT principal_id::text || '|' || coalesce(external_issuer, '(internal)')
                          FROM principal
                         WHERE tenant_id = 'c0000000-0000-4000-8000-000000000001'::uuid
                         ORDER BY principal_id
                        """);
                    Assert.Equal(
                        [
                            "c2000000-0000-4000-8000-000000000001|(internal)",
                            "c2000000-0000-4000-8000-000000000002|(internal)",
                        ],
                        internalPrincipals);

                    var membership = await RawSql.TextListAsync(
                        verify,
                        """
                        SELECT role FROM workspace_member
                         WHERE workspace_id = 'a1000000-0000-4000-8000-000000000001'
                           AND subject_id = 'a2000000-0000-4000-8000-000000000001'
                        """);
                    Assert.Equal(["owner"], membership);
                }
            }
            finally
            {
                await migrator.MigrateAsync(targetMigration: null, cancellationToken: Cancellation);
                await _fixture.ResetAsync();
            }
        }
    }

    [Fact]
    public async Task Invitation_target_upgrade_backfills_accepted_history_before_guarding_identity()
    {
        await _fixture.ResetAsync();
        var options = new DbContextOptionsBuilder<NixDbContext>()
            .UseNpgsql(_fixture.MigratorConnectionString)
            .Options;
        var context = new NixDbContext(options);
        await using (context.ConfigureAwait(false))
        {
            var migrator = context.GetService<IMigrator>();
            await migrator.MigrateAsync("20260830183914_BrowserSessions", Cancellation);
            try
            {
                await _fixture.ResetAsync();
                await M0SchemaSeed.SeedBothTenantsAsync(_fixture);

                var connection = await _fixture.OpenMigratorConnectionAsync();
                await using (connection.ConfigureAwait(false))
                {
                    await RawSql.ExecuteAsync(
                        connection,
                        transaction: null,
                        $"""
                        UPDATE workspace_invitation
                           SET status = 'accepted', accepted_at = now(),
                               accepted_by_principal_id = '{M0SchemaSeed.Alpha.PrincipalId:D}'::uuid
                         WHERE invitation_id = '{M0SchemaSeed.Alpha.InvitationId:D}'::uuid
                        """);
                }

                await migrator.MigrateAsync(targetMigration: null, cancellationToken: Cancellation);

                var verify = await _fixture.OpenMigratorConnectionAsync();
                await using (verify.ConfigureAwait(false))
                {
                    var values = await RawSql.TextListAsync(
                        verify,
                        $"""
                        SELECT status || '|' || accepted_by_principal_id::text || '|'
                            || target_principal_id::text
                          FROM workspace_invitation
                         WHERE invitation_id = '{M0SchemaSeed.Alpha.InvitationId:D}'::uuid
                        """);
                    Assert.Equal(
                        [$"accepted|{M0SchemaSeed.Alpha.PrincipalId:D}|{M0SchemaSeed.Alpha.PrincipalId:D}"],
                        values);
                }
            }
            finally
            {
                await migrator.MigrateAsync(targetMigration: null, cancellationToken: Cancellation);
                await _fixture.ResetAsync();
            }
        }
    }

    private static string FindRepositoryFile(params string[] pathSegments)
    {
        for (var directory = new DirectoryInfo(AppContext.BaseDirectory);
             directory is not null;
             directory = directory.Parent)
        {
            var candidate = Path.Combine([directory.FullName, .. pathSegments]);
            if (File.Exists(candidate))
            {
                return candidate;
            }
        }

        throw new FileNotFoundException($"Could not find repository file {Path.Combine(pathSegments)}.");
    }

    [Fact]
    public async Task Upgrade_preflight_refuses_a_human_whose_issuer_is_ambiguous()
    {
        await _fixture.ResetAsync();
        var options = new DbContextOptionsBuilder<NixDbContext>()
            .UseNpgsql(_fixture.MigratorConnectionString)
            .Options;
        var context = new NixDbContext(options);
        await using (context.ConfigureAwait(false))
        {
            var migrator = context.GetService<IMigrator>();
            await migrator.MigrateAsync("20260821194634_TaskSemantics", Cancellation);
            try
            {
                var connection = await _fixture.OpenMigratorConnectionAsync();
                await using (connection.ConfigureAwait(false))
                {
                    await RawSql.ExecuteAsync(
                        connection,
                        null,
                        """
                        INSERT INTO tenant (tenant_id, name, isolation_mode, created_at)
                        VALUES ('90909090-0000-4000-8000-000000000001', 'ambiguous', 'shared', now());
                        INSERT INTO principal
                            (principal_id, tenant_id, external_subject, kind, display_name, status)
                        VALUES ('90909090-0000-4000-8000-000000000002',
                                '90909090-0000-4000-8000-000000000001',
                                'ambiguous-subject', 'user', 'Ambiguous', 'active');
                        INSERT INTO identity_provider
                            (provider_id, tenant_id, issuer, audience, jwks_uri,
                             allowed_algorithms, enabled)
                        VALUES
                            ('90909090-0000-4000-8000-000000000003',
                             '90909090-0000-4000-8000-000000000001',
                             'https://first.test', 'web', 'https://first.test/keys',
                             ARRAY['RS256'], true),
                            ('90909090-0000-4000-8000-000000000004',
                             '90909090-0000-4000-8000-000000000001',
                             'https://second.test', 'service', 'https://second.test/keys',
                             ARRAY['RS256'], true);
                        """);
                }

                var failure = await Assert.ThrowsAsync<PostgresException>(
                    async () => await migrator.MigrateAsync(null, Cancellation));
                Assert.Contains(
                    "90909090-0000-4000-8000-000000000002",
                    failure.MessageText,
                    StringComparison.Ordinal);
            }
            finally
            {
                var cleanup = await _fixture.OpenMigratorConnectionAsync();
                await using (cleanup.ConfigureAwait(false))
                {
                    await RawSql.ExecuteAsync(
                        cleanup,
                        null,
                        """
                        DELETE FROM identity_provider
                         WHERE tenant_id = '90909090-0000-4000-8000-000000000001';
                        DELETE FROM principal
                         WHERE tenant_id = '90909090-0000-4000-8000-000000000001';
                        DELETE FROM tenant
                         WHERE tenant_id = '90909090-0000-4000-8000-000000000001';
                        """);
                }

                await migrator.MigrateAsync(null, Cancellation);
                await _fixture.ResetAsync();
            }
        }
    }

    [Fact]
    public async Task Down_preflight_refuses_cross_issuer_subject_duplicates_before_changing_schema()
    {
        var connection = await _fixture.OpenMigratorConnectionAsync();
        await using (connection.ConfigureAwait(false))
        {
            await RawSql.ExecuteAsync(
                connection,
                null,
                $"""
                INSERT INTO principal
                    (principal_id, tenant_id, external_issuer, external_subject, kind,
                     display_name, email_verified, status)
                VALUES ('91919191-1111-4111-8111-919191919191',
                        '{M0SchemaSeed.Alpha.TenantId:D}', 'https://second.alpha.test',
                        'alpha-subject', 'user', 'Duplicate subject', false, 'active');
                """);
        }

        var options = new DbContextOptionsBuilder<NixDbContext>()
            .UseNpgsql(_fixture.MigratorConnectionString)
            .Options;
        var context = new NixDbContext(options);
        await using (context.ConfigureAwait(false))
        {
            var migrator = context.GetService<IMigrator>();
            try
            {
                var failure = await Assert.ThrowsAsync<PostgresException>(
                    async () => await migrator.MigrateAsync("20260821194634_TaskSemantics", Cancellation));
                Assert.Contains(
                    "91919191-1111-4111-8111-919191919191",
                    failure.MessageText,
                    StringComparison.Ordinal);
            }
            finally
            {
                var cleanup = await _fixture.OpenMigratorConnectionAsync();
                await using (cleanup.ConfigureAwait(false))
                {
                    await RawSql.ExecuteAsync(
                        cleanup,
                        null,
                        "DELETE FROM principal WHERE principal_id = '91919191-1111-4111-8111-919191919191';");
                }

                await migrator.MigrateAsync(null, Cancellation);
            }
        }
    }

    private async Task AssertCheckViolationAsync(string sql)
    {
        var connection = await _fixture.OpenMigratorConnectionAsync();
        await using (connection.ConfigureAwait(false))
        {
            var failure = await Assert.ThrowsAsync<PostgresException>(
                async () => await RawSql.ExecuteAsync(connection, null, sql));
            Assert.Equal(PostgresErrorCodes.CheckViolation, failure.SqlState);
        }
    }
}
