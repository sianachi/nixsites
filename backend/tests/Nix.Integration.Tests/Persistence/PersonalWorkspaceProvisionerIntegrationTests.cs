using Nix.Abstractions;
using Nix.Authentication;
using Nix.Domain.Identity;
using Nix.Domain.Provisioning;
using Nix.Domain.Tenancy;
using Nix.Features.Identity;
using Nix.Integration.Tests.Harness;
using Nix.Persistence.Identity;

namespace Nix.Integration.Tests.Persistence;

[Collection(PostgresCollectionDefinition.Name)]
public sealed class PersonalWorkspaceProvisionerIntegrationTests : IAsyncLifetime
{
    private readonly NixPostgresFixture _fixture;

    public PersonalWorkspaceProvisionerIntegrationTests(NixPostgresFixture fixture) => _fixture = fixture;

    private static CancellationToken Cancellation => TestContext.Current.CancellationToken;

    public async ValueTask InitializeAsync()
    {
        await _fixture.ResetAsync();
        await M0SchemaSeed.SeedBothTenantsAsync(_fixture);
    }

    public ValueTask DisposeAsync() => ValueTask.CompletedTask;

    [Fact]
    public async Task Two_simultaneous_first_requests_create_one_complete_personal_workspace()
    {
        var token = Token("concurrent-subject");
        var profile = new UserInfoProfile(
            "Concurrent Person",
            "concurrent@example.test",
            EmailVerified: true);

        var first = ProvisionAndCommitAsync(token, profile);
        var second = ProvisionAndCommitAsync(token, profile);
        var results = await Task.WhenAll(first, second);

        Assert.Equal(results[0], results[1]);
        var principalId = results[0].Id.Value;
        var workspaceId = DeterministicProvisioningId.PersonalWorkspace(results[0].Id).Value;
        var connection = await _fixture.OpenMigratorConnectionAsync();
        await using (connection.ConfigureAwait(false))
        {
            Assert.Equal(1, await RawSql.CountAsync(connection, null,
                $"SELECT count(*) FROM principal WHERE principal_id = '{principalId:D}'::uuid"));
            Assert.Equal(1, await RawSql.CountAsync(connection, null,
                $"SELECT count(*) FROM workspace WHERE workspace_id = '{workspaceId:D}'::uuid AND personal_owner_principal_id = '{principalId:D}'::uuid"));
            Assert.Equal(1, await RawSql.CountAsync(connection, null,
                $"SELECT count(*) FROM workspace_member WHERE workspace_id = '{workspaceId:D}'::uuid AND subject_id = '{principalId:D}'::uuid AND role = 'owner'"));
            Assert.Equal(1, await RawSql.CountAsync(connection, null,
                $"SELECT count(*) FROM item WHERE id = '{DeterministicProvisioningId.DailyNotesRoot(WorkspaceId.From(workspaceId)):D}'::uuid"));
            Assert.Equal(3, await RawSql.CountAsync(connection, null,
                $"SELECT count(*) FROM workspace_template WHERE workspace_id = '{workspaceId:D}'::uuid AND origin = 'seed' AND state = 'active'"));
            Assert.Equal(3, await RawSql.CountAsync(connection, null,
                $"SELECT count(*) FROM audit_event WHERE actor_id = '{principalId:D}'::uuid AND action IN ('principal.provisioned', 'workspace.created', 'workspace.ownership_granted')"));
        }
    }

