import { useEffect, useState } from 'react';

import { browserStorage } from '../lib/browser-storage';
import { syncStatusBar } from '../native/native-shell';
import {
  readStoredMode,
  readStoredPalette,
  storeMode,
  storePalette,
  type Ground,
  type ThemePalette,
} from './theme-store';

const DARK_QUERY = '(prefers-color-scheme: dark)';

export interface ThemeSelection {
  readonly mode: Ground | null;
  readonly palette: ThemePalette;
}

export interface Theme extends ThemeSelection {
  readonly ground: Ground;
  readonly setTheme: (mode: Ground | null, palette: ThemePalette) => void;
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

export function useTheme(preview: ThemeSelection | null = null): Theme {
  const [mode, setStoredMode] = useState(() => readStoredMode(browserStorage()));
  const [palette, setStoredPalette] = useState(() => readStoredPalette(browserStorage()));

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

  const shownMode = preview === null ? mode : preview.mode;
  const shownPalette = preview?.palette ?? palette;
  const ground = shownMode ?? (prefersDark ? 'dark' : 'light');
  useEffect(() => {
    const root = document.documentElement;
    if (shownMode === null) root.removeAttribute('data-theme');
    else root.setAttribute('data-theme', shownMode);
    syncStatusBar(ground);
  }, [ground, shownMode]);

  useEffect(() => {
    const root = document.documentElement;
    if (shownPalette === 'nix') root.removeAttribute('data-palette');
    else root.setAttribute('data-palette', shownPalette);
  }, [shownPalette]);

  function setTheme(nextMode: Ground | null, nextPalette: ThemePalette): void {
    const storage = browserStorage();
    setStoredMode(nextMode);
    setStoredPalette(nextPalette);
    storeMode(storage, nextMode);
    storePalette(storage, nextPalette);
  }

  return { palette, ground, mode, setTheme };
}
