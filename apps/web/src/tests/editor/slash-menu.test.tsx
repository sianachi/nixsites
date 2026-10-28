import { TOGGLE_LEVELS, nixEditingExtensions } from '@nix/editor-schema';
import { act, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { EditorContent, useEditor, type Editor } from '@tiptap/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { type ReactNode } from 'react';

import {
  SLASH_COMMANDS,
  SLASH_FRECENCY_NAMESPACE,
  filterSlashCommands,
  findSlashTrigger,
  rankSlashCommands,
  SlashMenu,
} from '../../editor/slash-menu';
import { frecencyScores, recordPick } from '@nix/web-foundation/lib/frecency';
import { useChoiceOrderPreference } from '@nix/web-foundation/lib/suggestion-preferences';
import { memoryStorage } from '../memory-storage';

describe('the slash menu', () => {
  it('offers every block the schema defines a way to insert', () => {
    const ids = SLASH_COMMANDS.map((command) => command.id);

    // A block in the schema with no way to insert it is a block nobody can use. Tables and
    // callouts are here because they are exactly the two a thin first cut always omits.
    expect(ids).toEqual(
      expect.arrayContaining([
        'paragraph',
        'heading-1',
        'heading-2',
        'heading-3',
        'bullet-list',
        'ordered-list',
        'task-list',
        'blockquote',
        'code-block',
        'callout',
        'toggle',
        'toggle-heading-1',
        'toggle-heading-2',
        'toggle-heading-3',
        'divider',
        'table',
        'columns',
        'image',
        'link-item',
      ]),
    );
  });

  it('tells the toggle headings apart by their hints, as the plain headings are', () => {
    // Three entries reading "A folding section titled like a heading" would be three rows a
    // person has to pick between on the level number alone.
    const hints = SLASH_COMMANDS.filter((command) => command.id.startsWith('toggle-heading-')).map(
      (command) => command.hint,
    );

    expect(hints).toHaveLength(TOGGLE_LEVELS.length);
    expect(new Set(hints).size).toBe(TOGGLE_LEVELS.length);
  });

  it('shows everything when nothing has been typed', () => {
    expect(filterSlashCommands('')).toHaveLength(SLASH_COMMANDS.length);
    expect(filterSlashCommands('   ')).toHaveLength(SLASH_COMMANDS.length);
  });

  it('matches on the label', () => {
    expect(filterSlashCommands('table').map((command) => command.id)).toEqual(['table']);
  });

  it('matches on the words people actually reach for', () => {
    // "bullet", "ul" and "list" all have to find the same thing: people type the word they know,
    // not the word the schema uses.
    for (const query of ['bullet', 'ul', 'unordered']) {
      expect(filterSlashCommands(query).map((command) => command.id)).toContain('bullet-list');
    }

    expect(filterSlashCommands('todo').map((command) => command.id)).toContain('task-list');
    expect(filterSlashCommands('admonition').map((command) => command.id)).toContain('callout');

    // A person who wants a collapsible section may know it as any of these; "details" is the
    // word the schema uses, kept findable for whoever greps the storage format.
    for (const query of ['section', 'collapse', 'fold', 'details', 'disclosure']) {
      expect(filterSlashCommands(query).map((command) => command.id)).toContain('toggle');
    }

    // "toggle" finds the whole family, plain and headed alike.
    expect(filterSlashCommands('toggle').map((command) => command.id)).toEqual([
      'toggle',
      'toggle-heading-1',
      'toggle-heading-2',
      'toggle-heading-3',
    ]);

    // Side-by-side content: the words are "columns", "split" and "side", and none of them is
    // the schema's own node name.
    for (const query of ['columns', 'split', 'side', 'layout']) {
      expect(filterSlashCommands(query).map((command) => command.id)).toContain('columns');
    }

    // And the exact name of a command finds that command first, so Enter inserts what was typed.
    expect(filterSlashCommands('columns')[0]?.id).toBe('columns');
    expect(filterSlashCommands('table')[0]?.id).toBe('table');

    // The words somebody who wants a wiki link reaches for, "backlink" included: the panel that
    // surfaces them is the reason many people go looking for the command.
    for (const query of ['link', 'reference', 'backlink', 'wiki']) {
      expect(filterSlashCommands(query).map((command) => command.id)).toContain('link-item');
    }
  });

  it('ignores case and surrounding space', () => {
    expect(filterSlashCommands('  TABLE ').map((command) => command.id)).toEqual(['table']);
  });

  it('matches the whole of what was typed, first character included', () => {
    // The label arm used to drop the needle's first character - a leftover from when the query
    // still carried the `/` that opened the menu. Every correct match still matched, which is why
    // it survived unnoticed; what it also did was match things it should not.
    //
    // "zable" is the query that tells the two apart. Its tail is a real label, so the old arm
    // found "Table"; nothing in the list contains the whole of it, so the fixed arm finds nothing.
    // "able" would not have shown it, because that one is a genuine substring of the *keyword*
    // "table" and matches on the keywords arm either way.
    expect(filterSlashCommands('zable')).toEqual([]);
    expect(filterSlashCommands('table').map((command) => command.id)).toEqual(['table']);
  });

  it('returns nothing when nothing matches', () => {
    expect(filterSlashCommands('spreadsheet')).toEqual([]);
  });
});

describe('finding an open slash trigger', () => {
  it('opens at the start of a block', () => {
    expect(findSlashTrigger('/')).toEqual({ start: 0, query: '' });
  });

  it('opens after whitespace and carries what was typed', () => {
    expect(findSlashTrigger('say /tab')).toEqual({ start: 4, query: 'tab' });
  });

  it('allows spaces in the query, because the labels have them', () => {
    expect(findSlashTrigger('/task l')).toEqual({ start: 0, query: 'task l' });
  });

  it('stays closed mid-word, so "and/or" and URLs stay prose', () => {
    expect(findSlashTrigger('and/or')).toBeNull();
    expect(findSlashTrigger('https://example')).toBeNull();
  });

  it('stays closed at the edge of a truncated window, where the preceding character is unknown', () => {
    expect(findSlashTrigger('/x', true)).toBeNull();
  });

  it('closes when a second slash makes it a path', () => {
    // The second slash re-anchors the search and then fails the word-start test.
    expect(findSlashTrigger('see /a/b')).toBeNull();
  });

  it('closes on a newline', () => {
    expect(findSlashTrigger('/head\nmore')).toBeNull();
  });

  it('closes past the length any command name could have', () => {
    expect(findSlashTrigger(`/${'x'.repeat(25)}`)).toBeNull();
  });
});

/**
 * The menu against a real editor: the trigger read out of the document, the keyboard driven
 * through the editor's own element, and the commit against real positions.
 *
 * These exist because the previous design's bugs were exactly interaction bugs - a menu that
 * opened showing "No block matches" until a backspace, and arrow keys that moved nothing - and
 * the pure-function tests above cannot see either.
 */

let captured: Editor | null = null;
let insertImage: ReturnType<typeof vi.fn>;

function Harness(): ReactNode {
  const editor = useEditor({
    // `nixEditingExtensions` rather than the schema alone: the columns entry runs a command the
    // editing extension owns, and a harness without it would assert the menu offers something
    // that silently does nothing. The pairing has a name so no caller has to remember it.
    extensions: [...nixEditingExtensions],
    onCreate: ({ editor: created }) => {
      captured = created;
    },
  });

  return (
    <>
      <SlashMenu
        editor={editor}
        onInsertImage={insertImage}
        onInsertItem={() => undefined}
        onPageBreak={() => undefined}
      />
      <EditorContent editor={editor} />
    </>
  );
}

beforeEach(() => {
  captured = null;
  insertImage = vi.fn();
});

/** Renders the harness and types `content` into the document as one insertion. */
async function openWith(content: string): Promise<Editor> {
  render(<Harness />);

  await waitFor(() => {
    expect(captured).not.toBeNull();
  });

  const editor = captured;
  if (editor === null) {
    throw new Error('The editor never reported itself created.');
  }

  // jsdom performs no layout, so the caret has no coordinates to measure. The menu only uses
  // them to position its floating box, which these tests do not assert on.
  vi.spyOn(editor.view, 'coordsAtPos').mockReturnValue({
    left: 0,
    top: 0,
    right: 0,
    bottom: 0,
  });

  act(() => {
    editor.commands.insertContent(content);
  });

  return editor;
}

describe('the slash menu over a real document', () => {
  it('opens on a slash typed at the start of a block, with every command on offer', async () => {
    await openWith('/');

    const listbox = await screen.findByRole('listbox', { name: 'Insert a block' });
    expect(listbox).toBeInTheDocument();
    expect(screen.getAllByRole('option')).toHaveLength(SLASH_COMMANDS.length);
  });

  it('filters as the query is typed into the document', async () => {
    await openWith('/tab');

    const options = await screen.findAllByRole('option');
    expect(options).toHaveLength(1);
    expect(options[0]).toHaveTextContent('Table');
  });

  it('commits with the arrow keys and Enter, and removes the trigger text', async () => {
    const editor = await openWith('/');
    await screen.findByRole('listbox', { name: 'Insert a block' });

    // The keys go to the editor's element, because that is what holds the focus - there is no
    // field of the menu's own for them to go to.
    fireEvent.keyDown(editor.view.dom, { key: 'ArrowDown' });
    fireEvent.keyDown(editor.view.dom, { key: 'Enter' });

    // The second option is Heading 1, and the slash it was filtered by is gone.
    expect(editor.getHTML()).toContain('<h1');
    expect(editor.getText()).not.toContain('/');
  });

  it('inserts a reference trigger from the link command, which is what opens the item picker', async () => {
    const editor = await openWith('/link');
    await screen.findByRole('listbox', { name: 'Insert a block' });

    fireEvent.keyDown(editor.view.dom, { key: 'Enter' });

    // `[[` in the document is the reference picker's trigger; writing it is how this command
    // opens that picker rather than owning a picker of its own.
    expect(editor.getText()).toContain('[[');
    expect(editor.getText()).not.toContain('/link');
  });

  it('opens the image form and removes the committed slash command', async () => {
    const editor = await openWith('/image');
    await screen.findByRole('listbox', { name: 'Insert a block' });

    fireEvent.keyDown(editor.view.dom, { key: 'Enter' });

    expect(insertImage).toHaveBeenCalledOnce();
    expect(editor.getText()).not.toContain('/image');
  });

  it('inserts a row of two columns from the columns command', async () => {
    const editor = await openWith('/columns');
    await screen.findByRole('listbox', { name: 'Insert a block' });

    // Enter on the first option. Typing the exact name of a command has to insert that command:
    // "columns" used to find Table first, because Table listed the word among its keywords, so
    // the default highlight was the wrong block entirely.
    fireEvent.keyDown(editor.view.dom, { key: 'Enter' });

    // Two, because two is what somebody typing "/columns" means; widening a row is a separate
    // command, and there is no undo for a menu that guessed three.
    const row = editor.state.doc.firstChild;
    expect(row?.type.name).toBe('columnBlock');
    expect(row?.childCount).toBe(2);
    expect(editor.getText()).not.toContain('/columns');
  });

  it('closes on Escape and leaves the typed slash where it was', async () => {
    const editor = await openWith('/');
    await screen.findByRole('listbox', { name: 'Insert a block' });

    fireEvent.keyDown(editor.view.dom, { key: 'Escape' });

    expect(screen.queryByRole('listbox', { name: 'Insert a block' })).not.toBeInTheDocument();
    // The `/` somebody typed is theirs; dismissing the menu must not edit the document.
    expect(editor.getText()).toContain('/');
  });

  it('does not open mid-word, so a URL can be typed in peace', async () => {
    await openWith('https://example');

    expect(screen.queryByRole('listbox', { name: 'Insert a block' })).not.toBeInTheDocument();
  });

  it('creates a toggle with a summary and a body, no HTML pasted', async () => {
    const editor = await openWith('/toggle');
    await screen.findByRole('listbox', { name: 'Insert a block' });

    // The first match for "toggle" is the plain toggle.
    fireEvent.keyDown(editor.view.dom, { key: 'Enter' });

    // `setDetails` has to build the pair itself - `wrapIn` cannot, which is why the command
    // exists - and the trigger text must be gone.
    const details = editor.state.doc.firstChild;
    expect(details?.type.name).toBe('details');
    expect(details?.child(0).type.name).toBe('detailsSummary');
    expect(details?.child(1).type.name).toBe('detailsContent');
    expect(details?.attrs.toggleLevel).toBeNull();
    expect(editor.getText()).not.toContain('/');
  });

  it('leaves the caret in the summary, so what is typed next names the section', async () => {
    const editor = await openWith('/toggle');
    await screen.findByRole('listbox', { name: 'Insert a block' });
    fireEvent.keyDown(editor.view.dom, { key: 'Enter' });

    act(() => {
      editor.commands.insertContent('Quarterly plan');
    });

    expect(editor.state.doc.firstChild?.child(0).textContent).toBe('Quarterly plan');
  });

  // Every level the schema offers, not the middle one taken as a proxy for the other two: the
  // entries are generated from `TOGGLE_LEVELS`, and a generator is exactly the thing that can
  // be right for one input and wrong for the rest.
  it.each(TOGGLE_LEVELS)('creates a toggle heading at the level asked for, %i', async (level) => {
    const editor = await openWith(`/toggle heading ${String(level)}`);
    await screen.findByRole('listbox', { name: 'Insert a block' });

    fireEvent.keyDown(editor.view.dom, { key: 'Enter' });

    const details = editor.state.doc.firstChild;
    expect(details?.type.name).toBe('details');
    expect(details?.attrs.toggleLevel).toBe(level);
  });

  it('yields to the reference picker when the slash is inside an open link query', async () => {
    await openWith('[[ledger /q');

    // Two floating menus over one caret would fight for the same arrow keys; the more specific
    // trigger wins.
    expect(screen.queryByRole('listbox', { name: 'Insert a block' })).not.toBeInTheDocument();
  });
});

describe('ordering matches by what this person picks', () => {
  const ids = (commands: readonly { id: string }[]): string[] =>
    commands.map((command) => command.id);

  // For "list", Bulleted and Numbered list carry the keyword exactly; Task list only contains it
  // in its label. That gives one query with both tiers.

  it('changes nothing without history when the exact matches already lead', () => {
    expect(ids(rankSlashCommands(filterSlashCommands('list'), 'list', new Map()))).toEqual([
      'bullet-list',
      'ordered-list',
      'task-list',
    ]);
  });

  it('puts the more often picked of two exact matches first', () => {
    const scores = new Map([['ordered-list', 3]]);

    expect(ids(rankSlashCommands(filterSlashCommands('list'), 'list', scores))).toEqual([
      'ordered-list',
      'bullet-list',
      'task-list',
    ]);
  });

  it('never lifts a partial match above an exact one, however often it was picked', () => {
    const scores = new Map([['task-list', 50]]);

    expect(ids(rankSlashCommands(filterSlashCommands('list'), 'list', scores)).at(-1)).toBe(
      'task-list',
    );
  });

  it('hoists an exact match over a partial one that comes earlier in the input', () => {
    // The catalogue happens never to list a partial match before an exact one, so the input is
    // reordered here to prove the tier rule rather than the catalogue's arrangement.
    const byId = (id: string) => SLASH_COMMANDS.find((command) => command.id === id);
    const input = [byId('task-list'), byId('bullet-list')].filter(
      (command) => command !== undefined,
    );

    expect(ids(rankSlashCommands(input, 'list', new Map()))).toEqual(['bullet-list', 'task-list']);
  });

  it('orders partial matches by history', () => {
    const scores = new Map([['task-list', 2]]);

    expect(ids(rankSlashCommands(filterSlashCommands('lis'), 'lis', scores))[0]).toBe('task-list');
  });

  it('leaves the full menu in catalogue order, because it is browsed rather than searched', () => {
    const scores = new Map([['divider', 100]]);

    expect(ids(rankSlashCommands(SLASH_COMMANDS, '', scores))).toEqual(ids(SLASH_COMMANDS));
  });
});

describe('remembering slash commands', () => {
  beforeEach(() => {
    vi.stubGlobal('localStorage', memoryStorage());
  });

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it('records the command that ran, by id', async () => {
    const editor = await openWith('/quote');
    await screen.findByRole('listbox', { name: 'Insert a block' });

    fireEvent.keyDown(editor.view.dom, { key: 'Enter' });

    expect(frecencyScores(SLASH_FRECENCY_NAMESPACE).get('blockquote')).toBeCloseTo(1);
  });

  it('offers the command picked most often first among the matches', async () => {
    recordPick(SLASH_FRECENCY_NAMESPACE, 'ordered-list');
    recordPick(SLASH_FRECENCY_NAMESPACE, 'ordered-list');

    await openWith('/lis');

    const options = await screen.findAllByRole('option');
    expect(options[0]).toHaveTextContent('Numbered list');
  });

  it('keeps the catalogue order and records nothing when ordering by picks is off', async () => {
    useChoiceOrderPreference.setState({ setting: 'off', saved: true });
    recordPick(SLASH_FRECENCY_NAMESPACE, 'ordered-list');
    recordPick(SLASH_FRECENCY_NAMESPACE, 'ordered-list');

    try {
      const editor = await openWith('/lis');
      const options = await screen.findAllByRole('option');
      expect(options[0]).not.toHaveTextContent('Numbered list');

      fireEvent.keyDown(editor.view.dom, { key: 'Enter' });
      expect(frecencyScores(SLASH_FRECENCY_NAMESPACE).get('ordered-list')).toBeCloseTo(2);
      expect([...frecencyScores(SLASH_FRECENCY_NAMESPACE).keys()]).toEqual(['ordered-list']);
    } finally {
      useChoiceOrderPreference.setState({ setting: 'on', saved: true });
    }
  });
});
