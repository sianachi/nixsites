import { nixEditingExtensions, nixExtensions } from '@nix/editor-schema';
import { Editor, getSchema } from '@tiptap/core';
import { Slice } from '@tiptap/pm/model';
import type { Node as PMNode } from '@tiptap/pm/model';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { ColumnControls, columnDropTarget } from '../../editor/column-controls';

/**
 * The browser half of columns: how the structure is named, where a dropped block lands, what the
 * dividers offer, and the keys that give every gesture a keyboard.
 *
 * **jsdom performs no layout**, so nothing here drags anything: a pointer drag reads
 * `getBoundingClientRect`, which is all zeroes in this environment, and asserting against that
 * would be asserting the stub. The drop target is tested at the position layer, where the real
 * decision is made, and the resize is tested through the keyboard path, which commits the same
 * widths a drag commits. The pointer geometry itself is owed a real-browser check (MVP-3 K14).
 */

const announced: string[] = [];

vi.mock('@nix/web-foundation/a11y/announcer', () => ({
  announce: (message: string) => {
    announced.push(message);
  },
}));

const schema = getSchema(nixExtensions);

function docOf(content: readonly unknown[]): PMNode {
  return schema.nodeFromJSON({ type: 'doc', content });
}

function paragraph(text?: string): unknown {
  return text === undefined
    ? { type: 'paragraph' }
    : { type: 'paragraph', content: [{ type: 'text', text }] };
}

function column(children: readonly unknown[], width: number | null = null): unknown {
  return { type: 'column', attrs: { width }, content: children };
}

const editors: Editor[] = [];

function makeEditor(content: readonly unknown[]): Editor {
  const element = document.createElement('div');
  document.body.append(element);

  const editor = new Editor({
    element,
    extensions: [...nixEditingExtensions, ColumnControls],
    // Through the schema rather than as JSON: TipTap's `content` option wants a mutable
    // structure, and a parsed node is the same document with the schema's own reading of it.
    content: docOf(content).toJSON() as Record<string, unknown>,
  });
  editors.push(editor);
  return editor;
}

beforeEach(() => {
  announced.length = 0;
});

afterEach(() => {
  for (const editor of editors.splice(0)) {
    editor.destroy();
  }
  vi.restoreAllMocks();
});

/** Where the caret has to be for a column command to see it: inside the text reading `text`. */
function caretAt(editor: Editor, text: string): void {
  // An array rather than a nullable local: an assignment inside the callback is invisible to the
  // narrowing, so a `=== null` check afterwards reads as always true.
  const found: number[] = [];
  editor.state.doc.descendants((node, pos) => {
    if (found.length === 0 && node.isText && node.text === text) {
      found.push(pos + 1);
    }
    return found.length === 0;
  });
  const at = found[0];
  if (at === undefined) {
    throw new Error(`No text node reads "${text}".`);
  }
  editor.commands.setTextSelection(at);
}

function columnTexts(editor: Editor): string[][] {
  const texts: string[][] = [];
  editor.state.doc.descendants((node) => {
    if (node.type.name !== 'columnBlock') {
      return true;
    }
    node.forEach((col) => {
      const inner: string[] = [];
      col.forEach((child) => {
        inner.push(child.textContent);
      });
      texts.push(inner);
    });
    return false;
  });
  return texts;
}

function widthsOf(editor: Editor): (number | null)[] {
  const widths: (number | null)[] = [];
  editor.state.doc.descendants((node) => {
    if (node.type.name !== 'columnBlock') {
      return true;
    }
    node.forEach((col) => {
      widths.push(col.attrs.width as number | null);
    });
    return false;
  });
  return widths;
}

/** The first column's share of its pair, as the document currently holds it. */
function pairShare(editor: Editor): number {
  const widths = widthsOf(editor).map((width) => width ?? 1);
  const left = widths[0] ?? 1;
  const right = widths[1] ?? 1;
  return left / (left + right);
}

function handles(editor: Editor): HTMLElement[] {
  return [...editor.view.dom.querySelectorAll<HTMLElement>('[role="separator"]')];
}

function firstHandle(editor: Editor): HTMLElement {
  const handle = handles(editor)[0];
  if (handle === undefined) {
    throw new Error('The row rendered no divider.');
  }
  return handle;
}

