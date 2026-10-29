import { useEffect, useState, type RefObject, type UIEvent } from 'react';

/**
 * The scroller's scroll offset and measured size, plus the keep-the-active-cell-visible effect.
 *
 * The active cell is kept on screen the way a caret is: moving it scrolls the minimum that makes
 * it visible. It is keyed on the cell's own geometry as scalars, not on the geometry arrays, so it
 * cannot fire for an unrelated column's change - and suspended while a resize drag is live, or
 * every pointermove that pushes the active cell's edge past the viewport would scroll the grid
 * out from under the column being held.
 */
export function useGridViewport(
  scrollerRef: RefObject<HTMLDivElement | null>,
  active: {
    readonly top: number;
    readonly left: number;
    readonly width: number;
    readonly rowHeight: number;
    readonly resizing: boolean;
  },
): {
  readonly scroll: { readonly top: number; readonly left: number };
  readonly viewport: { readonly width: number; readonly height: number };
  readonly onScroll: (event: UIEvent<HTMLDivElement>) => void;
} {
  const [scroll, setScroll] = useState({ top: 0, left: 0 });
  const [viewport, setViewport] = useState({ width: 0, height: 0 });

  useEffect(() => {
    const scroller = scrollerRef.current;
    if (scroller === null) {
      return;
    }
    const observer = new ResizeObserver(() => {
      setViewport({ width: scroller.clientWidth, height: scroller.clientHeight });
    });
    observer.observe(scroller);
    return () => {
      observer.disconnect();
    };
  }, [scrollerRef]);

  const { top: activeTop, left: activeLeft, width: activeWidth, rowHeight, resizing } = active;
  useEffect(() => {
    const scroller = scrollerRef.current;
    if (scroller === null || resizing) {
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
  }, [scrollerRef, activeTop, activeLeft, activeWidth, resizing, rowHeight]);

  return {
    scroll,
    viewport,
    onScroll: (event) => {
      setScroll({ top: event.currentTarget.scrollTop, left: event.currentTarget.scrollLeft });
    },
  };
}
