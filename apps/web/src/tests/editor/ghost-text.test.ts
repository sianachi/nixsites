import { nixEditingExtensions } from '@nix/editor-schema';
import { act, renderHook } from '@testing-library/react';
import { Editor } from '@tiptap/core';
import { TextSelection } from '@tiptap/pm/state';
import { ySyncPlugin } from 'y-prosemirror';
import type { Plugin } from '@tiptap/pm/state';
import * as Y from 'yjs';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { resetAnnouncements, useAnnouncement } from '@nix/web-foundation/a11y/announcer';
import {
  currentGhostText,
  documentText,
  DOCUMENT_CHARS,
  GHOST_CLASS,
  GhostText,
  IDLE_MS,
  REBUILD_MS,
  setGhostTextContext,
} from '@nix/web-editor/editor/ghost-text';
import { setVimEnabled, VimMotions } from '@nix/web-editor/editor/vim-motions';

/**
 * Phrase suggestions against a real editor: typed text, a real idle timer (faked), the decoration
 * in the rendered DOM and the keys through the editor's own element.
 *
 * Every test starts from the same two sentences, which teach the document's own model that "the
 * quarterly" is followed by "review is" - twice, the evidence floor.
 */

const TRAINING = 'The quarterly review is due. The quarterly review is late.';

let editor: Editor | null = null;

function makeEditor(options: { enabled?: boolean; withYjs?: Y.Doc } = {}): Editor {
  const element = document.createElement('div');
  document.body.append(element);
  const created = new Editor({
    element,
    extensions: [...nixEditingExtensions, VimMotions, GhostText],
    ...(options.withYjs === undefined ? { content: `<p>${TRAINING}</p><p></p>` } : {}),
  });
  if (options.withYjs !== undefined) {
    created.registerPlugin(ySyncPlugin(options.withYjs.getXmlFragment('default')) as Plugin);
    created.commands.setContent(`<p>${TRAINING}</p><p></p>`);
  }
  setGhostTextContext(created, { enabled: options.enabled ?? true, learnable: false });
  // The caret at the end of the empty last paragraph, where writing continues.
  created.commands.setTextSelection(created.state.doc.content.size - 1);
  editor = created;
  return created;
}

/** Types `text` as one local insertion and lets the idle pause pass. */
function typeAndPause(target: Editor, text: string): void {
  act(() => {
    target.commands.insertContent(text);
  });
  act(() => {
    vi.advanceTimersByTime(IDLE_MS + 10);
  });
}

function ghostElement(target: Editor): HTMLElement | null {
  return target.view.dom.querySelector('[data-ghost-text]');
}

beforeEach(() => {
  vi.useFakeTimers();
  resetAnnouncements();
});

afterEach(() => {
  editor?.destroy();
  editor = null;
  vi.useRealTimers();
  document.body.replaceChildren();
});

