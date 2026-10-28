import {
  MIN_COLUMN_PAIR_SHARE,
  columnGrowFactors,
  columnPairShare,
  resizedColumnWidths,
} from '@nix/editor-schema';
import { dragHandleLineStates, focusRing } from '@nix/ui';
import { Extension, type Editor } from '@tiptap/core';
import type { Node as PMNode, Slice } from '@tiptap/pm/model';
import { Plugin, PluginKey, TextSelection, type EditorState } from '@tiptap/pm/state';
import { dropPoint } from '@tiptap/pm/transform';
import { Decoration, DecorationSet, type EditorView } from '@tiptap/pm/view';

import { announce } from '@nix/web-foundation/a11y/announcer';
import { COLUMN_HANDLE_INSET } from './prose';

/**
 * The column interactions: the row and its columns named for a screen reader, dividers you can
 * drag or arrow, drops that land inside a column, and the keys that give every gesture a
 * keyboard.
 *
 * The commands these call live in `@nix/editor-schema` (`column-commands.ts`), where they are
 * tested against the schema without a DOM. This file owns only what needs a browser.
 *
 * **Every drag has a key**, the rule `PaneDivider` records. The divider is the ARIA window
 * splitter - a focusable `role="separator"` with a value - so a resize is Tab, then arrows, with
 * Enter to even the split. Moving a block between columns is `Mod-Alt-Arrow`, and resizing from
 * the caret is `Mod-Alt-Shift-Arrow`.
 *
 * **`Mod-` is not decoration.** Bare `Alt-Arrow` is word-wise caret movement on macOS and Back on
 * Windows, and binding a structural edit - relocating a whole paragraph - to a reflex navigation
 * key is a claim on the platform that ADR-0031 judged worth writing down for far less. The
 * editor's own commands are all `Mod-` prefixed, so this is also the idiom already here.
 *
 * **Nothing here writes a transaction per event.** A pointer drag previews by writing
 * `flex-grow` inline on the two columns and commits once on release; a held arrow key does the
 * same and commits when the key settles. The alternative - one transaction per pointermove or
 * per key repeat - is thirty to sixty edits a second into the CRDT, each broadcast to every peer
 * and each its own undo step.
 */

/** How far one arrow press moves a divider, as percent of its pair; Shift is the coarse step. */
const STEP = 1;
const COARSE_STEP = 10;

/** How far `Mod-Alt-Shift-Arrow` resizes the caret's column: a nudge, not a jump. */
const CARET_RESIZE_STEP = 5;

/**
 * How long after the last key press a resize is written to the document.
 *
 * Long enough that a held arrow - about thirty repeats a second - commits once rather than
 * thirty times; short enough that a single deliberate press feels immediate and is announced
 * before anybody wonders whether it worked.
 */
const SETTLE_MS = 180;

const SHARE_MIN_PERCENT = Math.round(MIN_COLUMN_PAIR_SHARE * 100);
const SHARE_MAX_PERCENT = 100 - SHARE_MIN_PERCENT;

function clampShare(share: number): number {
  return Math.min(1 - MIN_COLUMN_PAIR_SHARE, Math.max(MIN_COLUMN_PAIR_SHARE, share));
}

/** The caret's column: its row, where that row starts, and which column of it the caret is in. */
function caretColumn(
  state: EditorState,
): { readonly rowPos: number; readonly row: PMNode; readonly index: number } | null {
  const $from = state.selection.$from;
  for (let depth = $from.depth; depth > 0; depth -= 1) {
    if ($from.node(depth).type.name === 'column') {
      const row = $from.node(depth - 1);
      if (row.type.name !== 'columnBlock') {
        return null;
      }
      return { rowPos: $from.before(depth - 1), row, index: $from.index(depth - 1) };
    }
  }
  return null;
}

/** Where each column of `row` starts, in document positions. */
function columnPositions(row: PMNode, rowPos: number): number[] {
  const positions: number[] = [];
  let offset = rowPos + 1;
  for (let index = 0; index < row.childCount; index += 1) {
    positions.push(offset);
    offset += row.child(index).nodeSize;
  }
  return positions;
}