    [Fact]
    public async Task A_failed_request_rolls_back_every_provisioning_row_and_a_retry_can_win()
    {
        var token = Token("rollback-subject");
        var profile = new UserInfoProfile("Rollback Person", null, EmailVerified: false);
        var principalId = DeterministicProvisioningId.Principal(
            token.TenantId,
            token.Registration.Issuer,
            token.Subject);

        var context = NixSessionContext.ForTenant(token.TenantId, principalId);
        var abandoned = await _fixture.Application.BeginUnitOfWorkAsync(context, Cancellation);
        await using (abandoned.ConfigureAwait(false))
        {
            await abandoned.Resolve<PersonalWorkspaceProvisioner>()
                .ProvisionAsync(
                    token.TenantId,
                    token.Registration.Issuer,
                    token.Subject,
                    profile,
                    Cancellation);
        }

        var connection = await _fixture.OpenMigratorConnectionAsync();
        await using (connection.ConfigureAwait(false))
        {
            Assert.Equal(0, await RawSql.CountAsync(connection, null,
                $"SELECT count(*) FROM principal WHERE principal_id = '{principalId.Value:D}'::uuid"));
        }

        var retried = await ProvisionAndCommitAsync(token, profile);
        Assert.Equal(principalId, retried.Id);
    }

    [Fact]
    public async Task Signing_in_with_an_invited_email_leaves_the_invitation_pending_and_grants_nothing()
    {
        var token = Token("invited-subject");
        var profile = new UserInfoProfile(
            "Invited Person",
            " Pending-Alpha@Example.Test ",
            EmailVerified: true);

        var principal = await ProvisionAndCommitAsync(token, profile);
        var connection = await _fixture.OpenMigratorConnectionAsync();
        await using (connection.ConfigureAwait(false))
        {
            Assert.Equal(1, await RawSql.CountAsync(connection, null,
                $"SELECT count(*) FROM workspace_invitation WHERE invitation_id = '{M0SchemaSeed.Alpha.InvitationId:D}'::uuid AND status = 'pending'"));
            Assert.Equal(0, await RawSql.CountAsync(connection, null,
                $"SELECT count(*) FROM workspace_member WHERE workspace_id = '{M0SchemaSeed.Alpha.WorkspaceId:D}'::uuid AND subject_id = '{principal.Id.Value:D}'::uuid"));
        }
    }

    [Theory]
    [InlineData(false, false)]
    [InlineData(true, true)]
    public async Task Unverified_or_ambiguous_emails_leave_the_invitation_pending(
        bool emailVerified,
        bool addAmbiguousPrincipal)
    {
        if (addAmbiguousPrincipal)
        {
            var connection = await _fixture.OpenMigratorConnectionAsync();
            await using (connection.ConfigureAwait(false))
            {
                await RawSql.ExecuteAsync(connection, null,
                    $"""
                    INSERT INTO principal
                        (principal_id, tenant_id, external_issuer, external_subject, kind,
                         display_name, email, email_normalized, email_verified, status)
                    VALUES ('30303030-3030-4030-8030-303030303030'::uuid,
                            '{M0SchemaSeed.Alpha.TenantId:D}'::uuid,
                            'https://issuer.alpha.test', 'ambiguous-existing', 'user',
                            'Ambiguous existing', 'pending-alpha@example.test',
                            'pending-alpha@example.test', true, 'active')
                    """);
            }
        }

        var token = Token(emailVerified ? "ambiguous-subject" : "unverified-subject");
        var profile = new UserInfoProfile(
            "Pending Person",
            "pending-alpha@example.test",
            emailVerified);
        await ProvisionAndCommitAsync(token, profile);

        var assertionConnection = await _fixture.OpenMigratorConnectionAsync();
        await using (assertionConnection.ConfigureAwait(false))
        {
            Assert.Equal(1, await RawSql.CountAsync(assertionConnection, null,
                $"SELECT count(*) FROM workspace_invitation WHERE invitation_id = '{M0SchemaSeed.Alpha.InvitationId:D}'::uuid AND status = 'pending'"));
        }
    }

