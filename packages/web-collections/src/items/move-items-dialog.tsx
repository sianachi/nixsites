import { Button, Dialog, Text } from '@nix/ui';
import { useState, type ReactNode } from 'react';

import { isInsideSelection } from './bulk-move';
import { MobileDestinationPicker } from './mobile-destination-picker';
import type { WorkspaceTree } from './use-workspace-tree';

export interface MoveItemsDialogProps {
  readonly ids: readonly string[];
  readonly tree: WorkspaceTree;
  readonly onClose: () => void;
  /** Runs the move and answers with the sentence to show; null closes silently. */
  readonly onMove: (targetParentId: string | null) => Promise<string | null>;
}

/**
 * "Move to…" for one item or many: a destination picker over the whole workspace, excluding the
 * selection and everything under it, and a confirm that names the count.
 */
export function MoveItemsDialog({ ids, tree, onClose, onMove }: MoveItemsDialogProps): ReactNode {
  const first = ids[0] === undefined ? null : tree.find(ids[0]);
  const [parentId, setParentId] = useState<string | null>(first?.parentId ?? null);
  const [saving, setSaving] = useState(false);
  const [report, setReport] = useState<string | null>(null);
  const selected = new Set(ids);
  const invalid = isInsideSelection(parentId, selected, tree.find);
  const count = ids.length;

  return (
    <Dialog
      open
      title={count === 1 ? 'Move item' : `Move ${String(count)} items`}
      onClose={() => {
        if (!saving) onClose();
      }}
      actions={
        <>
          <Button variant="ghost" disabled={saving} onClick={onClose}>
            {report === null ? 'Cancel' : 'Close'}
          </Button>
          <Button
            disabled={saving || invalid || report !== null}
            onClick={() => {
              setSaving(true);
              void onMove(parentId)
                .then((sentence) => {
                  if (sentence === null) onClose();
                  else setReport(sentence);
                })
                .finally(() => {
                  setSaving(false);
                });
            }}
          >
            {saving ? 'Moving…' : 'Move here'}
          </Button>
        </>
      }
    >
      <MobileDestinationPicker
        tree={tree}
        parentId={parentId}
        onChange={setParentId}
        disabled={saving}
        purpose="move"
        excludedIds={selected}
      />
      {invalid ? (
        <Text as="p" variant="note" role="alert">
          An item cannot be moved into itself or into something it contains.
        </Text>
      ) : null}
      {report === null ? null : (
        <Text as="p" variant="note" role="status">
          {report}
        </Text>
      )}
    </Dialog>
  );
}
