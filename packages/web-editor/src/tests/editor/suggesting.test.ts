import { nixEditingExtensions, rejectAllSuggestions } from '@nix/editor-schema';
import { Editor } from '@tiptap/core';
import { DOMParser as ProseDOMParser, Slice } from '@tiptap/pm/model';
import { TextSelection } from '@tiptap/pm/state';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { ySyncPluginKey } from 'y-prosemirror';

import {
  Suggesting,
  hasSuggestions,
  listSuggestions,
  type SuggestionEntry,
  setSuggesting,
  suggestionIdsAt,
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

/** The textblocks' text, one per block, so list items show too. */
function blocksOf(target: Editor): string {
  const lines: string[] = [];
  target.state.doc.descendants((node) => {
    if (node.isTextblock) lines.push(node.textContent);
    return !node.isTextblock;
  });
  return lines.join(' | ');
}

/** Like a clipboard paste: the parsed blocks join the text on both sides of the selection. */
function paste(target: Editor, from: number, to: number, html: string): void {
  const dom = document.createElement('div');
  dom.innerHTML = html;
  const parsed = ProseDOMParser.fromSchema(target.schema).parseSlice(dom);
  target.view.dispatch(target.state.tr.replace(from, to, new Slice(parsed.content, 1, 1)));
}

function backspace(target: Editor): void {
  target.view.someProp('handleKeyDown', (handler) =>
    handler(target.view, new KeyboardEvent('keydown', { key: 'Backspace' })),
  );
}

/** Deletes `from..to` the way the Delete key does, through the real selection command. */
function deleteSelection(target: Editor, from: number, to: number): void {
  target.view.dispatch(
    target.state.tr.setSelection(TextSelection.create(target.state.doc, from, to)),
  );
  target.commands.deleteSelection();
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
    expect(show(target)).toBe('One [-two] | delete:[-Middle] | delete:[-Three ]four');
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

describe('a paste over a selection that spans blocks', () => {
  const SOURCE = '<p>One two</p><p>Three</p>';

  it('rejects to the original and accepts into the open edges', () => {
    const target = makeEditor(SOURCE);
    paste(target, 5, 12, '<p>X</p><p>Y</p>');
    target.commands.rejectAllSuggestions();
    expect(show(target)).toBe('One two | Three');

    const other = makeEditor(SOURCE);
    paste(other, 5, 12, '<p>X</p><p>Y</p>');
    other.commands.acceptAllSuggestions();
    expect(show(other)).toBe('One X | Yree');
  });

  it('rejects a closed block paste to the original, joining at a surviving block', () => {
    const target = makeEditor(SOURCE);
    target.commands.setTextSelection({ from: 5, to: 12 });
    target.commands.insertContent('<p>X</p><p>Y</p>');
    target.commands.rejectAllSuggestions();
    expect(show(target)).toBe('One two | Three');
  });
});

describe('list restructures', () => {
  const LIST = '<ul><li><p>A</p></li><li><p>B</p></li></ul>';

  it('wrapping several paragraphs is one suggestion that reject undoes whole', () => {
    const target = makeEditor('<p>One</p><p>Two</p>');
    target.commands.setTextSelection({ from: 2, to: 8 });
    target.commands.toggleBulletList();
    expect(listSuggestions(target.state.doc)).toHaveLength(1);
    target.commands.rejectAllSuggestions();
    expect(show(target)).toBe('One | Two');
    expect(target.state.doc.childCount).toBe(2);
  });

  it('tracks sinking a list item, and reject restores it', () => {
    const target = makeEditor(LIST);
    target.commands.setTextSelection(8);
    target.commands.sinkListItem('listItem');
    const entry = only(target);
    expect(entry.kind).toBe('block');
    target.commands.rejectSuggestion(entry.id);
    expect(target.getHTML()).toBe('<ul><li><p>A</p></li><li><p>B</p></li></ul>');
  });

  it('tracks lifting a list item out of its list, and reject restores it', () => {
    const target = makeEditor(LIST);
    target.commands.setTextSelection(8);
    target.commands.liftListItem('listItem');
    expect(target.state.doc.childCount).toBe(2);
    const entries = listSuggestions(target.state.doc);
    expect(entries).toHaveLength(1);
    target.commands.rejectAllSuggestions();
    expect(target.getHTML()).toBe('<ul><li><p>A</p></li><li><p>B</p></li></ul>');
  });
});

describe('deletes that cross blocks', () => {
  it('accepting one that starts at a block end joins the first boundary', () => {
    const target = makeEditor('<p>One</p><p>Two</p><p>Three</p>');
    remove(target, 4, 13);
    target.commands.acceptAllSuggestions();
    expect(show(target)).toBe('Oneree');
  });

  const ITEMS = '<ul><li><p>A</p></li><li><p>B</p></li><li><p>C</p></li></ul>';

  it.each([
    [4, 11, 'A | C'],
    [4, 10, 'A | C'],
    [5, 10, 'A | C'],
    [4, 16, 'A'],
    [1, 13, 'C'],
  ])('a list-item delete %i..%i is suggested, and accept leaves %s', (from, to, left) => {
    const target = makeEditor(ITEMS);
    deleteSelection(target, from, to);
    expect(listSuggestions(target.state.doc).length).toBeGreaterThan(0);
    expect(target.state.doc.textContent).toBe('ABC');
    target.commands.acceptAllSuggestions();
    expect(blocksOf(target)).toBe(left);
  });

  it('a delete from the list start into item C suggests only a delete, and reject restores it', () => {
    const target = makeEditor(ITEMS);
    deleteSelection(target, 1, 13);
    const entries = listSuggestions(target.state.doc);
    expect(entries.map((entry) => entry.kind)).toEqual(['delete']);
    expect(entries[0]?.excerpt).toBe('AB');
    target.commands.rejectAllSuggestions();
    expect(target.getHTML()).toBe(ITEMS);
  });

  it('accepting a delete keeps pending inserts and unmarked text between its pieces', () => {
    const target = makeEditor('<p>Hello world</p>');
    remove(target, 1, 12);
    const [del] = listSuggestions(target.state.doc);
    // Text typed inside the struck run stays when the delete is accepted.
    type(target, 6, 'X');
    target.commands.acceptSuggestion(del?.id ?? '');
    expect(target.state.doc.textContent).toBe('X');
  });
});

describe('backspace and coalescing', () => {
  it('moves the caret before text that is already struck', () => {
    const target = makeEditor();
    remove(target, 5, 6);
    target.commands.setTextSelection(6);
    backspace(target);
    remove(target, 5, 6);
    expect(show(target)).toBe('Hell[-o] world | Second');
    expect(target.state.selection.from).toBe(5);
  });

  it('keeps successive backspaces in one suggestion', () => {
    const target = makeEditor();
    target.commands.setTextSelection(6);
    backspace(target);
    remove(target, 5, 6);
    backspace(target);
    remove(target, 4, 5);
    expect(show(target)).toBe('Hel[-lo] world | Second');
    expect(listSuggestions(target.state.doc)).toHaveLength(1);
  });

  it('keeps Enter and the typing after it in one suggestion', () => {
    const target = makeEditor();
    target.commands.setTextSelection(6);
    target.commands.splitBlock();
    target.commands.insertContent('New');
    expect(listSuggestions(target.state.doc)).toHaveLength(1);
  });
});

describe("what is not the user's edit", () => {
  it('ignores a transaction another plugin appended', () => {
    const target = makeEditor();
    target.view.dispatch(
      target.state.tr.insertText('repair', 6).setMeta('appendedTransaction', target.state.tr),
    );
    expect(show(target)).toBe('Hellorepair world | Second');
  });
});

describe('hasSuggestions and suggestionIdsAt', () => {
  it('finds a suggestion anywhere, and none once resolved', () => {
    const target = makeEditor();
    expect(hasSuggestions(target.state.doc)).toBe(false);
    type(target, 16, 'x');
    expect(hasSuggestions(target.state.doc)).toBe(true);
    target.commands.rejectAllSuggestions();
    expect(hasSuggestions(target.state.doc)).toBe(false);
  });

  it('offers a caret inside a block-level-only suggestion its id', () => {
    const target = makeEditor();
    target.commands.setTextSelection(3);
    target.commands.toggleBulletList();
    target.commands.setTextSelection(3);
    expect(suggestionIdsAt(target.state)).toEqual([only(target).id]);
  });
});

describe('listSuggestions excerpts', () => {
  it("does not count a deleted block's text twice", () => {
    const target = makeEditor('<p>One</p><p>Two</p><p>Three</p>');
    remove(target, 4, 13);
    expect(only(target).excerpt).toBe('TwoTh');
  });
});

describe('rejecting matches the pure transform exports use', () => {
  const cases: [string, string, (target: Editor) => void][] = [
    [
      'an open paste',
      '<p>One two</p><p>Three</p>',
      (t) => {
        paste(t, 5, 12, '<p>X</p><p>Y</p>');
      },
    ],
    [
      'a closed paste',
      '<p>One two</p><p>Three</p>',
      (t) => {
        t.commands.setTextSelection({ from: 5, to: 12 });
        t.commands.insertContent('<p>X</p><p>Y</p>');
      },
    ],
    [
      'a delete across blocks',
      '<p>One</p><p>Two</p><p>Three</p>',
      (t) => {
        remove(t, 4, 13);
      },
    ],
    [
      'a list wrap over two paragraphs',
      '<p>One</p><p>Two</p>',
      (t) => {
        t.commands.setTextSelection({ from: 2, to: 8 });
        t.commands.toggleBulletList();
      },
    ],
    [
      'a sunk list item',
      '<ul><li><p>A</p></li><li><p>B</p></li></ul>',
      (t) => {
        t.commands.setTextSelection(8);
        t.commands.sinkListItem('listItem');
      },
    ],
  ];

  it.each(cases)('%s', (_name, content, edit) => {
    const target = makeEditor(content);
    edit(target);
    const expected: unknown = target.schema
      .nodeFromJSON(rejectAllSuggestions(target.getJSON()))
      .toJSON();
    target.commands.rejectAllSuggestions();
    expect(target.getJSON()).toEqual(expected);
  });
});

describe('composition', () => {
  /** A preedit replace step as the browser makes it, then compositionend and the settle delay. */
  const compose = (target: Editor, from: number, to: number, text: string): void => {
    target.view.dispatch(target.state.tr.insertText(text, from, to).setMeta('composition', 1));
  };
  const settle = (target: Editor): void => {
    target.view.dom.dispatchEvent(new Event('compositionend'));
    vi.advanceTimersByTime(100);
  };

  it('marks one insert for a preedit that is replaced and then committed', () => {
    vi.useFakeTimers();
    const target = makeEditor();
    compose(target, 12, 12, 'k');
    compose(target, 12, 13, 'ko');
    compose(target, 12, 14, 'konni');
    settle(target);
    // Chromium may commit after compositionend, without the composition meta.
    target.view.dispatch(target.state.tr.insertText('こんにちは', 12, 17));
    vi.advanceTimersByTime(100);
    expect(show(target)).toBe('Hello world[+こんにちは] | Second');
    vi.useRealTimers();
  });

  it('marks one delete and one insert for a composition over a selection', () => {
    vi.useFakeTimers();
    const target = makeEditor();
    compose(target, 7, 12, 'chi');
    compose(target, 7, 10, '茶');
    settle(target);
    expect(show(target)).toBe('Hello [-world][+茶] | Second');
    vi.useRealTimers();
  });
});
