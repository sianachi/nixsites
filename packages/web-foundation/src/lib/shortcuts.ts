import { isEditableTarget } from '@nix/ui';

/**
 * Keyboard shortcuts as data: one description of a chord that both answers "was this pressed?"
 * and writes itself down the way the platform does, so the key a label shows is the key the
 * handler listens for.
 *
 * `mod` is the platform's command key - Command on Apple devices, Control elsewhere - the same
 * convention every desktop application and ProseMirror's own keymaps use.
 */
export interface Shortcut {
  /** `KeyboardEvent.key`, compared case-insensitively for letters; also what the label shows. */
  readonly key: string;
  /**
   * The physical key, `KeyboardEvent.code`, matched instead of `key` when given. Needed for a
   * letter or punctuation chord that holds Option on a Mac - Option turns N into a dead key and
   * `key` into whatever it composes - and for punctuation that other layouts type with AltGr.
   */
  readonly code?: string;
  readonly mod?: boolean;
  readonly alt?: boolean;
  readonly shift?: boolean;
}

/**
 * Whether this is an Apple platform, from the user agent's own platform hint where there is one.
 * Deliberately not `navigator.platform`, which is deprecated and frozen on several browsers.
 */
export function isApplePlatform(): boolean {
  if (typeof navigator === 'undefined') return false;
  const hint =
    (navigator as { userAgentData?: { platform?: string } }).userAgentData?.platform ??
    navigator.userAgent;
  return /mac|iphone|ipad|ipod/iu.test(hint);
}

export function matchesShortcut(
  event: Pick<KeyboardEvent, 'key' | 'code' | 'metaKey' | 'ctrlKey' | 'altKey' | 'shiftKey'>,
  shortcut: Shortcut,
  apple = isApplePlatform(),
): boolean {
  const mod = apple ? event.metaKey : event.ctrlKey;
  // The other of the two is never part of a chord here, so a stray one means a different chord.
  const other = apple ? event.ctrlKey : event.metaKey;
  const sameKey =
    shortcut.code === undefined
      ? event.key.toLowerCase() === shortcut.key.toLowerCase()
      : event.code === shortcut.code;
  return (
    sameKey &&
    mod === (shortcut.mod ?? false) &&
    !other &&
    event.altKey === (shortcut.alt ?? false) &&
    // Shift is part of what makes some keys ('?') at all, so it is only required, never refused,
    // for a chord that does not name it.
    (shortcut.shift === undefined || event.shiftKey === shortcut.shift)
  );
}

const KEY_NAMES: Readonly<Record<string, string>> = {
  arrowup: 'Up',
  arrowdown: 'Down',
  arrowleft: 'Left',
  arrowright: 'Right',
  escape: 'Esc',
  delete: 'Delete',
  backspace: 'Backspace',
  enter: 'Enter',
  ' ': 'Space',
};

const APPLE_KEY_NAMES: Readonly<Record<string, string>> = {
  // The keys as a Mac keyboard labels them: its Backspace is marked "delete".
  backspace: '⌫',
  delete: '⌦',
  // A Mac keyboard labels it "return"; "Enter" there is the keypad key.
  enter: 'Return',
  arrowup: '↑',
  arrowdown: '↓',
  arrowleft: '←',
  arrowright: '→',
};

/** The chord as the platform writes it: "⌘K" on a Mac, "Ctrl+K" elsewhere. */
export function formatShortcut(shortcut: Shortcut, apple = isApplePlatform()): string {
  const lower = shortcut.key.toLowerCase();
  const key =
    (apple ? APPLE_KEY_NAMES[lower] : undefined) ??
    KEY_NAMES[lower] ??
    (shortcut.key.length === 1 ? shortcut.key.toUpperCase() : shortcut.key);
  if (apple) {
    return `${shortcut.alt === true ? '⌥' : ''}${shortcut.shift === true ? '⇧' : ''}${
      shortcut.mod === true ? '⌘' : ''
    }${key}`;
  }
  return [
    shortcut.mod === true ? 'Ctrl' : null,
    shortcut.alt === true ? 'Alt' : null,
    shortcut.shift === true ? 'Shift' : null,
    key,
  ]
    .filter((part): part is string => part !== null)
    .join('+');
}

/**
 * Whether a key press landed where typing happens, where single-key shortcuts must not fire: a
 * field or editable content (`isEditableTarget`, shared with the context menu), or the canvas,
 * which takes bare keys as its own tools and help.
 */
export function isTypingTarget(target: EventTarget | null): boolean {
  return (
    isEditableTarget(target) ||
    (target instanceof Element && target.closest('.excalidraw') !== null)
  );
}
