import { nixSchema, parseDocument } from '@nix/editor-schema';
import { EditorState, TextSelection, type Transaction } from '@tiptap/pm/state';
import { describe, expect, it } from 'vitest';

import { moveTopLevelBlockTr } from '@nix/web-editor/editor/move-block';
import { paragraph } from '@nix/web-foundation/testing/paragraph-fixture';

/**
 * `MoveBlock`'s transform, at the layer that has no DOM.
 *
 * The drag handle it stands in for is asserted by dragging in `note-editor.test.tsx`; what this
 * checks is the arithmetic the keyboard command and the toolbar's "Move up"/"Move down" both
 * call - that the two top-level blocks around the selection actually swap, that a block at the
 * document's edge refuses rather than swapping with nothing, and that the selection lands back
 * inside whichever block moved rather than wherever the byte count happened to leave it.
 */

function heading(text: string, level = 1): unknown {
  return { type: 'heading', attrs: { level }, content: [{ type: 'text', text }] };
}

function stateOf(content: readonly unknown[]): EditorState {
  const parsed = parseDocument({ type: 'doc', content });
  if (!parsed.ok) {
    throw new Error(`The fixture does not parse: ${parsed.error}`);
  }
  return EditorState.create({ schema: nixSchema, doc: parsed.document });
}

/** Puts the caret at the first position inside the text block that reads `text`. */
function withCaretIn(state: EditorState, text: string): EditorState {
  const found: number[] = [];
  state.doc.descendants((node, pos) => {
    if (found.length === 0 && node.isText && node.text === text) {
      found.push(pos);
    }
    return found.length === 0;
  });
  const at = found[0];
  if (at === undefined) {
    throw new Error(`No text node reads "${text}".`);
  }
  return state.apply(state.tr.setSelection(TextSelection.create(state.doc, at)));
}

function applied(state: EditorState, transform: (tr: Transaction) => boolean): EditorState {
  const tr = state.tr;
  transform(tr);
  return state.apply(tr);
}

/** The document's top-level blocks, as the plain text each one holds. */
function topLevelText(state: EditorState): readonly string[] {
  const blocks: string[] = [];
  state.doc.forEach((node) => {
    blocks.push(node.textContent);
  });
  return blocks;
}

describe('moveTopLevelBlockTr', () => {
  it('swaps the caret block up past its previous sibling', () => {
    const state = withCaretIn(stateOf([paragraph('first'), paragraph('second')]), 'second');

    const moved = applied(state, (tr) => moveTopLevelBlockTr(tr, 'up', true));

    expect(topLevelText(moved)).toEqual(['second', 'first']);
  });

  it('swaps the caret block down past its next sibling', () => {
    const state = withCaretIn(stateOf([paragraph('first'), paragraph('second')]), 'first');

    const moved = applied(state, (tr) => moveTopLevelBlockTr(tr, 'down', true));

    expect(topLevelText(moved)).toEqual(['second', 'first']);
  });

  it('moves a block of a different kind past its sibling without losing either one', () => {
    const state = withCaretIn(
      stateOf([heading('Title'), paragraph('body'), paragraph('more')]),
      'body',
    );

    const moved = applied(state, (tr) => moveTopLevelBlockTr(tr, 'up', true));

    expect(topLevelText(moved)).toEqual(['body', 'Title', 'more']);
  });

  it('keeps the selection inside the block that moved, at the same offset within it', () => {
    const state = withCaretIn(stateOf([paragraph('first'), paragraph('second')]), 'second');
    // The caret sits at the start of "second"; nudge it two characters in first.
    const nudged = state.apply(
      state.tr.setSelection(TextSelection.create(state.doc, state.selection.from + 2)),
    );

    const moved = applied(nudged, (tr) => moveTopLevelBlockTr(tr, 'up', true));

    // "second" is now the document's first block; the caret should still read as two characters
    // into it, i.e. sitting between "se" and "cond".
    const $caret = moved.doc.resolve(moved.selection.from);
    expect($caret.parent.textContent).toBe('second');
    expect($caret.parentOffset).toBe(2);
  });

  it('refuses to move the first block up', () => {
    const state = withCaretIn(stateOf([paragraph('first'), paragraph('second')]), 'first');

    expect(moveTopLevelBlockTr(state.tr, 'up', true)).toBe(false);
    expect(topLevelText(state)).toEqual(['first', 'second']);
  });

  it('refuses to move the last block down', () => {
    const state = withCaretIn(stateOf([paragraph('first'), paragraph('second')]), 'second');

    expect(moveTopLevelBlockTr(state.tr, 'down', true)).toBe(false);
    expect(topLevelText(state)).toEqual(['first', 'second']);
  });

  it('refuses on a document with only one block', () => {
    const state = withCaretIn(stateOf([paragraph('only')]), 'only');

    expect(moveTopLevelBlockTr(state.tr, 'up', true)).toBe(false);
    expect(moveTopLevelBlockTr(state.tr, 'down', true)).toBe(false);
  });

  it('reports whether a move is possible without writing anything, when apply is false', () => {
    const state = withCaretIn(stateOf([paragraph('first'), paragraph('second')]), 'second');

    expect(moveTopLevelBlockTr(state.tr, 'up', false)).toBe(true);
    expect(topLevelText(state)).toEqual(['first', 'second']);
  });
});
