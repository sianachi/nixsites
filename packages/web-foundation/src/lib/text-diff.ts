/** One run of text on one side of a comparison, and whether it differs from the other side. */
export interface DiffSegment {
  readonly text: string;
  readonly changed: boolean;
}

export interface TextRange {
  readonly start: number;
  readonly end: number;
}

/** Above this many line pairs the comparison stops looking for a longest common run and marks
 * everything between the shared first and last lines as changed: a large section stays cheap to
 * compare, and the result is still honest, only coarser. */
const MAX_LINE_PAIRS = 200_000;

function merge(segments: readonly DiffSegment[]): DiffSegment[] {
  const out: DiffSegment[] = [];
  for (const segment of segments) {
    if (!segment.text) continue;
    const last = out.at(-1);
    if (last?.changed === segment.changed)
      out[out.length - 1] = { text: last.text + segment.text, changed: last.changed };
    else out.push(segment);
  }
  return out;
}

/** `text` split into the unchanged run before `range`, the changed run, and the run after. */
export function rangeSegments(text: string, range: TextRange): DiffSegment[] {
  const start = Math.max(0, Math.min(range.start, text.length));
  const end = Math.max(start, Math.min(range.end, text.length));
  return merge([
    { text: text.slice(0, start), changed: false },
    { text: text.slice(start, end), changed: true },
    { text: text.slice(end), changed: false },
  ]);
}

/** A line-level comparison of `before` and `after`: lines on the longest common run are
 * unchanged, every other line is changed on its own side. Lines are compared with their
 * whitespace collapsed, and a blank line is never marked: re-rendered Markdown often shifts
 * spacing, and marking that would point the owner at nothing. */
export function lineSegments(
  before: string,
  after: string,
): { before: DiffSegment[]; after: DiffSegment[] } {
  const rawA = before.split('\n');
  const rawB = after.split('\n');
  const key = (text: string) => text.replace(/\s+/g, ' ').trim();
  const a = rawA.map(key);
  const b = rawB.map(key);
  const line = (lines: readonly string[], index: number) =>
    index < lines.length - 1 ? `${lines[index] ?? ''}\n` : (lines[index] ?? '');
  const marked = (keys: readonly string[], kept: readonly boolean[], index: number) =>
    !kept[index] && keys[index] !== '';
  const keptA = new Array<boolean>(a.length).fill(false);
  const keptB = new Array<boolean>(b.length).fill(false);
  let head = 0;
  while (head < a.length && head < b.length && a[head] === b[head]) {
    keptA[head] = keptB[head] = true;
    head++;
  }
  let tail = 0;
  while (
    tail < a.length - head &&
    tail < b.length - head &&
    a[a.length - 1 - tail] === b[b.length - 1 - tail]
  ) {
    keptA[a.length - 1 - tail] = keptB[b.length - 1 - tail] = true;
    tail++;
  }
  const midA = a.length - head - tail;
  const midB = b.length - head - tail;
  if (midA > 0 && midB > 0 && midA * midB <= MAX_LINE_PAIRS) {
    // Longest common subsequence over the middle lines only.
    const table: number[][] = Array.from({ length: midA + 1 }, () =>
      new Array<number>(midB + 1).fill(0),
    );
    for (let i = midA - 1; i >= 0; i--)
      for (let j = midB - 1; j >= 0; j--) {
        const row = table[i];
        if (row === undefined) continue;
        row[j] =
          a[head + i] === b[head + j]
            ? (table[i + 1]?.[j + 1] ?? 0) + 1
            : Math.max(table[i + 1]?.[j] ?? 0, row[j + 1] ?? 0);
      }
    let i = 0;
    let j = 0;
    while (i < midA && j < midB) {
      if (a[head + i] === b[head + j]) {
        keptA[head + i] = keptB[head + j] = true;
        i++;
        j++;
      } else if ((table[i + 1]?.[j] ?? 0) >= (table[i]?.[j + 1] ?? 0)) i++;
      else j++;
    }
  }
  return {
    before: merge(
      rawA.map((_, index) => ({ text: line(rawA, index), changed: marked(a, keptA, index) })),
    ),
    after: merge(
      rawB.map((_, index) => ({ text: line(rawB, index), changed: marked(b, keptB, index) })),
    ),
  };
}
