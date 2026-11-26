import { Dialog } from '@nix/ui';
import type { ReactNode } from 'react';

import { MessageComposer } from './message-composer';

/** Starts a message thread under an item. Sending closes it; the thread appears among the item's children. */
export function MessageDialog({
  workspaceId,
  itemId,
  title,
  onClose,
}: {
  readonly workspaceId: string;
  readonly itemId: string;
  readonly title: string;
  readonly onClose: () => void;
}): ReactNode {
  return (
    <Dialog open title={`Message about ${title.length > 0 ? title : 'Untitled'}`} onClose={onClose}>
      <MessageComposer
        workspaceId={workspaceId}
        parentId={itemId}
        focusOnMount
        onPosted={onClose}
      />
    </Dialog>
  );
}
