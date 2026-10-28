using Nix.Abstractions;
using Nix.Domain.Audit;
using Nix.Domain.Identity;
using Nix.Domain.Provisioning;
using Nix.Domain.Tenancy;
using Nix.Persistence.Sql;
using Nix.Persistence.Sql.Statements;
using Npgsql;
using NpgsqlTypes;

namespace Nix.Persistence.Identity;

/// <summary>Creates one principal and personal workspace inside the ordinary request transaction.</summary>
public sealed class PersonalWorkspaceProvisioner(
    NixSqlExecutor sql,
    TimeProvider clock)
    : IPersonalWorkspaceProvisioner
{
    private static readonly string[] PresetKeys = ["seed.kanban", "seed.calendar", "seed.list"];

    /// <summary>Creates or observes the one winner for an externally validated identity.</summary>
    public async ValueTask<AuthenticatedPrincipal> ProvisionAsync(
        TenantId tenantId,
        string issuer,
        string subject,
        UserInfoProfile profile,
        CancellationToken cancellationToken)
    {
        ArgumentException.ThrowIfNullOrWhiteSpace(issuer);
        ArgumentException.ThrowIfNullOrWhiteSpace(subject);
        ArgumentNullException.ThrowIfNull(profile);

        var displayName = profile.DisplayName ?? "Nix user";

        var principalId = DeterministicProvisioningId.Principal(
            tenantId,
            issuer,
            subject);
        var workspaceId = DeterministicProvisioningId.PersonalWorkspace(principalId);
        var normalizedEmail = NormalizeVerifiedEmail(profile);
        var now = clock.GetUtcNow();

        var inserted = await sql.ScalarOrDefaultAsync<bool>(
            ProvisioningSql.InsertPrincipal,
            [
                Uuid("principal_id", principalId.Value),
                Uuid("tenant_id", tenantId.Value),
                Text("subject", subject),
                Text("issuer", issuer),
                Text("display_name", displayName),
                NullableText("email", profile.Email),
                NullableText("email_normalized", normalizedEmail),
                Boolean("email_verified", normalizedEmail is not null),
            ],
            cancellationToken).ConfigureAwait(false);

        if (!inserted)
        {
            return await ReadWinnerAsync(tenantId, issuer, subject, cancellationToken).ConfigureAwait(false);
        }

        var actualWorkspaceId = await sql.ScalarOrDefaultAsync<Guid>(
            ProvisioningSql.InsertWorkspace,
            [
                Uuid("workspace_id", workspaceId.Value),
                Uuid("tenant_id", tenantId.Value),
                Text("workspace_name", WorkspaceName(profile.DisplayName)),
                Uuid("principal_id", principalId.Value),
                Timestamp("now", now),
            ],
            cancellationToken).ConfigureAwait(false);
        if (actualWorkspaceId == Guid.Empty)
        {
            throw new PersonalWorkspaceProvisioningInvariantException();
        }

        workspaceId = WorkspaceId.From(actualWorkspaceId);
        await sql.ExecuteAsync(
            ProvisioningSql.SeedWorkspace,
            [
                Uuid("workspace_id", workspaceId.Value),
                Uuid("tenant_id", tenantId.Value),
                Uuid("principal_id", principalId.Value),
                Uuid("daily_root_id", DeterministicProvisioningId.DailyNotesRoot(workspaceId)),
                Timestamp("now", now),
            ],
            cancellationToken).ConfigureAwait(false);

        await SeedPresetsAsync(tenantId, principalId, workspaceId, now, cancellationToken)
            .ConfigureAwait(false);
        await InsertAuditAsync(tenantId, principalId, workspaceId, now, cancellationToken)
            .ConfigureAwait(false);

        if (normalizedEmail is not null)
        {
            await sql.ExecuteAsync(
                ProvisioningSql.RedeemInvitations,
                [
                    Uuid("tenant_id", tenantId.Value),
                    Uuid("principal_id", principalId.Value),
                    Text("email_normalized", normalizedEmail),
                    Timestamp("now", now),
                ],
                cancellationToken).ConfigureAwait(false);
        }

        return new AuthenticatedPrincipal(
            principalId,
            tenantId,
            PrincipalStatus.Active,
            displayName);
    }

    /// <inheritdoc />
    public async ValueTask RefreshEmailAsync(
        TenantId tenantId,
        PrincipalId principalId,
        string issuer,
        string subject,
        UserInfoProfile profile,
        CancellationToken cancellationToken)
    {
        ArgumentNullException.ThrowIfNull(profile);
        var normalizedEmail = NormalizeVerifiedEmail(profile);
        var updated = await sql.ExecuteAsync(
            ProvisioningSql.RefreshEmail,
            [
                Uuid("tenant_id", tenantId.Value),
                Uuid("principal_id", principalId.Value),
                Text("issuer", issuer),
                Text("subject", subject),
                NullableText("email", profile.Email),
                NullableText("email_normalized", normalizedEmail),
                Boolean("email_verified", normalizedEmail is not null),
            ],
            cancellationToken).ConfigureAwait(false);
        if (updated != 1)
        {
            throw new PersonalWorkspaceProvisioningInvariantException();
        }

        if (normalizedEmail is not null)
        {
            await sql.ExecuteAsync(
                ProvisioningSql.RedeemInvitations,
                [
                    Uuid("tenant_id", tenantId.Value),
                    Uuid("principal_id", principalId.Value),
                    Text("email_normalized", normalizedEmail),
                    Timestamp("now", clock.GetUtcNow()),
                ],
                cancellationToken).ConfigureAwait(false);
        }
    }

    private async ValueTask<AuthenticatedPrincipal> ReadWinnerAsync(
        TenantId tenantId,
        string issuer,
        string subject,
        CancellationToken cancellationToken)
    {
        await foreach (var winner in sql.QueryAsync<ProvisionedPrincipal, PrincipalMapper>(
            ProvisioningSql.ReadPrincipal,
            new PrincipalMapper(),
            [
                Uuid("tenant_id", tenantId.Value),
                Text("issuer", issuer),
                Text("subject", subject),
            ],
            cancellationToken).ConfigureAwait(false))
        {
            if (winner.Kind != PrincipalKind.User)
            {
                throw new PersonalWorkspaceProvisioningInvariantException();
            }

            return new AuthenticatedPrincipal(winner.Id, winner.TenantId, winner.Status, winner.DisplayName);
        }

        throw new PersonalWorkspaceProvisioningInvariantException();
    }

    private async ValueTask SeedPresetsAsync(
        TenantId tenantId,
        PrincipalId principalId,
        WorkspaceId workspaceId,
        DateTimeOffset now,
        CancellationToken cancellationToken)
    {
        var parameters = new List<NpgsqlParameter>
        {
            Uuid("tenant_id", tenantId.Value),
            Uuid("principal_id", principalId.Value),
            Uuid("workspace_id", workspaceId.Value),
            Timestamp("now", now),
        };

        foreach (var key in PresetKeys)
        {
            var prefix = key[5..];
            parameters.Add(Uuid($"{prefix}_template_id", DeterministicProvisioningId.PresetObject(workspaceId, key, "template")));
            parameters.Add(Uuid($"{prefix}_root_id", DeterministicProvisioningId.PresetObject(workspaceId, key, "root")));
            parameters.Add(Uuid($"{prefix}_source_id", DeterministicProvisioningId.PresetObject(workspaceId, key, "source-root")));
        }

        await sql.ExecuteAsync(ProvisioningSql.SeedPresets, [.. parameters], cancellationToken)
            .ConfigureAwait(false);
    }

    private async ValueTask InsertAuditAsync(
        TenantId tenantId,
        PrincipalId principalId,
        WorkspaceId workspaceId,
        DateTimeOffset now,
        CancellationToken cancellationToken) =>
        await sql.ExecuteAsync(
            ProvisioningSql.InsertFoundationAudit,
            [
                Uuid("principal_event_id", AuditEventId.Create().Value),
                Uuid("workspace_event_id", AuditEventId.Create().Value),
                Uuid("ownership_event_id", AuditEventId.Create().Value),
                Uuid("tenant_id", tenantId.Value),
                Uuid("principal_id", principalId.Value),
                Uuid("workspace_id", workspaceId.Value),
                Timestamp("now", now),
            ],
            cancellationToken).ConfigureAwait(false);

    [System.Diagnostics.CodeAnalysis.SuppressMessage(
        "Globalization",
        "CA1308:Normalize strings to uppercase",
        Justification = "Email invitation keys have a frozen lowercase canonical representation in ADR-0045.")]
    private static string? NormalizeVerifiedEmail(UserInfoProfile profile)
    {
        if (!profile.EmailVerified || string.IsNullOrWhiteSpace(profile.Email))
        {
            return null;
        }

        if (!EmailAddressNormalizer.TryNormalize(profile.Email, out var normalized))
        {
            throw new PersonalWorkspaceProvisioningInvariantException();
        }

        return normalized;
    }

    private static string WorkspaceName(string? displayName)
    {
        var trimmed = displayName?.Trim();
        if (string.IsNullOrEmpty(trimmed))
        {
            return "Personal workspace";
        }

        const string suffix = "'s workspace";
        return trimmed.Length <= 200 - suffix.Length
            ? trimmed + suffix
            : trimmed[..(200 - suffix.Length)] + suffix;
    }

    private static NpgsqlParameter Uuid(string name, Guid value) =>
        new(name, NpgsqlDbType.Uuid) { Value = value };

    private static NpgsqlParameter Text(string name, string value) =>
        new(name, NpgsqlDbType.Text) { Value = value };

    private static NpgsqlParameter NullableText(string name, string? value) =>
        new(name, NpgsqlDbType.Text) { Value = value is null ? DBNull.Value : value };

    private static NpgsqlParameter Boolean(string name, bool value) =>
        new(name, NpgsqlDbType.Boolean) { Value = value };

    private static NpgsqlParameter Timestamp(string name, DateTimeOffset value) =>
        new(name, NpgsqlDbType.TimestampTz) { Value = value };

    private readonly record struct ProvisionedPrincipal(
        PrincipalId Id,
        TenantId TenantId,
        PrincipalStatus Status,
        PrincipalKind Kind,
        string DisplayName);

    private readonly struct PrincipalMapper : INixRowMapper<ProvisionedPrincipal>
    {
        public ProvisionedPrincipal Map(NpgsqlDataReader reader) => new(
            PrincipalId.From(reader.GetGuid(0)),
            TenantId.From(reader.GetGuid(1)),
            reader.GetString(2) switch
            {
                "active" => PrincipalStatus.Active,
                "suspended" => PrincipalStatus.Suspended,
                _ => PrincipalStatus.Deprovisioned,
            },
            reader.GetString(3) == "user" ? PrincipalKind.User : PrincipalKind.Service,
            reader.GetString(4));
    }
}
