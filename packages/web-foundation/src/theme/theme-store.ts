import { z } from 'zod';

/**
 * Which ground the application is drawn on, and who decided.
 *
 * **Three choices, not two.** "System" is a real answer rather than the absence of one: somebody
 * whose machine switches at dusk wants the application to switch with it, and a two-state toggle
 * cannot express that - it can only record whichever ground they happened to be on when they last
 * touched it, and then stop following.
 *
 * The stored value is the *preference*, never the resolved ground. Storing "dark" because the
 * system was dark at the time would silently convert "follow my machine" into "always dark", which
 * is precisely the setting the person did not choose.
 */

export const ThemePreferenceSchema = z.enum(['system', 'light', 'dark']);

export type ThemePreference = z.infer<typeof ThemePreferenceSchema>;

/** The two grounds the sheet actually draws. A preference resolves to one of these. */
export type Ground = 'light' | 'dark';

/**
 * Where the preference is kept.
 *
 * **Also spelled out in `index.html`**, in the inline script that applies the ground before the
 * first paint. That duplication is deliberate and cannot be removed: the script has to run before
 * any module loads, so it cannot import this. Changing this key means changing that script.
 */
export const STORAGE_KEY = 'nix.theme';

export const DEFAULT_PREFERENCE: ThemePreference = 'system';

/**
 * Reads a stored preference.
 *
 * Anything unrecognised falls back to following the system, because that is the answer that is
 * never wrong: a value written by a newer build, or corrupted by hand, should leave the
 * application tracking the machine rather than pinned to a ground nobody chose.
 */
export function parsePreference(raw: string | null): ThemePreference {
  if (raw === null) {
    return DEFAULT_PREFERENCE;
  }

  const parsed = ThemePreferenceSchema.safeParse(raw);
  return parsed.success ? parsed.data : DEFAULT_PREFERENCE;
}

/** What a preference means right now, given what the machine says. */
export function resolveGround(preference: ThemePreference, systemPrefersDark: boolean): Ground {
  if (preference === 'system') {
    return systemPrefersDark ? 'dark' : 'light';
  }

  return preference;
}

/**
 * Puts the chosen ground on the document, or takes the attribute off entirely.
 *
 * **Absent rather than set, when following the system.** The sheet answers a system preference
 * through a media query and an explicit choice through `[data-theme]`, and the attribute wins.
 * Writing `data-theme="light"` for somebody who asked to follow their machine would pin them to
 * light and stop the media query ever applying again - the toggle would appear to work once and
 * then never respond to the machine changing.
 */
export function applyGround(root: HTMLElement, preference: ThemePreference, ground: Ground): void {
  if (preference === 'system') {
    root.removeAttribute('data-theme');
    return;
  }

  root.setAttribute('data-theme', ground);
}

/** Reads the stored preference, tolerating a browser that refuses storage entirely. */
export function readStoredPreference(storage: Storage | undefined): ThemePreference {
  try {
    return parsePreference(storage?.getItem(STORAGE_KEY) ?? null);
  } catch {
    // Private browsing, or a policy that blocks storage. A theme that cannot be remembered is a
    // small loss; an application that will not start because of it is not.
    return DEFAULT_PREFERENCE;
  }
}

/** Stores a preference, tolerating the same. */
export function storePreference(storage: Storage | undefined, preference: ThemePreference): void {
  try {
    if (preference === DEFAULT_PREFERENCE) {
      // Nothing stored means "follow the machine", which is also what an absent key means. Writing
      // the default would be indistinguishable from a deliberate choice to a later reader.
      storage?.removeItem(STORAGE_KEY);
      return;
    }

    storage?.setItem(STORAGE_KEY, preference);
  } catch {
    // Nothing to do and nothing worth failing over.
  }
}
