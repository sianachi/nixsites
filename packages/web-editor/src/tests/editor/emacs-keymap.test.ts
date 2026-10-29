import { nixEditingExtensions } from '@nix/editor-schema';
import { Editor, Extension } from '@tiptap/core';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { EmacsKeymap, emacsKillRing, emacsStatus } from '../../editor/emacs-keymap';
import { useKeyboardModeStore } from '../../editor/keyboard-mode-store';

let editor: Editor | null = null;

function key(keyValue: string, options: KeyboardEventInit = {}): KeyboardEvent {
  if (editor === null) {
    throw new Error('The editor is not open.');
  }
  const event = new KeyboardEvent('keydown', {
    key: keyValue,
    ctrlKey: true,
    bubbles: true,
    cancelable: true,
    ...options,
  });
  editor.view.dom.dispatchEvent(event);
  return event;
}

function textStart(label: string): number {
  if (editor === null) {
    throw new Error('The editor is not open.');
  }
  const matches: number[] = [];
  editor.state.doc.descendants((node, position) => {
    if (node.isText && node.text === label) {
      matches.push(position);
    }
  });
  const found = matches[0];
  if (found === undefined) {
    throw new Error(`The editor does not contain "${label}".`);
  }
  return found;
}

beforeEach(() => {
  useKeyboardModeStore.setState({ mode: 'emacs', persistence: 'stored' });
});

afterEach(() => {
  editor?.destroy();
  editor = null;
});

describe('Emacs basics', () => {
  it('moves to the start and end of the current rich-text block', () => {
    editor = new Editor({
      element: document.createElement('div'),
      extensions: [...nixEditingExtensions, EmacsKeymap],
      content: '<h2>Heading</h2><p>Second block</p>',
    });
    // The second paragraph starts after the heading's opening token, text and closing token.
    editor.commands.setTextSelection(12);

    expect(key('a').defaultPrevented).toBe(true);
    expect(editor.state.selection.from).toBe(10);

    expect(key('e').defaultPrevented).toBe(true);
    expect(editor.state.selection.from).toBe(22);
  });

  it('claims a supported key even when the caret is already at the boundary', () => {
    editor = new Editor({
      element: document.createElement('div'),
      extensions: [...nixEditingExtensions, EmacsKeymap],
      content: '<p>Text</p>',
    });
    editor.commands.setTextSelection(1);

    expect(key('a').defaultPrevented).toBe(true);
    expect(editor.state.selection.from).toBe(1);
  });

  it('keeps movement inside list, table, toggle, and column text blocks', () => {
    editor = new Editor({
      element: document.createElement('div'),
      extensions: [...nixEditingExtensions, EmacsKeymap],
      content: {
        type: 'doc',
        content: [
          {
            type: 'bulletList',
            content: [
              {
                type: 'listItem',
                content: [{ type: 'paragraph', content: [{ type: 'text', text: 'List text' }] }],
              },
            ],
          },
          {
            type: 'table',
            content: [
              {
                type: 'tableRow',
                content: [
                  {
                    type: 'tableCell',
                    attrs: { colspan: 1, rowspan: 1, colwidth: null, align: null },
                    content: [
                      { type: 'paragraph', content: [{ type: 'text', text: 'Cell text' }] },
                    ],
                  },
                ],
              },
            ],
          },
          {
            type: 'details',
            attrs: { toggleLevel: null },
            content: [
              { type: 'detailsSummary', content: [{ type: 'text', text: 'Summary' }] },
              {
                type: 'detailsContent',
                content: [{ type: 'paragraph', content: [{ type: 'text', text: 'Toggle text' }] }],
              },
            ],
          },
          {
            type: 'columnBlock',
            content: [
              {
                type: 'column',
                attrs: { width: null },
                content: [{ type: 'paragraph', content: [{ type: 'text', text: 'Column text' }] }],
              },
              {
                type: 'column',
                attrs: { width: null },
                content: [{ type: 'paragraph' }],
              },
            ],
          },
        ],
      },
    });
    const before = editor.getJSON();

    for (const label of ['List text', 'Cell text', 'Toggle text', 'Column text']) {
      const start = textStart(label);
      editor.commands.setTextSelection(start + 1);
      key('a');
      expect(editor.state.selection.from).toBe(start);
      key('e');
      expect(editor.state.selection.from).toBe(start + label.length);
    }
    expect(editor.getJSON()).toEqual(before);
  });

  it('falls through immediately in Standard mode', () => {
    const competing = vi.fn(() => true);
    const BaseKeymap = Extension.create({
      name: 'baseKeymapProbe',
      priority: 1000,
      addKeyboardShortcuts() {
        return { 'Ctrl-a': competing };
      },
    });
    editor = new Editor({
      element: document.createElement('div'),
      extensions: [...nixEditingExtensions, EmacsKeymap, BaseKeymap],
      content: '<p>Text</p>',
    });
    useKeyboardModeStore.setState({ mode: 'standard' });

    key('a');

    expect(competing).toHaveBeenCalledOnce();
  });

  it('responds to a live preference change without recreating the editor', () => {
    editor = new Editor({
      element: document.createElement('div'),
      extensions: [...nixEditingExtensions, EmacsKeymap],
      content: '<p>Text</p>',
    });
    const original = editor;
    useKeyboardModeStore.setState({ mode: 'standard' });
    expect(key('/').defaultPrevented).toBe(false);

    useKeyboardModeStore.setState({ mode: 'emacs' });
    expect(key('/').defaultPrevented).toBe(true);
    expect(editor).toBe(original);
  });

  it('leaves every supported chord alone while text is being composed', () => {
    editor = new Editor({
      element: document.createElement('div'),
      extensions: [...nixEditingExtensions, EmacsKeymap],
      content: '<p>Composed text</p>',
    });
    editor.commands.setTextSelection(5);
    const before = editor.getJSON();
    editor.view.dom.dispatchEvent(new CompositionEvent('compositionstart', { bubbles: true }));

    for (const [keyValue, shiftKey] of [
      ['a', false],
      ['e', false],
      ['/', false],
      ['_', true],
    ] as const) {
      expect(key(keyValue, { shiftKey }).defaultPrevented).toBe(false);
    }

    expect(editor.state.selection.from).toBe(5);
    expect(editor.getJSON()).toEqual(before);
    editor.view.dom.dispatchEvent(new CompositionEvent('compositionend', { bubbles: true }));
  });
});