/** The rendered element of the column at `pos`, when the view has drawn one. */
function columnElement(view: EditorView, pos: number): HTMLElement | null {
  const dom = view.nodeDOM(pos);
  return dom instanceof HTMLElement ? dom : null;
}

/**
 * Where a dropped block should land when the pointer is inside a column, or `null` to leave the
 * drop to ProseMirror's default handling.
 *
 * The default asks `dropPoint` for a fit and takes whatever depth it finds - which, at a
 * column's isolating edge, can be beside the row rather than inside the column the pointer is
 * visibly over. This keeps the drop in that column: `dropPoint`'s answer is accepted only if it
 * stays inside, and otherwise the block lands at the boundary nearest the pointer.
 *
 * **A slice carrying a row of columns is refused outright.** `Column.content` is `block*` and
 * `ColumnBlock.group` is `block`, so the schema would take a row inside a column happily - and
 * that shape is one the product has declared it does not draw: `insertColumnBlock` refuses to
 * mint it, the repair unwraps it wherever it appears, and the handles would render an inner
 * divider that resizes a column inside a column. One invariant, enforced everywhere it can
 * arrive.
 *
 * Open slices - a dragged text range with torn edges - are left to the default, which knows how
 * to knit them; this path exists for whole blocks, which is what column composition is for.
 *
 * Exported for its tests: jsdom performs no layout, so the event path cannot be exercised there,
 * but every position decision can.
 */
export function columnDropTarget(doc: PMNode, pos: number, slice: Slice): number | null {
  if (slice.openStart > 0 || slice.openEnd > 0 || slice.content.childCount === 0) {
    return null;
  }

  // Counted rather than flagged: an assignment inside the callback is invisible to the
  // narrowing, and a boolean would read as a constant afterwards. Only the count is used - what
  // was wrong with the slice does not change the answer, which is "not this path".
  const refusals = [0];
  slice.content.forEach((child) => {
    if (!child.isBlock || child.type.name === 'columnBlock') {
      refusals.push(1);
    }
    child.descendants((node) => {
      if (node.type.name === 'columnBlock') {
        refusals.push(1);
        return false;
      }
      return true;
    });
  });
  if (refusals.length > 1) {
    return null;
  }

  const $pos = doc.resolve(pos);
  let depth: number | null = null;
  for (let d = $pos.depth; d > 0; d -= 1) {
    if ($pos.node(d).type.name === 'column') {
      depth = d;
      break;
    }
  }
  if (depth === null) {
    return null;
  }

  const point = dropPoint(doc, pos, slice);
  if (point !== null) {
    const $point = doc.resolve(point);
    if ($point.depth >= depth && $point.start(depth) === $pos.start(depth)) {
      return point;
    }
  }

  // The boundary after the block the pointer is over, or the position itself when the pointer
  // sits between the column's blocks already.
  return $pos.depth > depth ? $pos.after(depth + 1) : pos;
}

/** Wires `columnDropTarget` to the real drop event. */
function columnDropPlugin(): Plugin {
  return new Plugin({
    key: new PluginKey('columnDrop'),
    props: {
      handleDrop(view, event, slice, moved) {
        const coords = view.posAtCoords({ left: event.clientX, top: event.clientY });
        if (coords === null) {
          return false;
        }
        const target = columnDropTarget(view.state.doc, coords.pos, slice);
        if (target === null) {
          return false;
        }

        const tr = view.state.tr;
        if (moved) {
          // The block is moving, not copying: take it out first, then land the insertion
          // through the deletion's mapping so it cannot drift.
          tr.deleteSelection();
        }
        const insertAt = tr.mapping.map(target);
        tr.insert(insertAt, slice.content);
        tr.setSelection(
          TextSelection.near(tr.doc.resolve(Math.min(insertAt + 1, tr.doc.content.size)), 1),
        );
        view.dispatch(tr.scrollIntoView());
        return true;
      },
    },
  });
}

/**
 * A resize in progress, whether it is being dragged or arrowed.
 *
 * Held per editor rather than per handle because the caret shortcuts resize a row no handle is
 * focused on, and both paths have to settle into the same single transaction.
 */