describe('showing a phrase suggestion', () => {
  it('draws the likely ending after a pause, as muted text outside the document', () => {
    const target = makeEditor();

    typeAndPause(target, 'the quar');

    expect(currentGhostText(target.state)).toBe('terly review is');
    const ghost = ghostElement(target);
    expect(ghost).toHaveTextContent('terly review is');
    expect(ghost).toHaveClass(...GHOST_CLASS.split(' '));
    // Never read as part of the note, never editable.
    expect(ghost).toHaveAttribute('aria-hidden', 'true');
    expect(ghost).toHaveAttribute('contenteditable', 'false');
    // And not in the document: only what was typed is.
    expect(target.state.doc.lastChild?.textContent).toBe('the quar');
  });

  it('is told apart by more than colour: italic, with the accept key drawn after it', () => {
    const target = makeEditor();

    typeAndPause(target, 'the quar');

    const ghost = ghostElement(target);
    expect(ghost).toHaveClass('italic');
    const keycap = ghost?.querySelector('kbd');
    expect(keycap).toHaveTextContent('→');
    expect(keycap).toHaveAttribute('aria-hidden', 'true');
    // The keycap is drawn, never inserted.
    expect(currentGhostText(target.state)).toBe('terly review is');
  });

  it('waits for the pause rather than drawing on every keystroke', () => {
    const target = makeEditor();

    act(() => {
      target.commands.insertContent('the quar');
    });
    act(() => {
      vi.advanceTimersByTime(IDLE_MS - 50);
    });

    expect(currentGhostText(target.state)).toBeNull();
  });

  it('never reaches the shared Yjs document', () => {
    const doc = new Y.Doc();
    const target = makeEditor({ withYjs: doc });

    typeAndPause(target, 'the quar');

    expect(currentGhostText(target.state)).toBe('terly review is');
    // The last paragraph holds exactly what was typed; the ghost's words are nowhere in it.
    const fragment: Y.XmlFragment = doc.getXmlFragment('default');
    expect(fragment.toJSON()).toContain('<paragraph>the quar</paragraph>');
  });

  it('shows nothing when the preference is off', () => {
    const target = makeEditor({ enabled: false });

    typeAndPause(target, 'the quar');

    expect(currentGhostText(target.state)).toBeNull();
    expect(ghostElement(target)).toBeNull();
  });

  it('shows nothing inside a code block', () => {
    const target = makeEditor();
    act(() => {
      target.commands.setCodeBlock();
    });

    typeAndPause(target, 'the quar');

    expect(currentGhostText(target.state)).toBeNull();
  });

  it('shows nothing while a reference trigger is open, so the picker has the caret to itself', () => {
    const target = makeEditor();

    typeAndPause(target, '[[the quar');

    expect(currentGhostText(target.state)).toBeNull();
  });

  it('shows nothing while a slash command is being typed', () => {
    const target = makeEditor();

    typeAndPause(target, '/the quar');

    expect(currentGhostText(target.state)).toBeNull();
  });

  it('shows nothing in a read-only editor', () => {
    const target = makeEditor();
    target.setEditable(false);

    typeAndPause(target, 'the quar');

    expect(currentGhostText(target.state)).toBeNull();
  });

  it('shows nothing in Vim Normal mode', () => {
    const target = makeEditor();
    setVimEnabled(target.view, true);

    typeAndPause(target, 'the quar');

    expect(currentGhostText(target.state)).toBeNull();
  });

  it('shows nothing before the end of a block, where it would push the rest of the line along', () => {
    const target = makeEditor();
    act(() => {
      target.commands.insertContent('the quar later');
    });
    const end = target.state.selection.head;
    act(() => {
      target.view.dispatch(
        target.state.tr.setSelection(TextSelection.create(target.state.doc, end - ' later'.length)),
      );
      target.commands.insertContent('t');
    });
    act(() => {
      vi.advanceTimersByTime(IDLE_MS + 10);
    });

    expect(currentGhostText(target.state)).toBeNull();
  });

  it('does not appear after a caret move alone, and a caret move removes one', () => {
    const target = makeEditor();
    typeAndPause(target, 'the quar');
    expect(currentGhostText(target.state)).not.toBeNull();

    act(() => {
      target.commands.setTextSelection(1);
    });
    act(() => {
      vi.advanceTimersByTime(IDLE_MS + 10);
    });

    expect(currentGhostText(target.state)).toBeNull();
    expect(ghostElement(target)).toBeNull();
  });
});

