import { Text } from '@nix/ui';
import { useEffect, useRef, useSyncExternalStore, type ReactNode } from 'react';

import { useActiveEditor, useActiveSyncState } from '@nix/web-editor/editor/active-editor';
import { useNoteStats } from '@nix/web-editor/editor/note-stats';
import type { Editor } from '@tiptap/core';
import { useBacklinks } from '../links/use-backlinks';
import type { ShellContext } from './shell-context';

const SYNC_LABEL = {
  connecting: 'Connecting',
  live: 'Synced',
  pending: 'Saving',
  readonly: 'Read-only',
  degraded: 'Reconnecting',
  offline: 'Offline',
} as const;

function subscribeOnline(listener: () => void): () => void {
  window.addEventListener('online', listener);
  window.addEventListener('offline', listener);
  return () => {
    window.removeEventListener('online', listener);
    window.removeEventListener('offline', listener);
  };
}

function Words({ editor }: { readonly editor: Editor }): ReactNode {
  const { words } = useNoteStats(editor);
  return <span>{`${String(words)} ${words === 1 ? 'word' : 'words'}`}</span>;
}

export interface StatusBarProps {
  readonly tree: ShellContext['tree'];
  readonly itemId: string | null;
}

/**
 * The bottom bar on a wide screen: what points at the open item, how big it is (words for a note,
 * items for a collection) and whether it is saved. Publishes its height as `--status-bar-height`
 * so the pet launcher can sit above it.
 */
export function StatusBar({ tree, itemId }: StatusBarProps): ReactNode {
  const ref = useRef<HTMLDivElement>(null);
  const editor = useActiveEditor();
  const sync = useActiveSyncState();
  const online = useSyncExternalStore(
    subscribeOnline,
    () => navigator.onLine,
    () => true,
  );
  const { backlinks } = useBacklinks(itemId);
  const item = itemId === null ? null : tree.find(itemId);
  const note = editor !== null && item?.type === 'note';
  const children = itemId === null ? 0 : tree.childrenOf(itemId).length;

  useEffect(() => {
    const node = ref.current;
    if (node === null) return;
    document.documentElement.style.setProperty(
      '--status-bar-height',
      `${String(node.getBoundingClientRect().height)}px`,
    );
    return () => {
      document.documentElement.style.removeProperty('--status-bar-height');
    };
  }, []);

  const syncLabel = !online ? 'Offline' : note ? SYNC_LABEL[sync] : 'Online';

  return (
    <div
      ref={ref}
      role="group"
      aria-label="Status bar"
      className="flex shrink-0 items-center justify-end gap-3 bg-surface px-3 py-1 text-muted"
    >
      <Text as="span" variant="caption" tone="muted" className="flex items-center gap-3">
        {itemId === null ? null : (
          <span>{`${String(backlinks.length)} ${backlinks.length === 1 ? 'backlink' : 'backlinks'}`}</span>
        )}
        {note ? (
          <Words editor={editor} />
        ) : item !== null && children > 0 ? (
          <span>{`${String(children)} ${children === 1 ? 'item' : 'items'}`}</span>
        ) : null}
        <span>{syncLabel}</span>
      </Text>
    </div>
  );
}