interface PendingResize {
  readonly rowPos: number;
  readonly index: number;
  share: number;
  timer: ReturnType<typeof setTimeout> | null;
  /** The columns whose inline `flex-grow` is standing in for the width, so it can be undone. */
  readonly preview: readonly [HTMLElement | null, HTMLElement | null];
}

const pendingResizes = new WeakMap<EditorView, PendingResize>();

/** The drag in flight for a view, so an unmount can end it rather than leave its listeners on. */
const liveGestures = new WeakMap<EditorView, AbortController>();

/** Puts the pair's inline preview back, so the document's own widths render again. */
function clearPreview(pending: PendingResize): void {
  for (const element of pending.preview) {
    if (element !== null) {
      element.style.flexGrow = '';
    }
  }
}

/**
 * Writes the pending share to the document, announces where it landed, and forgets it.
 *
 * The inline preview comes off *first*: every path out of this function has to leave the
 * document rendering its own widths, including the paths where nothing is written at all - a row
 * that has since been deleted, or a share the arithmetic refuses. A preview left behind is a
 * column stuck at a width the document does not hold.
 */
function commitResize(view: EditorView, editor: Editor): void {
  const pending = pendingResizes.get(view);
  if (pending === undefined) {
    return;
  }
  if (pending.timer !== null) {
    clearTimeout(pending.timer);
  }
  pendingResizes.delete(view);
  clearPreview(pending);

  const row = view.state.doc.nodeAt(pending.rowPos);
  if (row?.type.name !== 'columnBlock') {
    return;
  }
  const widths = resizedColumnWidths(row, pending.index, clampShare(pending.share));
  if (widths === null) {
    return;
  }

  editor.commands.setColumnBlockWidths({ pos: pending.rowPos, widths });

  const percent = Math.round(clampShare(pending.share) * 100);
  announce(
    `Columns ${String(pending.index + 1)} and ${String(pending.index + 2)}: ` +
      `${String(percent)} percent to column ${String(pending.index + 1)}.`,
  );
}

/**
 * Records where a resize has got to, draws it, and schedules the write.
 *
 * The preview is inline `flex-grow` on the two columns - the same property the committed width
 * renders as - so what a person sees during the gesture is what the document will hold when it
 * settles.
 */
function previewResize(
  view: EditorView,
  editor: Editor,
  rowPos: number,
  index: number,
  share: number,
  settle: boolean,
): void {
  const row = view.state.doc.nodeAt(rowPos);
  if (row?.type.name !== 'columnBlock') {
    return;
  }

  const existing = pendingResizes.get(view);
  if (existing !== undefined && (existing.rowPos !== rowPos || existing.index !== index)) {
    // A different divider: the one in flight settles now rather than being abandoned mid-gesture.
    commitResize(view, editor);
  }

  const positions = columnPositions(row, rowPos);
  const left = columnElement(view, positions[index] ?? -1);
  const right = columnElement(view, positions[index + 1] ?? -1);

  const factors = columnGrowFactors(row);
  const pairGrow = (factors[index] ?? 1) + (factors[index + 1] ?? 1);
  const clamped = clampShare(share);
  if (left !== null) {
    left.style.flexGrow = String(pairGrow * clamped);
  }
  if (right !== null) {
    right.style.flexGrow = String(pairGrow * (1 - clamped));
  }

  const previous = pendingResizes.get(view);
  if (previous?.timer != null) {
    clearTimeout(previous.timer);
  }

  const pending: PendingResize = {
    rowPos,
    index,
    share: clamped,
    timer: null,
    preview: [left, right],
  };
  pendingResizes.set(view, pending);

  if (settle) {
    pending.timer = setTimeout(() => {
      commitResize(view, editor);
    }, SETTLE_MS);
  }
}

/** The share a gesture should move from: whatever is pending, or what the document holds. */
function currentShare(view: EditorView, rowPos: number, index: number): number {
  const pending = pendingResizes.get(view);
  if (pending?.rowPos === rowPos && pending.index === index) {
    return pending.share;
  }
  const row = view.state.doc.nodeAt(rowPos);
  return row?.type.name === 'columnBlock' ? columnPairShare(row, index) : 0.5;
}

/**
 * Says that an arrow press did nothing because the divider is already at its bound.
 *
 * Without this, the two are indistinguishable: a refused move writes no transaction, nothing
 * rerenders, and the value a screen reader last heard is the value it hears next. "At the limit"
 * has to sound different from "broken".
 */
