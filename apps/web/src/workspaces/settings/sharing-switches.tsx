import { isCanceledError, isNixApiError, workspaces as coreWorkspaces } from '@nix/api-client';
import { Checkbox, Text } from '@nix/ui';
import { useId, useState, type ReactElement } from 'react';

import { useApiClient } from '../../api/api-client-provider';
import { useWorkspace } from '../workspace-context';

/** Who may join this workspace, and whether several people may edit a file at once. Owners only. */
export function SharingSwitches(): ReactElement {
  const client = useApiClient();
  const context = useWorkspace();
  const { workspace } = context;
  const headingId = useId();
  const [saving, setSaving] = useState(false);
  const [message, setMessage] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  // `canRename` is the server's "owner or tenant administrator" flag, as for daily notes.
  const canManage = workspace.canRename;

  async function save(
    input: { membershipLocked?: boolean; collaboration?: boolean },
    done: string,
  ): Promise<void> {
    setSaving(true);
    setMessage(null);
    setError(null);
    try {
      const updated = await client.execute(coreWorkspaces.setWorkspaceSharing(workspace.id, input));
      context.workspaceUpdated(updated);
      setMessage(done);
    } catch (reason) {
      if (isCanceledError(reason)) return;
      setError(
        isNixApiError(reason)
          ? (reason.detail ?? 'The setting could not be saved.')
          : 'The setting could not be saved.',
      );
    } finally {
      setSaving(false);
    }
  }

  return (
    <section aria-labelledby={headingId} className="flex max-w-xl flex-col gap-2">
      <Text id={headingId} variant="h3" as="h3">
        Sharing
      </Text>
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
      {canManage ? null : (
        <Text variant="note">Only a workspace owner or an administrator can change these.</Text>
      )}
      {error === null ? null : (
        <Text role="alert" variant="note">
          {error}
        </Text>
      )}
      {message === null ? null : (
        <Text role="status" variant="note">
          {message}
        </Text>
      )}
    </section>
  );
}
