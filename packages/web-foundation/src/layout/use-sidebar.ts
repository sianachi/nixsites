import { useCallback, useState } from 'react';

import { browserStorage } from '../lib/browser-storage';
import { SIDEBAR_DEFAULT_WIDTH, SIDEBAR_MAXIMUM_WIDTH, SIDEBAR_MINIMUM_WIDTH } from './regions';

/**
 * Whether the workspace tree is on screen.
 *
 * **Remembered, not held for the session - on a wide screen.** Somebody who collapses the fixed
 * panel has decided they want the width back, and reopening the application to find it open again
 * would make the control feel like it did not work. It is stored the same way the theme is, and
 * for the same reason.
 *
 * **Not in the URL**, unlike the selected item or the active view. Those describe *what* is being
 * looked at and belong in a link somebody can share; this describes how one person's window is
 * arranged, and sending it to a colleague would collapse their sidebar for them.
 *
 * **Transient, and narrow-scoped, on a phone.** Below the breakpoint the tree is an off-canvas
 * drawer rather than the fixed panel (`app-shell.tsx`, `sidebar-drawer.tsx`), and dismissing a
 * drawer is not the same choice as collapsing a panel - it is "I'm done looking at this, for now",
 * not "give the width back to the document". Persisting it the same way the wide preference is
 * would mean closing the drawer on a phone silently left a later, wider visit to the same
 * application collapsed, which is a different screen's decision leaking into this one's storage.
 * So the narrow arrangement gets its own piece of state that never touches `localStorage`, and it
 * starts closed on every fresh render regardless of what the wide preference says - a shared link
 * opened on a phone must show the document it named, not a drawer covering it.
 */

export const STORAGE_KEY = 'nix.sidebar';

const COLLAPSED = 'collapsed';

export const WIDTH_STORAGE_KEY = 'nix.sidebar.width';

/** Whole pixels within the bounds - the one shape a width is allowed to have anywhere. */
export function clampWidth(width: number): number {
  return Math.min(SIDEBAR_MAXIMUM_WIDTH, Math.max(SIDEBAR_MINIMUM_WIDTH, Math.round(width)));
}

/** Reads the stored state, defaulting to open. */
export function readCollapsed(storage: Storage | undefined): boolean {
  try {
    return storage?.getItem(STORAGE_KEY) === COLLAPSED;
  } catch {
    // Private browsing, or a policy that blocks storage. A sidebar that forgets is a small loss.
    return false;
  }
}

/** Stores the state, tolerating a browser that refuses storage. */
export function storeCollapsed(storage: Storage | undefined, collapsed: boolean): void {
  try {
    if (collapsed) {
      storage?.setItem(STORAGE_KEY, COLLAPSED);
      return;
    }

    // Open is the default, and absent already means it. Writing a second spelling of the same
    // state would leave a later reader unable to tell "never chosen" from "chose the default".
    storage?.removeItem(STORAGE_KEY);
  } catch {
    // Nothing to do and nothing worth failing over.
  }
}

/** Reads the stored width, defaulting - and clamping, since storage is writable by anything. */
export function readWidth(storage: Storage | undefined): number {
  try {
    const raw = storage?.getItem(WIDTH_STORAGE_KEY);
    const parsed = raw === null || raw === undefined ? Number.NaN : Number(raw);
    return Number.isFinite(parsed) ? clampWidth(parsed) : SIDEBAR_DEFAULT_WIDTH;
  } catch {
    return SIDEBAR_DEFAULT_WIDTH;
  }
}

/** Stores a width, tolerating a browser that refuses storage. */
export function storeWidth(storage: Storage | undefined, width: number): void {
  try {
    if (width === SIDEBAR_DEFAULT_WIDTH) {
      // The default is spelled as absence, for the same reason `collapsed` is: writing it out
      // would leave a later reader unable to tell "never chosen" from "chose the default".
      storage?.removeItem(WIDTH_STORAGE_KEY);
      return;
    }

    storage?.setItem(WIDTH_STORAGE_KEY, String(width));
  } catch {
    // Nothing to do and nothing worth failing over.
  }
}

export interface Sidebar {
  /** Whether the tree is on screen right now - the persisted collapse flag on a wide screen,
   * transient open/closed state on a narrow one. See the module comment for why the two differ. */
  readonly visible: boolean;
  readonly toggle: () => void;

  /** The tree's width in pixels, already clamped to the bounds above. */
  readonly width: number;
  readonly resize: (width: number) => void;
}

/**
 * @param narrow Whether the tree is currently a drawer rather than a fixed panel
 * (`useNarrowViewport`). Which piece of state `visible` and `toggle` read and write forks on it,
 * so it is taken as a parameter rather than read again in here - `app-shell.tsx` already has it,
 * and a second read could answer differently within the same render if the two ever raced.
 */
export function useSidebar(narrow: boolean): Sidebar {
  const [collapsed, setCollapsed] = useState(() => readCollapsed(browserStorage()));
  // Always false to start, on both branches - see the module comment on why a phone never
  // inherits the wide preference. Never read or written to storage.
  const [drawerOpen, setDrawerOpen] = useState(false);
  const [width, setWidth] = useState(() => readWidth(browserStorage()));

  const toggle = useCallback((): void => {
    if (narrow) {
      setDrawerOpen((current) => !current);
      return;
    }

    setCollapsed((current) => {
      const next = !current;
      storeCollapsed(browserStorage(), next);
      return next;
    });
  }, [narrow]);

  const resize = useCallback((next: number): void => {
    const clamped = clampWidth(next);
    setWidth(clamped);
    storeWidth(browserStorage(), clamped);
  }, []);

  return { visible: narrow ? drawerOpen : !collapsed, toggle, width, resize };
}