function announceBound(index: number, atMinimum: boolean): void {
  announce(
    `Column ${String(index + 1)} is at its ${atMinimum ? 'narrowest' : 'widest'}: ` +
      `${String(atMinimum ? SHARE_MIN_PERCENT : SHARE_MAX_PERCENT)} percent of the pair.`,
  );
}

/** The row and divider a handle currently sits at, asked of the position the view maintains. */
function handleTarget(
  view: EditorView,
  getPos: () => number,
): { readonly rowPos: number; readonly row: PMNode; readonly index: number } | null {
  const at = getPos();
  if (at < 0 || at > view.state.doc.content.size) {
    return null;
  }
  const $at = view.state.doc.resolve(at);
  const row = $at.parent;
  if (row.type.name !== 'columnBlock') {
    return null;
  }
  const index = $at.index() - 1;
  return index < 0 ? null : { rowPos: $at.before($at.depth), row, index };
}

/** The id a column carries, so a divider can say which two it controls. */
function columnId(ordinal: number, index: number): string {
  return `nix-column-${String(ordinal)}-${String(index)}`;
}

/** Every handle currently drawn, so their values can be refreshed without rebuilding them. */
const liveHandles = new WeakMap<EditorView, Set<HTMLElement>>();
const handlePositions = new WeakMap<HTMLElement, () => number>();

/**
 * Rewrites what each handle reports.
 *
 * **Mutated rather than rebuilt.** The value on a separator changes on every resize, so putting
 * it in the decoration's key - which is what makes prosemirror-view replace the element - would
 * destroy and recreate the very element that is focused, dropping focus to the body mid-gesture
 * and killing an in-flight drag. Six attributes on a live element cost nothing and keep both.
 */
function refreshHandles(view: EditorView): void {
  const handles = liveHandles.get(view);
  if (handles === undefined) {
    return;
  }

  for (const handle of handles) {
    if (!handle.isConnected) {
      handles.delete(handle);
      continue;
    }
    const getPos = handlePositions.get(handle);
    if (getPos !== undefined) {
      applyHandleValues(view, handle, getPos);
    }
  }
}

/** What one handle reports right now: which two columns it moves, and where it stands. */
function applyHandleValues(view: EditorView, handle: HTMLElement, getPos: () => number): void {
  const target = handleTarget(view, getPos);
  if (target === null) {
    return;
  }

  const share = Math.round(columnPairShare(target.row, target.index) * 100);
  // Written only when it differs. Some screen readers announce a mutation of `aria-valuenow` on
  // a focused separator whether or not the value moved, so an unconditional write turns a
  // colleague typing at ten keystrokes a second into ten announcements of a number that did not
  // change.
  setIfChanged(handle, 'aria-valuenow', String(share));
  setIfChanged(
    handle,
    'aria-valuetext',
    `${String(share)} percent to column ${String(target.index + 1)}`,
  );
  setIfChanged(
    handle,
    'aria-label',
    `Resize columns ${String(target.index + 1)} and ${String(target.index + 2)}`,
  );
}

function setIfChanged(element: HTMLElement, name: string, value: string): void {
  if (element.getAttribute(name) !== value) {
    element.setAttribute(name, value);
  }
}

/**
 * One divider, as a raw element: the handles live between ProseMirror-rendered columns, outside
 * React's tree - the same constraint the toggle chevron records in `note-editor.tsx`.
 *
 * `contenteditable="false"` with a `tabindex` is what makes a control inside editable content
 * reachable at all. Nothing about the row is captured here: the position comes from `getPos`,
 * which the view keeps current through every edit, so a colleague typing above this row does not
 * invalidate the element - which is what lets it stay focused and keep a drag alive.
 */
