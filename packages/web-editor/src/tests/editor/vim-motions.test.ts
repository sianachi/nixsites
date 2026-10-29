import { nixEditingExtensions } from '@nix/editor-schema';
import { Editor } from '@tiptap/core';
import { Gapcursor } from '@tiptap/extensions';
import { GapCursor } from '@tiptap/pm/gapcursor';
import { Slice } from '@tiptap/pm/model';
import { TextSelection, type Plugin } from '@tiptap/pm/state';
import { CellSelection } from '@tiptap/pm/tables';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { ySyncPlugin, yUndoPlugin, yUndoPluginKey } from 'y-prosemirror';
import * as Y from 'yjs';

import {
  setVimEnabled,
  vimMode,
  vimModeLabel,
  vimMotionsKey,
  vimStatus,
  vimStatusMode,
  VimMotions,
} from '../../editor/vim-motions';

let editors: Editor[] = [];

function open(
  content = '<p>alpha beta gamma</p><p>last</p>',
  enabled = true,
  isApplePlatform?: boolean,
): Editor {
  const vimExtension =
    isApplePlatform === undefined ? VimMotions : VimMotions.configure({ isApplePlatform });
  const editor = new Editor({
    element: document.createElement('div'),
    extensions: [...nixEditingExtensions, Gapcursor, vimExtension],
    content,
  });
  editors.push(editor);
  if (enabled) {
    setVimEnabled(editor.view, true);
  }
  return editor;
}

function vimPlugin(editor: Editor) {
  const plugin = editor.state.plugins.find((candidate) => candidate.spec.key === vimMotionsKey);
  if (plugin === undefined) {
    throw new Error('The Vim motions plugin was not installed.');
  }
  return plugin;
}

function key(editor: Editor, keyValue: string, options: KeyboardEventInit = {}): KeyboardEvent {
  const event = new KeyboardEvent('keydown', {
    key: keyValue,
    bubbles: true,
    cancelable: true,
    ...options,
  });
  editor.view.dom.dispatchEvent(event);
  return event;
}

afterEach(() => {
  for (const editor of editors) {
    editor.destroy();
  }
  editors = [];
});

