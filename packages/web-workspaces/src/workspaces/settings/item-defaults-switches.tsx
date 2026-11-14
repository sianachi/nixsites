import {
  isCanceledError,
  isNixApiError,
  workspaces as coreWorkspaces,
  type ItemSettings,
} from '@nix/api-client';
import { Checkbox, Text } from '@nix/ui';
import { useEffect, useState, type ReactElement } from 'react';

import { useApiClient } from '@nix/web-platform/api/api-client-provider';
import { publishNotice } from '@nix/web-foundation/lib/notices';
import { useWorkspace } from '../workspace-context';

const SWITCHES: readonly { readonly key: keyof ItemSettings; readonly label: string }[] = [
  { key: 'comments', label: 'Comments' },
  { key: 'suggesting', label: 'Suggesting' },
  { key: 'reviewStates', label: 'File review states' },
  { key: 'fullWidth', label: 'Full width' },
];

/**
 * What new items in this workspace start with. Each item can still change its own settings, and
 * items that already exist keep theirs. Owners only.
 */
export function ItemDefaultsSwitches(): ReactElement {
  const client = useApiClient();
  const { workspace } = useWorkspace();
  const [defaults, setDefaults] = useState<ItemSettings | null>(null);
  const [saving, setSaving] = useState(false);
  const canManage = workspace.canRename;

  useEffect(() => {
    const controller = new AbortController();
    client
      .query(coreWorkspaces.itemDefaults(workspace.id), {
        signal: controller.signal,
        forceRefresh: true,
      })
      .then(setDefaults, (reason: unknown) => {
        if (!isCanceledError(reason)) setDefaults(null);
      });
    return () => {
      controller.abort();
    };
  }, [client, workspace.id]);

  async function change(key: keyof ItemSettings, on: boolean): Promise<void> {
    setSaving(true);
    try {
      setDefaults(
        await client.execute(coreWorkspaces.setItemDefaults(workspace.id, { [key]: on })),
      );
    } catch (reason) {
      if (isCanceledError(reason)) return;
      publishNotice({
        key: 'workspace-item-defaults',
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
      <Text variant="note" tone="muted">
        New items in this workspace start with these. Existing items keep their own settings.
      </Text>
      {SWITCHES.map(({ key, label }) => (
        <div key={key} className="flex flex-wrap items-center gap-x-3">
          <Checkbox
            label={label}
            checked={defaults?.[key] === true}
            disabled={!canManage || saving || defaults === null}
            onChange={(event) => {
              void change(key, event.currentTarget.checked);
            }}
          />
        </div>
      ))}
    </>
  );
}