function openEmacs(content: string): Editor {
  const opened = new Editor({
    element: document.createElement('div'),
    extensions: [...nixEditingExtensions, EmacsKeymap],
    content,
  });
  editor = opened;
  return opened;
}

const alt = { ctrlKey: false, altKey: true } as const;

function blocks(): string[] {
  const texts: string[] = [];
  editor?.state.doc.descendants((node) => {
    if (!node.isTextblock) return true;
    texts.push(node.textContent);
    return false;
  });
  return texts;
}

function at(pos: number): void {
  editor?.commands.setTextSelection(pos);
}

function selection(): { from: number; to: number } {
  if (editor === null) throw new Error('The editor is not open.');
  return { from: editor.state.selection.from, to: editor.state.selection.to };
}

describe('Emacs basics movement', () => {
  it('moves by character with Ctrl+F/B, crossing into the next and previous block', () => {
    openEmacs('<p>ab</p><p>cd</p>');
    at(2);

    expect(key('f').defaultPrevented).toBe(true);
    expect(selection().from).toBe(3);
    key('f');
    expect(selection().from).toBe(5);
    key('b');
    expect(selection().from).toBe(3);
    key('b');
    expect(selection().from).toBe(2);
  });

  it('moves by whole graphemes', () => {
    openEmacs(`<p>A\u{1F469}\u200D\u{1F4BB}Z</p>`);
    at(2);

    key('f');
    expect(selection().from).toBe(7);
    key('b');
    expect(selection().from).toBe(2);
  });

  it('moves to word ends with Alt+F and word starts with Alt+B, across blocks', () => {
    openEmacs('<p>alpha beta</p><p>gamma</p>');
    at(1);

    key('f', alt);
    expect(selection().from).toBe(6);
    key('f', alt);
    expect(selection().from).toBe(11);
    key('f', alt);
    expect(selection().from).toBe(18);
    key('b', alt);
    expect(selection().from).toBe(13);
    key('b', alt);
    expect(selection().from).toBe(7);
  });

  it('moves by line with Ctrl+N/P, keeping the column, where no layout is available', () => {
    openEmacs('<p>alpha</p><p>beta</p><p>c</p>');
    at(4);

    key('n');
    expect(selection().from).toBe(11);
    key('n');
    // "c" is shorter; the caret stops at its end.
    expect(selection().from).toBe(15);
    key('p');
    expect(selection().from).toBe(9);
  });

  it('goes to either end of the note with Alt+< and Alt+>', () => {
    openEmacs('<p>first</p><p>last</p>');
    at(3);

    key('>', { ...alt, shiftKey: true });
    expect(selection().from).toBe(12);
    key('<', { ...alt, shiftKey: true });
    expect(selection().from).toBe(1);
  });
});

