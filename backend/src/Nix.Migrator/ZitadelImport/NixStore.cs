using Microsoft.AspNetCore.DataProtection;
using Nix.Domain.Identity;
using Nix.Domain.Provisioning;
using Nix.Domain.Tenancy;
using Nix.Persistence.Sql.Statements;
using Npgsql;
using NpgsqlTypes;

namespace Nix.Migrator.ZitadelImport;

/// <summary>How many rows of each kind an import wrote, or would write.</summary>
internal sealed class ImportCounts
{
    /// <summary>People who had never signed in to Nix and got a principal and workspace.</summary>
    public int PrincipalsCreated { get; set; }

    /// <summary>Local accounts written.</summary>
    public int Accounts { get; set; }

    /// <summary>Accounts that already existed and were left as they are.</summary>
    public int AccountsAlreadyThere { get; set; }

    /// <summary>Accounts that carry a password hash.</summary>
    public int Passwords { get; set; }

    /// <summary>Authenticator secrets written.</summary>
    public int Authenticators { get; set; }

    /// <summary>Passkeys written.</summary>
    public int Passkeys { get; set; }

    /// <summary>Second-step security keys written.</summary>
    public int SecurityKeys { get; set; }
}

/// <summary>Reads the Nix side for planning and writes the plan. Runs as the migrator role, which bypasses row security.</summary>
internal static class NixStore
{
    /// <summary>The data-protection purpose Core uses for authenticator secrets; it must match LocalCredentialStore.</summary>
    internal const string TotpPurpose = "Nix.Auth.Totp.v1";

    /// <summary>Reads existing Zitadel-backed principals, local accounts and the identity provider.</summary>
    public static async Task<NixState> ReadAsync(NpgsqlConnection nix, IReadOnlyCollection<string> subjects, CancellationToken ct)
    {
        var principals = new Dictionary<string, ExistingPrincipal>(StringComparer.Ordinal);
        var providers = new HashSet<(Guid, string)>();
        var emails = new Dictionary<string, Guid>(StringComparer.Ordinal);

        await Read(nix, "SELECT tenant_id, issuer FROM identity_provider", [], r => providers.Add((r.GetGuid(0), r.GetString(1))), ct).ConfigureAwait(false);
        await Read(
            nix,
            """
            SELECT p.external_subject, p.principal_id, p.tenant_id
              FROM principal p JOIN identity_provider i ON i.tenant_id = p.tenant_id AND i.issuer = p.external_issuer
             WHERE p.kind = 'user' AND p.external_subject = ANY(@subjects)
            """,
            [("subjects", subjects.ToArray())],
            r => principals[r.GetString(0)] = new ExistingPrincipal(r.GetGuid(1), r.GetGuid(2)),
            ct).ConfigureAwait(false);
        await Read(nix, "SELECT email_normalized, principal_id FROM local_account", [], r => emails[r.GetString(0)] = r.GetGuid(1), ct).ConfigureAwait(false);

        return new NixState(principals, emails, providers.Count == 1 ? providers.Single() : null);
    }

    /// <summary>Writes the plan. The caller owns the transaction.</summary>
    public static async Task<ImportCounts> WriteAsync(
        NpgsqlConnection nix, ImportPlan plan, string issuer, string rpId, IDataProtectionProvider? protection, DateTimeOffset now, CancellationToken ct)
    {
        var counts = new ImportCounts();
        var totp = protection?.CreateProtector(TotpPurpose);
        foreach (var a in plan.Accounts)
        {
            if (a.NewPrincipal)
            {
                await CreatePrincipalAsync(nix, a, issuer, now, ct).ConfigureAwait(false);
                counts.PrincipalsCreated++;
            }

            if (await Exec(
                nix,
                """
                INSERT INTO local_account (principal_id, tenant_id, email_normalized, password_hash, password_changed_at)
                VALUES (@p, @t, @email, @hash, @changed) ON CONFLICT DO NOTHING
                """,
                ct,
                ("p", a.PrincipalId), ("t", a.TenantId), ("email", a.Email),
                ("hash", OrNull(a.PasswordHash)), ("changed", OrNull(a.PasswordSetAt))).ConfigureAwait(false) == 1)
            {
                counts.Accounts++;
                counts.Passwords += a.PasswordHash is null ? 0 : 1;
            }
            else
            {
                counts.AccountsAlreadyThere++;
            }

            if (a.TotpSecret is { } secret && totp is not null
                && await Exec(
                    nix,
                    "INSERT INTO local_totp (principal_id, tenant_id, secret, confirmed_at) VALUES (@p, @t, @secret, @now) ON CONFLICT DO NOTHING",
                    ct,
                    ("p", a.PrincipalId), ("t", a.TenantId), ("secret", totp.Protect(Convert.ToBase64String(secret))), ("now", now)).ConfigureAwait(false) == 1)
            {
                counts.Authenticators++;
            }

            foreach (var key in a.Passkeys)
            {
                var inserted = await Exec(
                    nix,
                    """
                    INSERT INTO local_passkey (id, principal_id, tenant_id, credential_id, public_key, sign_count, aaguid, rp_id, kind, name, created_at)
                    VALUES (@id, @p, @t, @cred, @pub, @count, @aaguid, @rp, @kind, @name, @created) ON CONFLICT DO NOTHING
                    """,
                    ct,
                    ("id", Guid.CreateVersion7()), ("p", a.PrincipalId), ("t", a.TenantId), ("cred", key.CredentialId), ("pub", key.PublicKey),
                    ("count", key.SignCount), ("aaguid", OrNull(key.Aaguid)), ("rp", rpId),
                    ("kind", key.SecurityKey ? "security_key" : "passkey"), ("name", DisplayName(key)), ("created", key.CreatedAt)).ConfigureAwait(false);
                if (inserted == 1)
                {
                    if (key.SecurityKey)
                    {
                        counts.SecurityKeys++;
                    }
                    else
                    {
                        counts.Passkeys++;
                    }
                }
            }
        }

        return counts;
    }

