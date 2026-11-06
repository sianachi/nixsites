using Nix.Abstractions;
using Nix.Domain.Tenancy;

namespace Nix.Features.Workspaces;

/// <summary>
/// [SEC] The workspace's agent switches, for the HTTP handlers that approve file versions and create
/// public links. A browser session (and a CLI login, which Core cannot tell apart from one) is held
/// to the caller's role instead; anything else needs the switch on and the matching token ceiling.
/// </summary>
/// <remarks>
/// Automations and scheduled work never reach these: their actions cannot name these operations.
/// </remarks>
internal static class AgentPolicyGate
{
    /// <summary>Whether this credential may approve or revoke a file version in the workspace.</summary>
    internal static bool MayChangeVersionState(AccessTokenSessionContext session, Workspace workspace) =>
        session.IsInteractive || (workspace.AgentsMayApprove && session.MayWrite);

    /// <summary>Whether this credential may create a public link in the workspace.</summary>
    internal static bool MayCreatePublicLink(AccessTokenSessionContext session, Workspace workspace) =>
        session.IsInteractive || (workspace.AgentsMayCreatePublicLinks && session.MayAdminister);
}
