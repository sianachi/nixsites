import { isCanceledError, isNixApiError, workspaces as coreWorkspaces } from '@nix/api-client';
import { Checkbox, Text } from '@nix/ui';
import { useState, type ReactElement } from 'react';

import { useApiClient } from '@nix/web-platform/api/api-client-provider';
import { publishNotice } from '@nix/web-foundation/lib/notices';
import { useWorkspace } from '../workspace-context';

/** Who may join this workspace, and whether several people may edit a file at once. Owners only. */
export function SharingSwitches(): ReactElement {
  const client = useApiClient();
  const context = useWorkspace();
  const { workspace } = context;
  const [saving, setSaving] = useState(false);
  // `canRename` is the server's "owner or tenant administrator" flag, as for daily notes.
  const canManage = workspace.canRename;

  async function save(
    input: { membershipLocked?: boolean; collaboration?: boolean },
    done: string,
  ): Promise<void> {
    setSaving(true);
    try {
      const updated = await client.execute(coreWorkspaces.setWorkspaceSharing(workspace.id, input));
      context.workspaceUpdated(updated);
      publishNotice({ key: 'workspace-sharing', message: done });
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
            );
          }}
        />
        <Text variant="note" tone="muted">
          Off means one editor at a time.
        </Text>
      </div>
    </>
  );
}
