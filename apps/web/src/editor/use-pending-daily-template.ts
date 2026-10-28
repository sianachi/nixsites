import type { Editor } from '@tiptap/core';
import { useEffect, useSyncExternalStore } from 'react';
import * as Y from 'yjs';

import {
  clearPendingDailyTemplate,
  onPendingDailyTemplateChanged,
  pendingDailyTemplate,
} from '@nix/web-foundation/lib/pending-daily-template';

/**
 * Whether the shared fragment holds nothing a writer would call content: no blocks but empty
 * paragraphs. Asked of the Yjs side rather than the editor's, because that is the document the
 * server's copy lands in first - the editor mirrors it a moment later.
 */
function isBlank(fragment: Y.XmlFragment): boolean {
  return fragment
    .toArray()
    .every(
      (node) => node instanceof Y.XmlElement && node.nodeName === 'paragraph' && node.length === 0,
    );
}

/**
 * Writes a new daily note's template into its body, once.
 *
 * Waits for the document's first sync: inserting before the server's copy has arrived would merge
 * with content the writer has not seen. It then inserts only into a document that is still empty,
 * and clears the pending entry whatever it decided, so the template can never be written twice or
 * into a note somebody has already started. A note that cannot be written to is cleared and left
 * alone.
 */
export function usePendingDailyTemplate({
  itemId,
  editor,
  fragment,
  synced,
  writable,
}: {
  readonly itemId: string;
  readonly editor: Editor;
  readonly fragment: Y.XmlFragment;
  readonly synced: boolean;
  readonly writable: boolean;
}): void {
  const pending = useSyncExternalStore(onPendingDailyTemplateChanged, pendingDailyTemplate);
  const markdown = pending?.itemId === itemId ? pending.markdown : null;

  useEffect(() => {
    if (markdown === null || !synced) return;
    const live = { current: true };

    if (!writable || !editor.isEditable || editor.isDestroyed) {
      clearPendingDailyTemplate();
      return;
    }
    if (!isBlank(fragment)) {
      clearPendingDailyTemplate();
      return;
    }

    void (async () => {
      // The same parser an import uses, loaded when first needed.
      const { markdownToDocument } = await import('@nix/markdown/from-markdown');
      if (!live.current || editor.isDestroyed) return;
      const parsed = markdownToDocument(markdown);
      // Checked again after the load: the document may have been typed into meanwhile.
      if (parsed.ok && isBlank(fragment)) {
        const content = (parsed.doc as { content?: unknown }).content;
        if (Array.isArray(content) && content.length > 0) {
          editor.commands.setContent(content, { emitUpdate: true });
        }
      }
      clearPendingDailyTemplate();
    })();

    return () => {
      live.current = false;
    };
  }, [editor, fragment, markdown, synced, writable]);
}