/**
 * One press of a key on an element, released.
 *
 * The release matters: a resize previews while a key is held and writes once it settles, so a
 * test that only presses is asserting the preview and not the document.
 */
function press(target: HTMLElement, key: string, modifiers: KeyboardEventInit = {}): void {
  target.dispatchEvent(new KeyboardEvent('keydown', { key, bubbles: true, ...modifiers }));
  target.dispatchEvent(new KeyboardEvent('keyup', { key, bubbles: true, ...modifiers }));
}

/**
 * The platform's own "Mod", so a shortcut test asserts the binding rather than the platform.
 *
 * Read the way TipTap reads it - off the user agent - because `Mod-` resolves to Cmd on a Mac
 * and Ctrl everywhere else, and a test that hard-coded one would pass on one machine only.
 */
const MOD: KeyboardEventInit = /Mac|iP(hone|ad|od)/.test(navigator.userAgent)
  ? { metaKey: true }
  : { ctrlKey: true };

const ROW = [
  {
    type: 'columnBlock',
    content: [column([paragraph('left')]), column([paragraph('right'), paragraph('below')])],
  },
];

describe('naming the structure', () => {
  it('says a row is a row, and how many columns it holds', () => {
    const editor = makeEditor(ROW);
    const row = editor.view.dom.querySelector('[data-column-block]');

    expect(row?.getAttribute('role')).toBe('group');
    expect(row?.getAttribute('aria-label')).toBe('Row of 2 columns');
  });

  it('numbers each column, so a reader knows which one they are in', () => {
    const editor = makeEditor(ROW);
    const columns = [...editor.view.dom.querySelectorAll('[data-column]')];

    expect(columns.map((element) => element.getAttribute('aria-label'))).toEqual([
      'Column 1 of 2',
      'Column 2 of 2',
    ]);
  });

  it('names the structure without help from the divider, which narrow screens do not get', () => {
    // The handle is `hidden` below the medium breakpoint - display:none takes it out of the
    // accessibility tree entirely - so a phone reader would otherwise hear a run of unrelated
    // paragraphs with nothing saying they sit side by side.
    const editor = makeEditor(ROW);
    const columns = [...editor.view.dom.querySelectorAll('[data-column]')];

    expect(columns.every((element) => element.getAttribute('role') === 'group')).toBe(true);
    expect(columns.every((element) => element.id.length > 0)).toBe(true);
  });

  it('points each divider at the two columns it moves', () => {
    const editor = makeEditor(ROW);
    const controls = firstHandle(editor).getAttribute('aria-controls') ?? '';
    const ids = [...editor.view.dom.querySelectorAll('[data-column]')].map((element) => element.id);

    expect(controls.split(' ')).toEqual(ids);
  });
});

describe('dropping a block into a column', () => {
  /** The position of the text reading `text`, in the given document. */
  function posOf(doc: PMNode, text: string): number {
    const found: number[] = [];
    doc.descendants((node, pos) => {
      if (found.length === 0 && node.isText && node.text === text) {
        found.push(pos);
      }
      return found.length === 0;
    });
    const at = found[0];
    if (at === undefined) {
      throw new Error(`No text node reads "${text}".`);
    }
    return at;
  }

  function blockSlice(): Slice {
    return new Slice(docOf([paragraph('dragged')]).content, 0, 0);
  }

  it('keeps the drop inside the column the pointer is over', () => {
    const doc = docOf(ROW);
    const target = columnDropTarget(doc, posOf(doc, 'right'), blockSlice());

    expect(target).not.toBeNull();

    // Inside the second column, which is the whole point: ProseMirror's own answer at an
    // isolating edge can be beside the row instead.
    const $target = doc.resolve(target ?? 0);
    let insideColumn = false;
    for (let depth = $target.depth; depth > 0; depth -= 1) {
      if ($target.node(depth).type.name === 'column') {
        insideColumn = true;
      }
    }
    expect(insideColumn).toBe(true);
  });

  it('puts the dropped block among that column’s blocks, not beside the row', () => {
    const doc = docOf(ROW);
    const slice = blockSlice();
    const target = columnDropTarget(doc, posOf(doc, 'right'), slice);
    const dropped = doc.copy(doc.content).resolve(target ?? 0);
    const row = dropped.node(1);

    expect(row.type.name).toBe('columnBlock');
    expect(row.childCount).toBe(2);
    expect(dropped.node(2)).toBe(row.child(1));
  });

  it('refuses a row of columns, which no other path can put inside a column', () => {
    // The schema would take it - `Column.content` is `block*` and a row is a block - and nothing
    // else in the product can produce one: the insert command refuses inside a row and the
    // repair unwraps one wherever it appears. A drop is the remaining way in, so it is shut.
    const doc = docOf(ROW);
    const nested = new Slice(docOf(ROW).content, 0, 0);

    expect(columnDropTarget(doc, posOf(doc, 'right'), nested)).toBeNull();
  });

  it('refuses a row nested inside something else in the slice', () => {
    const doc = docOf(ROW);
    const wrapped = new Slice(
      docOf([{ type: 'callout', attrs: { tone: 'note' }, content: ROW }]).content,
      0,
      0,
    );

    expect(columnDropTarget(doc, posOf(doc, 'right'), wrapped)).toBeNull();
  });

  it('leaves a drop outside any column to the editor’s own handling', () => {
    const doc = docOf([paragraph('loose'), ...ROW]);

    expect(columnDropTarget(doc, posOf(doc, 'loose'), blockSlice())).toBeNull();
  });

  it('leaves a torn text range to the editor’s own handling', () => {
    const doc = docOf(ROW);
    const torn = new Slice(docOf([paragraph('half')]).content, 1, 1);

    expect(columnDropTarget(doc, posOf(doc, 'right'), torn)).toBeNull();
  });
});

