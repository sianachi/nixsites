using Nix.Domain.Audit;

namespace Nix.Abstractions;

/// <summary>The caller's organisation switches, as stored.</summary>
/// <param name="McpEnabled">Whether remote MCP is allowed.</param>
/// <param name="PublicLinksEnabled">Whether public links are allowed.</param>
public sealed record TenantSettingsRow(bool McpEnabled, bool PublicLinksEnabled);

/// <summary>The organisation's switches for remote MCP and public links, inside the request's tenant transaction.</summary>
public interface ITenantSettingsStore
{
    /// <summary>The caller's tenant switches.</summary>
    public ValueTask<TenantSettingsRow> GetAsync(CancellationToken cancellationToken);

    /// <summary>Applies the given switches (null leaves one unchanged) and returns the result.</summary>
    public ValueTask<TenantSettingsRow> SetAsync(bool? mcpEnabled, bool? publicLinksEnabled, CancellationToken cancellationToken);

    /// <summary>Queues one audit event, saved with <see cref="SaveAsync"/>.</summary>
    public void AddAudit(AuditEvent auditEvent);

    /// <summary>Saves the queued changes.</summary>
    public ValueTask SaveAsync(CancellationToken cancellationToken);
}
