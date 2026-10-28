import { Extension } from '@tiptap/core';
import { TextSelection, type Transaction } from '@tiptap/pm/state';

/**
 * Moving a block with the keyboard, past its sibling.
 *
 * The drag handle in `note-editor.tsx` is a pointer-only affordance - HTML5 drag-and-drop has no
 * keyboard equivalent - and until now the only way to reorder a block without a mouse was to cut
 * it and paste it back, which a person has to already know is possible and loses the selection.
 * `Mod-Shift-ArrowUp`/`Mod-Shift-ArrowDown` give the same reorder a shortcut: `Mod-` because a
 * bare Shift-Arrow is text selection, which this must not steal, the idiom `column-commands.ts`
 * already uses for the same reason.
 *
 * **Top-level blocks only, one sibling at a time.** The selection's own top-level block - the
 * doc's direct child that contains it, whatever its own depth, a paragraph or a whole table -
 * swaps places with whichever sibling sits on the side moved toward. Reordering *within* a list
 * or a table is a different operation with different invariants (a list item cannot leave its
 * list this way) and is out of scope here; the command simply does not fire past a boundary it
 * cannot cross meaningfully, because there is no sibling at the document's own top level to swap
 * with the last item of a nested structure.
 */

/** Which direction the block travels; the transformation is a mirror image either way. */
export type MoveBlockDirection = 'up' | 'down';

/**
 * Swaps the selection's top-level block with its previous or next sibling, keeping the selection
 * inside the block that moved.
 *
 * `apply` mirrors the schema package's own command shape (`moveBlockToColumnTr`): `false` only
 * asks whether the move is possible, which is what `canMoveBlockUp`/`canMoveBlockDown` use to
 * disable the toolbar's "Move up"/"Move down" entries without writing anything.
 */
export function moveTopLevelBlockTr(
  tr: Transaction,
  direction: MoveBlockDirection,
  apply: boolean,
): boolean {
  const { doc, selection } = tr;
  const index = selection.$from.index(0);
  const siblingIndex = direction === 'up' ? index - 1 : index + 1;
  if (siblingIndex < 0 || siblingIndex >= doc.childCount) {
    return false;
  }
  if (!apply) {
    return true;
  }

  // The pair is adjacent either way, so it is always the lower index first: moving up swaps the
  // selection's block (the higher index) ahead of its predecessor; moving down swaps it (the
  // lower index) behind its successor. Both are the same operation on the same pair, reversed.
  const loIndex = Math.min(index, siblingIndex);
  const hiIndex = loIndex + 1;

  let loStart = 0;
  for (let i = 0; i < loIndex; i += 1) {
    loStart += doc.child(i).nodeSize;
  }
  const loNode = doc.child(loIndex);
  const hiNode = doc.child(hiIndex);
  const hiEnd = loStart + loNode.nodeSize + hiNode.nodeSize;

  // The moved block keeps its content untouched - only its position changes - so the selection's
  // offset *within* that block survives the swap unchanged; only where the block itself now
  // starts needs recomputing.
  const movedIsHi = index === hiIndex;
  const movedBlockStart = movedIsHi ? loStart + loNode.nodeSize : loStart;
  const relAnchor = selection.anchor - movedBlockStart;
  const relHead = selection.head - movedBlockStart;

  tr.replaceWith(loStart, hiEnd, [hiNode, loNode]);

  // Reversed from where it started: the block that was second is now first, and vice versa.
  const newBlockStart = movedIsHi ? loStart : loStart + hiNode.nodeSize;
  const size = tr.doc.content.size;
  const anchor = Math.min(Math.max(newBlockStart + relAnchor, 0), size);
  const head = Math.min(Math.max(newBlockStart + relHead, 0), size);
  tr.setSelection(TextSelection.between(tr.doc.resolve(anchor), tr.doc.resolve(head)));
  tr.scrollIntoView();
  return true;
}

declare module '@tiptap/core' {
  interface Commands<ReturnType> {
    moveBlock: {
      /** Move the selection's top-level block past its previous or next sibling. */
      moveBlockUp: () => ReturnType;
      moveBlockDown: () => ReturnType;
    };
  }
}

/** The commands above, bound to `Mod-Shift-ArrowUp`/`Mod-Shift-ArrowDown`. */
export const MoveBlock = Extension.create({
  name: 'moveBlock',

  addCommands() {
    return {
      moveBlockUp:
        () =>
        ({ tr, dispatch }) =>
          moveTopLevelBlockTr(tr, 'up', dispatch !== undefined),
      moveBlockDown:
        () =>
        ({ tr, dispatch }) =>
          moveTopLevelBlockTr(tr, 'down', dispatch !== undefined),
    };
  },

  addKeyboardShortcuts() {
    return {
      'Mod-Shift-ArrowUp': () => this.editor.commands.moveBlockUp(),
      'Mod-Shift-ArrowDown': () => this.editor.commands.moveBlockDown(),
    };
  },
});
