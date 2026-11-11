import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { runInNewContext } from 'node:vm';
import { describe, expect, it } from 'vitest';

import {
  MODE_STORAGE_KEY,
  PALETTE_STORAGE_KEY,
  ThemePaletteSchema,
  readStoredMode,
  readStoredPalette,
  storePalette,
} from '@nix/web-foundation/theme/theme-store';

function fakeStorage(initial: Record<string, string> = {}): Storage {
  const values = new Map(Object.entries(initial));

  return {
    getItem: (key) => values.get(key) ?? null,
    setItem: (key, value) => {
      values.set(key, value);
    },
    removeItem: (key) => {
      values.delete(key);
    },
    clear: () => {
      values.clear();
    },
    key: (index) => [...values.keys()][index] ?? null,
    get length() {
      return values.size;
    },
  };
}

describe('saving a palette', () => {
  it('remembers the palette and clears the choice when returning to Nix', () => {
    const storage = fakeStorage();
    storePalette(storage, 'pine');
    expect(readStoredPalette(storage)).toBe('pine');

    storePalette(storage, 'nix');
    expect(storage.getItem(PALETTE_STORAGE_KEY)).toBeNull();
    expect(readStoredPalette(storage)).toBe('nix');
  });
});

describe('the inline palette script in index.html', () => {
  const html = readFileSync(
    join(dirname(fileURLToPath(import.meta.url)), '..', '..', '..', 'index.html'),
    'utf8',
  );

  const script = /<script>\s+(\(function[\s\S]*?)<\/script>/.exec(html)?.[1];

  it.each([
    ['light', 'light'],
    ['dark', 'dark'],
    ['system', null],
    ['unknown', null],
  ])('uses a saved mode of %s before and after startup', (saved, expected) => {
    expect(script).toBeDefined();
    const root = document.createElement('html');
    const localStorage = fakeStorage({ [MODE_STORAGE_KEY]: saved });
    runInNewContext(script ?? '', { localStorage, document: { documentElement: root } });
    expect(root.getAttribute('data-theme')).toBe(expected);
    expect(readStoredMode(localStorage)).toBe(expected);
  });

  it('applies the same palette before React and after startup, including older names', () => {
    expect(script).toBeDefined();

    const cases = [
      ...ThemePaletteSchema.options.map((value) => [value, value] as const),
      ['ocean', 'nix'],
      ['teal', 'pine'],
      ['moss', 'pine'],
      ['copper', 'sand'],
      ['iris', 'plum'],
      ['indigo', 'nix'],
      ['unknown', 'nix'],
      ['constructor', 'nix'],
    ] as const;

    for (const [value, expected] of cases) {
      const root = document.createElement('html');
      const localStorage = fakeStorage({ [PALETTE_STORAGE_KEY]: value });
      runInNewContext(script ?? '', { localStorage, document: { documentElement: root } });
      expect(root).not.toHaveAttribute('data-theme');
      expect(readStoredPalette(localStorage)).toBe(expected);
      expect(root.getAttribute('data-palette')).toBe(expected === 'nix' ? null : expected);
    }
  });
});