describe('Vim basics Normal mode', () => {
  it('exposes no active mode until enabled and activates directly in Normal', () => {
    const editor = open('<p>Text</p>', false);

    expect(vimStatusMode(editor.state)).toBeNull();
    setVimEnabled(editor.view, true);
    expect(vimStatusMode(editor.state)).toBe('normal');
  });

  it('starts each editor in Normal and blocks unsupported editing without cancelling Tab or arrows', () => {
    const editor = open('<p>Text</p>');
    const before = editor.getJSON();

    expect(vimMode(editor.state)).toBe('normal');
    for (const keyValue of ['q', ' ', 'Backspace', 'Delete', 'Enter']) {
      expect(key(editor, keyValue).defaultPrevented).toBe(true);
    }
    expect(key(editor, 'Tab').defaultPrevented).toBe(false);
    expect(key(editor, 'ArrowRight').defaultPrevented).toBe(false);
    expect(editor.getJSON()).toEqual(before);
  });

  it('skips rich-editor Tab and modified destructive keymaps without cancelling native focus traversal', () => {
    const editor = open('<p>Text</p>');
    editor.commands.insertTable({ rows: 2, cols: 2, withHeaderRow: false });
    const cells: number[] = [];
    editor.state.doc.descendants((node, position) => {
      if (node.type.name === 'tableCell') {
        cells.push(position);
      }
    });
    const lastCell = cells.at(-1);
    if (lastCell === undefined) {
      throw new Error('The table did not contain a cell.');
    }
    editor.commands.setTextSelection(lastCell + 2);
    const before = editor.getJSON();

    const tab = key(editor, 'Tab');
    for (const [keyValue, modifiers] of [
      ['Backspace', { ctrlKey: true }],
      ['Delete', { altKey: true }],
      ['Enter', { metaKey: true }],
    ] as const) {
      expect(key(editor, keyValue, modifiers).defaultPrevented).toBe(true);
    }

    expect(tab.defaultPrevented).toBe(false);
    expect(editor.getJSON()).toEqual(before);

    const listEditor = open('<ul><li><p>One</p></li><li><p>Two</p></li></ul>');
    let secondItemText: number | undefined;
    listEditor.state.doc.descendants((node, position) => {
      if (node.isTextblock && node.textContent === 'Two') {
        secondItemText = position + 1;
      }
    });
    if (secondItemText === undefined) {
      throw new Error('The list did not contain its second item.');
    }
    listEditor.commands.setTextSelection(secondItemText);
    const beforeListTab = listEditor.getJSON();

    const listTab = key(listEditor, 'Tab');

    expect(listTab.defaultPrevented).toBe(false);
    expect(listEditor.getJSON()).toEqual(beforeListTab);
  });

  it('skips code-block arrow keymaps while leaving native navigation uncancelled', () => {
    const editor = open('<pre><code>Code</code></pre>');
    const before = editor.getJSON();
    editor.commands.setTextSelection(1);

    const up = key(editor, 'ArrowUp');
    editor.commands.setTextSelection(editor.state.doc.content.size - 1);
    const down = key(editor, 'ArrowDown');

    expect(up.defaultPrevented).toBe(false);
    expect(down.defaultPrevented).toBe(false);
    expect(editor.getJSON()).toEqual(before);
  });

  it.each([
    ['Ctrl+H', 'h', { ctrlKey: true }],
    ['Ctrl+D', 'd', { ctrlKey: true }],
    ['Alt+D', 'd', { altKey: true }],
  ] as const)('claims the macOS destructive alias %s', (_name, keyValue, modifiers) => {
    const editor = open('<p>Text</p>', true, true);
    editor.commands.setTextSelection(3);
    const before = editor.getJSON();

    const event = key(editor, keyValue, modifiers);

    expect(event.defaultPrevented).toBe(true);
    expect(editor.state.selection.from).toBe(3);
    expect(editor.getJSON()).toEqual(before);
  });

  it.each([
    ['Ctrl+H', 'h', { ctrlKey: true }],
    ['Ctrl+D', 'd', { ctrlKey: true }],
    ['Alt+D', 'd', { altKey: true }],
  ] as const)('leaves the non-Apple browser shortcut %s alone', (_name, keyValue, modifiers) => {
    const editor = open('<p>Text</p>', true, false);
    const plugin = vimPlugin(editor);
    const event = new KeyboardEvent('keydown', { key: keyValue, ...modifiers });

    expect(plugin.props.handleKeyDown?.call(plugin, editor.view, event)).toBe(false);
  });

  it('moves by character, word, text-block edge, and document edge, resting on characters', () => {
    const editor = open();
    editor.commands.setTextSelection(3);

    key(editor, 'h');
    expect(editor.state.selection.from).toBe(2);
    key(editor, 'l');
    expect(editor.state.selection.from).toBe(3);
    key(editor, 'w');
    expect(editor.state.selection.from).toBe(7);
    key(editor, 'b');
    expect(editor.state.selection.from).toBe(1);
    // On the last character of "alpha" and of the block, not after it.
    key(editor, 'e');
    expect(editor.state.selection.from).toBe(5);
    key(editor, '$');
    expect(editor.state.selection.from).toBe(16);
    key(editor, 'l');
    expect(editor.state.selection.from).toBe(16);
    key(editor, '0');
    expect(editor.state.selection.from).toBe(1);
    // G goes to the first non-blank of the last line, as in Vim.
    key(editor, 'G');
    expect(editor.state.selection.from).toBe(19);
    key(editor, 'g');
    expect(editor.state.selection.from).toBe(19);
    key(editor, 'g');
    expect(editor.state.selection.from).toBe(1);
  });

  it('moves through a 100,000-character text block without expanding a segment array', () => {
    const text = `${'word '.repeat(20_000)}finish`;
    const editor = open(`<p>${text}</p>`);
    editor.commands.setTextSelection(text.length + 1);

    key(editor, 'b');

    expect(editor.state.selection.from).toBe(text.length - 'finish'.length + 1);
  });

  it('does not read a large text block for unsupported Normal keys', () => {
    const editor = open(`<p>${'word '.repeat(20_000)}</p>`);
    const textBetween = vi.spyOn(editor.state.selection.$head.parent, 'textBetween');

    key(editor, 'q');

    expect(textBetween).not.toHaveBeenCalled();
  });

  it('moves and appends only at whole Unicode grapheme boundaries', () => {
    const value = `A\u{1D11E}e\u0301\u{1F469}\u200D\u{1F4BB}Z`;
    const editor = open(`<p>${value}</p>`);
    editor.commands.setTextSelection(2);

    key(editor, 'l');
    expect(editor.state.selection.from).toBe(4);
    key(editor, 'l');
    expect(editor.state.selection.from).toBe(6);
    key(editor, 'l');
    expect(editor.state.selection.from).toBe(11);
    key(editor, 'h');
    expect(editor.state.selection.from).toBe(6);

    editor.commands.setTextSelection(2);
    key(editor, 'a');
    editor.commands.insertContent('X');
    expect(editor.getText()).toBe(`A\u{1D11E}Xe\u0301\u{1F469}\u200D\u{1F4BB}Z`);
  });

  it('treats w, b, and e as language-word motions that continue into the next block', () => {
    const editor = open('<p>alpha...beta привет мир</p><p>next block</p>');
    editor.commands.setTextSelection(3);

    key(editor, 'w');
    expect(editor.state.selection.from).toBe(9);
    key(editor, 'w');
    expect(editor.state.selection.from).toBe(14);
    key(editor, 'e');
    expect(editor.state.selection.from).toBe(19);
    key(editor, 'b');
    expect(editor.state.selection.from).toBe(14);

    key(editor, '$');
    expect(editor.state.selection.from).toBe(23);
    key(editor, 'w');
    expect(editor.state.selection.from).toBe(26);
    key(editor, 'b');
    expect(editor.state.selection.from).toBe(21);
  });

  it('enters Insert at the caret, after it, and at either text-block edge', () => {
    const editor = open('<p>alpha</p>');
    editor.commands.setTextSelection(3);

    key(editor, 'i');
    expect(vimMode(editor.state)).toBe('insert');
    expect(editor.state.selection.from).toBe(3);
    // Leaving Insert steps back onto the character before the caret, as Vim does.
    key(editor, 'Escape');
    expect(editor.state.selection.from).toBe(2);

    key(editor, 'a');
    expect(vimMode(editor.state)).toBe('insert');
    expect(editor.state.selection.from).toBe(3);
    key(editor, 'Escape');

    key(editor, 'I');
    expect(vimMode(editor.state)).toBe('insert');
    expect(editor.state.selection.from).toBe(1);
    key(editor, 'Escape');
    expect(editor.state.selection.from).toBe(1);

    key(editor, 'A');
    expect(vimMode(editor.state)).toBe('insert');
    expect(editor.state.selection.from).toBe(6);
  });

  it('collapses ranges and rich selections before entering Insert', () => {
    const rangeEditor = open('<p>alpha beta</p>');
    rangeEditor.commands.setTextSelection({ from: 2, to: 7 });
    key(rangeEditor, 'i');
    expect(rangeEditor.state.selection).toBeInstanceOf(TextSelection);
    expect(rangeEditor.state.selection.empty).toBe(true);
    rangeEditor.commands.insertContent('X');
    expect(rangeEditor.getText().replace('X', '')).toBe('alpha beta');

    const tableEditor = open('<p>Before</p>');
    tableEditor.commands.insertTable({ rows: 2, cols: 2, withHeaderRow: false });
    const cells: number[] = [];
    tableEditor.state.doc.descendants((node, position) => {
      if (node.type.name === 'tableCell') {
        cells.push(position);
      }
    });
    const first = cells[0];
    const last = cells.at(-1);
    if (first === undefined || last === undefined) {
      throw new Error('The table did not contain enough cells.');
    }
    tableEditor.view.dispatch(
      tableEditor.state.tr.setSelection(CellSelection.create(tableEditor.state.doc, first, last)),
    );
    key(tableEditor, 'i');
    expect(tableEditor.state.selection).toBeInstanceOf(TextSelection);
    expect(tableEditor.state.selection.empty).toBe(true);
  });

  it('uses text carets for document edges and never selects edge images', () => {
    const editor = open(
      '<img src="https://images.example.test/start.png"><p>Text</p><img src="https://images.example.test/end.png">',
    );

    key(editor, 'G');
    expect(editor.state.selection).toBeInstanceOf(TextSelection);
    key(editor, 'i');
    editor.commands.insertContent('X');
    expect(editor.getJSON().content.filter((node) => node.type === 'image')).toHaveLength(2);
    key(editor, 'Escape');

    key(editor, 'g');
    key(editor, 'g');
    expect(editor.state.selection).toBeInstanceOf(TextSelection);
    key(editor, 'i');
    editor.commands.insertContent('Y');
    expect(editor.getJSON().content.filter((node) => node.type === 'image')).toHaveLength(2);
  });

  it.each(['i', 'a', 'I', 'A'])(
    'enters Insert with a safe gap after an atom-only note via %s',
    (keyValue) => {
      const editor = open('<img src="https://images.example.test/only.png">');

      key(editor, keyValue);

      expect(vimMode(editor.state)).toBe('insert');
      expect(editor.state.selection).toBeInstanceOf(GapCursor);
      editor.commands.insertContent('X');
      expect(editor.getJSON().content.filter((node) => node.type === 'image')).toHaveLength(1);
      expect(editor.getText()).toContain('X');
    },
  );

  it('marks every mode and motion transaction as selection-only and outside document history', () => {
    const editor = open();
    const transactions: { readonly docChanged: boolean; readonly addToHistory: unknown }[] = [];
    editor.on('transaction', ({ transaction }) => {
      transactions.push({
        docChanged: transaction.docChanged,
        addToHistory: transaction.getMeta('addToHistory') as unknown,
      });
    });

    for (const keyValue of ['l', 'w', '0', 'g', 'g', 'i', 'Escape']) {
      key(editor, keyValue);
    }

    expect(transactions.length).toBeGreaterThan(0);
    expect(transactions.every((transaction) => !transaction.docChanged)).toBe(true);
    expect(transactions.every((transaction) => transaction.addToHistory === false)).toBe(true);
  });

  it('blocks every external mutation entry in Normal but leaves Insert and internal moves unchanged', () => {
    const editor = open('<p>Text</p>');
    const plugin = vimPlugin(editor);
    const { props } = plugin;
    const normalInput = new InputEvent('beforeinput', {
      inputType: 'insertText',
      data: 'x',
      bubbles: true,
      cancelable: true,
    });
    const normalCut = new Event('cut', { bubbles: true, cancelable: true });
    editor.view.dom.dispatchEvent(normalInput);
    editor.view.dom.dispatchEvent(normalCut);
    expect(normalInput.defaultPrevented).toBe(true);
    expect(normalCut.defaultPrevented).toBe(true);
    expect(props.handleTextInput?.call(plugin, editor.view, 1, 1, 'x', () => editor.state.tr)).toBe(
      true,
    );
    expect(
      props.handlePaste?.call(
        plugin,
        editor.view,
        new Event('paste') as ClipboardEvent,
        Slice.empty,
      ),
    ).toBe(true);
    expect(
      props.handleDrop?.call(
        plugin,
        editor.view,
        new Event('drop') as DragEvent,
        Slice.empty,
        false,
      ),
    ).toBe(true);
    expect(
      props.handleDrop?.call(
        plugin,
        editor.view,
        new Event('drop') as DragEvent,
        Slice.empty,
        true,
      ),
    ).toBe(false);

    key(editor, 'i');
    const insertInput = new InputEvent('beforeinput', {
      inputType: 'insertText',
      data: 'x',
      bubbles: true,
      cancelable: true,
    });
    const insertCut = new Event('cut', { bubbles: true, cancelable: true });
    editor.view.dom.dispatchEvent(insertInput);
    editor.view.dom.dispatchEvent(insertCut);
    expect(insertInput.defaultPrevented).toBe(false);
    expect(insertCut.defaultPrevented).toBe(false);
    expect(props.handleTextInput?.call(plugin, editor.view, 1, 1, 'x', () => editor.state.tr)).toBe(
      false,
    );
    expect(
      props.handlePaste?.call(
        plugin,
        editor.view,
        new Event('paste') as ClipboardEvent,
        Slice.empty,
      ),
    ).toBe(false);
    expect(
      props.handleDrop?.call(
        plugin,
        editor.view,
        new Event('drop') as DragEvent,
        Slice.empty,
        false,
      ),
    ).toBe(false);
  });

  it('does not interpret Normal motions or Insert Escape while an IME composition is active', () => {
    const normalEditor = open('<p>Text</p>');
    normalEditor.commands.setTextSelection(3);
    normalEditor.view.dom.dispatchEvent(
      new CompositionEvent('compositionstart', { bubbles: true }),
    );

    expect(key(normalEditor, 'h').defaultPrevented).toBe(false);
    expect(vimMode(normalEditor.state)).toBe('normal');
    expect(normalEditor.state.selection.from).toBe(3);

    const insertEditor = open('<p>Text</p>');
    insertEditor.commands.setTextSelection(3);
    key(insertEditor, 'i');
    insertEditor.view.dom.dispatchEvent(
      new CompositionEvent('compositionstart', { bubbles: true }),
    );

    expect(key(insertEditor, 'Escape').defaultPrevented).toBe(false);
    expect(key(insertEditor, 'h').defaultPrevented).toBe(false);
    expect(vimMode(insertEditor.state)).toBe('insert');
    expect(insertEditor.state.selection.from).toBe(3);

    normalEditor.view.dom.dispatchEvent(new CompositionEvent('compositionend', { bubbles: true }));
    insertEditor.view.dom.dispatchEvent(new CompositionEvent('compositionend', { bubbles: true }));
  });

  it('keeps modal state independent in two editor panes', () => {
    const first = open('<p>First</p>');
    const second = open('<p>Second</p>');

    key(first, 'i');

    expect(vimMode(first.state)).toBe('insert');
    expect(vimMode(second.state)).toBe('normal');
  });

  it('falls through entirely when disabled', () => {
    const editor = open('<p>Text</p>');
    const before = editor.getJSON();
    setVimEnabled(editor.view, false);

    const event = key(editor, 'q');

    expect(event.defaultPrevented).toBe(false);
    expect(editor.getJSON()).toEqual(before);
  });

  it('does not claim modified application shortcuts', () => {
    const editor = open('<p>Text</p>');
    const event = key(editor, 'k', { ctrlKey: true });

    expect(event.defaultPrevented).toBe(false);
  });

  it('clears a pending g prefix on shortcuts, blur, and external selection changes', () => {
    const editor = open();
    editor.commands.setTextSelection(20);

    key(editor, 'g');
    key(editor, 'k', { ctrlKey: true });
    key(editor, 'g');
    expect(editor.state.selection.from).toBe(20);

    editor.view.dom.dispatchEvent(new FocusEvent('blur', { bubbles: true }));
    key(editor, 'g');
    expect(editor.state.selection.from).toBe(20);

    editor.commands.setTextSelection(21);
    key(editor, 'g');
    expect(editor.state.selection.from).toBe(21);
  });
});

