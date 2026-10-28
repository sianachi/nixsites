import { useSyncExternalStore } from 'react';

import { browserSessionStorage } from './browser-storage';

/**
 * Zen mode: workspace content fills the window and the application's chrome steps aside.
 *
 * **A leaf store, for the reason `a11y/announcer.ts` is one.** The shell decides whether to draw
 * the rail, the tree and the header; the editor page decides whether to draw the tab strip, the
 * item's action rows and its side panel; the pet launcher decides whether to draw at all. All of
 * them have to read one answer, and the page may not import the shell, so the answer lives where
 * both can reach it. One boolean with no selectors does not need a Zustand slice.
 *
 * **Remembered for the browser tab only.** A reload keeps somebody inside the note they were
 * reading; a new session starts with the application as they would expect to find it.
 *
 * **Two facts, not one.** `zenModeOn` is what the reader asked for and is kept across screens.
 * Whether it *does* anything is `useZenActive`: it needs a workspace surface, claimed by the shell
 * with `claimZenSurface`. Every workspace page supports it; signing out releases the surface.
 */

const STORAGE_KEY = 'nix.zen';

function remembered(): boolean {
  try {
    return browserSessionStorage()?.getItem(STORAGE_KEY) === '1';
  } catch {
    return false;
  }
}

let on = remembered();
let surfaces = 0;
const subscribers = new Set<() => void>();
const changeListeners = new Set<(on: boolean) => void>();

function notify(): void {
  for (const subscriber of subscribers) subscriber();
}

function subscribe(listener: () => void): () => void {
  subscribers.add(listener);
  return () => {
    subscribers.delete(listener);
  };
}

/** Whether the reader has asked for Zen, wherever they are. */
export function zenModeOn(): boolean {
  return on;
}

export function setZenMode(next: boolean): void {
  if (next === on) return;
  on = next;
  try {
    // Absent rather than "0": a tab that never used Zen leaves no trace.
    if (next) browserSessionStorage()?.setItem(STORAGE_KEY, '1');
    else browserSessionStorage()?.removeItem(STORAGE_KEY);
  } catch {
    // Storage that refuses the write costs the reload memory and nothing else.
  }
  for (const listener of changeListeners) listener(next);
  notify();
}

export function toggleZenMode(): void {
  setZenMode(!on);
}

/** Calls `listener` whenever the request changes. Returns the unsubscribe. */
export function onZenModeChanged(listener: (on: boolean) => void): () => void {
  changeListeners.add(listener);
  return () => {
    changeListeners.delete(listener);
  };
}

/**
 * Declares workspace content is on screen, so Zen has something to act on. Returns the release.
 *
 * A count rather than a flag: a page that unmounts as another mounts must not clear the claim the
 * newcomer has just made.
 */
export function claimZenSurface(): () => void {
  surfaces += 1;
  notify();
  let released = false;
  return () => {
    if (released) return;
    released = true;
    surfaces -= 1;
    notify();
  };
}

/** Whether Zen is both requested and applicable: the answer layout decisions read. */
export function useZenActive(): boolean {
  return useSyncExternalStore(
    subscribe,
    () => on && surfaces > 0,
    () => false,
  );
}
