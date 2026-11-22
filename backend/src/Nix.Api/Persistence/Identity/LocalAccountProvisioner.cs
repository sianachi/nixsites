using Microsoft.Extensions.DependencyInjection;
using Nix.Abstractions;
using Nix.Authentication;
using Nix.Domain.Identity;
using Nix.Domain.Provisioning;
using Nix.Domain.Tenancy;
using Nix.Persistence;
using Nix.Persistence.Sql;
using Npgsql;
using NpgsqlTypes;

namespace Nix.Persistence.Identity;

/// <summary>How creating a local account ended.</summary>
internal enum LocalProvisionOutcome
{
    /// <summary>The person, their workspace and local account now exist.</summary>
    Created,

    /// <summary>Another local account already uses that email.</summary>
    EmailTaken,

    /// <summary>First-run setup was asked for, but an account already exists.</summary>
    SetupClosed,
}

/// <summary>The outcome plus the new person when there is one.</summary>
internal sealed record LocalProvisionResult(LocalProvisionOutcome Outcome, AuthenticatedPrincipal? Principal);

/// <summary>
/// Creates a person with their personal workspace and local account in one transaction of its own scope.
/// The scope is separate because the session context is write-once per scope and the caller still has a
/// session to start (or, for a tenant admin adding a person, is already running under their own).
/// </summary>
public sealed class LocalAccountProvisioner(IServiceScopeFactory scopes, SelfIssuedTokenService tokens, TimeProvider clock)
{
    // Serializes first-run setups: two at once with different emails must not both become admin.
    private const long SetupLockKey = 0x4e69_785f_5365_7475; // "Nix_Setu"

    /// <summary>Adds a person to a tenant. <paramref name="passwordHash"/> may be null: they set one through a link.</summary>
    internal ValueTask<LocalProvisionResult> CreateAsync(
        TenantId tenantId, string email, string name, string? passwordHash, CancellationToken cancellationToken) =>
        RunAsync(tenantId, email, name, passwordHash, firstAdmin: false, cancellationToken);

    /// <summary>
    /// First-run setup: succeeds for exactly one caller while no local account exists, and makes that person
    /// a tenant administrator.
    /// </summary>
    internal ValueTask<LocalProvisionResult> CreateFirstAdminAsync(
        TenantId tenantId, string email, string name, string passwordHash, CancellationToken cancellationToken) =>
        RunAsync(tenantId, email, name, passwordHash, firstAdmin: true, cancellationToken);

    private async ValueTask<LocalProvisionResult> RunAsync(
        TenantId tenantId, string email, string name, string? passwordHash, bool firstAdmin, CancellationToken cancellationToken)
    {
        var scope = scopes.CreateAsyncScope();
        await using (scope.ConfigureAwait(false))
        {
            var services = scope.ServiceProvider;
            var subject = Guid.CreateVersion7().ToString("D");
            var principalId = DeterministicProvisioningId.Principal(tenantId, tokens.Issuer, subject);
            services.GetRequiredService<ScopedNixSessionContextAccessor>().Set(NixSessionContext.ForTenant(tenantId, principalId));

            var db = services.GetRequiredService<NixDbContext>();
            var sql = services.GetRequiredService<NixSqlExecutor>();
            var transaction = await db.Database.BeginTransactionAsync(cancellationToken).ConfigureAwait(false);
            await using (transaction.ConfigureAwait(false))
            {
                if (firstAdmin)
                {
                    _ = await sql.ScalarAsync<int>(
                        "SELECT 1 FROM (SELECT pg_advisory_xact_lock(@key)) AS locked",
                        [new NpgsqlParameter("key", NpgsqlDbType.Bigint) { Value = SetupLockKey }],
                        cancellationToken).ConfigureAwait(false);
                    // A second connection sees whatever the previous lock holder committed before releasing.
                    if (await services.GetRequiredService<ILocalAccounts>().AnyAsync(cancellationToken).ConfigureAwait(false))
                    {
                        return new(LocalProvisionOutcome.SetupClosed, null);
                    }
                }

                var principal = await services.GetRequiredService<PersonalWorkspaceProvisioner>().ProvisionAsync(
                    tenantId,
                    tokens.Issuer,
                    subject,
                    new UserInfoProfile(name, email, EmailVerified: true),
                    cancellationToken).ConfigureAwait(false);
                var created = await sql.ScalarAsync<bool>(
                    "SELECT nix_local_create_account(@principal, @email, @hash)",
                    [
                        new NpgsqlParameter("principal", NpgsqlDbType.Uuid) { Value = principal.Id.Value },
                        new NpgsqlParameter("email", NpgsqlDbType.Text) { Value = email },
                        new NpgsqlParameter("hash", NpgsqlDbType.Text) { Value = (object?)passwordHash ?? DBNull.Value },
                    ],
                    cancellationToken).ConfigureAwait(false) ?? false;
                if (!created)
                {
                    await transaction.RollbackAsync(cancellationToken).ConfigureAwait(false);
                    return new(LocalProvisionOutcome.EmailTaken, null);
                }

                if (firstAdmin)
                {
                    _ = await services.GetRequiredService<IAccessGrantStore>()
                        .AddTenantAdminAsync(principal.Id, principal.Id, clock.GetUtcNow(), cancellationToken).ConfigureAwait(false);
                    _ = await db.SaveChangesAsync(cancellationToken).ConfigureAwait(false);
                }

                await transaction.CommitAsync(cancellationToken).ConfigureAwait(false);
                return new(LocalProvisionOutcome.Created, principal);
            }
        }
    }
}