function keys(editor: Editor, sequence: string): void {
  for (const keyValue of sequence) {
    key(editor, keyValue);
  }
}

function blocks(editor: Editor): string[] {
  const texts: string[] = [];
  editor.state.doc.descendants((node) => {
    if (!node.isTextblock) return true;
    texts.push(node.textContent);
    return false;
  });
  return texts;
}

/** An editor on the collaborative history the note uses, for `u` and Ctrl+R. */
async function openCollaborative(content: string): Promise<Editor> {
  const fragment = new Y.Doc().getXmlFragment('default');
  const editor = new Editor({
    element: document.createElement('div'),
    extensions: [...nixEditingExtensions, Gapcursor, VimMotions],
    onCreate: ({ editor: created }) => {
      created.registerPlugin(ySyncPlugin(fragment) as Plugin);
      created.registerPlugin(yUndoPlugin() as Plugin);
    },
  });
  editors.push(editor);
  // The binding renders the shared document on the next task; content set before then is lost.
  await new Promise((resolve) => setTimeout(resolve, 0));
  editor.commands.setContent(content);
  yUndoPluginKey.getState(editor.state)?.undoManager.clear();
  setVimEnabled(editor.view, true);
  return editor;
}

const THREE_LINES = '<p>alpha beta gamma</p><p>second line</p><p>third</p>';

