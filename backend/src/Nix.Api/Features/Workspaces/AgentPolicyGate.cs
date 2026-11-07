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
public static class AgentPolicyGate
{
    /// <summary>Whether this credential may approve or revoke a file version in the workspace.</summary>
    public static bool MayChangeVersionState(AccessTokenSessionContext session, Workspace workspace)
    {
        ArgumentNullException.ThrowIfNull(session);
        ArgumentNullException.ThrowIfNull(workspace);
        return session.IsInteractive || (IsAgentCredential(session) && workspace.AgentsMayApprove && session.MayWrite);
    }

    /// <summary>Whether this credential may create a public link in the workspace.</summary>
    public static bool MayCreatePublicLink(AccessTokenSessionContext session, Workspace workspace)
    {
        ArgumentNullException.ThrowIfNull(session);
        ArgumentNullException.ThrowIfNull(workspace);
        return session.IsInteractive || (IsAgentCredential(session) && workspace.AgentsMayCreatePublicLinks && session.MayAdminister);
    }

    // Only an access token or an external bearer can be an agent; workers and in-process work are refused.
    private static bool IsAgentCredential(AccessTokenSessionContext session) =>
        session.IsTokenSession || session.IsExternalBearer;
}
