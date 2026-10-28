import type { ItemInsertKind } from './item-insert-dialog';
import { TOGGLE_LEVELS, type ToggleLevel } from '@nix/editor-schema';
import { Listbox, placeFloatingMenu, readViewportBounds, useListbox } from '@nix/ui';
import type { ReactNode } from 'react';
import type { Editor } from '@tiptap/react';
import {
  ChevronRight,
  Code,
  Columns2,
  Heading1,
  Heading2,
  Heading3,
  Image as ImageIcon,
  Link,
  List,
  ListCollapse,
  ListOrdered,
  ListTodo,
  Minus,
  Quote,
  StickyNote,
  Table as TableIcon,
  Type,
  type LucideIcon,
} from 'lucide-react';

import { frecencyScores, recordPick } from '@nix/web-foundation/lib/frecency';
import { useChoiceOrderPreference } from '@nix/web-foundation/lib/suggestion-preferences';
import { INLINE_AI_COMMANDS, INLINE_AI_GROUP } from './inline-ai/inline-ai-commands';
import type { InlineKind } from './inline-ai/inline-ai-stream';
import {
  MAX_QUERY as REFERENCE_MAX_QUERY,
  findTrigger as findReferenceTrigger,
} from './reference-menu';
import { useEditorListbox, useEditorTrigger } from './trigger-menu';

/**
 * The frecency namespace for slash commands. One for every workspace: a command is not workspace
 * data, and somebody who reaches for tables in one workspace reaches for them everywhere.
 */
export const SLASH_FRECENCY_NAMESPACE = 'slash';

const NO_SCORES: ReadonlyMap<string, number> = new Map();

/**
 * Everything `/` can insert.
 *
 * A flat list rather than a nested one on purpose: a menu you filter by typing is faster than a
 * menu you navigate, and grouping only helps when you are browsing. The keywords exist so that
 * "bullet", "ul" and "list" all find the same thing - people reach for the word they know, not
 * the word the schema uses.
 */

export interface SlashCommand {
  readonly id: string;
  readonly label: string;
  readonly hint: string;
  readonly icon: LucideIcon;
  readonly keywords: readonly string[];
  /** A heading the command is listed under; set only on the writing assistance, which is optional. */
  readonly group?: string;
  readonly run: (editor: Editor, actions: SlashCommandActions) => void;
}

/** Actions whose UI is owned outside the caret menu. */
export interface SlashCommandActions {
  readonly insertImage: () => void;
  readonly insertItem?: ((kind: ItemInsertKind) => void) | undefined;
  readonly pageBreak?: (() => void) | undefined;
  readonly inlineAi?: ((kind: InlineKind) => void) | undefined;
}

/**
 * The writing assistance, as slash commands. Kept out of `SLASH_COMMANDS` because they exist only
 * when the person has switched inline writing on: the menu appends them, so an unavailable
 * assistant leaves no dead entries behind.
 */
const AI_SLASH_COMMANDS: readonly SlashCommand[] = INLINE_AI_COMMANDS.map(
  (command): SlashCommand => ({
    id: command.id,
    label: command.label,
    hint: command.hint,
    icon: command.icon,
    keywords: command.keywords,
    group: INLINE_AI_GROUP,
    run: (_editor, actions) => actions.inlineAi?.(command.kind),
  }),
);

/**
 * The words people reach for when they want a collapsible section, shared by the whole toggle
 * family so "collapse" finds the headed ones too. "details" is the word the schema uses, kept
 * findable for whoever greps the storage format.
 */
const TOGGLE_KEYWORDS = [
  'section',
  'toggle',
  'details',
  'collapse',
  'collapsible',
  'expand',
  'fold',
  'disclosure',
] as const;

/** One hint per toggle-heading level, mirroring the plain headings' own hints. */
const TOGGLE_HEADING_HINTS: Readonly<Record<ToggleLevel, string>> = {
  1: 'A folding section title',
  2: 'A folding subsection title',
  3: 'A folding minor heading',
};

