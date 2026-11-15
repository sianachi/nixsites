using System.Globalization;
using Microsoft.AspNetCore.DataProtection;
using Microsoft.Extensions.Configuration;
using Nix.Domain.Provisioning;
using Nix.Domain.Tenancy;
using Npgsql;

namespace Nix.Migrator.ZitadelImport;

/// <summary>
/// <c>account import-zitadel [--dry-run]</c>: carries the bundled Zitadel's people and credentials into Core's own
/// sign-in tables, attaching them to the principal rows that already exist so ids, content, sessions and access
/// tokens survive. Zitadel's database is only ever read.
/// </summary>
internal static class ZitadelImportCommand
{
    internal const string ZitadelUrlVariable = "NIX_ZITADEL_DATABASE_URL";
    internal const string MasterKeyVariable = "NIX_ZITADEL_MASTERKEY";

    /// <summary>Runs the command and returns the process exit code: 0 done, 3 refused, 2 misconfigured.</summary>
    public static async Task<int> RunAsync(string[] args, IConfiguration configuration, TextWriter output, CancellationToken ct)
    {
        ArgumentNullException.ThrowIfNull(args);
        ArgumentNullException.ThrowIfNull(configuration);
        ArgumentNullException.ThrowIfNull(output);

        var dryRun = args.Contains("--dry-run", StringComparer.Ordinal);
        var unknown = args.Where(static a => a is not "--dry-run").ToArray();
        if (unknown.Length > 0)
        {
            await output.WriteLineAsync($"Unknown argument: {unknown[0]}. Usage: account import-zitadel [--dry-run]").ConfigureAwait(false);
            return 2;
        }

        var nixConnection = configuration["ConnectionString"] ?? configuration["NIX_MIGRATOR_CONNECTION_STRING"];
        var zitadelUrl = configuration[ZitadelUrlVariable];
        var masterKey = configuration[MasterKeyVariable];
        if (string.IsNullOrWhiteSpace(nixConnection) || string.IsNullOrWhiteSpace(zitadelUrl) || string.IsNullOrWhiteSpace(masterKey))
        {
            await output.WriteLineAsync($"Set NIX_MIGRATOR_CONNECTION_STRING, {ZitadelUrlVariable} and {MasterKeyVariable}.").ConfigureAwait(false);
            return 2;
        }

        if (configuration["NIX_ZITADEL_VERSION"] is { Length: > 0 } declared
            && !string.Equals(declared.TrimStart('v'), ZitadelSource.SupportedVersion, StringComparison.Ordinal))
        {
            await output.WriteLineAsync($"Refused: Zitadel {declared} is declared, and only v{ZitadelSource.SupportedVersion} is supported.").ConfigureAwait(false);
            return 3;
        }

        try
        {
            return await ImportAsync(nixConnection, zitadelUrl, masterKey, configuration, dryRun, output, ct).ConfigureAwait(false);
        }
        catch (ImportRefusedException refused)
        {
            await output.WriteLineAsync($"Refused: {refused.Message}").ConfigureAwait(false);
            return 3;
        }
    }

