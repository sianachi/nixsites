import type { MirrorConflict } from '@nix/sync-core/mirror';
import { Button, Dialog, Text } from '@nix/ui';
import { useCallback, useEffect, useState, type ReactNode } from 'react';

import { getNativeMirror } from './native-mirror';
import { coalesced, useOfflineState } from './offline-state';
import { recoveryText } from './recovery-text';

/**
 * Changes made offline that the server refused or that lost to a newer edit. They are kept in the
 * synced copy until the person has seen them; a refused note edit keeps its text so it can be
 * copied out. Renders nothing outside the iOS shell or when there is nothing to show.
 */

interface Row {
  readonly conflict: MirrorConflict;
  readonly title: string;
}

const WHAT: Record<string, string> = {
  create: 'Create',
  rename: 'Rename',
  move: 'Move',
  archive: 'Move to trash',
  properties: 'Edit properties',
  'daily-note': 'Open daily note',
  request: 'Habit check-in or repeat completion',
};

const REQUEST_WHAT: [string, string][] = [
  ['/protection', 'Change protection'],
  ['/views', 'Change views'],
  ['/schema', 'Change properties'],
];

export const describeConflict = (conflict: MirrorConflict): string => {
  if (conflict.kind === 'body') return 'Note text';
  const operation = conflict.operation;
  if (operation?.kind === 'request')
    return (
      REQUEST_WHAT.find(([suffix]) => operation.payload.path.endsWith(suffix))?.[1] ??
      WHAT.request ??
      'Change'
    );
  return WHAT[operation?.kind ?? ''] ?? 'Change';
};

const WHY: Record<string, string> = {
  'sync.revision_conflict': 'It was changed on the server after you went offline.',
  'items.lifecycle_conflict': 'It was moved to the trash or archived on the server.',
  'items.not_found': 'It no longer exists on the server.',
  'items.parent_not_found': 'The page it belongs under no longer exists on the server.',
  'items.locked': 'It is locked.',
  'items.move_would_create_cycle': 'It cannot be moved inside itself.',
  'items.schema_violation': 'A property value is not allowed here.',
  'properties.invalid': 'A property value is not allowed here.',
  'items.protection_base_changed':
    'Its protection was changed on the server after you went offline.',
  'views.version_conflict': 'Its views were changed on the server after you went offline.',
  'items.schema_base_changed': 'Its properties were changed on the server after you went offline.',
  document_changed: 'The note was replaced on the server. Copy your text to keep it.',
  document_read_only: 'You can no longer edit this note. Copy your text to keep it.',
  invalid_local_update: 'The edit could not be read. Copy your text to keep it.',
  response_too_large: 'The note is too large to sync from this device.',
};

/** Why the change was not applied, in plain words; an unlisted code gets the general reason. */
export const explainConflict = (conflict: MirrorConflict): string =>
  WHY[conflict.code] ?? 'The server did not accept it.';

async function loadRows(): Promise<Row[]> {
  const store = getNativeMirror()?.current();
  if (store === null || store === undefined) return [];
  const rows: Row[] = [];
  for (const workspace of await store.readWorkspaceList()) {
    const conflicts = await store.listConflicts(workspace.id);
    const items = await store.readItems([...new Set(conflicts.map((entry) => entry.itemId))]);
    for (const conflict of conflicts) {
      const known = items.find((item) => item.id === conflict.itemId)?.title;
      const wanted =
        conflict.operation?.kind === 'create' ? conflict.operation.payload.title : undefined;
      rows.push({ conflict, title: known ?? wanted ?? 'An item that is no longer available' });
    }
  }
  return rows;
}

export function OfflineConflicts(): ReactNode {
  const mirror = getNativeMirror();
  const { lastSyncedAt, bootOffline } = useOfflineState();
  const [rows, setRows] = useState<Row[]>([]);
  const [open, setOpen] = useState(false);

  const refresh = useCallback(() => {
    void loadRows().then(setRows, () => undefined);
  }, []);

  useEffect(() => {
    if (mirror === null) return;
    refresh();
    return mirror.current()?.subscribe(coalesced(refresh));
  }, [mirror, refresh, lastSyncedAt, bootOffline]);

  if (rows.length === 0) return null;

  const copy = async (row: Row): Promise<void> => {
    const store = mirror?.current();
    const bytes = await store?.readConflictRecovery(row.conflict.workspaceId, row.conflict.id);
    if (bytes !== null && bytes !== undefined)
      await navigator.clipboard.writeText(recoveryText(bytes));
  };
  const dismiss = async (row: Row): Promise<void> => {
    await mirror?.current()?.dismissConflict(row.conflict.workspaceId, row.conflict.id);
    refresh();
  };

  return (
    <>
      <Button
        variant="secondary"
        onClick={() => {
          setOpen(true);
        }}
      >
        {rows.length === 1
          ? '1 change needs attention'
          : `${String(rows.length)} changes need attention`}
      </Button>
      <Dialog
        open={open}
        title="Changes that were not applied"
        onClose={() => {
          setOpen(false);
        }}
        actions={
          <Button
            onClick={() => {
              setOpen(false);
            }}
          >
            Close
          </Button>
        }
      >
        <Text as="p" tone="muted">
          These were made offline, and the server did not accept them.
        </Text>
        <ul className="mt-3 flex flex-col gap-3">
          {rows.map((row) => (
            <li key={row.conflict.id} className="flex flex-col gap-1">
              <Text as="p">{row.title}</Text>
              <Text as="p" variant="note" tone="muted">
                {describeConflict(row.conflict)}. {explainConflict(row.conflict)}
              </Text>
              <div className="flex gap-2">
                {row.conflict.kind === 'body' ? (
                  <Button variant="secondary" onClick={() => void copy(row)}>
                    Copy text
                  </Button>
                ) : null}
                <Button variant="secondary" onClick={() => void dismiss(row)}>
                  Dismiss
                </Button>
              </div>
            </li>
          ))}
        </ul>
      </Dialog>
    </>
  );
}