    [Fact]
    public async Task A_targeted_invitation_cannot_be_redeemed_by_a_different_identity_with_the_same_email()
    {
        var targetPrincipalId = Guid.Parse("32323232-3232-4232-8232-323232323232");
        var invitationId = Guid.Parse("42424242-4242-4242-8242-424242424242");
        var connection = await _fixture.OpenMigratorConnectionAsync();
        await using (connection.ConfigureAwait(false))
        {
            await RawSql.ExecuteAsync(connection, null,
                $"""
                INSERT INTO principal
                    (principal_id, tenant_id, external_issuer, external_subject, kind,
                     display_name, email, email_normalized, email_verified, status)
                VALUES ('{targetPrincipalId:D}'::uuid, '{M0SchemaSeed.Alpha.TenantId:D}'::uuid,
                        'https://issuer.alpha.test', 'inactive-invite-target', 'user',
                        'Inactive target', 'targeted@example.test', 'targeted@example.test',
                        true, 'suspended');

                INSERT INTO workspace_invitation
                    (invitation_id, tenant_id, workspace_id, email_normalized, target_principal_id,
                     role, invited_by_principal_id, status, invited_at)
                VALUES ('{invitationId:D}'::uuid, '{M0SchemaSeed.Alpha.TenantId:D}'::uuid,
                        '{M0SchemaSeed.Alpha.WorkspaceId:D}'::uuid, 'targeted@example.test',
                        '{targetPrincipalId:D}'::uuid, 'viewer',
                        '{M0SchemaSeed.Alpha.PrincipalId:D}'::uuid, 'pending', now())
                """);
        }

        var token = Token("different-targeted-email-subject");
        var profile = new UserInfoProfile("Different person", "targeted@example.test", EmailVerified: true);
        var principal = await ProvisionAndCommitAsync(token, profile);

        var assertionConnection = await _fixture.OpenMigratorConnectionAsync();
        await using (assertionConnection.ConfigureAwait(false))
        {
            Assert.Equal(1, await RawSql.CountAsync(assertionConnection, null,
                $"SELECT count(*) FROM workspace_invitation WHERE invitation_id = '{invitationId:D}'::uuid AND status = 'pending'"));
            Assert.Equal(0, await RawSql.CountAsync(assertionConnection, null,
                $"SELECT count(*) FROM workspace_member WHERE workspace_id = '{M0SchemaSeed.Alpha.WorkspaceId:D}'::uuid AND subject_id = '{principal.Id.Value:D}'::uuid"));
        }
    }

    [Theory]
    [InlineData("https://another-issuer.test", "later-verified")]
    [InlineData("https://issuer.alpha.test", "another-subject")]
    public async Task Email_refresh_cannot_update_another_external_identity(string issuer, string subject)
    {
        var token = Token("later-verified");
        var profile = new UserInfoProfile("Later Person", "pending-alpha@example.test", EmailVerified: false);
        var principal = await ProvisionAndCommitAsync(token, profile);
        var unitOfWork = await _fixture.Application.BeginUnitOfWorkAsync(
            NixSessionContext.ForTenant(token.TenantId, principal.Id), Cancellation);
        await using (unitOfWork.ConfigureAwait(false))
        {
            await Assert.ThrowsAsync<PersonalWorkspaceProvisioningInvariantException>(async () =>
                await unitOfWork.Resolve<PersonalWorkspaceProvisioner>().RefreshEmailAsync(
                    token.TenantId, principal.Id, issuer, subject,
                    profile with { EmailVerified = true }, Cancellation));
        }

        var connection = await _fixture.OpenMigratorConnectionAsync();
        await using (connection.ConfigureAwait(false))
        {
            Assert.Equal(1, await RawSql.CountAsync(connection, null,
                $"SELECT count(*) FROM principal WHERE principal_id = '{principal.Id.Value:D}'::uuid AND NOT email_verified AND email_normalized IS NULL"));
            Assert.Equal(1, await RawSql.CountAsync(connection, null,
                $"SELECT count(*) FROM workspace_invitation WHERE invitation_id = '{M0SchemaSeed.Alpha.InvitationId:D}'::uuid AND status = 'pending'"));
        }
    }