    private static async Task<int> ImportAsync(
        string nixConnection, string zitadelUrl, string masterKey, IConfiguration configuration, bool dryRun, TextWriter output, CancellationToken ct)
    {
        var snapshot = await ZitadelSource.ReadAsync(zitadelUrl, masterKey, ct).ConfigureAwait(false);
        var nix = new NpgsqlConnection(nixConnection);
        await using (nix.ConfigureAwait(false))
        {
            await nix.OpenAsync(ct).ConfigureAwait(false);
            var state = await NixStore.ReadAsync(nix, [.. snapshot.Users.Select(static u => u.Id)], ct).ConfigureAwait(false);
            var issuer = state.OnlyProvider?.Issuer;
            var plan = ZitadelImportPlanner.Plan(
                snapshot.Users, snapshot.Credentials, snapshot.MachineUsers, state, snapshot.OtpKey,
                (tenant, subject) => DeterministicProvisioningId.Principal(TenantId.From(tenant), issuer ?? string.Empty, subject).Value);

            // Migrated passkeys keep the hostname they were created for; Core must be told the same value.
            var rpId = configuration["Nix:Auth:Passkeys:RpId"] is { Length: > 0 } configured ? configured : snapshot.PrimaryDomain ?? string.Empty;
            var needsKeys = plan.Accounts.Any(static a => a.TotpSecret is not null);
            var keysPath = configuration["Nix:Bff:DataProtectionKeysPath"];
            if (needsKeys && string.IsNullOrWhiteSpace(keysPath))
            {
                plan.Blockers.Add("Authenticator secrets need the data protection key ring Core uses: set Nix__Bff__DataProtectionKeysPath to the same directory.");
            }

            await Report(output, plan, snapshot, rpId, dryRun).ConfigureAwait(false);
            if (plan.Clashes.Count > 0 || plan.Blockers.Count > 0)
            {
                await output.WriteLineAsync("Refused: nothing was written.").ConfigureAwait(false);
                return 3;
            }

            var protection = needsKeys
                ? DataProtectionProvider.Create(new DirectoryInfo(keysPath!), static o => o.SetApplicationName("Nix"))
                : null;
            var transaction = await nix.BeginTransactionAsync(ct).ConfigureAwait(false);
            await using (transaction.ConfigureAwait(false))
            {
                var counts = await NixStore.WriteAsync(nix, plan, issuer ?? string.Empty, rpId, protection, DateTimeOffset.UtcNow, ct).ConfigureAwait(false);
                if (dryRun)
                {
                    await transaction.RollbackAsync(ct).ConfigureAwait(false);
                }
                else
                {
                    await transaction.CommitAsync(ct).ConfigureAwait(false);
                }

                await WriteCounts(output, counts, dryRun).ConfigureAwait(false);
            }
        }

        return 0;
    }

    // The dry run runs the real writes and rolls them back, so its numbers are exactly what a real run would do.
    private static async Task WriteCounts(TextWriter output, ImportCounts c, bool dryRun)
    {
        var verb = dryRun ? "would write" : "wrote";
        await output.WriteLineAsync(string.Create(
            CultureInfo.InvariantCulture,
            $"{verb}: {c.Accounts} accounts ({c.Passwords} with a password, {c.PrincipalsCreated} new principals), {c.Authenticators} authenticator apps, {c.Passkeys} passkeys, {c.SecurityKeys} security keys; {c.AccountsAlreadyThere} accounts already present")).ConfigureAwait(false);
    }

    private static async Task Report(TextWriter output, ImportPlan plan, ZitadelSnapshot snapshot, string rpId, bool dryRun)
    {
        await output.WriteLineAsync(string.Create(
            CultureInfo.InvariantCulture,
            $"{(dryRun ? "Dry run: " : string.Empty)}{snapshot.Users.Count} Zitadel people, {plan.Accounts.Count} to import.")).ConfigureAwait(false);
        foreach (var clash in plan.Clashes)
        {
            await output.WriteLineAsync($"CLASH {clash.Email}: {string.Join(", ", clash.Owners)}").ConfigureAwait(false);
        }

        foreach (var blocker in plan.Blockers)
        {
            await output.WriteLineAsync($"BLOCKED {blocker}").ConfigureAwait(false);
        }

        foreach (var line in plan.NotCarried)
        {
            await output.WriteLineAsync($"not carried, {line}").ConfigureAwait(false);
        }

        if (plan.Accounts.Any(static a => a.Passkeys.Count > 0))
        {
            await output.WriteLineAsync($"Passkeys keep the RP ID '{rpId}'. Set Nix__Auth__Passkeys__RpId={rpId} on Core, or they will not verify.").ConfigureAwait(false);
        }
    }
}
