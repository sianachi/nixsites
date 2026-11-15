using System.Globalization;
using Microsoft.Extensions.Configuration;
using Nix.Domain.Identity;
using Nix.Domain.Provisioning;
using Nix.Domain.Tenancy;
using Npgsql;
using NpgsqlTypes;

namespace Nix.Migrator;

// Host-side account commands, run with the migrator's connection string (the one role that bypasses row-level
// security, because these run when nobody can sign in):
//
//   account reset-link --email <address>              a one-hour link for an existing local account
//   account service-token --name <name> [--scopes read,write] [--expires-days 365]
//                                                      a service principal and its access token, shown once
//
// The first line of stdout is the result and nothing else is printed there, so a script can capture it.
internal static class AccountCommands
{
    private const string ServiceIssuer = "nix-service";

    /// <summary>True when the arguments ask for an account command rather than a migration.</summary>
    internal static bool Matches(string[] args) => args.Length >= 2 && args[0] == "account";

    internal static async Task<int> RunAsync(string[] args, IConfiguration configuration, string connectionString, CancellationToken cancellationToken)
    {
        switch (args[1])
        {
            case "reset-link":
                return await ResetLinkAsync(configuration, connectionString, cancellationToken).ConfigureAwait(false);
            case "service-token":
                return await ServiceTokenAsync(configuration, connectionString, cancellationToken).ConfigureAwait(false);
            default:
                return Usage($"Unknown account command '{args[1]}'.");
        }
    }

    private static async Task<int> ResetLinkAsync(IConfiguration configuration, string connectionString, CancellationToken cancellationToken)
    {
        if (!LocalAccountEmail.TryNormalize(configuration["email"], out var email))
        {
            return Usage("reset-link needs --email <address>.");
        }

        var origin = configuration["origin"] ?? configuration["Nix:Bff:PublicOrigin"];
        if (!Uri.TryCreate(origin, UriKind.Absolute, out var publicOrigin))
        {
            return Usage("The public origin is not set: provide Nix__Bff__PublicOrigin or --origin https://<host>.");
        }

        var connection = new NpgsqlConnection(connectionString);
        await using (connection.ConfigureAwait(false))
        {
            await connection.OpenAsync(cancellationToken).ConfigureAwait(false);

            Guid principal;
            string status;
            var find = new NpgsqlCommand(
                "SELECT a.principal_id, p.status FROM local_account a JOIN principal p ON p.principal_id = a.principal_id WHERE a.email_normalized = @email",
                connection);
            await using (find.ConfigureAwait(false))
            {
                find.Parameters.AddWithValue("email", email);
                var reader = await find.ExecuteReaderAsync(cancellationToken).ConfigureAwait(false);
                await using (reader.ConfigureAwait(false))
                {
                    if (!await reader.ReadAsync(cancellationToken).ConfigureAwait(false))
                    {
                        return Fail("No local account has that email address.");
                    }

                    principal = reader.GetGuid(0);
                    status = reader.GetString(1);
                }
            }

            // A link for a disabled person would be refused when opened, so say so now.
            if (status != "active")
            {
                return Fail("That account is disabled; an administrator must enable it first.");
            }

            var minted = LocalLinkToken.Mint();
            var create = new NpgsqlCommand("SELECT nix_local_create_link(@id, @principal, 'reset', @hash, @expires, NULL)", connection);
            await using (create.ConfigureAwait(false))
            {
                create.Parameters.Add(new NpgsqlParameter("id", NpgsqlDbType.Uuid) { Value = Guid.CreateVersion7() });
                create.Parameters.Add(new NpgsqlParameter("principal", NpgsqlDbType.Uuid) { Value = principal });
                create.Parameters.Add(new NpgsqlParameter("hash", NpgsqlDbType.Text) { Value = minted.Hash });
                create.Parameters.Add(new NpgsqlParameter("expires", NpgsqlDbType.TimestampTz) { Value = DateTime.UtcNow + LocalLinkToken.Lifetime });
                if (await create.ExecuteScalarAsync(cancellationToken).ConfigureAwait(false) is not true)
                {
                    return Fail("No local account has that email address.");
                }
            }

            await Console.Out.WriteLineAsync(new Uri(publicOrigin, string.Create(CultureInfo.InvariantCulture, $"/account-link/{minted.Token}")).AbsoluteUri).ConfigureAwait(false);
            await Console.Error.WriteLineAsync("Valid for one hour, once. Using it signs the person out everywhere.").ConfigureAwait(false);
            return 0;
        }
    }

