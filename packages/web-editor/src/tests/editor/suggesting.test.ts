import { nixEditingExtensions } from '@nix/editor-schema';
import { Editor } from '@tiptap/core';
import { afterEach, describe, expect, it } from 'vitest';
import { ySyncPluginKey } from 'y-prosemirror';

import {
  Suggesting,
  hasSuggestions,
  listSuggestions,
  type SuggestionEntry,
  setSuggesting,
} from '../../editor/suggesting';

/** A real editor with suggesting on: P1 "Hello world" spans 1..12, P2 "Second" spans 14..20. */
let editor: Editor | null = null;

function makeEditor(content = '<p>Hello world</p><p>Second</p>', author = 'me'): Editor {
  const element = document.createElement('div');
  document.body.append(element);
  const created = new Editor({
    element,
    extensions: [...nixEditingExtensions, Suggesting],
    content,
  });
  setSuggesting(created, { enabled: true, authorId: author });
  editor = created;
  return created;
}

afterEach(() => {
  editor?.destroy();
  editor = null;
  document.body.replaceChildren();
});

/** The text with marks shown as `[+inserted]` and `[-deleted]`. */
function show(target: Editor): string {
  const parts: string[] = [];
  target.state.doc.forEach((block) => {
    let line = '';
    block.forEach((child) => {
      const names = child.marks.map((mark) => mark.type.name);
      const text = child.text ?? '';
      line += names.includes('suggestionInsert')
        ? `[+${text}]`
        : names.includes('suggestionDelete')
          ? `[-${text}]`
          : text;
    });
    const op = (block.attrs.suggestion as { op?: string } | null)?.op;
    parts.push(op === undefined ? line : `${op}:${line}`);
  });
  return parts.join(' | ');
}

function type(target: Editor, at: number, text: string): void {
  target.view.dispatch(target.state.tr.insertText(text, at));
}

function remove(target: Editor, from: number, to: number): void {
  target.view.dispatch(target.state.tr.delete(from, to));
}

function only(target: Editor): SuggestionEntry {
  const [entry] = listSuggestions(target.state.doc);
  if (entry === undefined) throw new Error('Expected one suggestion.');
  return entry;
}

/** The marks on the first run of text in the first block. */
function firstMarks(target: Editor): string[] {
  return target.state.doc.firstChild?.firstChild?.marks.map((mark) => mark.type.name) ?? [];
}

describe('inline text', () => {
  it('marks typed text as an insert and extends it while typing', () => {
    const target = makeEditor();
    type(target, 6, 'ab');
    type(target, 8, 'c');
    expect(show(target)).toBe('Hello[+abc] world | Second');
    expect(listSuggestions(target.state.doc)).toHaveLength(1);
  });

  it('keeps deleted text, struck, instead of removing it', () => {
    const target = makeEditor();
    remove(target, 1, 6);
    expect(show(target)).toBe('[-Hello] world | Second');
  });

  it('puts the caret before the struck text after a backspace', () => {
    const target = makeEditor();
    target.commands.setTextSelection(6);
    target.view.someProp('handleKeyDown', (handler) =>
      handler(target.view, new KeyboardEvent('keydown', { key: 'Backspace' })),
    );
    remove(target, 5, 6);
    expect(show(target)).toBe('Hell[-o] world | Second');
    expect(target.state.selection.from).toBe(5);
  });

  it('really deletes text the same author suggested', () => {
    const target = makeEditor();
    type(target, 6, 'abc');
    remove(target, 7, 9);
    expect(show(target)).toBe('Hello[+a] world | Second');
  });

  it('strikes a replaced selection and inserts the new text after it', () => {
    const target = makeEditor();
    target.view.dispatch(target.state.tr.insertText('Howdy', 1, 6));
    expect(show(target)).toBe('[-Hello][+Howdy] world | Second');
  });

  it('stamps the author on a suggestion', () => {
    const target = makeEditor(undefined, 'ada');
    type(target, 6, 'x');
    expect(only(target)).toMatchObject({
      authorId: 'ada',
      kind: 'insert',
      excerpt: 'x',
    });
  });
});

