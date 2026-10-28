import type { Shortcut } from '../lib/shortcuts';

/**
 * Every keyboard shortcut the application offers, in one list the shortcut sheet reads.
 *
 * `handledBy: 'shell'` entries are the ones `useShellShortcuts` listens for itself; the rest are
 * handled where they apply (a tab, a tree row, the pane frame) and are listed here so the sheet is
 * the complete answer to "what can I do from the keyboard?" rather than half of it.
 */
export type ShellShortcutId =
  'search' | 'new-note' | 'toggle-sidebar' | 'zen' | 'back' | 'forward' | 'shortcuts';

type Group = 'General' | 'Editor' | 'Views' | 'Outline' | 'Panes and tabs' | 'Explorer';

/**
 * Links the underlined item name at the caret (`editor/unlinked-mentions.ts`). Exported so the
 * bubble and the settings copy name the chord the handler listens for, the way the platform
 * writes it.
 */
export const LINK_MENTION_SHORTCUT: Shortcut = { key: 'Enter', alt: true };

/**
 * Fills a series down a spreadsheet column, overwriting whatever the target cells hold - the
 * explicit route, where the unprompted offer only appears over empty cells.
 */
export const FILL_SERIES_SHORTCUT: Shortcut = { key: 'd', mod: true, shift: true };

interface Entry {
  readonly label: string;
  readonly group: Group;
  /** One or more chords that do the same thing. */
  readonly keys: readonly Shortcut[];
}

/** A shortcut the shell listens for itself. */
export interface ShellShortcut extends Entry {
  readonly handledBy: 'shell';
  readonly id: ShellShortcutId;
  /**
   * Whether it still fires from a text field or editable content. Chords of the command key do
   * - Search from inside a note is the point of it - but history keys and bare characters are
   * things people type there, so they are left to the typist.
   */
  readonly whileTyping: boolean;
}

/** A shortcut handled where it applies, listed so the sheet is the complete answer. */
export interface LocalShortcut extends Entry {
  readonly handledBy: 'local';
}

export type ShortcutEntry = ShellShortcut | LocalShortcut;

