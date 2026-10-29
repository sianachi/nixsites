import { describe, expect, it } from 'vitest';

import {
  FILL_SERIES_SHORTCUT,
  LINK_MENTION_SHORTCUT,
  SHORTCUTS,
} from '../../keyboard/shortcut-registry';
import { formatShortcut } from '../../lib/shortcuts';

describe('the shortcut registry', () => {
  it('lists linking an underlined item name under the editor', () => {
    const entry = SHORTCUTS.find((candidate) => candidate.keys.includes(LINK_MENTION_SHORTCUT));
    expect(entry?.group).toBe('Editor');
  });

  it('lists filling a series down under views', () => {
    const entry = SHORTCUTS.find((candidate) => candidate.keys.includes(FILL_SERIES_SHORTCUT));
    expect(entry?.group).toBe('Views');
    expect(entry?.label).toMatch(/fill/i);
  });

  it('names each chord the way the platform does', () => {
    expect(formatShortcut(FILL_SERIES_SHORTCUT, false)).toBe('Ctrl+Shift+D');
    expect(formatShortcut(FILL_SERIES_SHORTCUT, true)).toBe('⇧⌘D');
    expect(formatShortcut(LINK_MENTION_SHORTCUT, false)).toBe('Alt+Enter');
    expect(formatShortcut(LINK_MENTION_SHORTCUT, true)).toBe('⌥Return');
  });
});