describe('Vim basics lines and counts', () => {
  it('moves between text blocks with j and k, keeping the column where it fits', () => {
    const editor = open(THREE_LINES);
    editor.commands.setTextSelection(3);

    key(editor, 'j');
    expect(editor.state.selection.from).toBe(21);
    key(editor, 'j');
    expect(editor.state.selection.from).toBe(34);
    key(editor, 'k');
    key(editor, 'k');
    expect(editor.state.selection.from).toBe(3);

    key(editor, '$');
    key(editor, 'j');
    // "second line" is shorter; the cursor lands on its last character.
    expect(editor.state.selection.from).toBe(29);
  });

  it('repeats motions by a count, and treats 0 as a count digit only after another digit', () => {
    const editor = open(THREE_LINES);
    editor.commands.setTextSelection(1);

    keys(editor, '2w');
    expect(editor.state.selection.from).toBe(12);
    keys(editor, '0');
    expect(editor.state.selection.from).toBe(1);
    keys(editor, '3l');
    expect(editor.state.selection.from).toBe(4);
    keys(editor, '2j');
    expect(editor.state.selection.from).toBe(35);
    keys(editor, '10k');
    expect(editor.state.selection.from).toBe(4);
    keys(editor, '2G');
    expect(editor.state.selection.from).toBe(19);
  });

  it('abandons a half-typed command on Escape', () => {
    const editor = open(THREE_LINES);
    editor.commands.setTextSelection(1);

    key(editor, 'd');
    key(editor, 'Escape');
    key(editor, 'w');

    expect(blocks(editor)[0]).toBe('alpha beta gamma');
    expect(editor.state.selection.from).toBe(7);
  });
});

describe('Vim basics operators', () => {
  it.each([
    ['dw', 1, 'beta gamma', 1],
    ['de', 1, ' beta gamma', 1],
    ['d$', 7, 'alpha ', 6],
    ['D', 7, 'alpha ', 6],
    ['x', 1, 'lpha beta gamma', 1],
    ['3x', 1, 'ha beta gamma', 1],
    ['X', 3, 'apha beta gamma', 2],
    ['d2w', 1, 'gamma', 1],
    ['2dw', 1, 'gamma', 1],
    ['db', 7, 'beta gamma', 1],
    ['d0', 7, 'beta gamma', 1],
  ] as const)('%s at %i leaves "%s" with the cursor at %i', (sequence, at, text, cursor) => {
    const editor = open(THREE_LINES);
    editor.commands.setTextSelection(at);

    keys(editor, sequence);

    expect(blocks(editor)).toEqual([text, 'second line', 'third']);
    expect(editor.state.selection.from).toBe(cursor);
    expect(vimMode(editor.state)).toBe('normal');
  });

  it('stops dw at the end of the block instead of joining the next one', () => {
    const editor = open(THREE_LINES);
    editor.commands.setTextSelection(12);

    keys(editor, 'dw');

    expect(blocks(editor)).toEqual(['alpha beta ', 'second line', 'third']);
  });

  it('changes to the end of the word with cw and to the end of the block with C', () => {
    const change = open(THREE_LINES);
    change.commands.setTextSelection(1);
    keys(change, 'cw');
    expect(vimMode(change.state)).toBe('insert');
    expect(blocks(change)[0]).toBe(' beta gamma');
    expect(change.state.selection.from).toBe(1);

    const rest = open(THREE_LINES);
    rest.commands.setTextSelection(7);
    keys(rest, 'C');
    expect(vimMode(rest.state)).toBe('insert');
    expect(blocks(rest)[0]).toBe('alpha ');
    expect(rest.state.selection.from).toBe(7);
  });

  it('deletes whole lines with dd, counts and linewise motions', () => {
    const one = open(THREE_LINES);
    one.commands.setTextSelection(21);
    keys(one, 'dd');
    expect(blocks(one)).toEqual(['alpha beta gamma', 'third']);
    expect(one.state.selection.$head.parent.textContent).toBe('third');

    const two = open(THREE_LINES);
    two.commands.setTextSelection(3);
    keys(two, '2dd');
    expect(blocks(two)).toEqual(['third']);

    const down = open(THREE_LINES);
    down.commands.setTextSelection(3);
    keys(down, 'dj');
    expect(blocks(down)).toEqual(['third']);

    const toEnd = open(THREE_LINES);
    toEnd.commands.setTextSelection(21);
    keys(toEnd, 'dG');
    expect(blocks(toEnd)).toEqual(['alpha beta gamma']);
  });

  it('empties the only line rather than leaving a document the schema refuses', () => {
    const editor = open('<p>only</p>');
    editor.commands.setTextSelection(2);

    keys(editor, 'dd');

    expect(blocks(editor)).toEqual(['']);
  });

  it('empties a line with cc and keeps its block type', () => {
    const editor = open('<h2>Heading</h2><p>after</p>');
    editor.commands.setTextSelection(3);

    keys(editor, 'cc');

    expect(vimMode(editor.state)).toBe('insert');
    expect(editor.state.doc.firstChild?.type.name).toBe('heading');
    expect(blocks(editor)).toEqual(['', 'after']);
    expect(editor.state.selection.from).toBe(1);
  });

  it('removes lines in list items, taking the item with them', () => {
    const editor = open('<ul><li><p>one</p></li><li><p>two</p></li></ul><p>after</p>');
    editor.commands.setTextSelection(4);

    keys(editor, 'dd');

    expect(blocks(editor)).toEqual(['two', 'after']);
  });

  it('leaves a read-only note to the browser', () => {
    const editor = open(THREE_LINES);
    editor.setEditable(false);
    editor.commands.setTextSelection(1);
    const before = editor.getJSON();

    for (const keyValue of ['d', 'x', 'c', 'o', 'p']) {
      expect(key(editor, keyValue).defaultPrevented).toBe(false);
    }
    expect(vimMode(editor.state)).toBe('normal');
    expect(editor.getJSON()).toEqual(before);
  });
});