export const SHORTCUTS: readonly ShortcutEntry[] = [
  {
    id: 'search',
    label: 'Search and commands',
    group: 'General',
    keys: [{ key: 'k', code: 'KeyK', mod: true }],
    handledBy: 'shell',
    whileTyping: true,
  },
  {
    id: 'new-note',
    label: 'New note',
    group: 'General',
    // Not Ctrl+N: the browser keeps that chord for a new window and never passes it to a page.
    keys: [{ key: 'n', code: 'KeyN', mod: true, alt: true }],
    handledBy: 'shell',
    whileTyping: true,
  },
  {
    id: 'toggle-sidebar',
    label: 'Show or hide the sidebar',
    group: 'General',
    keys: [{ key: '\\', code: 'Backslash', mod: true }],
    handledBy: 'shell',
    whileTyping: true,
  },
  {
    id: 'zen',
    label: 'Zen mode: current page with workspace navigation hidden',
    group: 'General',
    // Command-Option-Z, like New note, rather than a bare chord: Mod+Shift+Z is redo in the editor
    // and in the sheet, and no editor keymap, Vim or Emacs preset binds Mod+Alt+Z. `code` because
    // Option turns Z into a composed character on a Mac.
    keys: [{ key: 'z', code: 'KeyZ', mod: true, alt: true }],
    handledBy: 'shell',
    whileTyping: true,
  },
  // An installed window has no Back button of its own; these are the platform's history keys.
  {
    id: 'back',
    label: 'Go back',
    group: 'General',
    keys: [{ key: '[', code: 'BracketLeft', mod: true }],
    handledBy: 'shell',
    whileTyping: false,
  },
  {
    id: 'forward',
    label: 'Go forward',
    group: 'General',
    keys: [{ key: ']', code: 'BracketRight', mod: true }],
    handledBy: 'shell',
    whileTyping: false,
  },
  {
    id: 'shortcuts',
    label: 'Keyboard shortcuts',
    group: 'General',
    keys: [{ key: '/', code: 'Slash', mod: true }, { key: '?' }],
    handledBy: 'shell',
    whileTyping: false,
  },
  {
    label: 'Leave Zen mode when focus is not in a text field or a dialog',
    group: 'General',
    keys: [{ key: 'Escape' }],
    handledBy: 'local',
  },
  {
    label: 'Actions for the focused row, tab or card',
    group: 'General',
    keys: [{ key: 'F10', shift: true }, { key: 'ContextMenu' }],
    handledBy: 'local',
  },
  {
    label: 'Link the underlined item name at the caret',
    group: 'Editor',
    keys: [LINK_MENTION_SHORTCUT],
    handledBy: 'local',
  },
  {
    label: 'Fill the selected spreadsheet cells down as a series',
    group: 'Views',
    keys: [FILL_SERIES_SHORTCUT],
    handledBy: 'local',
  },
  // The outline view (plan 3.8). Its Alt chords are the workspace tree's own, on purpose.
  {
    label: 'Add an item below the chosen row',
    group: 'Outline',
    keys: [{ key: 'Enter' }],
    handledBy: 'local',
  },
  {
    label: 'Move inside the row above',
    group: 'Outline',
    keys: [{ key: 'Tab' }, { key: 'ArrowRight', alt: true }],
    handledBy: 'local',
  },
  {
    label: 'Move out of its parent',
    group: 'Outline',
    keys: [
      { key: 'Tab', shift: true },
      { key: 'ArrowLeft', alt: true },
    ],
    handledBy: 'local',
  },
  {
    label: 'Move up among its siblings',
    group: 'Outline',
    keys: [
      { key: 'ArrowUp', mod: true },
      { key: 'ArrowUp', alt: true },
    ],
    handledBy: 'local',
  },
  {
    label: 'Move down among its siblings',
    group: 'Outline',
    keys: [
      { key: 'ArrowDown', mod: true },
      { key: 'ArrowDown', alt: true },
    ],
    handledBy: 'local',
  },
  {
    label: 'Open the chosen item',
    group: 'Outline',
    keys: [
      { key: 'Enter', mod: true },
      { key: 'Enter', alt: true },
    ],
    handledBy: 'local',
  },
  {
    label: 'Let the next Tab leave the outline',
    group: 'Outline',
    keys: [{ key: 'Escape' }],
    handledBy: 'local',
  },
  { label: 'Next pane', group: 'Panes and tabs', keys: [{ key: 'F6' }], handledBy: 'local' },
  {
    label: 'Previous pane',
    group: 'Panes and tabs',
    keys: [{ key: 'F6', shift: true }],
    handledBy: 'local',
  },
  {
    label: 'Close the focused tab',
    group: 'Panes and tabs',
    keys: [{ key: 'Delete' }, { key: 'Backspace' }],
    handledBy: 'local',
  },
  {
    label: 'Open the focused row beside',
    group: 'Explorer',
    keys: [{ key: 'Enter', alt: true }],
    handledBy: 'local',
  },
  {
    label: 'Move up among its siblings',
    group: 'Explorer',
    keys: [{ key: 'ArrowUp', alt: true }],
    handledBy: 'local',
  },
  {
    label: 'Move down among its siblings',
    group: 'Explorer',
    keys: [{ key: 'ArrowDown', alt: true }],
    handledBy: 'local',
  },
  {
    label: 'Move inside the row above',
    group: 'Explorer',
    keys: [{ key: 'ArrowRight', alt: true }],
    handledBy: 'local',
  },
  {
    label: 'Move out of its parent',
    group: 'Explorer',
    keys: [{ key: 'ArrowLeft', alt: true }],
    handledBy: 'local',
  },
];

export function shortcutFor(id: ShellShortcutId): ShellShortcut {
  const entry = SHORTCUTS.find(
    (candidate): candidate is ShellShortcut =>
      candidate.handledBy === 'shell' && candidate.id === id,
  );
  if (entry === undefined) throw new Error(`No shortcut is registered for ${id}.`);
  return entry;
}