describe('Emacs basics mark and region', () => {
  it('extends a region from the mark, and Ctrl+G clears it', () => {
    openEmacs('<p>alpha beta</p>');
    at(1);

    key(' ');
    key('f', alt);
    expect(selection()).toEqual({ from: 1, to: 6 });
    key('e');
    expect(selection()).toEqual({ from: 1, to: 11 });

    key('g');
    expect(selection()).toEqual({ from: 11, to: 11 });
    key('b');
    expect(selection()).toEqual({ from: 10, to: 10 });
  });

  it('deactivates the mark on a second Ctrl+Space and on any edit', () => {
    openEmacs('<p>alpha beta</p>');
    at(1);
    key(' ');
    key(' ');
    key('f');
    expect(selection()).toEqual({ from: 2, to: 2 });

    key(' ');
    editor?.commands.insertContent('X');
    key('f');
    expect(selection().from).toBe(selection().to);
  });

  it('kills the region with Ctrl+W and copies it with Alt+W', () => {
    openEmacs('<p>alpha beta</p>');
    at(1);
    key(' ');
    key('f', alt);
    key('w', alt);
    expect(blocks()).toEqual(['alpha beta']);
    expect(selection()).toEqual({ from: 6, to: 6 });
    expect(emacsKillRing()[0]?.content.textBetween(0, emacsKillRing()[0]?.content.size ?? 0)).toBe(
      'alpha',
    );

    at(7);
    key(' ');
    key('e');
    key('w');
    expect(blocks()).toEqual(['alpha ']);
    key('y');
    expect(blocks()).toEqual(['alpha beta']);
  });
});

describe('Emacs basics kill ring', () => {
  it('kills the rest of the line, then the break, and yanks both back as one entry', () => {
    openEmacs('<p>alpha beta</p><p>next</p><p>after</p>');
    at(7);

    key('k');
    expect(blocks()).toEqual(['alpha ', 'next', 'after']);
    key('k');
    expect(blocks()).toEqual(['alpha next', 'after']);
    key('k');
    expect(blocks()).toEqual(['alpha ', 'after']);

    key('y');
    expect(blocks()).toEqual(['alpha beta', 'next', 'after']);
  });

  it('starts a new entry when something else happened between kills', () => {
    openEmacs('<p>one two</p>');
    const before = emacsKillRing().length;
    at(5);
    key('k');
    key('b');
    key('b');
    key('k');

    expect(emacsKillRing().length).toBe(before + 2);
    expect(blocks()).toEqual(['on']);
  });

  it('kills a word forward with Alt+D', () => {
    openEmacs('<p>alpha beta gamma</p>');
    at(6);

    key('d', alt);
    expect(blocks()).toEqual(['alpha gamma']);
  });

  it('swaps a yank for the previous kill with Alt+Y', () => {
    openEmacs('<p>one</p><p>two</p><p></p>');
    at(1);
    key('k');
    at(3);
    key('k');
    key('n');
    key('y');
    expect(blocks()).toEqual(['', '', 'two']);

    key('y', alt);
    expect(blocks()).toEqual(['', '', 'one']);
    key('y', alt);
    expect(blocks()[2]).not.toBe('one');
  });

  it('keeps formatting through a kill and a yank', () => {
    openEmacs('<p><strong>bold</strong> plain</p><p></p>');
    at(1);
    key('k');
    key('n');
    key('y');

    const yanked = editor?.state.doc.child(1).firstChild;
    expect(yanked?.text).toBe('bold');
    expect(yanked?.marks.map((mark) => mark.type.name)).toEqual(['bold']);
  });

  it('deletes forward with Ctrl+D without touching the kill ring, joining at a block end', () => {
    openEmacs('<p>ab</p><p>cd</p>');
    const ring = emacsKillRing().length;
    at(1);

    key('d');
    expect(blocks()).toEqual(['b', 'cd']);
    key('e');
    key('d');
    expect(blocks()).toEqual(['bcd']);
    expect(emacsKillRing().length).toBe(ring);
  });

  it('leaves a read-only note to the browser', () => {
    openEmacs('<p>alpha beta</p>');
    editor?.setEditable(false);
    at(1);

    expect(key('k').defaultPrevented).toBe(false);
    expect(key('d').defaultPrevented).toBe(false);
    expect(blocks()).toEqual(['alpha beta']);
  });
});