describe('Vim basics register', () => {
  it('pastes whole lines below and above with p and P', () => {
    const editor = open(THREE_LINES);
    editor.commands.setTextSelection(3);

    keys(editor, 'yy');
    expect(blocks(editor)).toEqual(['alpha beta gamma', 'second line', 'third']);
    keys(editor, 'j');
    keys(editor, 'p');
    expect(blocks(editor)).toEqual([
      'alpha beta gamma',
      'second line',
      'alpha beta gamma',
      'third',
    ]);
    expect(editor.state.selection.$head.parent.textContent).toBe('alpha beta gamma');
    expect(editor.state.selection.$head.index(0)).toBe(2);

    keys(editor, 'G');
    keys(editor, 'P');
    expect(blocks(editor)).toEqual([
      'alpha beta gamma',
      'second line',
      'alpha beta gamma',
      'alpha beta gamma',
      'third',
    ]);
  });

  it('pastes a deleted line back with its block type', () => {
    const editor = open('<h2>Heading</h2><p>body</p>');
    editor.commands.setTextSelection(2);

    keys(editor, 'dd');
    keys(editor, 'p');

    expect(editor.getJSON().content.map((node) => node.type)).toEqual(['paragraph', 'heading']);
    expect(blocks(editor)).toEqual(['body', 'Heading']);
  });

  it('pastes characters after the cursor with p, before it with P, and keeps formatting', () => {
    const editor = open('<p><strong>bold</strong> plain</p>');
    editor.commands.setTextSelection(1);

    keys(editor, 'yw');
    expect(editor.state.selection.from).toBe(1);
    keys(editor, '$');
    keys(editor, 'p');
    expect(blocks(editor)).toEqual(['bold plainbold ']);
    // The cursor rests on the last pasted character.
    expect(editor.state.selection.from).toBe(15);
    // "bold " pastes back as a bold word and a plain space.
    const line = editor.state.doc.firstChild;
    const pasted = line?.child(line.childCount - 2);
    expect(pasted?.text).toBe('bold');
    expect(pasted?.marks.map((mark) => mark.type.name)).toEqual(['bold']);

    keys(editor, '0');
    keys(editor, '2P');
    expect(blocks(editor)).toEqual(['bold bold bold plainbold ']);
  });
});

describe('Vim basics opening lines', () => {
  it('opens an empty line below with o and above with O, in Insert', () => {
    const below = open(THREE_LINES);
    below.commands.setTextSelection(3);
    key(below, 'o');
    expect(vimMode(below.state)).toBe('insert');
    expect(blocks(below)).toEqual(['alpha beta gamma', '', 'second line', 'third']);
    expect(below.state.selection.$head.index(0)).toBe(1);

    const above = open(THREE_LINES);
    above.commands.setTextSelection(21);
    key(above, 'O');
    expect(vimMode(above.state)).toBe('insert');
    expect(blocks(above)).toEqual(['alpha beta gamma', '', 'second line', 'third']);
    expect(above.state.selection.$head.index(0)).toBe(1);
  });

  it('opens a new list item inside a list', () => {
    const editor = open('<ul><li><p>one</p></li></ul>');
    editor.commands.setTextSelection(4);

    key(editor, 'o');

    expect(editor.state.doc.firstChild?.childCount).toBe(2);
    expect(blocks(editor)).toEqual(['one', '']);
  });
});

describe('Vim basics Visual mode', () => {
  it('selects characters inclusively and deletes them with d', () => {
    const editor = open(THREE_LINES);
    editor.commands.setTextSelection(1);

    key(editor, 'v');
    expect(vimMode(editor.state)).toBe('visual');
    expect(editor.state.selection.from).toBe(1);
    expect(editor.state.selection.to).toBe(2);
    key(editor, 'e');
    expect(editor.state.selection.to).toBe(6);

    key(editor, 'd');
    expect(vimMode(editor.state)).toBe('normal');
    expect(blocks(editor)[0]).toBe(' beta gamma');
  });

  it('extends backwards from the anchor and yanks without editing', () => {
    const editor = open(THREE_LINES);
    editor.commands.setTextSelection(10);

    key(editor, 'v');
    key(editor, 'b');
    expect(editor.state.selection.from).toBe(7);
    expect(editor.state.selection.to).toBe(11);

    key(editor, 'y');
    expect(vimMode(editor.state)).toBe('normal');
    expect(editor.state.selection.from).toBe(7);
    keys(editor, '$p');
    expect(blocks(editor)[0]).toBe('alpha beta gammabeta');
  });

  it('takes whole lines in Visual Line mode', () => {
    const editor = open(THREE_LINES);
    editor.commands.setTextSelection(3);

    key(editor, 'V');
    expect(vimMode(editor.state)).toBe('visual-line');
    expect(editor.state.selection.from).toBe(1);
    expect(editor.state.selection.to).toBe(17);
    key(editor, 'j');
    expect(editor.state.selection.to).toBe(30);

    key(editor, 'd');
    expect(blocks(editor)).toEqual(['third']);
  });

  it('changes a selection with c, and leaves Visual on Escape, v, or a click', () => {
    const change = open(THREE_LINES);
    change.commands.setTextSelection(7);
    keys(change, 'vec');
    expect(vimMode(change.state)).toBe('insert');
    expect(blocks(change)[0]).toBe('alpha  gamma');

    const escape = open(THREE_LINES);
    escape.commands.setTextSelection(1);
    keys(escape, 'vw');
    key(escape, 'Escape');
    expect(vimMode(escape.state)).toBe('normal');
    expect(escape.state.selection.empty).toBe(true);
    expect(escape.state.selection.from).toBe(7);

    const toggle = open(THREE_LINES);
    keys(toggle, 'vv');
    expect(vimMode(toggle.state)).toBe('normal');

    const click = open(THREE_LINES);
    keys(click, 'vw');
    click.commands.setTextSelection(20);
    expect(vimMode(click.state)).toBe('normal');
  });

  it('blocks typing in Visual mode', () => {
    const editor = open(THREE_LINES);
    const before = editor.getJSON();

    key(editor, 'v');
    for (const keyValue of ['q', 'Backspace', 'Enter']) {
      expect(key(editor, keyValue).defaultPrevented).toBe(true);
    }

    expect(editor.getJSON()).toEqual(before);
  });
});

describe('Vim basics history and display', () => {
  it('undoes with u and redoes with Ctrl+R on the collaborative history', async () => {
    const editor = await openCollaborative(THREE_LINES);
    editor.commands.setTextSelection(1);

    keys(editor, 'dw');
    expect(blocks(editor)[0]).toBe('beta gamma');

    key(editor, 'u');
    expect(blocks(editor)[0]).toBe('alpha beta gamma');
    expect(vimMode(editor.state)).toBe('normal');

    const redoKey = key(editor, 'r', { ctrlKey: true });
    // Claimed, so Windows and Linux never reload the page instead.
    expect(redoKey.defaultPrevented).toBe(true);
    expect(blocks(editor)[0]).toBe('beta gamma');
  });

  it('draws a block cursor on the character in Normal mode only', () => {
    const editor = open('<p>abc</p><p></p>');
    editor.commands.setTextSelection(2);

    const cursor = editor.view.dom.querySelector('.nix-vim-cursor');
    expect(cursor?.textContent).toBe('b');
    expect(editor.view.dom.classList.contains('nix-vim-command')).toBe(true);

    key(editor, 'j');
    expect(editor.view.dom.querySelector('.nix-vim-cursor')?.getAttribute('aria-hidden')).toBe(
      'true',
    );

    key(editor, 'i');
    expect(editor.view.dom.querySelector('.nix-vim-cursor')).toBeNull();
    expect(editor.view.dom.classList.contains('nix-vim-command')).toBe(false);
  });

  it('names Visual Line mode for the status line', () => {
    expect(vimModeLabel('visual-line')).toBe('visual line');
    expect(vimModeLabel('normal')).toBe('normal');
  });
});

