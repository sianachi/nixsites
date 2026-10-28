import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

import {
  DEFAULT_PREFERENCE,
  STORAGE_KEY,
  applyGround,
  parsePreference,
  readStoredPreference,
  resolveGround,
  storePreference,
} from '@nix/web-foundation/theme/theme-store';

/**
 * Which ground the application is drawn on.
 *
 * The distinction every test here turns on is between the *preference* and the *ground*. Storing
 * the ground rather than the preference is the mistake that looks correct on the day it is made:
 * somebody who asked to follow their machine gets "dark" written down because their machine was
 * dark at the time, and from then on the application no longer follows anything.
 */

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

describe('reading a preference', () => {
  it.each(['system', 'light', 'dark'] as const)('reads %s', (value) => {
    expect(parsePreference(value)).toBe(value);
  });

  it('follows the machine when nothing has been chosen', () => {
    expect(parsePreference(null)).toBe('system');
  });

  it('follows the machine when the stored value makes no sense', () => {
    // A value written by a newer build, or edited by hand. Following the machine is the answer
    // that is never wrong; pinning somebody to a ground nobody chose is.
    expect(parsePreference('sepia')).toBe(DEFAULT_PREFERENCE);
    expect(parsePreference('')).toBe(DEFAULT_PREFERENCE);
  });
});

describe('resolving a preference to a ground', () => {
  it('takes an explicit choice literally, whatever the machine says', () => {
    expect(resolveGround('light', true)).toBe('light');
    expect(resolveGround('dark', false)).toBe('dark');
  });

  it('asks the machine when told to', () => {
    expect(resolveGround('system', true)).toBe('dark');
    expect(resolveGround('system', false)).toBe('light');
  });
});

describe('applying a ground to the document', () => {
  it('names the chosen ground', () => {
    const root = document.createElement('html');

    applyGround(root, 'dark', 'dark');
    expect(root.getAttribute('data-theme')).toBe('dark');

    applyGround(root, 'light', 'light');
    expect(root.getAttribute('data-theme')).toBe('light');
  });

  it('names nothing at all when following the machine', () => {
    const root = document.createElement('html');
    root.setAttribute('data-theme', 'dark');

    applyGround(root, 'system', 'dark');

    // The sheet answers a system preference through a media query and an explicit choice through
    // the attribute, and the attribute wins. Writing "light" for somebody following their machine
    // would pin them to light and stop the media query applying ever again - the control would
    // appear to work once and then go deaf to the machine changing.
    expect(root.hasAttribute('data-theme')).toBe(false);
  });
});

describe('remembering a preference', () => {
  it('stores an explicit choice', () => {
    const storage = fakeStorage();

    storePreference(storage, 'dark');

    expect(storage.getItem(STORAGE_KEY)).toBe('dark');
    expect(readStoredPreference(storage)).toBe('dark');
  });

  it('stores nothing for the default, because absent already means it', () => {
    const storage = fakeStorage({ [STORAGE_KEY]: 'dark' });

    storePreference(storage, 'system');

    // Written down, the default would be indistinguishable from a deliberate choice to any later
    // reader - including a migration that wanted to know whether anybody had ever chosen.
    expect(storage.getItem(STORAGE_KEY)).toBeNull();
    expect(readStoredPreference(storage)).toBe('system');
  });

  it('survives a browser that refuses storage', () => {
    const refusing = {
      getItem: () => {
        throw new Error('denied');
      },
      setItem: () => {
        throw new Error('denied');
      },
      removeItem: () => {
        throw new Error('denied');
      },
    } as unknown as Storage;

    // Private browsing, or an enterprise policy. A theme that cannot be remembered is a small
    // loss; an application that will not start because of it is not.
    expect(() => readStoredPreference(refusing)).not.toThrow();
    expect(readStoredPreference(refusing)).toBe(DEFAULT_PREFERENCE);
    expect(() => {
      storePreference(refusing, 'dark');
    }).not.toThrow();
  });

  it('survives having no storage at all', () => {
    expect(readStoredPreference(undefined)).toBe(DEFAULT_PREFERENCE);
    expect(() => {
      storePreference(undefined, 'dark');
    }).not.toThrow();
  });
});

describe('the inline script in index.html', () => {
  const html = readFileSync(
    join(dirname(fileURLToPath(import.meta.url)), '..', '..', '..', 'index.html'),
    'utf8',
  );

  it('reads the same key and the same values this module writes', () => {
    // It cannot import them: it has to run before any module loads, or the first paint is the
    // wrong ground. This is the test that keeps the duplicate honest.
    expect(html).toContain(STORAGE_KEY);
    expect(html).toContain("'light'");
    expect(html).toContain("'dark'");
    expect(html).toContain('data-theme');
  });

  it('applies the ground before anything is painted', () => {
    // Blocking and inline. Deferred, async or external, it would paint the wrong ground and
    // correct it afterwards - which is the flash it exists to prevent, arriving slightly later.
    expect(html).toMatch(/<script>[\s\S]*?nix\.theme[\s\S]*?<\/script>/);
    expect(html).not.toMatch(/<script\s+(defer|async)[^>]*>[\s\S]*?nix\.theme/);
  });

  it('sets nothing when the machine is being followed', () => {
    // The script writes the attribute only for an explicit light or dark. Writing it for "system"
    // would pin the first paint and defeat the media query it is meant to defer to.
    expect(html).toMatch(/stored === 'light' \|\| stored === 'dark'/);
  });
});