const plain = { ctrlKey: false } as const;

/** Types plain keys as a person would: each goes to the editor, then the text lands if unclaimed. */
function type(text: string): void {
  for (const char of text) {
    if (!key(char, plain).defaultPrevented) {
      editor?.view.dispatch(editor.state.tr.insertText(char));
    }
  }
}

function status() {
  if (editor === null) throw new Error('The editor is not open.');
  return emacsStatus(editor.state);
}

describe('Emacs words, case and whitespace', () => {
  it('upcases, downcases and capitalises to the end of the word with Alt+U, Alt+L and Alt+C', () => {
    openEmacs('<p>alpha beta gamma</p>');
    at(1);

    key('u', alt);
    expect(blocks()).toEqual(['ALPHA beta gamma']);
    expect(selection().from).toBe(6);
    key('c', alt);
    expect(blocks()).toEqual(['ALPHA Beta gamma']);
    at(1);
    key('l', alt);
    expect(blocks()).toEqual(['alpha Beta gamma']);
  });

  it('capitalises a word split by formatting as one word', () => {
    openEmacs('<p><strong>al</strong>PHA</p>');
    at(1);

    key('c', alt);

    expect(blocks()).toEqual(['Alpha']);
    expect(editor?.state.doc.firstChild?.firstChild?.marks.map((mark) => mark.type.name)).toEqual([
      'bold',
    ]);
  });

  it('kills words backward with Alt+Backspace into one kill-ring entry', () => {
    openEmacs('<p>alpha beta gamma</p>');
    at(11);

    key('Backspace', alt);
    expect(blocks()).toEqual(['alpha  gamma']);
    key('Backspace', alt);
    expect(blocks()).toEqual([' gamma']);
    key('y');
    expect(blocks()).toEqual(['alpha beta gamma']);
  });

  it('transposes characters with Ctrl+T and words with Alt+T', () => {
    openEmacs('<p>abcd</p>');
    at(2);
    key('t');
    expect(blocks()).toEqual(['bacd']);
    expect(selection().from).toBe(3);
    at(5);
    key('t');
    expect(blocks()).toEqual(['badc']);

    openEmacs('<p>alpha beta gamma</p>');
    at(9);
    key('t', alt);
    expect(blocks()).toEqual(['alpha gamma beta']);
    expect(selection().from).toBe(17);
    at(6);
    key('t', alt);
    expect(blocks()).toEqual(['gamma alpha beta']);
  });

  it('closes up blanks with Alt+\\ and leaves one with Alt+Space', () => {
    openEmacs('<p>ab</p>');
    editor?.view.dispatch(editor.state.tr.insertText('    ', 2));
    at(4);
    key('\\', alt);
    expect(blocks()).toEqual(['ab']);
    key(' ', alt);
    expect(blocks()).toEqual(['a b']);
  });

  it('opens a line with Ctrl+O, joins upward with Alt+^ and goes to the indentation with Alt+M', () => {
    openEmacs('<p>alpha</p>');
    at(3);
    key('o');
    expect(blocks()).toEqual(['al', 'pha']);
    expect(selection().from).toBe(3);

    openEmacs('<p>one</p><p>  two</p>');
    at(8);
    key('^', { ...alt, shiftKey: true });
    expect(blocks()).toEqual(['one two']);
    expect(selection().from).toBe(4);

    openEmacs('<p>indented</p>');
    editor?.view.dispatch(editor.state.tr.insertText('  ', 1));
    at(8);
    key('m', alt);
    expect(selection().from).toBe(3);
  });

  it('moves by paragraph with Alt+} and Alt+{', () => {
    openEmacs('<p>one</p><p>two</p><p></p><p>three</p>');
    at(1);

    key('}', { ...alt, shiftKey: true });
    expect(selection().from).toBe(11);
    key('}', { ...alt, shiftKey: true });
    expect(selection().from).toBe(18);
    key('{', { ...alt, shiftKey: true });
    expect(selection().from).toBe(11);
    key('{', { ...alt, shiftKey: true });
    expect(selection().from).toBe(1);
  });

  it('zaps to a character with Alt+Z', () => {
    openEmacs('<p>alpha, beta</p>');
    at(1);

    key('z', alt);
    expect(status().keys).toBe('Zap to char: ');
    key(',', plain);

    expect(blocks()).toEqual([' beta']);
  });
});