/** Types into Insert mode as a person would: the key goes to the editor, then the text lands. */
function type(editor: Editor, text: string): void {
  for (const char of text) {
    if (!key(editor, char).defaultPrevented) {
      editor.view.dispatch(editor.state.tr.insertText(char));
    }
  }
}

/** Opens the `:`, `/` or `?` command line, types `line` and presses Enter. */
function commandLine(editor: Editor, opener: ':' | '/' | '?', line: string): void {
  key(editor, opener);
  keys(editor, line);
  key(editor, 'Enter');
}

function status(editor: Editor) {
  const value = vimStatus(editor.state);
  if (value === null) throw new Error('Vim basics is off.');
  return value;
}

describe('Vim text objects', () => {
  it.each([
    ['diw', 9, 'alpha  gamma', 7],
    ['daw', 9, 'alpha gamma', 7],
    ['daw', 14, 'alpha beta', 10],
    ['diw', 6, 'alphabeta gamma', 6],
  ] as const)('%s at %i leaves "%s"', (sequence, at, text, cursor) => {
    const editor = open(THREE_LINES);
    editor.commands.setTextSelection(at);

    keys(editor, sequence);

    expect(blocks(editor)[0]).toBe(text);
    expect(editor.state.selection.from).toBe(cursor);
    expect(vimMode(editor.state)).toBe('normal');
  });

  it('changes a word with ciw and leaves Insert at its place', () => {
    const editor = open(THREE_LINES);
    editor.commands.setTextSelection(2);

    keys(editor, 'ciw');

    expect(blocks(editor)[0]).toBe(' beta gamma');
    expect(vimMode(editor.state)).toBe('insert');
    expect(editor.state.selection.from).toBe(1);
  });

  it.each([
    ['di"', 8, 'say "" now'],
    ['da"', 8, 'say now'],
    ['ci"', 1, 'say "" now'],
  ] as const)('%s at %i in a quoted string leaves "%s"', (sequence, at, text) => {
    const editor = open('<p>say "hello there" now</p>');
    editor.commands.setTextSelection(at);

    keys(editor, sequence);

    expect(blocks(editor)[0]).toBe(text);
  });

  it.each([
    ['di(', 3, 'f() end'],
    ['dib', 3, 'f() end'],
    ['di(', 7, 'f(a, (), c) end'],
    ['da)', 12, 'f end'],
    ['di(', 15, 'f(a, (b), c) end'],
  ] as const)('%s at %i matches nested brackets and leaves "%s"', (sequence, at, text) => {
    const editor = open('<p>f(a, (b), c) end</p>');
    editor.commands.setTextSelection(at);

    keys(editor, sequence);

    expect(blocks(editor)[0]).toBe(text);
  });

  it('takes paragraphs of non-empty blocks with ip and ap', () => {
    const inner = open('<p>one</p><p>two</p><p></p><p>three</p>');
    inner.commands.setTextSelection(7);
    keys(inner, 'dip');
    expect(blocks(inner)).toEqual(['', 'three']);

    const around = open('<p>one</p><p>two</p><p></p><p>three</p>');
    around.commands.setTextSelection(7);
    keys(around, 'dap');
    expect(blocks(around)).toEqual(['three']);
  });

  it('selects a text object in Visual mode', () => {
    const word = open(THREE_LINES);
    word.commands.setTextSelection(9);
    keys(word, 'viw');
    expect(vimMode(word.state)).toBe('visual');
    expect(word.state.doc.textBetween(word.state.selection.from, word.state.selection.to)).toBe(
      'beta',
    );
    key(word, 'd');
    expect(blocks(word)[0]).toBe('alpha  gamma');

    const paragraph = open('<p>one</p><p>two</p><p></p><p>three</p>');
    paragraph.commands.setTextSelection(2);
    keys(paragraph, 'vip');
    expect(vimMode(paragraph.state)).toBe('visual-line');
  });
});

describe('Vim finds and paragraph motions', () => {
  it('finds a character with f, t, F and T, and repeats with ; and ,', () => {
    const editor = open('<p>a,b,c,d</p>');
    editor.commands.setTextSelection(1);

    keys(editor, 'f,');
    expect(editor.state.selection.from).toBe(2);
    key(editor, ';');
    expect(editor.state.selection.from).toBe(4);
    key(editor, ',');
    expect(editor.state.selection.from).toBe(2);
    keys(editor, 't,');
    expect(editor.state.selection.from).toBe(3);
    // A repeated t moves past the character it already stands before.
    key(editor, ';');
    expect(editor.state.selection.from).toBe(5);
    keys(editor, '$F,');
    expect(editor.state.selection.from).toBe(6);
    keys(editor, 'T,');
    expect(editor.state.selection.from).toBe(5);
    keys(editor, 'fz');
    expect(editor.state.selection.from).toBe(5);
  });

  it.each([
    ['df,', 1, 'b,c,d'],
    ['dt,', 1, ',b,c,d'],
    ['d2f,', 1, 'c,d'],
    ['dF,', 5, 'a,bc,d'],
  ] as const)('%s at %i leaves "%s"', (sequence, at, text) => {
    const editor = open('<p>a,b,c,d</p>');
    editor.commands.setTextSelection(at);

    keys(editor, sequence);

    expect(blocks(editor)[0]).toBe(text);
  });

  it('moves between empty blocks with } and {, stopping at the document edges', () => {
    const editor = open('<p>one</p><p>two</p><p></p><p>three</p><p>four</p>');
    editor.commands.setTextSelection(1);

    key(editor, '}');
    expect(editor.state.selection.from).toBe(11);
    key(editor, '}');
    expect(editor.state.selection.from).toBe(23);
    key(editor, '{');
    expect(editor.state.selection.from).toBe(11);
    key(editor, '{');
    expect(editor.state.selection.from).toBe(1);
  });

  it('stops { on an empty block straight before the cursor', () => {
    const editor = open('<p>one</p><p></p><p>three</p>');
    editor.commands.setTextSelection(9);

    key(editor, '{');

    expect(editor.state.selection.from).toBe(6);
  });

  it('deletes whole lines with d} from a line start, and to the paragraph end from inside one', () => {
    const lines = open('<p>one</p><p>two</p><p></p><p>three</p><p>four</p>');
    lines.commands.setTextSelection(1);
    keys(lines, 'd}');
    expect(blocks(lines)).toEqual(['', 'three', 'four']);

    const rest = open('<p>one</p><p>two</p><p></p><p>three</p><p>four</p>');
    rest.commands.setTextSelection(2);
    keys(rest, 'd}');
    expect(blocks(rest)).toEqual(['o', '', 'three', 'four']);
  });
});

