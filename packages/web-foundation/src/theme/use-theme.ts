import { useCallback, useEffect, useState } from 'react';

import { browserStorage } from '../lib/browser-storage';
import {
  applyGround,
  readStoredPreference,
  resolveGround,
  storePreference,
  type Ground,
  type ThemePreference,
} from './theme-store';

/**
 * The ground the application is drawn on.
 *
 * Reads the stored preference, watches the machine's own setting, and keeps the document's
 * `data-theme` attribute in step with both. Everything visual follows from that one attribute,
 * because the token sheet defines the grounds and every component resolves its colours through
 * the roles - so nothing here touches a colour, and nothing else needs to know a theme exists.
 */

const DARK_QUERY = '(prefers-color-scheme: dark)';

export interface Theme {
  /** What was chosen: follow the machine, or one of the two grounds. */
  readonly preference: ThemePreference;

  /** What that means right now. */
  readonly ground: Ground;

  readonly setPreference: (preference: ThemePreference) => void;
}

/**
 * What the machine says right now.
 *
 * `matchMedia` is typed as always present and is not - it is absent outside a browser. Light is
 * the safer assumption when nothing can be asked: it is the ground the sheet declares by default,
 * so a wrong guess here shows the same thing as no guess at all.
 */
function systemPrefersDark(): boolean {
  const query: unknown = globalThis.matchMedia;

  return typeof query === 'function'
    ? (query.call(globalThis, DARK_QUERY) as MediaQueryList).matches
    : false;
}

export function useTheme(): Theme {
  const [preference, setStored] = useState<ThemePreference>(() =>
    readStoredPreference(browserStorage()),
  );

  // Tracked rather than read during render, because it changes without React: somebody switching
  // their machine to dark at dusk has to move the application with it, and a value read once at
  // mount would leave them looking at the wrong ground until they reloaded.
  const [prefersDark, setPrefersDark] = useState(systemPrefersDark);

  useEffect(() => {
    const query: unknown = globalThis.matchMedia;
    if (typeof query !== 'function') {
      return;
    }

    const media = query.call(globalThis, DARK_QUERY) as MediaQueryList;

    function onChange(event: MediaQueryListEvent): void {
      setPrefersDark(event.matches);
    }

    media.addEventListener('change', onChange);
    return () => {
      media.removeEventListener('change', onChange);
    };
  }, []);

  const ground = resolveGround(preference, prefersDark);

  useEffect(() => {
    applyGround(document.documentElement, preference, ground);
  }, [ground, preference]);

  const setPreference = useCallback((next: ThemePreference): void => {
    setStored(next);
    storePreference(browserStorage(), next);
  }, []);

  return { preference, ground, setPreference };
}
