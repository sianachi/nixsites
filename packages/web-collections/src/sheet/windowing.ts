/**
 * Which slice of the grid is worth rendering, as arithmetic.
 *
 * Rows are uniform height and columns have known widths, so the visible
 * range is a division, not a measurement - which is what makes a hand-rolled
 * window enough here and a virtualization dependency unnecessary. The grid
 * renders the window plus a small overscan so keyboard motion near the edge
 * lands on a cell that already exists.
 */

export interface RowWindow {
  readonly first: number;
  readonly last: number;
}

export function rowWindow(input: {
  scrollTop: number;
  viewportHeight: number;
  rowHeight: number;
  totalRows: number;
  overscan?: number;
}): RowWindow {
  const { scrollTop, viewportHeight, rowHeight, totalRows, overscan = 5 } = input;
  if (totalRows <= 0) {
    return { first: 0, last: -1 };
  }
  const first = Math.max(0, Math.floor(scrollTop / rowHeight) - overscan);
  const visible = Math.ceil(viewportHeight / rowHeight);
  const last = Math.min(totalRows - 1, first + visible + overscan * 2);
  return { first, last };
}

export interface ColumnWindow {
  readonly first: number;
  readonly last: number;
}

/** Cumulative left edges: offsets[i] is where column i starts, one extra entry for the total. */
export function columnOffsets(widths: readonly number[]): number[] {
  const offsets = new Array<number>(widths.length + 1);
  let x = 0;
  for (let i = 0; i < widths.length; i += 1) {
    offsets[i] = x;
    x += widths[i] ?? 0;
  }
  offsets[widths.length] = x;
  return offsets;
}

export function columnWindow(input: {
  scrollLeft: number;
  viewportWidth: number;
  offsets: readonly number[];
  overscan?: number;
}): ColumnWindow {
  const { scrollLeft, viewportWidth, offsets, overscan = 2 } = input;
  const count = offsets.length - 1;
  if (count <= 0) {
    return { first: 0, last: -1 };
  }
  let first = 0;
  while (first < count - 1 && (offsets[first + 1] ?? 0) <= scrollLeft) {
    first += 1;
  }
  let last = first;
  const rightEdge = scrollLeft + viewportWidth;
  while (last < count - 1 && (offsets[last + 1] ?? 0) < rightEdge) {
    last += 1;
  }
  return {
    first: Math.max(0, first - overscan),
    last: Math.min(count - 1, last + overscan),
  };
}