describe('Emacs mark ring and C-x', () => {
  it('marks the whole note with Ctrl+X H and swaps caret and mark with Ctrl+X Ctrl+X', () => {
    openEmacs('<p>alpha</p><p>beta</p>');
    at(3);
    key('x');
    expect(status().keys).toBe('C-x-');
    key('h', plain);
    expect(selection()).toEqual({ from: 1, to: 12 });

    openEmacs('<p>alpha beta</p>');
    at(1);
    key(' ');
    key('e');
    key('g');
    expect(selection()).toEqual({ from: 11, to: 11 });
    key('x');
    key('x');
    expect(selection()).toEqual({ from: 1, to: 11 });
    expect(editor?.state.selection.head).toBe(1);
  });

  it('walks back through the mark ring with Ctrl+U Ctrl+Space', () => {
    openEmacs('<p>alpha beta gamma</p>');
    at(1);
    key(' ');
    at(7);
    key(' ');
    at(15);

    key('u');
    key(' ');
    expect(selection().from).toBe(7);
    key('u');
    key(' ');
    expect(selection().from).toBe(1);
  });

  it('says Ctrl+X Ctrl+S is not needed, names an undefined key and quits on Ctrl+G', () => {
    openEmacs('<p>alpha</p>');
    key('x');
    key('s');
    expect(status().message).toBe('Notes save as you type');
    key('x');
    key('q');
    expect(status().message).toBe('C-x C-q is undefined');
    key('x');
    key('g');
    expect(status().keys).toBe('');
    expect(blocks()).toEqual(['alpha']);
  });
});

describe('Emacs numeric arguments and repeat', () => {
  it('repeats a command by Ctrl+U, Ctrl+U digits and Alt+digits', () => {
    openEmacs('<p>abcdefgh</p>');
    at(1);

    key('u');
    expect(status().keys).toBe('C-u 4-');
    key('f');
    expect(selection().from).toBe(5);
    key('2', { ...alt, code: 'Digit2' });
    key('f');
    expect(selection().from).toBe(7);
    key('u');
    key('3', plain);
    key('b');
    expect(selection().from).toBe(4);
    key('u');
    key('u');
    key('f');
    expect(selection().from).toBe(9);
  });

  it('inserts a typed character that many times', () => {
    openEmacs('<p>ab</p>');
    at(2);

    key('u');
    key('3', plain);
    key('x', plain);

    expect(blocks()).toEqual(['axxxb']);
  });

  it('repeats the last command with Ctrl+X Z, and again with each Z', () => {
    openEmacs('<p>one two three four</p>');
    at(1);

    key('d', alt);
    expect(blocks()).toEqual([' two three four']);
    key('x');
    key('z', plain);
    expect(blocks()).toEqual([' three four']);
    key('z', plain);
    expect(blocks()).toEqual([' four']);
  });
});

describe('Emacs I-search', () => {
  it('searches as you type, finds the next with Ctrl+S, wraps, and saves the mark on Enter', () => {
    openEmacs('<p>alpha beta</p><p>gamma beta</p>');
    at(1);

    key('s');
    type('beta');
    expect(status().keys).toBe('I-search: beta');
    expect(selection()).toEqual({ from: 7, to: 11 });
    key('s');
    expect(selection()).toEqual({ from: 19, to: 23 });
    key('s');
    expect(selection()).toEqual({ from: 7, to: 11 });
    expect(status().keys).toBe('Wrapped I-search: beta');

    key('Enter', plain);
    expect(selection()).toEqual({ from: 11, to: 11 });
    expect(status().message).toBe('Mark saved where search started');
    key('u');
    key(' ');
    expect(selection().from).toBe(1);
  });

  it('searches backward with Ctrl+R', () => {
    openEmacs('<p>alpha beta</p><p>gamma beta</p>');
    at(24);

    key('r');
    type('beta');
    expect(selection()).toEqual({ from: 19, to: 23 });
    expect(editor?.state.selection.head).toBe(19);
    expect(status().keys).toBe('I-search backward: beta');
  });

  it('says when a search fails, and returns to the start on Ctrl+G', () => {
    openEmacs('<p>alpha beta</p>');
    at(3);

    key('s');
    type('zzz');
    expect(status().keys).toBe('Failing I-search: zzz');
    key('g');
    expect(selection()).toEqual({ from: 3, to: 3 });
    expect(status().keys).toBe('');
  });

  it('ends the search on another command and then runs it', () => {
    openEmacs('<p>alpha beta</p>');
    at(1);

    key('s');
    type('beta');
    key('e');

    expect(status().keys).toBe('');
    expect(selection()).toEqual({ from: 11, to: 11 });
  });

  it('edits the search text with Backspace', () => {
    openEmacs('<p>alpha beta</p>');
    at(1);

    key('s');
    type('bx');
    key('Backspace', plain);
    expect(status().keys).toBe('I-search: b');
    expect(selection()).toEqual({ from: 7, to: 8 });
  });
});

