import { z } from 'zod';

const ModeSchema = z.enum(['light', 'dark']);
export type Ground = z.infer<typeof ModeSchema>;
export const MODE_STORAGE_KEY = 'nix.theme';

export function readStoredMode(storage: Storage | undefined): Ground | null {
  try {
    const parsed = ModeSchema.safeParse(storage?.getItem(MODE_STORAGE_KEY));
    return parsed.success ? parsed.data : null;
  } catch {
    return null;
  }
}

export function storeMode(storage: Storage | undefined, mode: Ground | null): void {
  try {
    if (mode === null) storage?.removeItem(MODE_STORAGE_KEY);
    else storage?.setItem(MODE_STORAGE_KEY, mode);
  } catch {
    // Blocked storage must not prevent changing the mode.
  }
}

export const ThemePaletteSchema = z.enum(['nix', 'graphite', 'pine', 'sand', 'rose', 'plum']);
export type ThemePalette = z.infer<typeof ThemePaletteSchema>;
export const PALETTE_STORAGE_KEY = 'nix.palette';

// Keep these aliases in step with the first paint script in index.html.
const LEGACY_PALETTES = new Map<string, ThemePalette>([
  ['ocean', 'nix'],
  ['teal', 'pine'],
  ['moss', 'pine'],
  ['copper', 'sand'],
  ['iris', 'plum'],
  ['indigo', 'nix'],
]);

export function readStoredPalette(storage: Storage | undefined): ThemePalette {
  try {
    const saved = storage?.getItem(PALETTE_STORAGE_KEY) ?? '';
    const parsed = ThemePaletteSchema.safeParse(saved);
    return parsed.success ? parsed.data : (LEGACY_PALETTES.get(saved) ?? 'nix');
  } catch {
    return 'nix';
  }
}

export function storePalette(storage: Storage | undefined, palette: ThemePalette): void {
  try {
    if (palette === 'nix') storage?.removeItem(PALETTE_STORAGE_KEY);
    else storage?.setItem(PALETTE_STORAGE_KEY, palette);
  } catch {
    // Blocked storage must not prevent changing the palette.
  }
}
