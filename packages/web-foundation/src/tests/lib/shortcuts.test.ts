import { describe, expect, it } from 'vitest';

import { formatShortcut, isTypingTarget, matchesShortcut } from '../../lib/shortcuts';

function press(
  key: string,
  modifiers: Partial<Record<'meta' | 'ctrl' | 'alt' | 'shift', boolean>> = {},
  code = '',
) {
  return {
    key,
    code,
    metaKey: modifiers.meta ?? false,
    ctrlKey: modifiers.ctrl ?? false,
    altKey: modifiers.alt ?? false,
    shiftKey: modifiers.shift ?? false,
  };
}

describe('keyboard shortcuts', () => {
  it('takes Command as the command key on Apple platforms and Control elsewhere', () => {
    const search = { key: 'k', mod: true };
    expect(matchesShortcut(press('k', { meta: true }), search, true)).toBe(true);
    expect(matchesShortcut(press('k', { ctrl: true }), search, true)).toBe(false);
    expect(matchesShortcut(press('K', { ctrl: true }), search, false)).toBe(true);
    expect(matchesShortcut(press('k', { meta: true }), search, false)).toBe(false);
  });

  it('refuses a chord with a modifier it does not name', () => {
    expect(
      matchesShortcut(press('n', { ctrl: true }), { key: 'n', mod: true, alt: true }, false),
    ).toBe(false);
    expect(
      matchesShortcut(press('n', { ctrl: true, alt: true }), { key: 'n', mod: true }, false),
    ).toBe(false);
  });

  it('matches a physical key when Option has turned its letter into something else', () => {
    const newNote = { key: 'n', code: 'KeyN', mod: true, alt: true };
    expect(matchesShortcut(press('Dead', { meta: true, alt: true }, 'KeyN'), newNote, true)).toBe(
      true,
    );
    expect(matchesShortcut(press('n', { meta: true, alt: true }, 'KeyB'), newNote, true)).toBe(
      false,
    );
  });

  it('accepts the shift that a character like ? needs without naming it', () => {
    expect(matchesShortcut(press('?', { shift: true }), { key: '?' }, false)).toBe(true);
  });

  it('writes a chord the way the platform does', () => {
    expect(formatShortcut({ key: 'k', mod: true }, true)).toBe('⌘K');
    expect(formatShortcut({ key: 'k', mod: true }, false)).toBe('Ctrl+K');
    expect(formatShortcut({ key: 'n', mod: true, alt: true }, true)).toBe('⌥⌘N');
    expect(formatShortcut({ key: 'n', mod: true, alt: true }, false)).toBe('Ctrl+Alt+N');
    expect(formatShortcut({ key: 'ArrowUp', alt: true }, false)).toBe('Alt+Up');
    expect(formatShortcut({ key: 'F6', shift: true }, false)).toBe('Shift+F6');
  });

  it('knows where typing happens', () => {
    const field = document.createElement('input');
    const editable = document.createElement('div');
    editable.setAttribute('contenteditable', 'true');
    const inside = document.createElement('span');
    editable.append(inside);
    expect(isTypingTarget(field)).toBe(true);
    expect(isTypingTarget(inside)).toBe(true);
    expect(isTypingTarget(document.createElement('button'))).toBe(false);
  });
});