describe('Vim single-key edits', () => {
  it('replaces characters with r, refusing a count longer than the block', () => {
    const editor = open(THREE_LINES);
    editor.commands.setTextSelection(1);

    keys(editor, 'rx');
    expect(blocks(editor)[0]).toBe('xlpha beta gamma');
    expect(editor.state.selection.from).toBe(1);
    keys(editor, '3rz');
    expect(blocks(editor)[0]).toBe('zzzha beta gamma');
    expect(editor.state.selection.from).toBe(3);
    keys(editor, '99rq');
    expect(blocks(editor)[0]).toBe('zzzha beta gamma');
  });

  it('toggles case with ~ and moves on, keeping formatting', () => {
    const editor = open('<p><strong>ab</strong>cd</p>');
    editor.commands.setTextSelection(1);

    keys(editor, '3~');

    expect(blocks(editor)[0]).toBe('ABCd');
    expect(editor.state.selection.from).toBe(4);
    expect(editor.state.doc.firstChild?.firstChild?.marks.map((mark) => mark.type.name)).toEqual([
      'bold',
    ]);
  });

  it('joins lines with J and a count, with one space at the join', () => {
    const one = open(THREE_LINES);
    one.commands.setTextSelection(3);
    key(one, 'J');
    expect(blocks(one)).toEqual(['alpha beta gamma second line', 'third']);
    expect(one.state.selection.from).toBe(17);

    const all = open(THREE_LINES);
    all.commands.setTextSelection(3);
    keys(all, '3J');
    expect(blocks(all)).toEqual(['alpha beta gamma second line third']);

    const last = open(THREE_LINES);
    last.commands.setTextSelection(33);
    key(last, 'J');
    expect(blocks(last)).toEqual(['alpha beta gamma', 'second line', 'third']);
  });

  it('substitutes with s and S, and yanks a line with Y', () => {
    const character = open(THREE_LINES);
    character.commands.setTextSelection(1);
    key(character, 's');
    expect(blocks(character)[0]).toBe('lpha beta gamma');
    expect(vimMode(character.state)).toBe('insert');

    const line = open(THREE_LINES);
    line.commands.setTextSelection(3);
    key(line, 'S');
    expect(blocks(line)).toEqual(['', 'second line', 'third']);
    expect(vimMode(line.state)).toBe('insert');

    const yank = open(THREE_LINES);
    yank.commands.setTextSelection(3);
    keys(yank, 'Yp');
    expect(blocks(yank)).toEqual(['alpha beta gamma', 'alpha beta gamma', 'second line', 'third']);
  });

  it('indents and outdents list items with >> and <<, never out of the list', () => {
    const editor = open('<ul><li><p>One</p></li><li><p>Two</p></li></ul>');
    let two = 0;
    editor.state.doc.descendants((node, pos) => {
      if (node.isTextblock && node.textContent === 'Two') two = pos + 1;
    });
    editor.commands.setTextSelection(two);
    const depth = editor.state.selection.$head.depth;

    keys(editor, '>>');
    expect(editor.state.selection.$head.depth).toBe(depth + 2);
    expect(editor.state.selection.$head.parent.textContent).toBe('Two');
    keys(editor, '<<');
    expect(editor.state.selection.$head.depth).toBe(depth);
    keys(editor, '<<');
    expect(editor.state.selection.$head.depth).toBe(depth);

    const paragraph = open(THREE_LINES);
    keys(paragraph, '>>');
    expect(status(paragraph).message).toBe('Only list items indent');
  });
});

describe('Vim search', () => {
  it('searches forward with / and back with ?, repeating with n and N', () => {
    const editor = open(THREE_LINES);
    editor.commands.setTextSelection(1);

    key(editor, '/');
    keys(editor, 'a');
    expect(status(editor).keys).toBe('/a');
    key(editor, 'Enter');
    expect(editor.state.selection.from).toBe(5);
    key(editor, 'n');
    expect(editor.state.selection.from).toBe(10);
    key(editor, 'N');
    expect(editor.state.selection.from).toBe(5);

    editor.commands.setTextSelection(19);
    commandLine(editor, '?', 'alpha');
    expect(editor.state.selection.from).toBe(1);
  });

  it('wraps around the document, says so, and reports a missing match', () => {
    const editor = open(THREE_LINES);
    editor.commands.setTextSelection(13);

    commandLine(editor, '/', 'alpha');
    expect(editor.state.selection.from).toBe(1);
    expect(status(editor).message).toBe('Search hit the bottom, continuing at the top');

    commandLine(editor, '/', 'zzz');
    expect(editor.state.selection.from).toBe(1);
    expect(status(editor).message).toBe('Pattern not found: zzz');
  });

  it('ignores case unless the pattern has a capital', () => {
    const editor = open('<p>Alpha alpha</p>');
    editor.commands.setTextSelection(3);

    commandLine(editor, '/', 'ALPHA');
    expect(status(editor).message).toBe('Pattern not found: ALPHA');
    commandLine(editor, '/', 'alpha');
    expect(editor.state.selection.from).toBe(7);
  });

  it('takes a search as an operator motion', () => {
    const editor = open(THREE_LINES);
    editor.commands.setTextSelection(1);

    key(editor, 'd');
    commandLine(editor, '/', 'gam');

    expect(blocks(editor)[0]).toBe('gamma');
  });

  it('edits the command line with Backspace and abandons it with Escape', () => {
    const editor = open(THREE_LINES);
    editor.commands.setTextSelection(1);

    keys(editor, '/x');
    key(editor, 'Backspace');
    expect(status(editor).keys).toBe('/');
    key(editor, 'Backspace');
    expect(status(editor).keys).toBe('');
    keys(editor, '/beta');
    key(editor, 'Escape');
    expect(status(editor).keys).toBe('');
    expect(editor.state.selection.from).toBe(1);
  });
});

describe('Vim marks', () => {
  it("jumps to a mark exactly with ` and to its line with ', and back with ``", () => {
    const editor = open(THREE_LINES);
    editor.commands.setTextSelection(23);

    keys(editor, 'magg');
    expect(editor.state.selection.from).toBe(1);
    keys(editor, '`a');
    expect(editor.state.selection.from).toBe(23);
    keys(editor, "'a");
    expect(editor.state.selection.from).toBe(19);
    keys(editor, '``');
    expect(editor.state.selection.from).toBe(23);
    keys(editor, "'z");
    expect(status(editor).message).toBe('Mark not set');
  });

  it('uses a mark as an operator motion', () => {
    const editor = open(THREE_LINES);
    editor.commands.setTextSelection(23);

    keys(editor, 'ma');
    editor.commands.setTextSelection(1);
    keys(editor, 'd`a');

    expect(blocks(editor)).toEqual(['nd line', 'third']);
  });

  it('keeps a mark on its text through a collaborative undo', async () => {
    const editor = await openCollaborative(THREE_LINES);
    editor.commands.setTextSelection(34);

    keys(editor, 'maggdd');
    expect(blocks(editor)).toEqual(['second line', 'third']);
    key(editor, 'u');
    expect(blocks(editor)).toEqual(['alpha beta gamma', 'second line', 'third']);
    keys(editor, 'gg`a');

    expect(editor.state.selection.$head.parent.textContent).toBe('third');
    expect(editor.state.selection.$head.parentOffset).toBe(2);
  });
});