describe('the resize handles', () => {
  it('offers one divider between every adjacent pair of columns', () => {
    const editor = makeEditor([
      {
        type: 'columnBlock',
        content: [column([paragraph('a')]), column([paragraph('b')]), column([paragraph('c')])],
      },
    ]);

    expect(handles(editor)).toHaveLength(2);
  });

  it('is reachable by keyboard from inside the editable region', () => {
    // A control inside contenteditable is not focusable unless it is its own non-editable island
    // with a tabindex - the same two attributes a toggle button needs.
    const handle = firstHandle(makeEditor(ROW));

    expect(handle.getAttribute('tabindex')).toBe('0');
    expect(handle.getAttribute('contenteditable')).toBe('false');
  });

  it('carries a hit strip wider than the line it draws', () => {
    // 8px is a third of WCAG 2.2's 24px target minimum, and a divider is exactly the control a
    // shaky hand misses. The pseudo-element widens what a pointer must hit without widening
    // what the eye sees - the same fix, and the same reasoning, as PaneDivider.
    const handle = firstHandle(makeEditor(ROW));

    expect(handle.className).toContain('before:-inset-x-2');
  });

  it('says what it resizes and where it currently stands', () => {
    const editor = makeEditor([
      { type: 'columnBlock', content: [column([paragraph('a')], 3), column([paragraph('b')], 1)] },
    ]);
    const handle = firstHandle(editor);

    expect(handle.getAttribute('aria-label')).toBe('Resize columns 1 and 2');
    expect(handle.getAttribute('aria-valuenow')).toBe('75');
    expect(handle.getAttribute('aria-valuetext')).toBe('75 percent to column 1');
  });

  it('moves the divider one step per arrow press, and ten with shift held', () => {
    const editor = makeEditor(ROW);
    press(firstHandle(editor), 'ArrowRight');
    expect(pairShare(editor)).toBeCloseTo(0.51);

    press(firstHandle(editor), 'ArrowLeft', { shiftKey: true });
    expect(pairShare(editor)).toBeCloseTo(0.41);
  });

  it('takes the divider to its bounds with Home and End, and no further', () => {
    const editor = makeEditor(ROW);
    press(firstHandle(editor), 'Home');
    expect(pairShare(editor)).toBeCloseTo(0.15);

    press(firstHandle(editor), 'End');
    expect(pairShare(editor)).toBeCloseTo(0.85);
  });

  it('evens the split on Enter, and puts it back on the next Enter', () => {
    // The one gesture a pointer does not offer at all: a drag reaches exactly half only by
    // aiming at it. Undoing to a bound nobody chose would not be an undo, so it restores.
    const editor = makeEditor([
      { type: 'columnBlock', content: [column([paragraph('a')], 3), column([paragraph('b')], 1)] },
    ]);

    press(firstHandle(editor), 'Enter');
    expect(pairShare(editor)).toBeCloseTo(0.5);

    press(firstHandle(editor), 'Enter');
    expect(pairShare(editor)).toBeCloseTo(0.75);
  });

  it('says so at the bound, where a further press changes nothing', () => {
    // A refused move writes no transaction and rerenders nothing, so "at the limit" would sound
    // exactly like "broken" - the same value announced twice, or not at all.
    const editor = makeEditor(ROW);
    press(firstHandle(editor), 'Home');
    announced.length = 0;

    press(firstHandle(editor), 'ArrowLeft');

    expect(announced.join(' ')).toContain('narrowest');
    expect(pairShare(editor)).toBeCloseTo(0.15);
  });

  it('keeps the focused divider through an edit somewhere else in the document', () => {
    // The failure this replaces: the decoration key carried the row's document position, so a
    // character typed anywhere above rebuilt the widget - dropping focus to the body and killing
    // any drag in flight. A colleague typing must not take the control out from under you.
    const editor = makeEditor([paragraph('above'), ...ROW]);
    const handle = firstHandle(editor);
    handle.focus();

    editor.commands.insertContentAt(1, 'x');

    expect(document.activeElement).toBe(handle);
    expect(handles(editor)[0]).toBe(handle);
  });

  it('keeps reporting the truth after a resize, without being rebuilt', () => {
    const editor = makeEditor(ROW);
    const handle = firstHandle(editor);

    press(handle, 'End');

    expect(handles(editor)[0]).toBe(handle);
    expect(handle.getAttribute('aria-valuenow')).toBe('85');
  });

  it('announces where the divider landed, once it has settled', () => {
    const editor = makeEditor(ROW);
    press(firstHandle(editor), 'ArrowRight');

    expect(announced.at(-1)).toBe('Columns 1 and 2: 51 percent to column 1.');
  });

  it('writes one edit for a held key, not one per repeat', () => {
    // Thirty transactions a second is thirty CRDT broadcasts and thirty undo steps. A held key
    // previews and settles once, which is what the pointer path has always done.
    const editor = makeEditor(ROW);
    const handle = firstHandle(editor);
    let transactions = 0;
    editor.on('transaction', ({ transaction }) => {
      if (transaction.docChanged) {
        transactions += 1;
      }
    });

    for (let repeat = 0; repeat < 5; repeat += 1) {
      handle.dispatchEvent(new KeyboardEvent('keydown', { key: 'ArrowRight', bubbles: true }));
    }
    handle.dispatchEvent(new KeyboardEvent('keyup', { key: 'ArrowRight', bubbles: true }));

    expect(transactions).toBe(1);
    expect(pairShare(editor)).toBeCloseTo(0.55);
  });
});