function createHandle(
  view: EditorView,
  editor: Editor,
  getPos: () => number,
  ordinal: number,
  dividerIndex: number,
): HTMLElement {
  const handle = document.createElement('div');
  handle.setAttribute('role', 'separator');
  handle.setAttribute('tabindex', '0');
  handle.setAttribute('contenteditable', 'false');
  handle.setAttribute('aria-orientation', 'vertical');
  handle.setAttribute('aria-valuemin', String(SHARE_MIN_PERCENT));
  handle.setAttribute('aria-valuemax', String(SHARE_MAX_PERCENT));
  handle.setAttribute(
    'aria-controls',
    `${columnId(ordinal, dividerIndex)} ${columnId(ordinal, dividerIndex + 1)}`,
  );
  handle.dataset.columnHandle = `${String(ordinal)}:${String(dividerIndex)}`;

  handle.className = [
    // The 8px band, pulled back into the row's own gutter - see `COLUMN_HANDLE_INSET`.
    `group relative ${COLUMN_HANDLE_INSET} hidden w-2 shrink-0 cursor-col-resize touch-none md:block`,
    // The hit strip. 8px alone is a third of WCAG 2.2's 24px target minimum, and a divider is
    // exactly the control a shaky hand misses - the same reasoning, and the same pseudo-element,
    // as `PaneDivider`. 8px of padding either side fills the gutter without reaching into a
    // column's text.
    'before:absolute before:inset-y-0 before:-inset-x-2',
    focusRing,
  ].join(' ');

  const line = document.createElement('span');
  line.setAttribute('aria-hidden', 'true');
  line.className = [
    'pointer-events-none absolute inset-y-0 left-1/2 w-px -translate-x-1/2 bg-divider transition-colors',
    // The shared drag-handle states, which carry the pressed step this element used to omit.
    dragHandleLineStates,
  ].join(' ');
  handle.append(line);

  // Where the divider was before it was evened, so the same key puts it back - the one gesture a
  // pointer cannot offer, because a drag reaches exactly half only by aiming at it.
  let beforeEven: number | null = null;

  handle.addEventListener('keydown', (event) => {
    const target = handleTarget(view, getPos);
    if (target === null) {
      return;
    }
    const share = currentShare(view, target.rowPos, target.index);
    const step = (event.shiftKey ? COARSE_STEP : STEP) / 100;

    let next: number | null = null;
    if (event.key === 'ArrowLeft') {
      next = share - step;
    } else if (event.key === 'ArrowRight') {
      next = share + step;
    } else if (event.key === 'Home') {
      next = MIN_COLUMN_PAIR_SHARE;
    } else if (event.key === 'End') {
      next = 1 - MIN_COLUMN_PAIR_SHARE;
    } else if (event.key === 'Enter' || event.key === ' ') {
      if (Math.round(share * 100) === 50) {
        next = beforeEven ?? 1 - MIN_COLUMN_PAIR_SHARE;
        beforeEven = null;
      } else {
        beforeEven = share;
        next = 0.5;
      }
    }

    if (next === null) {
      return;
    }
    event.preventDefault();
    event.stopPropagation();

    if (clampShare(next) === clampShare(share) && next !== share) {
      announceBound(target.index, next < share);
      return;
    }

    previewResize(view, editor, target.rowPos, target.index, next, true);
  });

  // A held arrow settles on its own after `SETTLE_MS`; letting go settles it immediately, which
  // is what makes a single press feel like a single edit.
  handle.addEventListener('keyup', () => {
    commitResize(view, editor);
  });

  handle.addEventListener('blur', () => {
    commitResize(view, editor);
  });

  handle.addEventListener('pointerdown', (event) => {
    // Only the primary button, for the reason `PaneDivider` gives: a right-click must not start
    // a drag nothing ends.
    if (event.button !== 0) {
      return;
    }
    const target = handleTarget(view, getPos);
    if (target === null) {
      return;
    }
    const positions = columnPositions(target.row, target.rowPos);
    const previous = columnElement(view, positions[target.index] ?? -1);
    const next = columnElement(view, positions[target.index + 1] ?? -1);
    if (previous === null || next === null) {
      return;
    }

    event.preventDefault();
    // Capture, so the drag survives the pointer leaving an eight-pixel band, which it does
    // immediately. Feature-checked because jsdom implements no pointer capture at all, and an
    // unguarded call throws out of the handler before a single listener is attached - which
    // would leave the teardown path below untestable in the environment the tests run in.
    if (typeof handle.setPointerCapture === 'function') {
      handle.setPointerCapture(event.pointerId);
    }
    handle.dataset.dragging = '';

    // Every listener this gesture adds, on the handle and on the window, hangs off one signal.
    // Without it the two capture-phase window listeners come off only on pointerup or
    // pointercancel - neither of which fires if the editor unmounts mid-drag - and a scroll
    // listener left on `window` retains this closure and, through it, the view, the editor and
    // both column elements: the whole editor graph held by a global. The plugin's `destroy`
    // aborts whatever is still live.
    const gesture = new AbortController();
    liveGestures.set(view, gesture);
    const { signal } = gesture;
    // Named on the editor root for the duration, so the block drag handle's own hit-test can
    // bail out instead of running `elementsFromPoint` through a resize it has no part in.
    view.dom.setAttribute('data-column-dragging', '');

    // The pair's own region, measured rather than derived - the two columns already know where
    // they are. Re-measured when the page has moved under the gesture: a colleague's edit above
    // or a scroll shifts the origin these coordinates are read against, and a stale one drifts.
    let pairStart = previous.getBoundingClientRect().left;
    let pairLength = next.getBoundingClientRect().right - pairStart;
    let stale = false;
    const markStale = (): void => {
      stale = true;
    };
    window.addEventListener('scroll', markStale, { capture: true, signal });
    window.addEventListener('resize', markStale, { signal });

    const shareAt = (clientX: number): number => {
      if (stale) {
        pairStart = previous.getBoundingClientRect().left;
        pairLength = next.getBoundingClientRect().right - pairStart;
        stale = false;
      }
      return pairLength > 0 ? clampShare((clientX - pairStart) / pairLength) : 0.5;
    };

    const onMove = (moveEvent: PointerEvent): void => {
      const live = handleTarget(view, getPos);
      if (live === null) {
        return;
      }
      // No settle timer: a drag ends when the pointer is released, not when it pauses.
      previewResize(view, editor, live.rowPos, live.index, shareAt(moveEvent.clientX), false);
    };

    const stopTracking = (): void => {
      gesture.abort();
      if (liveGestures.get(view) === gesture) {
        liveGestures.delete(view);
      }
      delete handle.dataset.dragging;
      view.dom.removeAttribute('data-column-dragging');
    };

    const onUp = (upEvent: PointerEvent): void => {
      stopTracking();
      const live = handleTarget(view, getPos);
      if (live !== null) {
        previewResize(view, editor, live.rowPos, live.index, shareAt(upEvent.clientX), false);
      }
      commitResize(view, editor);
    };

    const onCancel = (): void => {
      // A gesture the system took away - an incoming call, a rejected palm - puts the widths back
      // rather than committing wherever the pointer happened to be. `pointercancel` also carries
      // stale coordinates in some engines, so committing from it can slam a column to a bound
      // nobody dragged to.
      stopTracking();
      const pending = pendingResizes.get(view);
      if (pending !== undefined) {
        if (pending.timer !== null) {
          clearTimeout(pending.timer);
        }
        clearPreview(pending);
        pendingResizes.delete(view);
      }
    };

    handle.addEventListener('pointermove', onMove, { signal });
    handle.addEventListener('pointerup', onUp, { signal });
    handle.addEventListener('pointercancel', onCancel, { signal });
  });

  // The values it starts with. `refreshHandles` keeps them true from here on; without this the
  // element would exist for one render reporting nothing at all.
  applyHandleValues(view, handle, getPos);

  handlePositions.set(handle, getPos);
  let handles = liveHandles.get(view);
  if (handles === undefined) {
    handles = new Set();
    liveHandles.set(view, handles);
  }
  handles.add(handle);

  return handle;
}