describe('Vim registers', () => {
  it('yanks into a named register and pastes from it', () => {
    const editor = open(THREE_LINES);
    editor.commands.setTextSelection(1);

    keys(editor, '"ayyjyy"ap');

    expect(blocks(editor)).toEqual([
      'alpha beta gamma',
      'second line',
      'alpha beta gamma',
      'third',
    ]);
  });

  it('keeps the unnamed register through the black hole, and the last yank in "0', () => {
    const blackHole = open(THREE_LINES);
    blackHole.commands.setTextSelection(1);
    keys(blackHole, 'yyj"_ddp');
    expect(blocks(blackHole)).toEqual(['alpha beta gamma', 'third', 'alpha beta gamma']);

    const yanked = open(THREE_LINES);
    yanked.commands.setTextSelection(1);
    keys(yanked, 'yyjdd"0p');
    expect(blocks(yanked)).toEqual(['alpha beta gamma', 'third', 'alpha beta gamma']);
  });

  it('yanks to and pastes from the system clipboard with "+', async () => {
    const writeText = vi.fn(() => Promise.resolve());
    const readText = vi.fn(() => Promise.resolve('XY'));
    const original = Object.getOwnPropertyDescriptor(navigator, 'clipboard');
    Object.defineProperty(navigator, 'clipboard', {
      value: { writeText, readText },
      configurable: true,
    });
    try {
      const editor = open(THREE_LINES);
      editor.commands.setTextSelection(1);

      keys(editor, '"+yiw');
      expect(writeText).toHaveBeenCalledWith('alpha');
      keys(editor, '"+P');
      await vi.waitFor(() => {
        expect(blocks(editor)[0]).toBe('XYalpha beta gamma');
      });
    } finally {
      if (original === undefined) Reflect.deleteProperty(navigator, 'clipboard');
      else Object.defineProperty(navigator, 'clipboard', original);
    }
  });
});

describe('Vim repeat', () => {
  it('repeats a delete with .', () => {
    const editor = open(THREE_LINES);
    editor.commands.setTextSelection(1);

    keys(editor, 'dw.');

    expect(blocks(editor)[0]).toBe('gamma');
  });

  it('repeats a change with the text typed in its Insert', () => {
    const editor = open(THREE_LINES);
    editor.commands.setTextSelection(1);

    keys(editor, 'ciw');
    type(editor, 'one');
    key(editor, 'Escape');
    keys(editor, 'w.');

    expect(blocks(editor)[0]).toBe('one one gamma');
    expect(vimMode(editor.state)).toBe('normal');
  });

  it('replaces the original count with a new one', () => {
    const editor = open(THREE_LINES);
    editor.commands.setTextSelection(1);

    keys(editor, 'x3.');

    expect(blocks(editor)[0]).toBe('a beta gamma');
  });

  it('repeats an append and an opened line', () => {
    const append = open(THREE_LINES);
    append.commands.setTextSelection(1);
    key(append, 'A');
    type(append, '!');
    key(append, 'Escape');
    keys(append, 'j.');
    expect(blocks(append)).toEqual(['alpha beta gamma!', 'second line!', 'third']);

    const opened = open(THREE_LINES);
    opened.commands.setTextSelection(1);
    key(opened, 'o');
    type(opened, 'new');
    key(opened, 'Escape');
    keys(opened, 'j.');
    expect(blocks(opened)).toEqual(['alpha beta gamma', 'new', 'second line', 'new', 'third']);
  });
});

describe('Vim macros', () => {
  function recordSemicolons(editor: Editor): void {
    editor.commands.setTextSelection(1);
    keys(editor, 'qa');
    expect(status(editor).recording).toBe('a');
    key(editor, 'A');
    type(editor, ';');
    key(editor, 'Escape');
    keys(editor, 'jq');
    expect(status(editor).recording).toBeNull();
  }

  it('records keys with q and replays them with @ and @@', () => {
    const editor = open(THREE_LINES);
    recordSemicolons(editor);
    expect(blocks(editor)[0]).toBe('alpha beta gamma;');

    keys(editor, '@a');
    expect(blocks(editor)[1]).toBe('second line;');
    keys(editor, '@@');
    expect(blocks(editor)).toEqual(['alpha beta gamma;', 'second line;', 'third;']);
  });

  it('ends a counted replay at the first key that fails', () => {
    const editor = open(THREE_LINES);
    recordSemicolons(editor);

    keys(editor, '10@a');

    expect(blocks(editor)).toEqual(['alpha beta gamma;', 'second line;', 'third;']);
  });

  it('stops a macro that runs itself', () => {
    const editor = open(THREE_LINES);
    editor.commands.setTextSelection(1);
    keys(editor, 'qbx@bq');

    keys(editor, '@b');

    expect(blocks(editor)[0]).toMatch(/^.{0,14}$/);
  });
});

describe('Vim : commands', () => {
  it('goes to a line by number', () => {
    const editor = open(THREE_LINES);
    commandLine(editor, ':', '2');
    expect(editor.state.selection.from).toBe(19);
  });

  it('substitutes on the line, over the document, and over the Visual lines', () => {
    const line = open(THREE_LINES);
    line.commands.setTextSelection(1);
    commandLine(line, ':', 's/a/A/');
    expect(blocks(line)[0]).toBe('Alpha beta gamma');

    const all = open(THREE_LINES);
    commandLine(all, ':', '%s/e/E/g');
    expect(blocks(all)).toEqual(['alpha bEta gamma', 'sEcond linE', 'third']);
    expect(status(all).message).toBe('3 substitutions on 2 lines');

    const visual = open(THREE_LINES);
    visual.commands.setTextSelection(1);
    keys(visual, 'Vj:');
    expect(status(visual).keys).toBe(":'<,'>");
    keys(visual, 's/^/> /');
    key(visual, 'Enter');
    expect(blocks(visual)).toEqual(['> alpha beta gamma', '> second line', 'third']);
  });

  it('expands & and groups in the replacement', () => {
    const editor = open(THREE_LINES);
    editor.commands.setTextSelection(1);
    commandLine(editor, ':', 's/(al)pha/\\1-&/');
    expect(blocks(editor)[0]).toBe('al-alpha beta gamma');
  });

  it('answers :w and names a command it does not know', () => {
    const editor = open(THREE_LINES);
    const before = editor.getJSON();

    commandLine(editor, ':', 'w');
    expect(status(editor).message).toBe('Notes save as you type');
    commandLine(editor, ':', 'foo');
    expect(status(editor).message).toBe('Not an editor command: foo');
    expect(editor.getJSON()).toEqual(before);
  });
});