describe('Emacs query replace and goto-line', () => {
  function startReplace(from: string, to: string): void {
    key('%', { ...alt, shiftKey: true });
    type(from);
    key('Enter', plain);
    type(to);
    key('Enter', plain);
  }

  it('asks at each match: y replaces, n skips', () => {
    openEmacs('<p>a b a b a</p>');
    at(1);

    startReplace('a', 'x');
    expect(status().keys).toBe('Query replacing a with x: (y, n, !, ., q)');
    expect(selection()).toEqual({ from: 1, to: 2 });
    key('y', plain);
    expect(selection()).toEqual({ from: 5, to: 6 });
    key('n', plain);
    key('y', plain);

    expect(blocks()).toEqual(['x b a b x']);
    expect(status().message).toBe('Replaced 2 occurrences');
  });

  it('replaces every remaining match with !', () => {
    openEmacs('<p>a b a</p><p>a</p>');
    at(1);

    startReplace('a', 'xy');
    key('!', { ...plain, shiftKey: true });

    expect(blocks()).toEqual(['xy b xy', 'xy']);
    expect(status().message).toBe('Replaced 3 occurrences');
  });

  it('goes to a line with Alt+G G', () => {
    openEmacs('<p>one</p><p>two</p><p>three</p>');
    at(1);

    key('g', alt);
    key('g', plain);
    type('3');
    expect(status().keys).toBe('Goto line: 3');
    key('Enter', plain);

    expect(selection().from).toBe(11);
  });
});

describe('Emacs registers and keyboard macros', () => {
  it('copies the region to a register and inserts it with Ctrl+X R S and I', () => {
    openEmacs('<p>alpha beta</p>');
    at(1);
    key(' ');
    key('f', alt);
    key('x');
    key('r', plain);
    key('s', plain);
    key('a', plain);
    expect(status().message).toBe('Copied to register a');

    at(11);
    key('x');
    key('r', plain);
    key('i', plain);
    key('a', plain);
    expect(blocks()).toEqual(['alpha betaalpha']);
    expect(selection().from).toBe(11);
  });

  it('saves the caret to a register and jumps back with Ctrl+X R Space and J', () => {
    openEmacs('<p>alpha beta</p>');
    at(4);
    key('x');
    key('r', plain);
    key(' ', plain);
    key('b', plain);
    at(1);
    key('x');
    key('r', plain);
    key('j', plain);
    key('b', plain);

    expect(selection().from).toBe(4);
  });

  function recordExclamation(): void {
    at(1);
    key('x');
    key('(', { ...plain, shiftKey: true });
    expect(status().recording).toBe(true);
    key('e');
    type('!');
    key('n');
    key('x');
    key(')', { ...plain, shiftKey: true });
    expect(status().recording).toBe(false);
  }

  it('records a keyboard macro and runs it with Ctrl+X E, then E again', () => {
    openEmacs('<p>one</p><p>two</p><p>three</p>');
    recordExclamation();
    expect(blocks()).toEqual(['one!', 'two', 'three']);

    key('x');
    key('e', plain);
    expect(blocks()).toEqual(['one!', 'two!', 'three']);
    key('e', plain);
    expect(blocks()).toEqual(['one!', 'two!', 'three!']);
  });

  it('ends a counted run at the first key that fails', () => {
    openEmacs('<p>one</p><p>two</p><p>three</p>');
    recordExclamation();

    key('u');
    key('9', plain);
    key('x');
    key('e', plain);

    expect(blocks()).toEqual(['one!', 'two!', 'three!']);
  });
});