/**
 * Every decoration a row needs: the names, and the dividers.
 *
 * **The names are here rather than in the schema's `renderHTML`** for two reasons. The
 * collaboration service builds the same node list in Node and has no business knowing what a row
 * is called for a screen reader; and the label has to count its siblings ("column 2 of 3"),
 * which a node's own renderer cannot see. Without them the only thing announcing that a document
 * has columns at all is the divider - which is hidden below the medium breakpoint, where the row
 * stacks and there is nothing to divide. A phone reader would hear a run of unrelated
 * paragraphs.
 */
function buildDecorations(doc: PMNode, editor: Editor): DecorationSet {
  const decorations: Decoration[] = [];
  let ordinal = 0;

  doc.descendants((node, pos) => {
    if (node.isTextblock) {
      return false;
    }
    if (node.type.name !== 'columnBlock') {
      return true;
    }

    const rowOrdinal = ordinal;
    ordinal += 1;

    decorations.push(
      Decoration.node(pos, pos + node.nodeSize, {
        role: 'group',
        'aria-label': `Row of ${String(node.childCount)} columns`,
      }),
    );

    let offset = pos + 1;
    for (let index = 0; index < node.childCount; index += 1) {
      const column = node.child(index);
      decorations.push(
        Decoration.node(offset, offset + column.nodeSize, {
          id: columnId(rowOrdinal, index),
          role: 'group',
          'aria-label': `Column ${String(index + 1)} of ${String(node.childCount)}`,
        }),
      );
      offset += column.nodeSize;

      if (index < node.childCount - 1) {
        const dividerIndex = index;
        decorations.push(
          Decoration.widget(
            offset,
            (widgetView, getPos) =>
              // `getPos` is nullable in the type only: prosemirror-view passes a live accessor
              // to a widget it is drawing. A position of -1 reads as "gone" everywhere below.
              createHandle(widgetView, editor, () => getPos() ?? -1, rowOrdinal, dividerIndex),
            {
              // Keyed by *which* divider this is, never by where it is or what it reports. A key
              // carrying the row's document position changes whenever anything above is typed,
              // and prosemirror-view answers a changed key by destroying the element and building
              // a new one - dropping focus and killing a live drag on a colleague's keystroke.
              key: `column-handle:${String(rowOrdinal)}:${String(dividerIndex)}`,
              // The handle is a control, not content: the editor must not route its keys through
              // the document's own keymap, and the selection must not try to include it.
              stopEvent: () => true,
              ignoreSelection: true,
              side: 0,
            },
          ),
        );
      }
    }

    // A nested row would be a shape nothing here can draw - the drop path refuses it and the
    // repair unwraps it - so there is nothing to decorate inside this one.
    return false;
  });

  return DecorationSet.create(doc, decorations);
}