describe('accepting and dismissing a suggestion', () => {
  it('inserts the suggestion as plain text on Right Arrow, and says so', () => {
    const target = makeEditor();
    const { result } = renderHook(() => useAnnouncement());
    typeAndPause(target, 'the quar');

    act(() => {
      target.view.dom.dispatchEvent(
        new KeyboardEvent('keydown', { key: 'ArrowRight', bubbles: true, cancelable: true }),
      );
    });

    expect(target.state.doc.lastChild?.textContent).toBe('the quarterly review is');
    expect(currentGhostText(target.state)).toBeNull();
    expect(result.current.text).toContain('Inserted suggestion: terly review is. Undo to remove.');
  });

  it('leaves Right Arrow alone when a modifier is held', () => {
    const target = makeEditor();
    typeAndPause(target, 'the quar');

    act(() => {
      target.view.dom.dispatchEvent(
        new KeyboardEvent('keydown', {
          key: 'ArrowRight',
          shiftKey: true,
          bubbles: true,
          cancelable: true,
        }),
      );
    });

    expect(target.state.doc.lastChild?.textContent).toBe('the quar');
  });

  it('dismisses on Escape without touching the document, and stops the key there', () => {
    const target = makeEditor();
    typeAndPause(target, 'the quar');
    const outer = vi.fn();
    document.body.addEventListener('keydown', outer);

    const escape = new KeyboardEvent('keydown', { key: 'Escape', bubbles: true, cancelable: true });
    act(() => {
      target.view.dom.dispatchEvent(escape);
    });

    expect(currentGhostText(target.state)).toBeNull();
    expect(target.state.doc.lastChild?.textContent).toBe('the quar');
    expect(escape.defaultPrevented).toBe(true);
    expect(outer).not.toHaveBeenCalled();
    document.body.removeEventListener('keydown', outer);
  });

  it('lets Escape through to Vim, which leaves Insert mode as it always does', () => {
    const target = makeEditor();
    setVimEnabled(target.view, true);
    // Into Insert mode, where a suggestion can show.
    act(() => {
      target.view.dom.dispatchEvent(
        new KeyboardEvent('keydown', { key: 'i', bubbles: true, cancelable: true }),
      );
    });
    typeAndPause(target, 'the quar');
    expect(currentGhostText(target.state)).not.toBeNull();

    act(() => {
      target.view.dom.dispatchEvent(
        new KeyboardEvent('keydown', { key: 'Escape', bubbles: true, cancelable: true }),
      );
    });

    expect(currentGhostText(target.state)).toBeNull();
    expect(target.state.doc.lastChild?.textContent).toBe('the quar');
  });

  it('removes the suggestion when typing continues, and offers the next one after a pause', () => {
    const target = makeEditor();
    typeAndPause(target, 'the quar');

    act(() => {
      target.commands.insertContent('terly ');
    });
    expect(currentGhostText(target.state)).toBeNull();

    act(() => {
      vi.advanceTimersByTime(IDLE_MS + 10);
    });
    expect(currentGhostText(target.state)).toBe('review is');
  });
});

describe('touch screens', () => {
  function coarsePointer(): void {
    vi.stubGlobal(
      'matchMedia',
      (query: string) =>
        ({
          matches: query.includes('coarse'),
          media: query,
          addEventListener: () => undefined,
          removeEventListener: () => undefined,
        }) as unknown as MediaQueryList,
    );
  }

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it('offers nothing on a touch screen with no keyboard, where Right Arrow cannot accept it', () => {
    coarsePointer();
    const target = makeEditor();

    typeAndPause(target, 'the quar');

    expect(currentGhostText(target.state)).toBeNull();
  });

  it('offers suggestions on a touch screen once a hardware keyboard has been used', () => {
    coarsePointer();
    const target = makeEditor();
    act(() => {
      target.view.dom.dispatchEvent(
        new KeyboardEvent('keydown', { key: 'ArrowLeft', bubbles: true, cancelable: true }),
      );
      target.commands.setTextSelection(target.state.doc.content.size - 1);
    });

    typeAndPause(target, 'the quar');

    expect(currentGhostText(target.state)).toBe('terly review is');
  });
});

describe('learning from a long document', () => {
  it('reads only a window of text around the caret', () => {
    const element = document.createElement('div');
    document.body.append(element);
    const filler = Array.from({ length: 60 }, () => `<p>${'filler words here '.repeat(50)}</p>`);
    const target = new Editor({
      element,
      extensions: [...nixEditingExtensions],
      content: `<p>far away phrase</p>${filler.join('')}<p>near</p>`,
    });

    const text = documentText(target.state.doc, null, target.state.doc.content.size - 1);

    expect(text.length).toBeLessThanOrEqual(DOCUMENT_CHARS + 1_000);
    expect(text).toContain('near');
    expect(text).not.toContain('far away phrase');
    target.destroy();
  });

  it('rebuilds its model when the browser is idle rather than while somebody types', () => {
    const idle = vi.fn((callback: () => void) => {
      callback();
      return 1;
    });
    vi.stubGlobal('requestIdleCallback', idle);
    vi.stubGlobal('cancelIdleCallback', vi.fn());
    const target = makeEditor();
    typeAndPause(target, 'the quar');
    expect(idle).not.toHaveBeenCalled();

    act(() => {
      vi.advanceTimersByTime(REBUILD_MS);
    });
    typeAndPause(target, 'terly ');

    expect(idle).toHaveBeenCalled();
    vi.unstubAllGlobals();
  });
});
