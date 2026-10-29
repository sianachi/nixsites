import { useEffect, useState, type Dispatch, type RefObject, type SetStateAction } from 'react';

import { type CellRef } from '@nix/sheet';
import { useColumnWidths } from '@nix/web-collections/core/column-widths';
import { columnOffsets, columnWindow, rowWindow } from '@nix/web-collections/sheet/windowing';
import { columnWidth, type SpreadsheetColumn } from './grid-model';

export interface GridViewport {
  readonly scroll: { top: number; left: number };
  readonly setScroll: Dispatch<SetStateAction<{ top: number; left: number }>>;
  readonly viewport: { width: number; height: number };
  readonly widths: readonly number[];
  readonly offsets: readonly number[];
  readonly totalWidth: number;
  readonly totalHeight: number;
  readonly visibleRows: readonly number[];
  readonly visibleCols: readonly number[];
  readonly activeTop: number;
  readonly activeLeft: number;
  readonly activeWidth: number;
}

/** Scroll position, viewport size, column geometry and the cell window they select. */
export function useGridViewport(args: {
  readonly viewId: string;
  readonly columns: readonly SpreadsheetColumn[];
  readonly rowCount: number;
  readonly rowHeight: number;
  readonly active: CellRef;
  readonly scrollerRef: RefObject<HTMLDivElement | null>;
}): GridViewport {
  const { viewId, columns, rowCount, rowHeight, active, scrollerRef } = args;
  const storedWidths = useColumnWidths(viewId);

  // Scroll and viewport state live HERE, in the grid, not in SpreadsheetView above. This is
  // load-bearing: scrolling must not re-run useViewChrome's filter and sort over all children.
  // Lifting either of these up would put a full-container sort on every scroll event.
  const [scroll, setScroll] = useState({ top: 0, left: 0 });
  const [viewport, setViewport] = useState({ width: 0, height: 0 });

  // Derived per render, deliberately unmemoized - the body grid's argument holds here too:
  // nothing depends on these arrays' identity, the reveal effect keys on scalars, and the work is
  // O(columns), noise beside the cell window it feeds.
  // A dragged width wins over the type's default; nothing stored draws the defaults.
  const widths = columns.map((column) => storedWidths[column.key] ?? columnWidth(column));
  const offsets = columnOffsets(widths);
  const totalWidth = offsets[columns.length] ?? 0;
  const totalHeight = rowCount * rowHeight;

  const rows = rowWindow({
    scrollTop: scroll.top,
    viewportHeight: viewport.height,
    rowHeight: rowHeight,
    totalRows: rowCount,
  });
  const cols = columnWindow({
    scrollLeft: scroll.left,
    viewportWidth: viewport.width,
    offsets,
  });

  // The active cell is kept on screen the way a caret is, keyed on its own geometry as scalars.
  const activeTop = active.row * rowHeight;
  const activeLeft = offsets[active.col] ?? 0;
  const activeWidth = widths[active.col] ?? 0;

  useEffect(() => {
    const scroller = scrollerRef.current;
    if (scroller === null) {
      return;
    }
    const observer = new ResizeObserver(() => {
      // Identity-guarded: a resize callback that reports the same box must not re-render a few
      // hundred cells to change nothing.
      setViewport((current) => {
        const next = { width: scroller.clientWidth, height: scroller.clientHeight };
        return next.width === current.width && next.height === current.height ? current : next;
      });
    });
    observer.observe(scroller);
    return () => {
      observer.disconnect();
    };
  }, [scrollerRef]);

  useEffect(() => {
    const scroller = scrollerRef.current;
    if (scroller === null) {
      return;
    }
    if (activeTop < scroller.scrollTop) {
      scroller.scrollTop = activeTop;
    } else if (activeTop + rowHeight > scroller.scrollTop + scroller.clientHeight) {
      scroller.scrollTop = activeTop + rowHeight - scroller.clientHeight;
    }
    if (activeLeft < scroller.scrollLeft) {
      scroller.scrollLeft = activeLeft;
    } else if (activeLeft + activeWidth > scroller.scrollLeft + scroller.clientWidth) {
      scroller.scrollLeft = activeLeft + activeWidth - scroller.clientWidth;
    }
  }, [scrollerRef, rowHeight, activeTop, activeLeft, activeWidth]);

  const visibleRows: number[] = [];
  for (let row = rows.first; row <= rows.last; row += 1) {
    visibleRows.push(row);
  }
  const visibleCols: number[] = [];
  for (let col = cols.first; col <= cols.last; col += 1) {
    visibleCols.push(col);
  }

  return {
    scroll,
    setScroll,
    viewport,
    widths,
    offsets,
    totalWidth,
    totalHeight,
    visibleRows,
    visibleCols,
    activeTop,
    activeLeft,
    activeWidth,
  };
}
