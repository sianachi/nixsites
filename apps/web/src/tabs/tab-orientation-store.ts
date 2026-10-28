import type { TabsOrientation } from '@nix/ui';
import { create } from 'zustand';

import { browserStorage } from '@nix/web-foundation/lib/browser-storage';

/**
 * Whether every pane's tab strip is a row above its content or a rail beside it.
 *
 * **One preference for the whole application, not one per pane.** This is a personal reading
 * preference - how the screen looks - rather than a fact about any document or pane, and a
 * three-pane arrangement with each strip drawn a different way would not be flexible so much as
 * inconsistent. The same reasoning `panel-state.ts` gives for the item-settings panel applies here
 * a second time: it describes the screen, so it is remembered the way the screen is, not the way
 * an open document is.
 *
 * **Persisted, unlike the tab lists themselves.** `tab-store.ts` is deliberately session-local -
 * the *documents* open in a pane are a working set, not worth carrying forward - but *how the
 * strip is drawn* is closer to the theme than to that: chosen once and expected to still be true
 * next time, which is exactly what `theme-store.ts`'s own reasoning is for storing a preference
 * rather than a resolved value.
 *
 * A Zustand slice rather than a bare read at each call site, because more than one pane's strip
 * reads this at once and a toggle in one has to repaint every other pane's strip in the same
 * render pass - the same reason `session-store.ts` is a slice and not a module-level variable.
 */

const STORAGE_KEY = 'nix.tab-orientation';

/** Reads the stored preference. Anything unrecognised falls back to the default, horizontal. */
export function readTabOrientation(storage: Storage | undefined): TabsOrientation {
  try {
    return storage?.getItem(STORAGE_KEY) === 'vertical' ? 'vertical' : 'horizontal';
  } catch {
    // Private browsing, or a policy that blocks storage. Horizontal is the default anyway.
    return 'horizontal';
  }
}

/** Writes the preference. Horizontal is the default, so it is the one spelling never stored. */
export function storeTabOrientation(
  storage: Storage | undefined,
  orientation: TabsOrientation,
): void {
  try {
    if (orientation === 'vertical') {
      storage?.setItem(STORAGE_KEY, 'vertical');
      return;
    }

    storage?.removeItem(STORAGE_KEY);
  } catch {
    // Nothing to do and nothing worth failing over.
  }
}

interface TabOrientationState {
  readonly orientation: TabsOrientation;

  /** Switches every pane's strip to the other orientation. */
  readonly orientationToggled: () => void;
}

export const useTabOrientationStore = create<TabOrientationState>((set, get) => ({
  orientation: readTabOrientation(browserStorage()),

  orientationToggled: () => {
    const next: TabsOrientation = get().orientation === 'horizontal' ? 'vertical' : 'horizontal';
    storeTabOrientation(browserStorage(), next);
    set({ orientation: next });
  },
}));
