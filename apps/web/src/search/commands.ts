import {
  CalendarDays,
  FilePlus,
  Keyboard,
  Maximize2,
  NotebookPen,
  PanelLeft,
  Star,
  Zap,
  type LucideIcon,
} from 'lucide-react';

import { formatShortcut } from '@nix/web-foundation/lib/shortcuts';
import { shortcutFor, type ShellShortcutId } from '@nix/web-foundation/keyboard/shortcut-registry';

/**
 * What the palette can do, as opposed to what it can find.
 *
 * **A registry rather than a literal list**, because MVP-2.9's Q3 names "a command in the palette"
 * as one of the closed set of extension points a plugin may use. A plugin contributing a command
 * has to be able to hand over exactly this shape; writing the commands as an array a component
 * closes over would mean discovering that later and rewriting the palette to accept them.
 *
 * `keywords` exist for the same reason the slash menu's do: people type the word they know rather
 * than the word the interface uses. Somebody looking for the sidebar types "hide", "collapse" or
 * "sidebar", and all three have to find it.
 */

export interface PaletteCommand {
  readonly id: string;
  readonly label: string;
  readonly hint?: string;
  /** The keys that do the same thing, written the way this platform writes them. */
  readonly shortcut?: string;
  readonly icon: LucideIcon;
  readonly keywords: readonly string[];
  readonly run: () => void;
}

/**
 * What a command needs from the shell to do its work.
 *
 * Passed in rather than reached for, because the shell is the one holder of each of these. The
 * theme is the reason this matters and is deliberately absent: `useTheme` keeps its choice in
 * component state, so a palette that called it would own a second copy and drift from the profile
 * menu's the moment either was used. Adding the command means giving the preference one owner
 * first, which is a change to the theme and not to the palette.
 */
export interface CommandContext {
  readonly createItem: () => void;
  readonly toggleSidebar: () => void;

  /**
   * Keeps or releases the item that is open, or null when nothing is.
   *
   * Null rather than a no-op function, so the command can be left out of the list entirely rather
   * than offered and then doing nothing - a palette that lists something inert teaches people to
   * distrust it.
   */
  readonly toggleBookmark: (() => void) | null;

  /** Whether the open item is already kept, so the command can say which way it goes. */
  readonly openItemIsKept: boolean;

  /**
   * Opens today's note, or null when daily notes are switched off in this workspace - left out of
   * the list rather than offered and refused, for the reason `toggleBookmark` is.
   */
  readonly openToday: (() => void) | null;

  /**
   * Opens the quick capture into today's note, or null when daily notes cannot be used here - left
   * out of the list rather than offered and refused, for the reason `toggleBookmark` is.
   */
  readonly captureToToday: (() => void) | null;
  readonly openShortcuts: () => void;

  /** Enters or leaves Zen mode for the current page. */
  readonly toggleZen: () => void;

  /** Opens the caller's automations in this workspace. */
  readonly openAutomations: () => void;

  /** Starts a new automation scoped to the open item, or null when nothing is open. */
  readonly automateOpenItem: (() => void) | null;
}

function keysOf(id: ShellShortcutId): string {
  const [first] = shortcutFor(id).keys;
  return first === undefined ? '' : formatShortcut(first);
}

/** The commands this build ships. */
export function builtInCommands(context: CommandContext): readonly PaletteCommand[] {
  return [
    {
      id: 'new-note',
      label: 'New note',
      hint: 'In the current workspace',
      icon: FilePlus,
      shortcut: keysOf('new-note'),
      keywords: ['new', 'note', 'create', 'add', 'document'],
      run: context.createItem,
    },
    ...(context.openToday === null
      ? []
      : [
          {
            id: 'open-today',
            label: 'Open today’s note',
            icon: CalendarDays,
            keywords: ['today', 'daily', 'journal', 'date'],
            run: context.openToday,
          },
        ]),
    ...(context.captureToToday === null
      ? []
      : [
          {
            id: 'capture-to-today',
            label: 'Capture to today’s note',
            hint: 'Add text without leaving what you have open',
            icon: NotebookPen,
            keywords: ['capture', 'quick', 'add', 'append', 'jot', 'today', 'daily', 'journal'],
            run: context.captureToToday,
          },
        ]),
    {
      id: 'toggle-sidebar',
      label: 'Show or hide the sidebar',
      icon: PanelLeft,
      shortcut: keysOf('toggle-sidebar'),
      keywords: ['sidebar', 'tree', 'hide', 'show', 'collapse', 'expand', 'navigation'],
      run: context.toggleSidebar,
    },
    {
      id: 'toggle-zen',
      label: 'Toggle Zen mode',
      hint: 'Current page, with workspace navigation hidden',
      icon: Maximize2,
      shortcut: keysOf('zen'),
      keywords: ['zen', 'focus', 'distraction', 'fullscreen', 'full', 'screen', 'read', 'write'],
      run: context.toggleZen,
    },
    {
      id: 'keyboard-shortcuts',
      label: 'Keyboard shortcuts',
      icon: Keyboard,
      shortcut: keysOf('shortcuts'),
      keywords: ['keyboard', 'shortcuts', 'keys', 'hotkeys', 'help'],
      run: context.openShortcuts,
    },

    {
      id: 'automations',
      label: 'Automations',
      hint: 'Rules that act for you',
      icon: Zap,
      keywords: ['automation', 'automate', 'rule', 'trigger', 'schedule', 'workflow', 'recurring'],
      run: context.openAutomations,
    },

    // Offered only when something is open, for the reason the bookmark command below is.
    ...(context.automateOpenItem === null
      ? []
      : [
          {
            id: 'automate-open-item',
            label: 'Automate this item',
            hint: 'A new automation for what is inside it',
            icon: Zap,
            keywords: ['automate', 'automation', 'rule', 'trigger'],
            run: context.automateOpenItem,
          },
        ]),

    // Offered only when there is something to keep. The label names the direction rather than the
    // control, because somebody reading a list of commands is choosing an outcome.
    ...(context.toggleBookmark === null
      ? []
      : [
          {
            id: 'toggle-bookmark',
            label: context.openItemIsKept ? 'Remove bookmark' : 'Bookmark this note',
            hint: 'The note you have open',
            icon: Star,
            keywords: ['bookmark', 'keep', 'star', 'save', 'favourite', 'favorite', 'shelf'],
            run: context.toggleBookmark,
          },
        ]),
  ];
}

/** Filters commands the way a person typing expects: label first, then the words they might use. */
export function filterCommands(
  commands: readonly PaletteCommand[],
  query: string,
): readonly PaletteCommand[] {
  const needle = query.trim().toLowerCase();
  if (needle.length === 0) {
    return commands;
  }

  return commands.filter(
    (command) =>
      command.label.toLowerCase().includes(needle) ||
      command.keywords.some((keyword) => keyword.includes(needle)),
  );
}
