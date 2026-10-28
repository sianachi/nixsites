import { items, locks } from '@nix/api-client';
import { useEffect, useState } from 'react';
import { useApiClient } from '@nix/web-platform/api/api-client-provider';

/** The most notes one message carries; the server refuses more. */
export const MAX_CONTEXTS = 5;

export interface SharedContext {
  /** The item the message's context is scoped to - always sent as `itemId`, never as free text
   * the model could be tricked into treating as an instruction. */
  readonly itemId: string;
  /** Explicit selected text (`shareSelection`) - empty for a whole-page share, where the worker
   * already resolves the item's own content from `itemId` (`currentItemId` in its prompt). */
  readonly sharedText: string;
  /** What the removable chip shows, e.g. `"This page: Weekly plan"` or a selection's own text. */
  readonly label: string;
}

/** The notes attached to the conversation (all go with every turn until removed), the open
 * page and its title, and the page selection that "Share selected text" can attach. */
export function useMessageContext({
  currentItem,
  noteScope,
  workspaceAccess,
}: {
  readonly currentItem: string | null;
  readonly noteScope: { readonly rootItemId: string; readonly readOnly: boolean } | undefined;
  readonly workspaceAccess: boolean;
}): {
  readonly contexts: readonly SharedContext[];
  readonly chips: readonly SharedContext[];
  readonly hasSelection: boolean;
  readonly setAutoPageOff: (off: boolean) => void;
  readonly shareSelection: () => void;
  readonly attachPageContext: () => void;
  readonly contextFields: () => object;
  readonly removeContext: (context: SharedContext) => void;
} {
  const client = useApiClient();
  const [contexts, setContexts] = useState<readonly SharedContext[]>([]);
  const [currentItemTitle, setCurrentItemTitle] = useState<string | null>(null);
  // The open note is known to be readable without an unlock. Core refuses a send that names a
  // locked note, so the page is never offered to the model until this is known.
  const [currentItemOpen, setCurrentItemOpen] = useState(false);
  // The owner removed the automatic "This page" context: it stays off for this conversation.
  const [autoPageOff, setAutoPageOff] = useState(false);
  const [hasSelection, setHasSelection] = useState(false);

  // Must-fix 5: resolves the open item's title for the "This page: {title}" chip. The worker
  // resolves its own copy of the title from `itemId` server-side (`currentItemTitle` in its
  // prompt) - this is display-only, never sent as text itself.
  useEffect(() => {
    const controller = new AbortController();
    // Deferred a microtask, the same way `use-bookmarks.ts`'s loader defers its own first read:
    // setting state synchronously in an effect body is the cascading render
    // `react-hooks/set-state-in-effect` exists to stop.
    queueMicrotask(() => {
      if (controller.signal.aborted) return;
      setCurrentItemTitle(null);
      setCurrentItemOpen(false);
    });
    if (!currentItem) return;
    void client
      .query(locks.getItemLock(currentItem), { signal: controller.signal, forceRefresh: true })
      .then((lock) => {
        if (!controller.signal.aborted)
          setCurrentItemOpen(!lock.locked || lock.unlockedUntil !== null);
      })
      .catch(() => {
        /* Unknown is treated as locked: nothing is attached. */
      });
    void client
      .query(items.itemById(currentItem), { signal: controller.signal })
      .then((value) => {
        if (!controller.signal.aborted) setCurrentItemTitle(value.title);
      })
      .catch(() => {
        /* The chip still offers a plain fallback below when the title cannot be resolved. */
      });
    return () => {
      controller.abort();
    };
  }, [client, currentItem]);

  // Must-fix 24: "Share selected text" is only ever meaningfully enabled while there really is a
  // selection on the page.
  useEffect(() => {
    const update = () => {
      setHasSelection(Boolean(window.getSelection()?.toString().trim()));
    };
    update();
    document.addEventListener('selectionchange', update);
    return () => {
      document.removeEventListener('selectionchange', update);
    };
  }, []);

  function shareSelection() {
    const text = window.getSelection()?.toString().trim() ?? '';
    if (!currentItem || !text) return;
    const trimmed = text.slice(0, 16000);
    addContext({ itemId: currentItem, sharedText: trimmed, label: trimmed.slice(0, 120) });
  }

  /** Adds `entry` to the attached notes; the same note or selection twice stays one entry, and
   * a full list takes no more (the buttons are disabled then). */
  function addContext(entry: SharedContext) {
    setContexts((list) =>
      list.length >= MAX_CONTEXTS
        ? list
        : [
            ...list.filter((c) => c.itemId !== entry.itemId || c.sharedText !== entry.sharedText),
            entry,
          ],
    );
  }

  /** The open note as a removable chip, sent as `itemId` with no text, when nothing else is chosen
   * and the note is known to be readable. Not in a note conversation, which has its own scope. */
  const autoPage: SharedContext | null =
    currentItem &&
    !noteScope &&
    workspaceAccess &&
    currentItemOpen &&
    !autoPageOff &&
    contexts.length === 0
      ? {
          itemId: currentItem,
          sharedText: '',
          label: `This page: ${currentItemTitle ?? 'Untitled'}`,
        }
      : null;

  /** Must-fix 5: "Summarize this page" attaches the open item as a removable chip, sent as
   * `itemId` with no `sharedText` - the worker already resolves the item's own content from
   * `currentItemId` in its prompt, so nothing here re-sends the page's text itself. */
  function attachPageContext() {
    if (!currentItem) return;
    addContext({
      itemId: currentItem,
      sharedText: '',
      label: `This page: ${currentItemTitle ?? 'Untitled'}`,
    });
  }

  /** What a turn sends as its context: the attached notes, with the text selected in any of
   * them joined into one `sharedText` (the request has a single field for it). */
  function contextFields() {
    if (noteScope) return { itemId: noteScope.rootItemId, readOnly: noteScope.readOnly };
    // With nothing chosen, the open note goes along as its id alone. The model decides whether to
    // read it; nothing of its text is sent from here.
    if (autoPage) return { itemId: autoPage.itemId };
    if (contexts.length === 0) return {};
    return {
      itemIds: [...new Set(contexts.map((context) => context.itemId))],
      sharedText: contexts
        .map((context) => context.sharedText)
        .filter(Boolean)
        .join('\n\n')
        .slice(0, 16000),
    };
  }

  function removeContext(context: SharedContext) {
    if (context === autoPage) setAutoPageOff(true);
    else setContexts((list) => list.filter((c) => c !== context));
  }

  return {
    contexts,
    chips: autoPage ? [autoPage] : contexts,
    hasSelection,
    setAutoPageOff,
    shareSelection,
    attachPageContext,
    contextFields,
    removeContext,
  };
}