/** Whether the change touched a row of columns, in which case the decorations are rebuilt. */
function touchedARow(oldDoc: PMNode, newDoc: PMNode): boolean {
  const touched: true[] = [];

  const walk = (old: PMNode, cur: PMNode): void => {
    if (touched.length > 0) {
      return;
    }
    const oldSize = old.childCount;

    outer: for (let index = 0, scanned = 0; index < cur.childCount; index += 1) {
      const child = cur.child(index);
      for (let scan = scanned, end = Math.min(oldSize, index + 3); scan < end; scan += 1) {
        if (old.child(scan) === child) {
          scanned = scan + 1;
          continue outer;
        }
      }

      if (child.type.name === 'columnBlock') {
        touched.push(true);
        return;
      }
      if (child.isTextblock) {
        continue;
      }

      const previous = scanned < oldSize ? old.child(scanned) : null;
      walk(previous?.sameMarkup(child) === true ? previous : child.type.create(), child);
      if (touched.length > 0) {
        return;
      }
    }
  };

  walk(oldDoc, newDoc);
  return touched.length > 0;
}

const columnDecorationsKey = new PluginKey<DecorationSet>('columnDecorations');

/**
 * The decorations, held in plugin state and mapped rather than recomputed.
 *
 * **`props.decorations` runs on every `updateState`, selection-only ones included**, so building
 * the set there walked the whole document on every arrow key and every mouse-selection move.
 * Held here, a selection change costs a lookup; a change that leaves every row alone costs the
 * mapping, which is what already moves every other position in the editor; and only a change
 * that actually touched a row rebuilds - with keys stable enough that prosemirror-view reuses
 * the handle elements it already has.
 */
