import type { ReactNode } from 'react';

import { ExportDialog } from '../../export/export-dialog';
import { ImportDialog } from '@nix/web-workspaces/import/import-dialog';
import { MobileItemMove } from '../../items/mobile-item-move';
import { LockDialog } from '../../locks/lock-dialog';
import type { useItemLock } from '../../locks/use-item-lock';
import type { ShellContext } from '../../shell/shell-context';

export type ItemDialogName = 'move' | 'export' | 'lock' | 'import';

interface ItemDialogsProps {
  readonly open: ItemDialogName | null;
  readonly onClose: () => void;
  readonly tree: ShellContext['tree'];
  readonly itemId: string;
  readonly title: string;
  readonly lockNoun: string;
  readonly lock: ReturnType<typeof useItemLock>;
  readonly getAccessToken: () => Promise<string | null>;
}

/** The item's modal dialogs, mounted only while open so a closed one keeps no half-chosen state. */
export function ItemDialogs({
  open,
  onClose,
  tree,
  itemId,
  title,
  lockNoun,
  lock,
  getAccessToken,
}: ItemDialogsProps): ReactNode {
  return (
    <>
      {open === 'move' ? (
        <MobileItemMove
          itemId={itemId}
          tree={tree}
          onClose={() => {
            onClose();
          }}
        />
      ) : null}
      {open === 'export' ? (
        <ExportDialog
          open
          itemId={itemId}
          // Straight from the tree node, which already carries it - the scope picker is hidden for
          // an item with nothing inside rather than offering a question with one real answer.
          hasChildren={tree.find(itemId)?.hasChildren ?? false}
          onClose={() => {
            onClose();
          }}
        />
      ) : null}

      {open === 'lock' && lock.open ? (
        <LockDialog
          title={title}
          noun={lockNoun}
          locked={lock.selfLocked}
          onClose={() => {
            onClose();
          }}
          onSetLock={lock.setLock}
          onRemoveLock={lock.removeLock}
          onRelock={lock.relock}
        />
      ) : null}

      {open === 'import' ? (
        <ImportDialog
          open
          parentId={itemId}
          getAccessToken={getAccessToken}
          onClose={() => {
            onClose();
          }}
          onImported={(rootItemId) => {
            // Revealed rather than navigated to: the person is mid-import in a dialog that still
            // has the report to show, so the tree opens to the result without yanking the page.
            void tree.reveal(rootItemId);
          }}
        />
      ) : null}
    </>
  );
}