    internal static string DisplayName(ZitadelWebAuthn key)
    {
        var name = key.Name.Trim();
        if (name.Length == 0)
        {
            return key.SecurityKey ? "Imported security key" : "Imported passkey";
        }

        return name.Length > 100 ? name[..100] : name;
    }

    // shortcut: no preset catalog entries or audit row for people created here (the first sign-in path adds them), add if a person reports a missing preset.
    private static async Task CreatePrincipalAsync(NpgsqlConnection nix, PlannedAccount a, string issuer, DateTimeOffset now, CancellationToken ct)
    {
        var principal = PrincipalId.From(a.PrincipalId);
        var workspace = DeterministicProvisioningId.PersonalWorkspace(principal);
        var name = string.IsNullOrWhiteSpace(a.User.DisplayName) ? "Nix user" : a.User.DisplayName.Trim();
        _ = await Exec(
            nix, ProvisioningSql.InsertPrincipal, ct,
            ("principal_id", a.PrincipalId), ("tenant_id", a.TenantId), ("subject", a.User.Id), ("issuer", issuer),
            ("display_name", name), ("email", a.User.Email), ("email_normalized", a.Email), ("email_verified", true)).ConfigureAwait(false);
        _ = await Exec(
            nix, ProvisioningSql.InsertWorkspace, ct,
            ("workspace_id", workspace.Value), ("tenant_id", a.TenantId), ("workspace_name", $"{name}'s workspace"),
            ("principal_id", a.PrincipalId), ("now", now)).ConfigureAwait(false);
        _ = await Exec(
            nix, ProvisioningSql.SeedWorkspace, ct,
            ("workspace_id", workspace.Value), ("principal_id", a.PrincipalId), ("tenant_id", a.TenantId),
            ("daily_root_id", DeterministicProvisioningId.DailyNotesRoot(workspace)), ("now", now)).ConfigureAwait(false);
    }

    private static object OrNull(object? value) => value ?? DBNull.Value;

#pragma warning disable CA2100 // Every statement is a constant of this file or of ProvisioningSql; values only travel as parameters.
    private static async Task<int> Exec(NpgsqlConnection nix, string sql, CancellationToken ct, params (string Name, object Value)[] parameters)
    {
        var command = new NpgsqlCommand(sql, nix);
        await using (command.ConfigureAwait(false))
        {
            foreach (var (name, value) in parameters)
            {
                _ = command.Parameters.Add(new NpgsqlParameter(name, value) { NpgsqlDbType = TypeOf(value) });
            }

            return await command.ExecuteNonQueryAsync(ct).ConfigureAwait(false);
        }
    }

#pragma warning restore CA2100

    private static NpgsqlDbType TypeOf(object value) => value switch
    {
        Guid => NpgsqlDbType.Uuid,
        DateTimeOffset => NpgsqlDbType.TimestampTz,
        byte[] => NpgsqlDbType.Bytea,
        long => NpgsqlDbType.Bigint,
        bool => NpgsqlDbType.Boolean,
        string => NpgsqlDbType.Text,
        _ => NpgsqlDbType.Unknown,
    };

#pragma warning disable CA2100 // Constant statements only, as above.
    private static async Task Read(NpgsqlConnection nix, string sql, (string Name, object Value)[] parameters, Action<NpgsqlDataReader> row, CancellationToken ct)
    {
        var command = new NpgsqlCommand(sql, nix);
        await using (command.ConfigureAwait(false))
        {
            foreach (var (name, value) in parameters)
            {
                _ = command.Parameters.AddWithValue(name, value);
            }

            var reader = await command.ExecuteReaderAsync(ct).ConfigureAwait(false);
            await using (reader.ConfigureAwait(false))
            {
                while (await reader.ReadAsync(ct).ConfigureAwait(false))
                {
                    row(reader);
                }
            }
        }
    }
#pragma warning restore CA2100
}