function columnDecorationsPlugin(editor: Editor): Plugin<DecorationSet> {
  return new Plugin<DecorationSet>({
    key: columnDecorationsKey,

    state: {
      init: (_config, state) => buildDecorations(state.doc, editor),
      apply: (tr, set, oldState, newState) => {
        if (!tr.docChanged) {
          return set;
        }
        return touchedARow(oldState.doc, newState.doc)
          ? buildDecorations(newState.doc, editor)
          : set.map(tr.mapping, tr.doc);
      },
    },

    props: {
      decorations(state) {
        return columnDecorationsKey.getState(state);
      },

      handleDOMEvents: {
        // Letting go of the key settles a caret resize immediately, so a single deliberate press
        // is a single edit rather than one that lands 180ms later. The timer remains the backstop
        // for a key held down and never released over the editor.
        keyup(view) {
          // Not during a drag: releasing a modifier mid-gesture would split one drag into two
          // transactions, two undo steps and two announcements.
          if (!view.dom.hasAttribute('data-column-dragging')) {
            commitResize(view, editor);
          }
          return false;
        },
      },
    },

    view: (view) => ({
      update: (updated: EditorView, previous: EditorState) => {
        // The values the handles report follow the widths, and the widths only move when the
        // document does.
        if (!previous.doc.eq(updated.state.doc)) {
          refreshHandles(updated);
        }
      },

      // An editor can go away mid-gesture: a route change, a colleague deleting the item, a hot
      // reload. Nothing here may outlive it - not a drag's listeners, and not a settle timer
      // about to write to a destroyed view.
      destroy: () => {
        liveGestures.get(view)?.abort();
        liveGestures.delete(view);

        const pending = pendingResizes.get(view);
        if (pending?.timer != null) {
          clearTimeout(pending.timer);
        }
        pendingResizes.delete(view);
        liveHandles.delete(view);
      },
    }),
  });
}

/** Runs the move command and says where the block landed, since nothing on screen reads it out. */
function moveBlock(editor: Editor, direction: 'previous' | 'next'): boolean {
  if (!editor.commands.moveBlockToColumn(direction)) {
    return false;
  }
  const landed = caretColumn(editor.state);
  if (landed !== null) {
    announce(`Moved into column ${String(landed.index + 1)} of ${String(landed.row.childCount)}.`);
  }
  return true;
}

/**
 * Resizes the caret's column by one step without leaving the text: right widens it, left narrows
 * it, against its right-hand neighbour - or the left-hand one when it is the last column.
 *
 * Previewed and settled exactly like a handle press, so holding the key is one edit.
 */
function resizeFromCaret(editor: Editor, deltaPercent: number): boolean {
  const found = caretColumn(editor.state);
  if (found === null || found.row.childCount < 2) {
    return false;
  }

  const divider = found.index < found.row.childCount - 1 ? found.index : found.index - 1;
  const caretOwnsLeft = found.index === divider;
  const view = editor.view;
  const share = currentShare(view, found.rowPos, divider);
  const next = share + (caretOwnsLeft ? deltaPercent : -deltaPercent) / 100;

  if (clampShare(next) === clampShare(share)) {
    announceBound(found.index, caretOwnsLeft ? next < share : next > share);
    return true;
  }

  previewResize(view, editor, found.rowPos, divider, next, true);
  return true;
}

/**
 * The editor-side half of columns. The schema half - the commands and the repair - is
 * `ColumnEditing` from `@nix/editor-schema`; `nixEditingExtensions` pairs it with the schema,
 * and `note-editor.tsx` adds this one alongside.
 */
export const ColumnControls = Extension.create({
  name: 'columnControls',

  addKeyboardShortcuts() {
    return {
      // See the header on why these are `Mod-` prefixed and bare `Alt-Arrow` is left alone.
      'Mod-Alt-ArrowLeft': () => moveBlock(this.editor, 'previous'),
      'Mod-Alt-ArrowRight': () => moveBlock(this.editor, 'next'),
      'Mod-Alt-Shift-ArrowLeft': () => resizeFromCaret(this.editor, -CARET_RESIZE_STEP),
      'Mod-Alt-Shift-ArrowRight': () => resizeFromCaret(this.editor, CARET_RESIZE_STEP),
      'Mod-Alt-Enter': () => this.editor.commands.addColumnToRow(),
      'Mod-Alt-Backspace': () => this.editor.commands.removeColumnFromRow(),
    };
  },

  addProseMirrorPlugins() {
    return [columnDecorationsPlugin(this.editor), columnDropPlugin()];
  },
});
