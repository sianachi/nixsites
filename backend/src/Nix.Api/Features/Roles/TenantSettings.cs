using Nix.Abstractions;
using Nix.Domain.Audit;
using Nix.Domain.Primitives;
using Nix.Features.PublicLinks;
using Nix.Messaging;

namespace Nix.Features.Roles;

/// <summary>
/// The organisation's switches for remote MCP and public links. <c>*Enabled</c> is the stored
/// switch; <c>*Available</c> says the deployment allows the feature at all (the ceiling).
/// </summary>
/// <param name="McpEnabled">The tenant switch for remote MCP.</param>
/// <param name="PublicLinksEnabled">The tenant switch for public links.</param>
/// <param name="McpAvailable">Whether the deployment advertises an MCP URL.</param>
/// <param name="PublicLinksAvailable">Whether the install enables public links.</param>
public sealed record TenantSettingsResponse(bool McpEnabled, bool PublicLinksEnabled, bool McpAvailable, bool PublicLinksAvailable);

/// <summary>The body of a settings change; an omitted field is unchanged.</summary>
/// <param name="McpEnabled">Turn remote MCP on or off.</param>
/// <param name="PublicLinksEnabled">Turn public links on or off.</param>
public sealed record UpdateTenantSettingsRequest(bool? McpEnabled = null, bool? PublicLinksEnabled = null);

/// <summary>Reads the organisation's switches; refused for anyone but a tenant administrator.</summary>
public sealed record GetTenantSettings : IQuery<Result<TenantSettingsResponse>>;

/// <summary>Changes the organisation's switches; refused for anyone but a tenant administrator.</summary>
/// <param name="Request">What to change.</param>
public sealed record UpdateTenantSettings(UpdateTenantSettingsRequest Request) : ICommand<TenantSettingsResponse>;

/// <summary>Handles reading and changing the organisation's switches.</summary>
public sealed class TenantSettingsHandlers(
    ITenantSettingsStore store,
    IPermissionResolver permissions,
    INixSessionContextAccessor session,
    IConfiguration configuration,
    TimeProvider clock) :
    IQueryHandler<GetTenantSettings, Result<TenantSettingsResponse>>,
    ICommandHandler<UpdateTenantSettings, TenantSettingsResponse>
{
    /// <summary>Whether the deployment advertises an MCP URL; the ceiling for the MCP switch.</summary>
    internal static bool McpAvailable(IConfiguration configuration) =>
        Uri.TryCreate(configuration["Nix:Mcp:PublicUrl"], UriKind.Absolute, out _);

    public async ValueTask<Result<TenantSettingsResponse>> HandleAsync(GetTenantSettings query, CancellationToken cancellationToken)
    {
        if (!await permissions.IsTenantAdministratorAsync(cancellationToken).ConfigureAwait(false))
        {
            return Result.Failure<TenantSettingsResponse>(Required());
        }

        return Result.Success(Respond(await store.GetAsync(cancellationToken).ConfigureAwait(false)));
    }

    public async ValueTask<Result<TenantSettingsResponse>> HandleAsync(UpdateTenantSettings command, CancellationToken cancellationToken)
    {
        ArgumentNullException.ThrowIfNull(command);
        if (!await permissions.IsTenantAdministratorAsync(cancellationToken).ConfigureAwait(false))
        {
            return Result.Failure<TenantSettingsResponse>(Required());
        }

        var context = session.Current ?? throw new InvalidOperationException("No session context; the pipeline must establish one.");
        var before = await store.GetAsync(cancellationToken).ConfigureAwait(false);
        var after = await store.SetAsync(command.Request.McpEnabled, command.Request.PublicLinksEnabled, cancellationToken).ConfigureAwait(false);
        if (after != before)
        {
            store.AddAudit(new AuditEvent
            {
                Id = AuditEventId.Create(),
                TenantId = context.TenantId,
                WorkspaceId = null,
                ActorId = context.PrincipalId,
                OnBehalfOf = null,
                Action = "tenant.settings_changed",
                SubjectId = context.TenantId.Value,
                SubjectType = "tenant",
                Before = Describe(before),
                After = Describe(after),
                ActorIp = null,
                OccurredAt = clock.GetUtcNow(),
            });
            await store.SaveAsync(cancellationToken).ConfigureAwait(false);
        }

        return Result.Success(Respond(after));
    }

    private static string Describe(TenantSettingsRow row) =>
        $$"""{"mcpEnabled":{{(row.McpEnabled ? "true" : "false")}},"publicLinksEnabled":{{(row.PublicLinksEnabled ? "true" : "false")}}}""";

    private TenantSettingsResponse Respond(TenantSettingsRow row) =>
        new(row.McpEnabled, row.PublicLinksEnabled, McpAvailable(configuration), PublicLinkSettings.IsEnabled(configuration));

    private static NixError Required() =>
        new(TenantAdminErrors.AdministratorRequiredCode, "Only a tenant administrator can change organization settings.");
}
