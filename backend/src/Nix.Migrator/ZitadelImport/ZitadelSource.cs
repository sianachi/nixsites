using System.Globalization;
using System.Security.Cryptography;
using System.Text;
using System.Text.Json;
using Npgsql;

namespace Nix.Migrator.ZitadelImport;

/// <summary>Everything read from Zitadel's database. Read-only: the session itself refuses writes.</summary>
internal sealed record ZitadelSnapshot(
    IReadOnlyList<ZitadelUser> Users,
    IReadOnlyDictionary<string, ZitadelCredentials> Credentials,
    int MachineUsers,
    string? PrimaryDomain,
    Func<string, byte[]?> OtpKey);

/// <summary>Reads the pinned Zitadel version's tables. Anything else is refused before a row is read.</summary>
internal static class ZitadelSource
{
    /// <summary>The one Zitadel release the bundled install runs and this importer understands.</summary>
    public const string SupportedVersion = "4.16.1";

    // SHA-256 of the sorted, newline-joined names of the system.migration.done events of a v4.16.1 database. Zitadel
    // records no version number in its database, but each release adds its own setup steps, so the set identifies it.
    internal const string MigrationFingerprint = "7849509758602e84634a165eb712c7bd36a6d38ae3f89977e1cc39051ffba712";

    /// <summary>Accepts a postgres:// URL or an Npgsql connection string, and forces a read-only session.</summary>
    public static string ConnectionString(string value)
    {
        ArgumentException.ThrowIfNullOrWhiteSpace(value);
        NpgsqlConnectionStringBuilder builder;
        if (Uri.TryCreate(value, UriKind.Absolute, out var uri) && uri.Scheme is "postgres" or "postgresql")
        {
            var user = uri.UserInfo.Split(':', 2);
            builder = new NpgsqlConnectionStringBuilder
            {
                Host = uri.Host,
                Port = uri.IsDefaultPort ? 5432 : uri.Port,
                Database = Uri.UnescapeDataString(uri.AbsolutePath.TrimStart('/')),
                Username = Uri.UnescapeDataString(user[0]),
                Password = user.Length > 1 ? Uri.UnescapeDataString(user[1]) : null,
            };
            foreach (var pair in uri.Query.TrimStart('?').Split('&', StringSplitOptions.RemoveEmptyEntries))
            {
                var kv = pair.Split('=', 2);
                if (kv[0] == "sslmode" && kv.Length == 2 && Enum.TryParse<SslMode>(kv[1], true, out var mode))
                {
                    builder.SslMode = mode;
                }
            }
        }
        else
        {
            builder = new NpgsqlConnectionStringBuilder(value);
        }

        builder.Options = "-c default_transaction_read_only=on";
        return builder.ConnectionString;
    }

    /// <summary>Checks the version, then reads users, credentials and keys.</summary>
    public static async Task<ZitadelSnapshot> ReadAsync(string connectionString, string masterKey, CancellationToken ct)
    {
        var source = new NpgsqlConnection(ConnectionString(connectionString));
        await using (source.ConfigureAwait(false))
        {
            await source.OpenAsync(ct).ConfigureAwait(false);
            await CheckVersionAsync(source, ct).ConfigureAwait(false);

            if (await Scalar<long>(source, "SELECT count(*) FROM projections.instances", ct).ConfigureAwait(false) != 1)
            {
                throw new ImportRefusedException("The Zitadel database holds more than one instance; the bundled install has exactly one.");
            }

            var instance = await Scalar<string>(source, "SELECT id FROM projections.instances", ct).ConfigureAwait(false);
            var primaryDomain = await Scalar<string>(source, "SELECT domain FROM projections.instance_domains WHERE is_primary AND instance_id = @i", ct, ("i", instance)).ConfigureAwait(false);
            var users = await ReadUsersAsync(source, instance, ct).ConfigureAwait(false);
            var machines = await Scalar<long>(source, "SELECT count(*) FROM projections.users14 WHERE type = 2 AND state <> 3 AND instance_id = @i", ct, ("i", instance)).ConfigureAwait(false);
            var events = await ReadEventsAsync(source, instance, ct).ConfigureAwait(false);
            var keys = await ReadKeysAsync(source, masterKey, ct).ConfigureAwait(false);
            return new ZitadelSnapshot(users, ZitadelEventFold.Fold(events), (int)machines, primaryDomain, id => keys.GetValueOrDefault(id));
        }
    }

    private static async Task CheckVersionAsync(NpgsqlConnection source, CancellationToken ct)
    {
        var names = new List<string>();
        var command = new NpgsqlCommand("SELECT DISTINCT payload->>'name' FROM eventstore.events2 WHERE event_type = 'system.migration.done'", source);
        await using (command.ConfigureAwait(false))
        {
            var reader = await command.ExecuteReaderAsync(ct).ConfigureAwait(false);
            await using (reader.ConfigureAwait(false))
            {
                while (await reader.ReadAsync(ct).ConfigureAwait(false))
                {
                    names.Add(reader.GetString(0));
                }
            }
        }

        names.Sort(StringComparer.Ordinal);
        var found = Convert.ToHexStringLower(SHA256.HashData(Encoding.UTF8.GetBytes(string.Join('\n', names))));
        if (!string.Equals(found, MigrationFingerprint, StringComparison.Ordinal))
        {
            throw new ImportRefusedException(
                $"This is not a Zitadel v{SupportedVersion} database (setup steps: {names.Count.ToString(CultureInfo.InvariantCulture)}, fingerprint {found}). Only the bundled version is supported.");
        }
    }

