import { SHEET_COLUMN_WIDTH, clampColumnWidth, columnLetters } from '@nix/sheet';
import { cn, dragHandleLineStates, fieldLabel, focusRingInset } from '@nix/ui';
import {
  Fragment,
  type KeyboardEvent as ReactKeyboardEvent,
  type PointerEvent as ReactPointerEvent,
  type ReactNode,
  type RefObject,
} from 'react';

import { COLUMN_RESIZE_STEP } from './column-resize';
import type { SheetData } from './use-sheet';

export const RESIZE_HINT_ID = 'sheet-resize-keyboard-hint';

export interface SheetColumnHeaderProps {
  readonly sheet: SheetData;
  readonly scrollerRef: RefObject<HTMLDivElement | null>;
  readonly visibleCols: readonly number[];
  readonly widths: readonly number[];
  readonly offsets: readonly number[];
  readonly totalWidth: number;
  readonly scrollLeft: number;
  readonly activeCol: number;
  readonly resizingCol: number | null;
  readonly defaultWidth: number;
  readonly dragging: boolean;
  readonly onCancelResize: () => void;
  readonly onHandlePointerDown: (
    col: number,
    width: number,
    event: ReactPointerEvent<HTMLDivElement>,
  ) => void;
}

/** Column letters, pinned vertically, following horizontal scroll, each with its resize handle. */
export function SheetColumnHeader({
  sheet,
  scrollerRef,
  visibleCols,
  widths,
  offsets,
  totalWidth,
  scrollLeft,
  activeCol,
  resizingCol,
  defaultWidth,
  dragging,
  onCancelResize,
  onHandlePointerDown,
}: SheetColumnHeaderProps): ReactNode {
  /**
   * After a keyboard resize, scrolls the body the minimum that keeps the
   * column's right edge - where the focused handle sits - in view, the same
   * arithmetic the active-cell effect uses. Without it, End would park the
   * focused element past the viewport (WCAG 2.4.11).
   */
  function revealColumnEdge(col: number, width: number): void {
    const scroller = scrollerRef.current;
    if (scroller === null) {
      return;
    }
    const left = offsets[col] ?? 0;
    const right = left + width;
    if (right > scroller.scrollLeft + scroller.clientWidth) {
      scroller.scrollLeft = right - scroller.clientWidth;
    } else if (left < scroller.scrollLeft) {
      scroller.scrollLeft = left;
    }
  }

  function onHandleKeyDown(col: number, event: ReactKeyboardEvent<HTMLDivElement>): void {
    if (event.key === 'Escape') {
      // The keyboard exit from a mouse-begun drag: revert, commit nothing.
      if (dragging) {
        event.preventDefault();
        onCancelResize();
      }
      return;
    }
    const meta = event.metaKey || event.ctrlKey;
    if (meta && (event.key === 'z' || event.key === 'Z')) {
      // The grid's undo shortcut, repeated here because the handles live in
      // the header strip, outside the scroller subtree that binds it - a
      // resize must be undoable from the very element that just made it.
      event.preventDefault();
      if (event.shiftKey) {
        sheet.redo();
      } else {
        sheet.undo();
      }
      return;
    }
    if (meta && (event.key === 'y' || event.key === 'Y')) {
      event.preventDefault();
      sheet.redo();
      return;
    }
    const width = widths[col] ?? defaultWidth;
    let next: number | null = null;
    if (event.key === 'ArrowLeft' || event.key === 'ArrowDown') {
      next = width - COLUMN_RESIZE_STEP;
    } else if (event.key === 'ArrowRight' || event.key === 'ArrowUp') {
      next = width + COLUMN_RESIZE_STEP;
    } else if (event.key === 'Home') {
      next = SHEET_COLUMN_WIDTH.min;
    } else if (event.key === 'End') {
      next = SHEET_COLUMN_WIDTH.max;
    }
    if (next !== null) {
      event.preventDefault();
      sheet.setColumnWidth(col, next);
      revealColumnEdge(col, clampColumnWidth(next));
    }
  }

  // design-token-exempt: the header strip mirrors the body's scroll position and extent, runtime values with no token to draw from
  const columnStripStyle = {
    width: `${String(totalWidth)}px`,
    transform: `translateX(-${String(scrollLeft)}px)`,
  };

  return (
    <div className="absolute left-12 right-0 top-0 z-20 h-8 overflow-hidden border-b border-divider bg-surface">
      <div className="relative h-8" style={columnStripStyle}>
        {visibleCols.map((col) => {
          const width = widths[col] ?? defaultWidth;
          // design-token-exempt: a column's place and width are grid geometry computed at runtime
          const style = {
            left: `${String(offsets[col] ?? 0)}px`,
            width: `${String(width)}px`,
          };
          // design-token-exempt: the handle sits on the column's right edge, grid geometry computed at runtime
          const handleStyle = { left: `${String(offsets[col + 1] ?? 0)}px` };
          return (
            <Fragment key={col}>
              <div
                aria-hidden="true"
                className={cn(
                  'absolute top-0 flex h-8 items-center justify-center border-r border-divider',
                  fieldLabel,
                )}
                style={style}
              >
                {columnLetters(col)}
              </div>
              {/* A focusable window-splitter separator: drag it, or focus
                      it and use the arrow keys - the resize must not be a
                      pointer-only act. Tab reaches only the active column's
                      handle (a stable single stop where the person already
                      is, instead of one stop per visible column); arrows
                      resize once focused. The 12px strip is the hit area,
                      the inner line is the visual. */}
              {/* eslint-disable jsx-a11y/no-noninteractive-element-interactions --
                      Justification: ARIA defines a focusable separator with
                      aria-valuenow as the window-splitter widget; jsx-a11y
                      models separator only as the static divider. */}
              <div
                role="separator"
                aria-orientation="vertical"
                aria-label={`Resize column ${columnLetters(col)}`}
                aria-valuenow={width}
                aria-valuemin={SHEET_COLUMN_WIDTH.min}
                aria-valuemax={SHEET_COLUMN_WIDTH.max}
                aria-valuetext={`${String(width)} pixels`}
                aria-describedby={RESIZE_HINT_ID}
                tabIndex={col === activeCol ? 0 : -1}
                data-dragging={resizingCol === col ? '' : undefined}
                onPointerDown={(event) => {
                  onHandlePointerDown(col, width, event);
                }}
                onKeyDown={(event) => {
                  onHandleKeyDown(col, event);
                }}
                className={`group absolute top-0 z-10 h-8 w-3 any-pointer-coarse:w-(--control-lg) -translate-x-1/2 cursor-col-resize touch-none ${focusRingInset}`}
                style={handleStyle}
              >
                <span
                  aria-hidden="true"
                  // `w-px`, the one hairline weight every drag handle in the product draws -
                  // this used to be `w-0.5`, which read as a heavier rule than the pane
                  // divider's beside it for no reason anybody chose. See
                  // `dragHandleLineStates`.
                  className={`pointer-events-none absolute inset-y-0 left-1/2 w-px -translate-x-1/2 ${dragHandleLineStates}`}
                />
              </div>
              {/* eslint-enable jsx-a11y/no-noninteractive-element-interactions */}
            </Fragment>
          );
        })}
      </div>
    </div>
  );
}
