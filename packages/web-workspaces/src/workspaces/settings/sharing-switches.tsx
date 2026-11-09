import { isCanceledError, isNixApiError, workspaces as coreWorkspaces } from '@nix/api-client';
import { Checkbox, Text, useUndo } from '@nix/ui';
import { useState, type ReactElement } from 'react';

import { useApiClient } from '@nix/web-platform/api/api-client-provider';
import { publishNotice } from '@nix/web-foundation/lib/notices';
import { useWorkspace } from '../workspace-context';

/** Who may join this workspace, and whether several people may edit a file at once. Owners only. */
export function SharingSwitches(): ReactElement {
  const client = useApiClient();
  const undo = useUndo();
  const context = useWorkspace();
  const { workspace } = context;
  const [saving, setSaving] = useState(false);
  // `canRename` is the server's "owner or tenant administrator" flag, as for daily notes.
  const canManage = workspace.canRename;

  function save(
    input: { membershipLocked?: boolean; collaboration?: boolean },
    done: string,
    back: { membershipLocked?: boolean; collaboration?: boolean },
  ): Promise<void> {
    return run(coreWorkspaces.setWorkspaceSharing(workspace.id, input), done, () =>
      client.execute(coreWorkspaces.setWorkspaceSharing(workspace.id, back)),
    );
  }

  function saveAgentPolicy(
    input: { agentsMayApprove?: boolean; agentsMayCreatePublicLinks?: boolean },
    done: string,
    back: { agentsMayApprove?: boolean; agentsMayCreatePublicLinks?: boolean },
  ): Promise<void> {
    return run(coreWorkspaces.setWorkspaceAgentPolicy(workspace.id, input), done, () =>
      client.execute(coreWorkspaces.setWorkspaceAgentPolicy(workspace.id, back)),
    );
  }

  async function run(
    command: ReturnType<typeof coreWorkspaces.setWorkspaceSharing>,
    done: string,
    revert: () => Promise<Parameters<typeof context.workspaceUpdated>[0]>,
  ): Promise<void> {
    setSaving(true);
    try {
      const updated = await client.execute(command);
      context.workspaceUpdated(updated);
      publishNotice({ key: 'workspace-sharing', message: done });
      undo.push(done.replace(/\.$/, ''), async () => {
        context.workspaceUpdated(await revert());
      });
    } catch (reason) {
      if (isCanceledError(reason)) return;
      publishNotice({
        key: 'workspace-sharing',
        message: isNixApiError(reason)
          ? (reason.detail ?? 'The setting could not be saved.')
          : 'The setting could not be saved.',
      });
    } finally {
      setSaving(false);
    }
  }

  return (
    <>
      <div className="flex flex-wrap items-center gap-x-3">
        <Checkbox
          label="Allow new members"
          checked={!workspace.membershipLocked}
          disabled={!canManage || saving}
          onChange={(event) => {
            const open = event.currentTarget.checked;
            void save(
              { membershipLocked: !open },
              open
                ? 'New members can be invited again.'
                : 'This workspace is closed to new members. Pending invitations wait until it opens.',
              { membershipLocked: workspace.membershipLocked },
            );
          }}
        />
      </div>
      <div className="flex flex-wrap items-center gap-x-3">
        <Checkbox
          label="Live collaboration"
          checked={workspace.collaboration}
          disabled={!canManage || saving}
          onChange={(event) => {
            const on = event.currentTarget.checked;
            void save(
              { collaboration: on },
              on
                ? 'Several people can edit a file at once.'
                : 'One person edits a file at a time; others can read until they leave.',
              { collaboration: workspace.collaboration },
            );
          }}
        />
        <Text variant="note" tone="muted">
          Off means one editor at a time.
        </Text>
      </div>
      <div className="flex flex-wrap items-center gap-x-3">
        <Checkbox
          label="Agents may approve file versions"
          checked={workspace.agentsMayApprove === true}
          disabled={!canManage || saving}
          onChange={(event) => {
            const on = event.currentTarget.checked;
            void saveAgentPolicy(
              { agentsMayApprove: on },
              on
                ? 'Access tokens can now approve and revoke file versions.'
                : 'Only people can approve and revoke file versions.',
              { agentsMayApprove: workspace.agentsMayApprove === true },
            );
          }}
        />
      </div>
      <div className="flex flex-wrap items-center gap-x-3">
        <Checkbox
          label="Agents may create public links"
          checked={workspace.agentsMayCreatePublicLinks === true}
          disabled={!canManage || saving}
          onChange={(event) => {
            const on = event.currentTarget.checked;
            void saveAgentPolicy(
              { agentsMayCreatePublicLinks: on },
              on
                ? 'Access tokens with admin scope can now make items public.'
                : 'Only people can make items public.',
              { agentsMayCreatePublicLinks: workspace.agentsMayCreatePublicLinks === true },
            );
          }}
        />
        <Text variant="note" tone="muted">
          Agents signed in as you count as you. Run them on access tokens for these to apply.
        </Text>
      </div>
    </>
  );
}
