/** Arithmetic shared by pane-scrolling list and gallery virtualization. */

export interface VirtualRange {
  readonly first: number;
  readonly last: number;
}

export interface LocalViewport {
  readonly top: number;
  readonly height: number;
}

/** Converts the pane viewport into coordinates local to one composed view slot. */
export function localViewport(input: {
  readonly rootTop: number;
  readonly contentOrigin: number;
  readonly viewportTop: number;
  readonly viewportBottom: number;
  readonly totalSize: number;
}): LocalViewport {
  const top = Math.max(0, input.viewportTop - input.rootTop - input.contentOrigin);
  const bottom = Math.max(
    top,
    Math.min(input.totalSize, input.viewportBottom - input.rootTop - input.contentOrigin),
  );
  return { top, height: bottom - top };
}

/** Cumulative top edges, with one final entry containing the complete size. */
export function variableOffsets(
  keys: readonly string[],
  estimate: number,
  measurements: ReadonlyMap<string, number>,
): number[] {
  const offsets = new Array<number>(keys.length + 1);
  let top = 0;

  for (let index = 0; index < keys.length; index += 1) {
    offsets[index] = top;
    top += measurements.get(keys[index] ?? '') ?? estimate;
  }

  offsets[keys.length] = top;
  return offsets;
}

/** The measured indexes intersecting a viewport, expanded by pixel overscan. */
export function variableWindow(input: {
  readonly offsets: readonly number[];
  readonly viewportTop: number;
  readonly viewportHeight: number;
  readonly overscan: number;
}): VirtualRange {
  const { offsets, viewportTop, viewportHeight, overscan } = input;
  const count = Math.max(0, offsets.length - 1);
  if (count === 0) {
    return { first: 0, last: -1 };
  }

  const top = Math.max(0, viewportTop - overscan);
  const bottom = Math.max(top, viewportTop + viewportHeight + overscan);

  return {
    first: edgeIndex(offsets, top),
    last: Math.min(count - 1, edgeIndex(offsets, bottom)),
  };
}

/**
 * The visible indexes plus a separately focused row when it is outside the viewport.
 *
 * Keeping the extra index disjoint avoids turning a focused first row and a viewport at the end
 * into one three-thousand-row DOM window.
 */
export function virtualIndexes(
  range: VirtualRange,
  total: number,
  focused: number | null,
  retained: readonly number[] = [],
): number[] {
  if (range.last < range.first || total <= 0) {
    return [];
  }

  const indexes = Array.from(
    { length: range.last - range.first + 1 },
    (_unused, offset) => range.first + offset,
  );

  if (focused !== null && focused >= 0 && focused < total && !indexes.includes(focused)) {
    indexes.push(focused);
  }

  for (const index of retained) {
    if (index >= 0 && index < total && !indexes.includes(index)) {
      indexes.push(index);
    }
  }
  indexes.sort((left, right) => left - right);

  return indexes;
}

/** Groups ordered indexes into contiguous segments for absolutely positioned gallery grids. */
export function virtualSegments(indexes: readonly number[]): readonly VirtualRange[] {
  if (indexes.length === 0) {
    return [];
  }

  const segments: VirtualRange[] = [];
  let first = indexes[0] ?? 0;
  let last = first;

  for (let offset = 1; offset < indexes.length; offset += 1) {
    const index = indexes[offset] ?? last;
    if (index === last + 1) {
      last = index;
      continue;
    }
    segments.push({ first, last });
    first = index;
    last = index;
  }

  segments.push({ first, last });
  return segments;
}

/** Empty heights before, between and after the supplied rendered indexes. */
export function virtualSpacers(offsets: readonly number[], indexes: readonly number[]): number[] {
  if (indexes.length === 0) {
    return [offsets.at(-1) ?? 0];
  }

  const spacers = new Array<number>(indexes.length + 1);
  let previous = 0;
  for (let offset = 0; offset < indexes.length; offset += 1) {
    const index = indexes[offset] ?? 0;
    spacers[offset] = Math.max(0, (offsets[index] ?? previous) - previous);
    previous = offsets[index + 1] ?? previous;
  }
  spacers[indexes.length] = Math.max(0, (offsets.at(-1) ?? previous) - previous);
  return spacers;
}

function edgeIndex(offsets: readonly number[], edge: number): number {
  const count = offsets.length - 1;
  let low = 0;
  let high = Math.max(0, count - 1);

  while (low < high) {
    const middle = Math.floor((low + high) / 2);
    if ((offsets[middle + 1] ?? Number.POSITIVE_INFINITY) <= edge) {
      low = middle + 1;
    } else {
      high = middle;
    }
  }

  return low;
}
