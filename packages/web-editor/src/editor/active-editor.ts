import type { Editor } from '@tiptap/core';
import { useSyncExternalStore } from 'react';

import type { SyncState } from './collab-sync';

/**
 * The note editor currently on screen, so a panel outside the editor (the outline, the status
 * bar) can read its document and sync state. shortcut: one slot, so with two note panes open the
 * most recently mounted wins; upgrade to a per-pane key if these must follow focus.
 */
let active: Editor | null = null;
let sync: SyncState = 'connecting';
const listeners = new Set<() => void>();

function notify(): void {
  listeners.forEach((listener) => {
    listener();
  });
}

/** Registers `editor` and returns the cleanup that clears it, unless another has taken the slot. */
export function registerActiveEditor(editor: Editor): () => void {
  active = editor;
  sync = 'connecting';
  notify();
  return () => {
    if (active !== editor) return;
    active = null;
    notify();
  };
}

/** The sync state of the registered editor's note. */
export function publishActiveSyncState(state: SyncState): void {
  sync = state;
  notify();
}

function subscribe(listener: () => void): () => void {
  listeners.add(listener);
  return () => listeners.delete(listener);
}

export function useActiveEditor(): Editor | null {
  return useSyncExternalStore(
    subscribe,
    () => active,
    () => null,
  );
}

export function useActiveSyncState(): SyncState {
  return useSyncExternalStore(
    subscribe,
    () => sync,
    () => 'connecting',
  );
}
