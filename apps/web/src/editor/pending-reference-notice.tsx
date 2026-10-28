import { Button, Text } from '@nix/ui';
import type { Editor } from '@tiptap/core';
import { useSyncExternalStore, type ReactNode } from 'react';

import {
  clearPendingReference,
  onPendingReferenceChanged,
  pendingReference,
} from '@nix/web-foundation/lib/pending-reference';

/**
 * A reference asked for elsewhere, waiting to be placed in this note.
 *
 * Shown only in the note the reference is for. The reader puts the cursor where it belongs and
 * inserts it; nothing is written until they do, and dismissing it writes nothing at all. A note
 * that cannot be edited - locked, or read-only for this person - says so rather than offering a
 * button that would do nothing.
 */
export function PendingReferenceNotice({
  itemId,
  editor,
}: {
  readonly itemId: string;
  readonly editor: Editor;
}): ReactNode {
  const pending = useSyncExternalStore(onPendingReferenceChanged, pendingReference);
  if (pending?.sourceId !== itemId) {
    return null;
  }

  const editable = editor.isEditable && !editor.isDestroyed;

  return (
    <div
      role="status"
      className="flex shrink-0 flex-wrap items-center gap-3 bg-background px-8 py-1.5"
    >
      <Text variant="caption" as="p" tone="accent">
        {editable
          ? `A reference to "${pending.label}" is ready. Put the cursor where it should go, then insert it.`
          : `A reference to "${pending.label}" cannot be placed because this note cannot be edited.`}
      </Text>
      {editable && (
        <Button
          variant="secondary"
          onClick={() => {
            const inserted = editor
              .chain()
              .focus()
              .insertContent({
                type: 'reference',
                attrs: { kind: 'item', targetId: pending.targetId, label: pending.label },
              })
              .run();
            // Kept on a refusal, so the reader can move the cursor somewhere it is allowed and
            // try again rather than having to go back and ask for the reference a second time.
            if (inserted) {
              clearPendingReference();
            }
          }}
        >
          Insert reference
        </Button>
      )}
      <Button variant="ghost" onClick={clearPendingReference}>
        Dismiss
      </Button>
    </div>
  );
}
