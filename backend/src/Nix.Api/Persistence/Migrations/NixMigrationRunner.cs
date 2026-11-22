using Microsoft.EntityFrameworkCore;
using Nix.Persistence.Sql;
using Nix.Persistence.Sql.Statements;
using Npgsql;

namespace Nix.Persistence.Migrations;

/// <summary>
/// Applies EF Core migrations as the schema-owning role.
/// </summary>
/// <remarks>
/// <para>
/// <b>Migrations are a deployment step, not a startup step.</b> Nothing in
/// <c>AddNixPersistence</c> calls this, and nothing should: at startup every replica would race
/// to migrate, the application would need DDL rights it must never have, and a failed migration
/// would surface as a crash-looping pod instead of a failed job. In the cluster this runs as a
/// Kubernetes <c>Job</c> that must complete before the rollout proceeds.
/// </para>
/// <para>
/// <b>It runs as <c>nix_migrator</c>, the only role holding <c>BYPASSRLS</c>.</b> The runtime role
/// <c>nix_app</c> cannot create objects in the schema at all, which is checked by the integration
/// suite against the real grants. This runner does not take that on trust either: before touching
/// anything it asks the database whether the role it is connected as can bypass row-level
/// security, and refuses to continue if it cannot. Handing it the application's connection string
/// by mistake fails the job instead of half-migrating under a role that cannot see other tenants'
/// rows.
/// </para>
/// <para>
/// How it is invoked:
/// </para>
/// <code>
/// # locally, against the dev stack
/// NIX_MIGRATOR_CONNECTION_STRING="Host=localhost;Port=5433;Database=nix;Username=nix_migrator;Password=nix-dev-migrator" \
///   dotnet run --project backend/src/Nix.Migrator
///
/// # in the cluster: a Job running the same image, with the migrator secret mounted
/// </code>
/// <para>
/// Adding a migration (the connection string is not used for scaffolding, only for scripting):
/// </para>
/// <code>
/// dotnet ef migrations add &lt;Name&gt; \
///   --project backend/src/Nix.Api \
///   --startup-project backend/src/Nix.Migrator \
///   --output-dir Persistence/Migrations/Generated
/// </code>
/// </remarks>
public static class NixMigrationRunner
{
    /// <summary>The runtime role, whose privileges the migration job verifies.</summary>
    public const string DefaultApplicationRoleName = "nix_app";

    /// <summary>
    /// Applies every pending migration.
    /// </summary>
    /// <param name="migratorConnectionString">
    /// A connection string for the schema-owning role. Must authenticate as a role holding
    /// <c>BYPASSRLS</c>.
    /// </param>
    /// <param name="applicationRoleName">
    /// The runtime role to audit while we are here. Pass <see langword="null"/> to skip the audit
    /// (only sensible where the runtime role is not provisioned yet).
    /// </param>
    /// <param name="cancellationToken">Cancels the run.</param>
    /// <returns>What the run did.</returns>
    /// <exception cref="InvalidOperationException">
    /// The connected role cannot bypass row-level security, or the runtime role can.
    /// </exception>
    public static async Task<NixMigrationOutcome> RunAsync(
        string migratorConnectionString,
        string? applicationRoleName = DefaultApplicationRoleName,
        CancellationToken cancellationToken = default)
    {
        ArgumentException.ThrowIfNullOrWhiteSpace(migratorConnectionString);

        // No interceptors. The RLS session interceptor would demand a tenant context that DDL has
        // no business carrying, and the transaction guard would fight EF's own migration
        // transactions. Migrations are the one path that legitimately runs outside tenant scope,
        // which is precisely why it is a separate role, a separate process, and a separate
        // context configuration rather than a flag on the application's.
        var options = new DbContextOptionsBuilder<NixDbContext>()
            .UseNpgsql(migratorConnectionString)
            .Options;

        var context = new NixDbContext(options);
        await using (context.ConfigureAwait(false))
        {
            var role = await AssertMigrationPrivilegesAsync(context, applicationRoleName, cancellationToken)
                .ConfigureAwait(false);

            var alreadyPresent = (await context.Database
                .GetAppliedMigrationsAsync(cancellationToken)
                .ConfigureAwait(false)).ToArray();

            var pending = (await context.Database
                .GetPendingMigrationsAsync(cancellationToken)
                .ConfigureAwait(false)).ToArray();

            await context.Database.MigrateAsync(cancellationToken).ConfigureAwait(false);

            return new NixMigrationOutcome(role, pending, alreadyPresent);
        }
    }

    private static async Task<string> AssertMigrationPrivilegesAsync(
        NixDbContext context,
        string? applicationRoleName,
        CancellationToken cancellationToken)
    {
        // A read-only transaction purely so the shared SQL executor - which insists on one,
        // because the application's SQL always needs a tenant scope - can be reused here.
        var transaction = await context.Database.BeginTransactionAsync(cancellationToken).ConfigureAwait(false);
        await using (transaction.ConfigureAwait(false))
        {
            var executor = new NixSqlExecutor(context);

            var role = await executor
                .ScalarRefAsync<string>(RoleSql.CurrentRoleName, cancellationToken: cancellationToken)
                .ConfigureAwait(false)
                ?? throw new InvalidOperationException("The database did not report a current role.");

            var canBypass = await executor
                .ScalarAsync<bool>(RoleSql.CurrentRoleBypassesRls, cancellationToken: cancellationToken)
                .ConfigureAwait(false) ?? false;

            if (!canBypass)
            {
                throw new InvalidOperationException(
                    $"Refusing to migrate as '{role}': the role cannot bypass row-level security, " +
                    "so it is not the schema owner. Migrations run as nix_migrator, which is the " +
                    "only role holding BYPASSRLS. Check which connection string this job was given.");
            }

            if (applicationRoleName is not null)
            {
                await AssertApplicationRoleIsConfinedAsync(executor, applicationRoleName, cancellationToken)
                    .ConfigureAwait(false);
            }

            await transaction.RollbackAsync(cancellationToken).ConfigureAwait(false);
            return role;
        }
    }

    private static async Task AssertApplicationRoleIsConfinedAsync(
        NixSqlExecutor executor,
        string applicationRoleName,
        CancellationToken cancellationToken)
    {
        var parameters = new[] { new NpgsqlParameter<string>("role_name", applicationRoleName) };

        var applicationCanBypass = await executor
            .ScalarAsync<bool>(RoleSql.RoleBypassesRlsByName, parameters, cancellationToken)
            .ConfigureAwait(false) ?? false;

        if (applicationCanBypass)
        {
            throw new InvalidOperationException(
                $"Refusing to migrate: the runtime role '{applicationRoleName}' can bypass " +
                "row-level security. Every RLS policy in this database is decorative until that " +
                "is revoked, so the rollout stops here rather than shipping a schema whose " +
                "tenant isolation does not hold.");
        }
    }
}
