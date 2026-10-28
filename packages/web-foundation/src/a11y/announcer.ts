import { useSyncExternalStore } from 'react';

/**
 * One place to say something to a screen reader that the screen does not already say.
 *
 * **Why a module-level store rather than state.** The things worth announcing here happen in one
 * component and are heard in another: opening a pane is a control in the tree, closing one is a
 * control inside a pane, and the live region that reads them has to be a single element that stays
 * mounted through both. Threading a setter from the shell down through the tree, and back up from
 * a pane, would put a prop on every component in between to carry something none of them uses.
 *
 * **Why not a Zustand slice.** This is one string with no selectors, no derived state and no
 * server data. `useSyncExternalStore` over a module variable is the whole thing, and the store
 * rules exist for state that has shape.
 *
 * Nothing here is a substitute for saying it on screen. A message a sighted reader also needs
 * belongs in the interface; this is for changes that are otherwise invisible - the layout gaining
 * a region, or a control refusing.
 */

export interface Announcement {
  /**
   * What to render inside the live region.
   *
   * **Alternating an inaudible trailing space is deliberate.** A live region is only re-read when
   * its text *changes*, so refusing the same thing twice would be silent the second time - which
   * is exactly when somebody starts wondering whether the control is broken. The obvious remedy,
   * keying the element so it remounts, is the one thing that must not be done: a region has to be
   * in the accessibility tree *before* its contents change, and one inserted together with its
   * text is the canonical reason a live region never speaks at all. So the element stays put and
   * the string differs.
   */
  readonly text: string;
}

const EMPTY: Announcement = { text: '' };

let current: Announcement = EMPTY;
let sequence = 0;
const listeners = new Set<() => void>();

export function announce(message: string): void {
  sequence += 1;
  current = {
    // A no-break space, which reads as nothing and is not collapsed away.
    text: message.length === 0 ? '' : sequence % 2 === 0 ? `${message}\u00a0` : message,
  };

  for (const listener of listeners) {
    listener();
  }
}

function subscribe(listener: () => void): () => void {
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
}

/** What the live region should currently be saying. */
export function useAnnouncement(): Announcement {
  return useSyncExternalStore(
    subscribe,
    () => current,
    () => EMPTY,
  );
}

/** Clears the store between tests, which share a module registry. */
export function resetAnnouncements(): void {
  current = EMPTY;
  sequence = 0;
  listeners.clear();
}