describe('the keyboard parity for the drag gestures', () => {
  it('moves the caret’s block into the previous column on mod-alt-left', () => {
    const editor = makeEditor(ROW);
    caretAt(editor, 'right');
    press(editor.view.dom, 'ArrowLeft', { ...MOD, altKey: true });

    expect(columnTexts(editor)).toEqual([['left', 'right'], ['below']]);
  });

  it('moves it into the next column on mod-alt-right', () => {
    const editor = makeEditor(ROW);
    caretAt(editor, 'left');
    press(editor.view.dom, 'ArrowRight', { ...MOD, altKey: true });

    // The emptied source column is refilled by the normaliser, so the caret still has a home.
    expect(columnTexts(editor)).toEqual([[''], ['left', 'right', 'below']]);
  });

  it('leaves bare alt-arrow to the caret, which is what the platform binds it to', () => {
    // Alt-Arrow is word-wise movement on macOS and Back on Windows. A structural edit on a
    // reflex navigation key is a claim on the platform this feature is not entitled to make.
    const editor = makeEditor(ROW);
    caretAt(editor, 'right');
    press(editor.view.dom, 'ArrowLeft', { altKey: true });

    expect(columnTexts(editor)).toEqual([['left'], ['right', 'below']]);
  });

  it('says where a moved block landed', () => {
    const editor = makeEditor(ROW);
    caretAt(editor, 'right');
    press(editor.view.dom, 'ArrowLeft', { ...MOD, altKey: true });

    expect(announced).toContain('Moved into column 1 of 2.');
  });

  it('resizes the caret’s column on mod-alt-shift-arrow, without reaching for the handle', () => {
    const editor = makeEditor(ROW);
    caretAt(editor, 'left');
    press(editor.view.dom, 'ArrowRight', { ...MOD, altKey: true, shiftKey: true });

    expect(pairShare(editor)).toBeCloseTo(0.55);
  });

  it('widens the last column against the one before it, since it has no neighbour after', () => {
    const editor = makeEditor(ROW);
    caretAt(editor, 'right');
    press(editor.view.dom, 'ArrowRight', { ...MOD, altKey: true, shiftKey: true });

    expect(pairShare(editor)).toBeCloseTo(0.45);
  });

  it('adds and removes a column from the keyboard', () => {
    const editor = makeEditor(ROW);
    caretAt(editor, 'left');

    press(editor.view.dom, 'Enter', { ...MOD, altKey: true });
    expect(columnTexts(editor)).toHaveLength(3);

    press(editor.view.dom, 'Backspace', { ...MOD, altKey: true });
    expect(columnTexts(editor)).toHaveLength(2);
  });

  it('leaves the arrows alone outside a row', () => {
    const editor = makeEditor([paragraph('loose')]);
    caretAt(editor, 'loose');
    press(editor.view.dom, 'ArrowRight', { ...MOD, altKey: true });

    expect(editor.state.doc.textContent).toBe('loose');
  });
});