    [Fact]
    public async Task Later_verified_email_is_refreshed_and_leaves_a_pending_workspace_invitation_pending()
    {
        var token = Token("later-verified");
        var profile = new UserInfoProfile("Later Person", " Pending-Alpha@Example.Test ", EmailVerified: false);
        var principal = await ProvisionAndCommitAsync(token, profile);

        var connection = await _fixture.OpenMigratorConnectionAsync();
        await using (connection.ConfigureAwait(false))
        {
            foreach (var verified in new[] { false, true, true, false })
            {
                var unitOfWork = await _fixture.Application.BeginUnitOfWorkAsync(
                    NixSessionContext.ForTenant(token.TenantId, principal.Id), Cancellation);
                await using (unitOfWork.ConfigureAwait(false))
                {
                    var now = DateTimeOffset.UtcNow;
                    var session = new BrowserSession
                    {
                        Id = BrowserSessionId.Create(),
                        TenantId = token.TenantId,
                        PrincipalId = principal.Id,
                        TokenHash = Guid.NewGuid().ToString("N") + Guid.NewGuid().ToString("N"),
                        CreatedAt = now,
                        ExpiresAt = now.AddHours(8),
                    };
                    var result = await unitOfWork.Resolve<Nix.Messaging.ICommandHandler<CompleteBrowserSignIn, CompletedBrowserSignIn>>().HandleAsync(
                        new CompleteBrowserSignIn(token.TenantId, token.Registration.Issuer, token.Subject,
                            profile with { EmailVerified = verified }, principal, session), Cancellation);
                    Assert.True(result.IsSuccess);
                    await unitOfWork.CommitAsync(Cancellation);
                }

                Assert.Equal(1, await RawSql.CountAsync(connection, null,
                    $"SELECT count(*) FROM principal WHERE principal_id = '{principal.Id.Value:D}'::uuid AND email_verified = {(verified ? "true" : "false")} AND {(verified ? "email_normalized = 'pending-alpha@example.test'" : "email_normalized IS NULL")}"));
                if (verified)
                {
                    Assert.Equal(1, await RawSql.CountAsync(connection, null,
                        $"SELECT count(*) FROM workspace_invitation WHERE invitation_id = '{M0SchemaSeed.Alpha.InvitationId:D}'::uuid AND status = 'pending'"));
                    Assert.Equal(0, await RawSql.CountAsync(connection, null,
                        $"SELECT count(*) FROM workspace_member WHERE workspace_id = '{M0SchemaSeed.Alpha.WorkspaceId:D}'::uuid AND subject_id = '{principal.Id.Value:D}'::uuid"));
                }
            }
        }
    }

    private async Task<AuthenticatedPrincipal> ProvisionAndCommitAsync(
        ValidatedExternalToken token,
        UserInfoProfile profile)
    {
        var principalId = DeterministicProvisioningId.Principal(
            token.TenantId,
            token.Registration.Issuer,
            token.Subject);
        var unitOfWork = await _fixture.Application.BeginUnitOfWorkAsync(
            NixSessionContext.ForTenant(token.TenantId, principalId),
            Cancellation);
        await using (unitOfWork.ConfigureAwait(false))
        {
            var principal = await unitOfWork.Resolve<PersonalWorkspaceProvisioner>()
                .ProvisionAsync(
                    token.TenantId,
                    token.Registration.Issuer,
                    token.Subject,
                    profile,
                    Cancellation);
            await unitOfWork.CommitAsync(Cancellation);
            return principal;
        }
    }

    private static ValidatedExternalToken Token(string subject)
    {
        var registration = new IdentityProviderRegistration(
            TenantId.From(M0SchemaSeed.Alpha.TenantId),
            "https://issuer.alpha.test",
            "nix-api",
            new Uri("https://issuer.alpha.test/keys"),
            ["RS256"],
            IdentityProviderId.From(M0SchemaSeed.Alpha.ProviderId),
            JitProvisioningEnabled: true,
            new Uri("https://issuer.alpha.test/userinfo"));
        return new ValidatedExternalToken(
            registration.TenantId,
            subject,
            registration,
            registration);
    }
}
