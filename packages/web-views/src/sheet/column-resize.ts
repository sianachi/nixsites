import { clampColumnWidth } from '@nix/sheet';

/**
 * The column-resize drag as data, in the folder's idiom (selection.ts,
 * windowing.ts): the grid owns the DOM wiring - handle, capture overlay,
 * commit to the shared document - and this module owns what a drag *is* and
 * how pointer positions become widths, so that part is testable as plain
 * functions.
 */

/**
 * How far one arrow keypress resizes, in pixels. Editor policy, not a
 * document constraint - which is why it lives beside the handle rather than
 * in @nix/sheet's SHEET_COLUMN_WIDTH bounds.
 */
export const COLUMN_RESIZE_STEP = 16;

/** A drag in flight; the shared document is written once, on release. */
export interface ResizeDrag {
  readonly col: number;
  readonly pointerId: number;
  readonly startX: number;
  readonly startWidth: number;
  /** The clamped live width, previewed by the whole grid while the drag lasts. */
  readonly width: number;
}

export function beginColumnResize(input: {
  readonly col: number;
  readonly pointerId: number;
  readonly clientX: number;
  readonly width: number;
}): ResizeDrag {
  return {
    col: input.col,
    pointerId: input.pointerId,
    startX: input.clientX,
    startWidth: input.width,
    width: input.width,
  };
}

/**
 * The drag after the pointer moved to `clientX`. Returns the same instance
 * when the clamped width is unchanged, so a caller storing the drag in state
 * can skip a render at the rails.
 */
export function moveColumnResize(drag: ResizeDrag, clientX: number): ResizeDrag {
  const width = clampColumnWidth(drag.startWidth + clientX - drag.startX);
  return width === drag.width ? drag : { ...drag, width };
}