describe('the command namespace', () => {
  it('leaves the table’s own add-column command alone', () => {
    // TipTap reduces every extension's commands into one flat object, last registered winning,
    // and `@tiptap/extension-table` already owns `addColumnAfter`. A column command of that name
    // silently replaced it - disabling the table toolbar's button - and typechecked, because the
    // two declarations sit on different members of `Commands`.
    const editor = makeEditor([
      {
        type: 'table',
        content: [
          {
            type: 'tableRow',
            content: [
              {
                type: 'tableCell',
                attrs: { colspan: 1, rowspan: 1, colwidth: null },
                content: [paragraph('cell')],
              },
            ],
          },
        ],
      },
    ]);
    caretAt(editor, 'cell');

    expect(editor.can().addColumnAfter()).toBe(true);
  });
});

describe('what a gesture must not outlive', () => {
  it('takes its window listeners off when the editor goes away mid-drag', () => {
    // A capture-phase scroll listener left on `window` retains the drag closure, and through it
    // the view, the editor and both columns - the whole editor graph held by a global. Neither
    // pointerup nor pointercancel fires when a route change or a hot reload takes the editor,
    // so the teardown has to come from the plugin's own `destroy`.
    const editor = makeEditor(ROW);
    const handle = firstHandle(editor);
    const added = vi.spyOn(window, 'addEventListener');

    handle.dispatchEvent(
      new PointerEvent('pointerdown', { button: 0, bubbles: true, pointerId: 1 }),
    );

    const scroll = added.mock.calls.find(([name]) => name === 'scroll');
    expect(scroll).toBeDefined();
    const options = scroll?.[2];
    const signal = typeof options === 'object' ? options.signal : undefined;
    expect(signal?.aborted).toBe(false);

    editor.destroy();

    expect(signal?.aborted).toBe(true);
  });

  it('does not settle a drag because a modifier key was released', () => {
    // One gesture is one transaction. Releasing Shift mid-drag would otherwise split it into
    // two edits, two undo steps and two announcements.
    const editor = makeEditor(ROW);
    const handle = firstHandle(editor);
    let transactions = 0;
    editor.on('transaction', ({ transaction }) => {
      if (transaction.docChanged) {
        transactions += 1;
      }
    });

    handle.dispatchEvent(
      new PointerEvent('pointerdown', { button: 0, bubbles: true, pointerId: 1 }),
    );
    editor.view.dom.dispatchEvent(new KeyboardEvent('keyup', { key: 'Shift', bubbles: true }));

    expect(transactions).toBe(0);
  });
});

describe('the repair, through the editor', () => {
  it('heals a one-column row the moment it appears', () => {
    const editor = makeEditor([
      { type: 'columnBlock', content: [column([paragraph('a')]), column([paragraph('b')])] },
    ]);
    caretAt(editor, 'b');
    editor.commands.removeColumnFromRow();

    // Removing the second column leaves one, and the normaliser unwraps that back into flow.
    expect(editor.state.doc.firstChild?.type.name).toBe('paragraph');
    expect(editor.state.doc.textContent).toBe('ab');
  });
});