export const SLASH_COMMANDS: readonly SlashCommand[] = [
  {
    id: 'paragraph',
    label: 'Text',
    hint: 'Plain paragraph',
    icon: Type,
    keywords: ['text', 'paragraph', 'body', 'p'],
    run: (editor) => editor.chain().focus().setParagraph().run(),
  },
  {
    id: 'heading-1',
    label: 'Heading 1',
    hint: 'Section title',
    icon: Heading1,
    keywords: ['heading', 'title', 'h1'],
    run: (editor) => editor.chain().focus().toggleHeading({ level: 1 }).run(),
  },
  {
    id: 'heading-2',
    label: 'Heading 2',
    hint: 'Subsection title',
    icon: Heading2,
    keywords: ['heading', 'subtitle', 'h2'],
    run: (editor) => editor.chain().focus().toggleHeading({ level: 2 }).run(),
  },
  {
    id: 'heading-3',
    label: 'Heading 3',
    hint: 'Minor heading',
    icon: Heading3,
    keywords: ['heading', 'h3'],
    run: (editor) => editor.chain().focus().toggleHeading({ level: 3 }).run(),
  },
  {
    id: 'bullet-list',
    label: 'Bulleted list',
    hint: 'An unordered list',
    icon: List,
    keywords: ['list', 'bullet', 'ul', 'unordered'],
    run: (editor) => editor.chain().focus().toggleBulletList().run(),
  },
  {
    id: 'ordered-list',
    label: 'Numbered list',
    hint: 'An ordered list',
    icon: ListOrdered,
    keywords: ['list', 'number', 'ol', 'ordered'],
    run: (editor) => editor.chain().focus().toggleOrderedList().run(),
  },
  {
    id: 'task-list',
    label: 'Task list',
    hint: 'Checkboxes you can tick',
    icon: ListTodo,
    keywords: ['task', 'todo', 'check', 'checkbox'],
    run: (editor) => editor.chain().focus().toggleTaskList().run(),
  },
  {
    id: 'blockquote',
    label: 'Quote',
    hint: 'Set text apart',
    icon: Quote,
    keywords: ['quote', 'blockquote', 'citation'],
    run: (editor) => editor.chain().focus().toggleBlockquote().run(),
  },
  {
    id: 'code-block',
    label: 'Code block',
    hint: 'Preformatted code',
    icon: Code,
    keywords: ['code', 'snippet', 'pre'],
    run: (editor) => editor.chain().focus().toggleCodeBlock().run(),
  },
  {
    id: 'callout',
    label: 'Callout',
    hint: 'A note that stands out',
    icon: StickyNote,
    keywords: ['callout', 'note', 'admonition', 'warning', 'tip'],
    run: (editor) => editor.chain().focus().wrapIn('callout').run(),
  },
  // The toggles insert through `setDetails`, never `wrapIn`: `details` needs a summary child
  // and a content child, and `wrapIn` can only fold the block into a single parent - it fails
  // silently against this schema. `setDetails` builds the pair and moves the caret into the
  // summary, so what somebody types next names the section.
  {
    id: 'toggle',
    label: 'Toggle',
    hint: 'A section that folds away',
    icon: ChevronRight,
    keywords: TOGGLE_KEYWORDS,
    run: (editor) => editor.chain().focus().setDetails().run(),
  },
  // One entry per level, mirroring the plain headings above: the levels are the schema's
  // `TOGGLE_LEVELS`, so a level added there appears here without anyone remembering to count.
  ...TOGGLE_LEVELS.map((level): SlashCommand => ({
    id: `toggle-heading-${String(level)}`,
    label: `Toggle heading ${String(level)}`,
    hint: TOGGLE_HEADING_HINTS[level],
    icon: ListCollapse,
    keywords: [...TOGGLE_KEYWORDS, 'heading', `h${String(level)}`],
    run: (editor) =>
      editor.chain().focus().setDetails().updateAttributes('details', { toggleLevel: level }).run(),
  })),
  {
    id: 'divider',
    label: 'Divider',
    hint: 'A horizontal rule',
    icon: Minus,
    keywords: ['divider', 'rule', 'hr', 'separator'],
    run: (editor) => editor.chain().focus().setHorizontalRule().run(),
  },
  {
    id: 'table',
    label: 'Table',
    hint: 'Three columns, with a header row',
    icon: TableIcon,
    // Deliberately not "columns". A table has columns, but so does the block *named* Columns,
    // and a flat filter has no way to prefer the exact label - so typing the one word that names
    // a command found the other command first and Enter inserted a table. "grid" and "rows"
    // still find this, and the hint says "Three columns, with a header row".
    keywords: ['table', 'grid', 'rows'],
    run: (editor) =>
      editor.chain().focus().insertTable({ rows: 3, cols: 3, withHeaderRow: true }).run(),
  },
  {
    id: 'columns',
    label: 'Columns',
    hint: 'Two columns, side by side',
    icon: Columns2,
    keywords: ['columns', 'column', 'side', 'split', 'layout'],
    // Two, because two is what somebody who types "/columns" means and because a row can be
    // widened afterwards - `addColumnToRow`, on the toolbar and on Mod+Alt+Enter, goes up to the
    // four the schema documents - and there is no undo for a menu that guessed three.
    run: (editor) => editor.chain().focus().insertColumnBlock({ columns: 2 }).run(),
  },
  {
    id: 'image',
    label: 'Image',
    hint: 'From a web address',
    icon: ImageIcon,
    keywords: ['image', 'picture', 'photo', 'figure'],
    // The modal is owned by the note editor, so toolbar and slash insertion share one form and
    // one document-selection boundary instead of growing two almost-identical dialogs.
    run: (_editor: Editor, actions: SlashCommandActions): void => {
      actions.insertImage();
    },
  },
  {
    id: 'link-item',
    label: 'Link to item',
    hint: 'Reference another document',
    icon: Link,
    keywords: ['link', 'reference', 'wiki', 'mention', 'backlink', 'item', 'document'],
    // Written as the trigger it abbreviates rather than opening the picker directly: the
    // reference menu reads `[[` out of the document on every transaction, so inserting the
    // trigger *is* opening the picker - one opening mechanism, not two to keep in step. The
    // insertion point is always a word start, because this menu's own trigger required one.
    run: (editor) => editor.chain().focus().insertContent('[[').run(),
  },
  {
    id: 'attachment',
    label: 'Attachment',
    hint: 'Upload or link an existing file',
    icon: Link,
    keywords: ['file', 'upload'],
    run: (_editor, actions) => actions.insertItem?.('attachment'),
  },
  {
    id: 'embed-note',
    label: 'Embed note',
    hint: 'A live section from another note',
    icon: StickyNote,
    keywords: ['embed', 'note', 'section'],
    run: (_editor, actions) => actions.insertItem?.('embed'),
  },
  {
    id: 'subpage',
    label: 'New subpage',
    hint: 'Create a named child note',
    icon: StickyNote,
    keywords: ['page', 'child'],
    run: (_editor, actions) => actions.insertItem?.('subpage'),
  },
  {
    id: 'page-break',
    label: 'Page break',
    hint: 'Start a new page in exports',
    icon: Minus,
    keywords: ['page', 'print'],
    run: (_editor, actions) => actions.pageBreak?.(),
  },
];