    private static async Task<int> ServiceTokenAsync(IConfiguration configuration, string connectionString, CancellationToken cancellationToken)
    {
        var name = configuration["name"]?.Trim();
        if (string.IsNullOrEmpty(name) || name.Length > PersonalAccessToken.MaximumNameLength)
        {
            return Usage($"service-token needs --name of 1 to {PersonalAccessToken.MaximumNameLength} characters.");
        }

        var scopes = ParseScopes(configuration["scopes"] ?? AccessTokenScopes.Read);
        if (scopes is null)
        {
            return Usage("--scopes must list some of: " + string.Join(", ", AccessTokenScopes.All) + ".");
        }

        if (!int.TryParse(configuration["expires-days"] ?? "365", CultureInfo.InvariantCulture, out var days)
            || days is < 1 or > PersonalAccessToken.MaximumLifetimeDays)
        {
            return Usage($"--expires-days must be 1 to {PersonalAccessToken.MaximumLifetimeDays}.");
        }

        var connection = new NpgsqlConnection(connectionString);
        await using (connection.ConfigureAwait(false))
        {
            await connection.OpenAsync(cancellationToken).ConfigureAwait(false);
            var minted = PersonalAccessTokenSecret.Mint();
            var transaction = await connection.BeginTransactionAsync(cancellationToken).ConfigureAwait(false);
            await using (transaction.ConfigureAwait(false))
            {
                var tenants = new List<Guid>();
                var listTenants = new NpgsqlCommand("SELECT tenant_id FROM tenant", connection, transaction);
                await using (listTenants.ConfigureAwait(false))
                {
                    var reader = await listTenants.ExecuteReaderAsync(cancellationToken).ConfigureAwait(false);
                    await using (reader.ConfigureAwait(false))
                    {
                        while (await reader.ReadAsync(cancellationToken).ConfigureAwait(false))
                        {
                            tenants.Add(reader.GetGuid(0));
                        }
                    }
                }

                var wanted = configuration["tenant"];
                var tenant = wanted is not null && Guid.TryParse(wanted, out var parsed) ? parsed
                    : tenants.Count == 1 && wanted is null ? tenants[0]
                    : Guid.Empty;
                if (!tenants.Contains(tenant))
                {
                    return Usage("This install does not have exactly one organization; pass --tenant <id>.");
                }

                // Same name, same principal: a second run mints another token for it instead of a second identity.
                var principal = DeterministicProvisioningId.Principal(TenantId.From(tenant), ServiceIssuer, name).Value;
                var upsert = new NpgsqlCommand(
                    """
                    INSERT INTO principal (principal_id, tenant_id, external_subject, external_issuer, kind, display_name, status)
                    VALUES (@principal, @tenant, @name, @issuer, 'service', @name, 'active')
                    ON CONFLICT (principal_id) DO NOTHING
                    """,
                    connection,
                    transaction);
                await using (upsert.ConfigureAwait(false))
                {
                    upsert.Parameters.Add(new NpgsqlParameter("principal", NpgsqlDbType.Uuid) { Value = principal });
                    upsert.Parameters.Add(new NpgsqlParameter("tenant", NpgsqlDbType.Uuid) { Value = tenant });
                    upsert.Parameters.Add(new NpgsqlParameter("name", NpgsqlDbType.Text) { Value = name });
                    upsert.Parameters.Add(new NpgsqlParameter("issuer", NpgsqlDbType.Text) { Value = ServiceIssuer });
                    _ = await upsert.ExecuteNonQueryAsync(cancellationToken).ConfigureAwait(false);
                }

                var now = DateTimeOffset.UtcNow;
                var insert = new NpgsqlCommand(
                    """
                    INSERT INTO personal_access_token (token_id, tenant_id, principal_id, name, lookup, secret_hash, scopes, created_at, expires_at)
                    VALUES (@id, @tenant, @principal, @name, @lookup, @hash, @scopes, @now, @expires)
                    """,
                    connection,
                    transaction);
                await using (insert.ConfigureAwait(false))
                {
                    insert.Parameters.Add(new NpgsqlParameter("id", NpgsqlDbType.Uuid) { Value = PersonalAccessTokenId.Create().Value });
                    insert.Parameters.Add(new NpgsqlParameter("tenant", NpgsqlDbType.Uuid) { Value = tenant });
                    insert.Parameters.Add(new NpgsqlParameter("principal", NpgsqlDbType.Uuid) { Value = principal });
                    insert.Parameters.Add(new NpgsqlParameter("name", NpgsqlDbType.Text) { Value = name });
                    insert.Parameters.Add(new NpgsqlParameter("lookup", NpgsqlDbType.Text) { Value = minted.Lookup });
                    insert.Parameters.Add(new NpgsqlParameter("hash", NpgsqlDbType.Bytea) { Value = minted.Hash.ToArray() });
                    insert.Parameters.Add(new NpgsqlParameter("scopes", NpgsqlDbType.Array | NpgsqlDbType.Text) { Value = scopes });
                    insert.Parameters.Add(new NpgsqlParameter("now", NpgsqlDbType.TimestampTz) { Value = now.UtcDateTime });
                    insert.Parameters.Add(new NpgsqlParameter("expires", NpgsqlDbType.TimestampTz) { Value = now.AddDays(days).UtcDateTime });
                    _ = await insert.ExecuteNonQueryAsync(cancellationToken).ConfigureAwait(false);
                }

                await transaction.CommitAsync(cancellationToken).ConfigureAwait(false);
            }

            await Console.Out.WriteLineAsync(minted.Token).ConfigureAwait(false);
            return 0;
        }
    }

    private static string[]? ParseScopes(string list)
    {
        var held = new bool[AccessTokenScopes.All.Count];
        foreach (var part in list.Split(',', StringSplitOptions.RemoveEmptyEntries | StringSplitOptions.TrimEntries))
        {
            if (!AccessTokenScopes.TryParse(part, out var scope))
            {
                return null;
            }

            held[(int)scope] = true;
        }

        var result = Enumerable.Range(0, held.Length).Where(i => held[i]).Select(i => AccessTokenScopes.Format((AccessTokenScope)i)).ToArray();
        return result.Length == 0 ? null : result;
    }

    private static int Usage(string message)
    {
        Console.Error.WriteLine(message);
        Console.Error.WriteLine("Usage: account reset-link --email <address> | account service-token --name <name> [--scopes read,write] [--expires-days 365] [--tenant <id>]");
        return 2;
    }

    private static int Fail(string message)
    {
        Console.Error.WriteLine(message);
        return 1;
    }
}