    private static async Task<List<ZitadelUser>> ReadUsersAsync(NpgsqlConnection source, string instance, CancellationToken ct)
    {
        var users = new List<ZitadelUser>();
        var command = new NpgsqlCommand(
            """
            SELECT u.id, u.state, h.email, h.is_email_verified, coalesce(nullif(h.display_name, ''), h.first_name || ' ' || h.last_name)
              FROM projections.users14 u JOIN projections.users14_humans h ON h.user_id = u.id AND h.instance_id = u.instance_id
             WHERE u.type = 1 AND u.state <> 3 AND u.instance_id = @i
             ORDER BY u.id
            """, source);
        await using (command.ConfigureAwait(false))
        {
            _ = command.Parameters.AddWithValue("i", instance);
            var reader = await command.ExecuteReaderAsync(ct).ConfigureAwait(false);
            await using (reader.ConfigureAwait(false))
            {
                while (await reader.ReadAsync(ct).ConfigureAwait(false))
                {
                    users.Add(new ZitadelUser(reader.GetString(0), reader.GetInt16(1), reader.GetString(2), reader.GetBoolean(3), reader.GetString(4)));
                }
            }
        }

        return users;
    }

    private static async Task<List<ZitadelEvent>> ReadEventsAsync(NpgsqlConnection source, string instance, CancellationToken ct)
    {
        var events = new List<ZitadelEvent>();
        var command = new NpgsqlCommand(
            """
            SELECT aggregate_id, event_type, created_at, coalesce(payload, '{}'::jsonb)::text
              FROM eventstore.events2
             WHERE instance_id = @i AND aggregate_type = 'user' AND event_type LIKE 'user.human.%'
             ORDER BY aggregate_id, sequence
            """, source);
        await using (command.ConfigureAwait(false))
        {
            _ = command.Parameters.AddWithValue("i", instance);
            var reader = await command.ExecuteReaderAsync(ct).ConfigureAwait(false);
            await using (reader.ConfigureAwait(false))
            {
                while (await reader.ReadAsync(ct).ConfigureAwait(false))
                {
                    using var json = JsonDocument.Parse(reader.GetString(3));
                    events.Add(new ZitadelEvent(reader.GetString(0), reader.GetString(1), await reader.GetFieldValueAsync<DateTimeOffset>(2, ct).ConfigureAwait(false), json.RootElement.Clone()));
                }
            }
        }

        return events;
    }

    private static async Task<Dictionary<string, byte[]>> ReadKeysAsync(NpgsqlConnection source, string masterKey, CancellationToken ct)
    {
        var keys = new Dictionary<string, byte[]>(StringComparer.Ordinal);
        var command = new NpgsqlCommand("SELECT id, key FROM system.encryption_keys", source);
        await using (command.ConfigureAwait(false))
        {
            var reader = await command.ExecuteReaderAsync(ct).ConfigureAwait(false);
            await using (reader.ConfigureAwait(false))
            {
                while (await reader.ReadAsync(ct).ConfigureAwait(false))
                {
                    try
                    {
                        keys[reader.GetString(0)] = ZitadelCrypto.DecryptKey(reader.GetString(1), masterKey);
                    }
                    catch (Exception e) when (e is CryptographicException or FormatException or ArgumentException)
                    {
                        // A wrong masterkey surfaces as an undecryptable key only for the ones that are needed.
                    }
                }
            }
        }

        return keys;
    }

#pragma warning disable CA2100 // Constant statements only; values travel as parameters.
    private static async Task<T> Scalar<T>(NpgsqlConnection source, string sql, CancellationToken ct, params (string Name, object Value)[] parameters)
    {
        var command = new NpgsqlCommand(sql, source);
        await using (command.ConfigureAwait(false))
        {
            foreach (var (name, value) in parameters)
            {
                _ = command.Parameters.AddWithValue(name, value);
            }

            var value2 = await command.ExecuteScalarAsync(ct).ConfigureAwait(false);
            return value2 is null or DBNull ? throw new ImportRefusedException($"Zitadel returned no row for: {sql[..Math.Min(sql.Length, 60)]}") : (T)value2;
        }
    }
#pragma warning restore CA2100
}

/// <summary>An expected stop: the operator gets the message, not a stack trace.</summary>
internal sealed class ImportRefusedException : Exception
{
    public ImportRefusedException()
    {
    }

    public ImportRefusedException(string message)
        : base(message)
    {
    }

    public ImportRefusedException(string message, Exception innerException)
        : base(message, innerException)
    {
    }
}
