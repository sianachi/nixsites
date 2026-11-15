using Microsoft.Extensions.DependencyInjection;
using Microsoft.Extensions.Hosting;
using Microsoft.Extensions.Logging;
using Nix.Persistence.Migrations;
using Npgsql;

namespace Nix.Migrator;

// Nix migration job.
//
// The one process allowed to change the schema, run as nix_migrator - the only role holding
// BYPASSRLS. It is a Kubernetes Job that must complete before a rollout proceeds, never a startup
// hook in the API: replicas would race, the runtime role would need DDL rights it must never
// have, and a bad migration would present as a crash loop instead of a failed job.
//
//   NIX_MIGRATOR_CONNECTION_STRING="Host=localhost;Port=5433;Database=nix;Username=nix_migrator;Password=nix-dev-migrator" \
//     dotnet run --project backend/src/Nix.Migrator
//
//   dotnet run --project backend/src/Nix.Migrator -- --ConnectionString="..."
//
// Exit code 0 means the schema is at the head revision. Any other code means it is not, and the
// rollout must stop.
internal static class Migrator
{
    private static async Task<int> Main(string[] args)
    {
        const string connectionStringKey = "ConnectionString";
        const string connectionStringEnvironmentVariable = "NIX_MIGRATOR_CONNECTION_STRING";
        const string applicationRoleKey = "ApplicationRole";

        var builder = Host.CreateApplicationBuilder(args);
        using var host = builder.Build();

        var logger = host.Services.GetRequiredService<ILoggerFactory>().CreateLogger("Nix.Migrator");

        var connectionString = builder.Configuration[connectionStringKey]
            ?? builder.Configuration[connectionStringEnvironmentVariable];

        if (string.IsNullOrWhiteSpace(connectionString))
        {
            MigratorLog.MissingConnectionString(logger, connectionStringEnvironmentVariable, connectionStringKey);
            return 2;
        }

        var applicationRole = builder.Configuration[applicationRoleKey]
            ?? NixMigrationRunner.DefaultApplicationRoleName;

        using var cancellation = new CancellationTokenSource();
        Console.CancelKeyPress += (_, eventArgs) =>
        {
            eventArgs.Cancel = true;
            cancellation.Cancel();
        };

        if (args is ["account", "import-zitadel", .. var importArgs])
        {
            return await Nix.Migrator.ZitadelImport.ZitadelImportCommand
                .RunAsync(importArgs, builder.Configuration, Console.Out, cancellation.Token).ConfigureAwait(false);
        }

        try
        {
            if (AccountCommands.Matches(args))
            {
                return await AccountCommands.RunAsync(args, builder.Configuration, connectionString, cancellation.Token).ConfigureAwait(false);
            }

            var target = new NpgsqlConnectionStringBuilder(connectionString);
            MigratorLog.Starting(logger, target.Host ?? "(unspecified)", target.Database ?? "(unspecified)");

            var outcome = await NixMigrationRunner
                .RunAsync(connectionString, applicationRole, cancellation.Token)
                .ConfigureAwait(false);

            MigratorLog.Connected(logger, outcome.Role, outcome.AlreadyPresent.Count, outcome.AppliedNow.Count);

            foreach (var migration in outcome.AppliedNow)
            {
                MigratorLog.Applied(logger, migration);
            }

            if (outcome.AppliedNow.Count == 0)
            {
                MigratorLog.UpToDate(logger);
            }

            return 0;
        }
#pragma warning disable CA1031 // Do not catch general exception types
        // Justification: this is a process entry point. Every failure - a refused role, a bad connection
        // string, a migration that throws - must become a non-zero exit code and one logged error, so the
        // Job fails and the rollout stops. Letting it escape would produce an unhandled-exception dump
        // with the same effect and worse diagnostics.
        catch (Exception exception)
        {
            MigratorLog.Failed(logger, exception);
            return 1;
        }
#pragma warning restore CA1031
    }
}