/**
 * Filters the list the way a person typing expects: label first, then keywords.
 *
 * The label arm used to read `needle.substring(1, needle.length)`, dropping the needle's first
 * character - a leftover from when the query still carried the `/` that opened the menu. It went
 * unnoticed because the shortened needle is a substring of the real one, so every correct match
 * still matched; what it also did was match things it should not. Searching for "able" found
 * "Table", and so did searching for "zable".
 */
export function filterSlashCommands(
  query: string,
  commands: readonly SlashCommand[] = SLASH_COMMANDS,
): readonly SlashCommand[] {
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

/**
 * The filtered commands in the order to offer them, given what was typed and how often each
 * command has been picked.
 *
 * **What it may change, and what it may not.** Two tiers, in this order:
 *
 * 1. An exact match - the query *is* a command's label or one of its keywords. Typing the whole
 *    name of a command has to put that command under Enter (the "columns" bug on `table` is the
 *    reason that is a contract and not a nicety), so no history ever lifts a partial match above
 *    an exact one.
 * 2. Every other match.
 *
 * Within a tier, the higher frecency score goes first, and equal scores - including the common
 * case of no history at all - keep the catalogue's order. So with no history this is
 * `filterSlashCommands` with exact matches hoisted, and history only reorders commands the query
 * already found equally well.
 *
 * An empty query is left in catalogue order: the full menu is browsed rather than searched, and a
 * list that reshuffles itself under the pointer is harder to browse than a fixed one.
 */
export function rankSlashCommands(
  commands: readonly SlashCommand[],
  query: string,
  scores: ReadonlyMap<string, number>,
): readonly SlashCommand[] {
  const needle = query.trim().toLowerCase();
  if (needle.length === 0) {
    return commands;
  }
  const exact = (command: SlashCommand): number =>
    command.label.toLowerCase() === needle || command.keywords.includes(needle) ? 0 : 1;
  return commands
    .map((command, index) => ({
      command,
      index,
      tier: exact(command),
      score: scores.get(command.id) ?? 0,
    }))
    .sort((a, b) => a.tier - b.tier || b.score - a.score || a.index - b.index)
    .map((entry) => entry.command);
}

/**
 * How far into `/` somebody can type before it stops being a command and goes back to being
 * prose. Longer than any label or keyword, with room for a typo; past it, this is a sentence
 * that happens to start with a slash.
 */
const MAX_QUERY = 24;

/** An open `/` trigger: where its text starts and what has been typed after it. */
export interface FoundSlashTrigger {
  readonly start: number;
  readonly query: string;
}

/**
 * Finds an open `/` in the text before the caret.
 *
 * The same contract as the reference picker's `findTrigger`, for the same reasons. A slash only
 * counts at the start of a word - after whitespace, or at the very start of the block - so
 * "and/or" and the slashes inside a URL stay text. The query may contain spaces, because the
 * labels do ("Task list"); a newline ends it, and so does a query longer than any command name.
 * A *second* slash re-anchors the search and then fails the word-start test, which is what closes
 * the menu when somebody carries on typing a path.
 *
 * Exported for its own tests: it is pure string handling, and the alternative is asserting it
 * through an editor, a document and a selection.
 */
export function findSlashTrigger(text: string, truncated = false): FoundSlashTrigger | null {
  const start = text.lastIndexOf('/');
  if (start < 0) {
    return null;
  }

  // Position zero is the start of a word only when it really is the start of the block. When the
  // caller handed over a window cut out of a longer paragraph, the character before it is unknown.
  const before = start === 0 ? (truncated ? undefined : ' ') : text[start - 1];
  if (before === undefined || !/\s/.test(before)) {
    return null;
  }

  const query = text.slice(start + 1);
  if (query.length > MAX_QUERY || query.includes('\n')) {
    return null;
  }

  return { start, query };
}

// The window is the *reference* picker's, not this menu's own smaller one, because the deferral
// has to see everything that picker can: a `[[` that sits further back than a slash query is long
// would otherwise be invisible here, and both menus would open at once over the same caret.
// The reference picker wins. `[[quarterly /q2` is somebody typing a slash inside a link query, and
// two floating menus fighting over the same arrow keys helps nobody.
function findUnlessReference(text: string, truncated: boolean): FoundSlashTrigger | null {
  return findReferenceTrigger(text, truncated) === null ? findSlashTrigger(text, truncated) : null;
}

/**
 * The block inserter, opened by typing `/` at the start of a word.
 *
 * **The same shape as the reference picker, deliberately.** The query lives in the document and
 * focus never leaves it; the trigger is read back out of the document on every transaction, and
 * the keys are taken off the editor's own element while the menu is open. The previous version
 * held its query in a field of its own and moved focus into it, and both reported bugs fell out
 * of exactly that: the `/` keystroke raced the focus move and landed in the field - so the menu
 * opened showing "No block matches" until a backspace cleared the stray slash - and the keyboard
 * model was attached to a field the focus had not reliably reached. Its removal arithmetic also
 * assumed the query had been typed into the document when it never was, so committing a command
 * deleted that many characters of real content.
 *
 * Escape closes it without unwriting anything: the `/` somebody typed is theirs. Committing a
 * command removes the trigger text and inserts the block in its place.
 */
export function SlashMenu({
  editor,
  onInsertImage,
  onInsertItem,
  onPageBreak,
  onInlineAi,
}: {
  readonly editor: Editor;
  readonly onInsertImage: () => void;
  readonly onInsertItem?: ((kind: ItemInsertKind) => void) | undefined;
  readonly onPageBreak?: (() => void) | undefined;
  /** Present only when the writing assistance is on offer; its commands are listed only then. */
  readonly onInlineAi?: ((kind: InlineKind) => void) | undefined;
}): ReactNode {
  const { trigger, open, dismiss } = useEditorTrigger(
    editor,
    REFERENCE_MAX_QUERY + 2,
    findUnlessReference,
  );
  const query = trigger?.query ?? '';

  const orderByPicks = useChoiceOrderPreference((state) => state.setting === 'on');
  const available = [
    ...filterSlashCommands(query),
    ...(onInlineAi === undefined ? [] : filterSlashCommands(query, AI_SLASH_COMMANDS)),
  ].filter((command) => {
    if (['attachment', 'embed-note', 'subpage'].includes(command.id))
      return onInsertItem !== undefined;
    if (command.id === 'page-break')
      return onPageBreak !== undefined && editor.state.selection.$from.depth <= 1;
    return true;
  });
  // Read per render while the menu is open, which is per keystroke into its query: a parse of at
  // most `MAX_ENTRIES` short records, and the scores only change when a command runs, which closes
  // the menu - so the order cannot shift under the highlight.
  const ranked = open
    ? rankSlashCommands(
        available,
        query,
        orderByPicks ? frecencyScores(SLASH_FRECENCY_NAMESPACE) : NO_SCORES,
      )
    : available;
  // The assistant's commands close the list under their own heading, however the ranking above
  // ordered them: a heading is drawn each time the group changes, so they must stay together.
  const commands = [
    ...ranked.filter((command) => command.group === undefined),
    ...ranked.filter((command) => command.group !== undefined),
  ];
  const options = commands.map((command) => ({
    id: command.id,
    label: command.label,
    hint: command.hint,
    icon: command.icon,
    ...(command.group === undefined ? {} : { group: command.group }),
  }));

  const listbox = useListbox(options, (_option, index) => {
    const command = commands[index];
    if (command === undefined || trigger === null) {
      return;
    }

    // The trigger's text - the `/` and the query, at the positions just read from the document -
    // comes out first, then the command runs against the caret it leaves behind. Nothing else is
    // touched, which is what the field-based version got wrong: its arithmetic deleted characters
    // the document actually owned.
    editor.chain().focus().deleteRange({ from: trigger.from, to: trigger.to }).run();
    if (orderByPicks) {
      recordPick(SLASH_FRECENCY_NAMESPACE, command.id);
    }
    command.run(editor, {
      insertImage: onInsertImage,
      insertItem: onInsertItem,
      pageBreak: onPageBreak,
      inlineAi: onInlineAi,
    });
  });

  useEditorListbox(editor, listbox, trigger, open, dismiss);

  if (trigger === null || !open) {
    return null;
  }

  // Below the caret at up to 280px wide, unless the viewport - a phone's, with its keyboard
  // already open - has no room for that: then the menu narrows, shrinks, or flips above.
  const placement = placeFloatingMenu(
    { left: trigger.left, top: trigger.top, bottom: trigger.bottom },
    280,
    readViewportBounds(),
  );

  const menuPosition = {
    left: placement.left,
    top: placement.top,
    width: placement.maxWidth,
    maxHeight: placement.maxHeight,
  };
  return (
    <div
      // Positioned against the caret in viewport coordinates, so it follows the text rather than
      // the scroller - which the editor does under it.
      style={menuPosition} // design-token-exempt: a caret's position is a runtime measurement, not a scale step.
      className={[
        'fixed z-20 flex flex-col overflow-y-auto border border-divider bg-background shadow-md',
        placement.above ? '-mb-1 -translate-y-full' : 'mt-1',
      ].join(' ')}
    >
      <Listbox
        label="Insert a block"
        options={options}
        controller={listbox}
        emptyMessage="No block matches."
      />
    </div>
  );
}