describe('formatting', () => {
  it('keeps the first marks through repeated changes and restores them on reject', () => {
    const target = makeEditor('<p><em>Hello</em> world</p>');
    target.chain().setTextSelection({ from: 1, to: 6 }).toggleBold().run();
    target.chain().setTextSelection({ from: 1, to: 6 }).toggleItalic().run();
    const entry = only(target);
    expect(entry.kind).toBe('format');
    target.commands.rejectSuggestion(entry.id);
    expect(firstMarks(target)).toEqual(['italic']);
    expect(hasSuggestions(target.state.doc)).toBe(false);
  });

  it('accepting a format change keeps the new formatting and drops the record', () => {
    const target = makeEditor();
    target.chain().setTextSelection({ from: 1, to: 6 }).toggleBold().run();
    target.commands.acceptAllSuggestions();
    expect(firstMarks(target)).toEqual(['bold']);
  });
});

describe('blocks', () => {
  it('marks a split as an inserted block, and reject joins it back', () => {
    const target = makeEditor();
    target.commands.setTextSelection(6);
    target.commands.splitBlock();
    expect(show(target)).toBe('Hello | insert: world | Second');
    target.commands.rejectAllSuggestions();
    expect(show(target)).toBe('Hello world | Second');
  });

  it('does nothing for a backspace that only joins two blocks', () => {
    const target = makeEditor();
    remove(target, 12, 14);
    expect(show(target)).toBe('Hello world | Second');
  });

  it('keeps blocks a delete spans, and accept joins the edges', () => {
    const target = makeEditor('<p>One two</p><p>Middle</p><p>Three four</p>');
    // From inside the first block to inside the last.
    remove(target, 5, 24);
    expect(show(target)).toBe('One [-two] | delete:[-Middle] | [-Three ]four');
    target.commands.acceptAllSuggestions();
    expect(show(target)).toBe('One four');
  });

  it('reject restores a delete that spanned blocks', () => {
    const target = makeEditor('<p>One two</p><p>Middle</p><p>Three four</p>');
    remove(target, 5, 24);
    target.commands.rejectAllSuggestions();
    expect(show(target)).toBe('One two | Middle | Three four');
  });

  it('turns a list wrap into a restructure that reject undoes', () => {
    const target = makeEditor();
    target.commands.setTextSelection(3);
    target.commands.toggleBulletList();
    const entry = only(target);
    expect(entry.kind).toBe('block');
    expect(target.state.doc.firstChild?.type.name).toBe('bulletList');
    target.commands.rejectSuggestion(entry.id);
    expect(target.state.doc.firstChild?.type.name).toBe('paragraph');
    expect(show(target)).toBe('Hello world | Second');
  });
});

describe('when it stays out of the way', () => {
  it('does not rewrite remote or undo transactions', () => {
    const target = makeEditor();
    target.view.dispatch(target.state.tr.insertText('remote', 6).setMeta(ySyncPluginKey, {}));
    expect(show(target)).toBe('Helloremote world | Second');
  });

  it('does nothing while the mode is off', () => {
    const target = makeEditor();
    setSuggesting(target, { enabled: false, authorId: 'me' });
    type(target, 6, 'x');
    remove(target, 1, 3);
    expect(hasSuggestions(target.state.doc)).toBe(false);
  });

  it('writes the edit and its bookkeeping in one update', () => {
    const target = makeEditor();
    const seen: string[] = [];
    target.on('update', () => seen.push(show(target)));
    type(target, 6, 'ab');
    expect(seen).toEqual(['Hello[+ab] world | Second']);
  });
});

describe('listSuggestions', () => {
  it('reports each suggestion once with its kind, range and excerpt', () => {
    const target = makeEditor();
    type(target, 6, 'ab');
    remove(target, 16, 22);
    const entries = listSuggestions(target.state.doc);
    expect(entries.map((entry) => [entry.kind, entry.excerpt])).toEqual([
      ['insert', 'ab'],
      ['delete', 'Second'],
    ]);
    expect(entries.map((entry) => [entry.from, entry.to])).toEqual([
      [6, 8],
      [16, 22],
    ]);
  });
});
