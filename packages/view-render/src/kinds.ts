import type { RenderRequest, ViewRow } from './types.js';
import { chatTranscript } from './chat.js';
import { line, rect, text, truncate } from './svg.js';
import { labelOf, rawOf, valueOf } from './values.js';

/**
 * The five view kinds, drawn.
 *
 * **A drawing, not a screenshot.** These are the same arrangement the interface uses - a board is
 * columns of cards, a calendar is a month grid - at print sizes and in the print palette, produced
 * without a browser. Trying to reproduce the interface pixel for pixel would mean shipping a
 * renderer that has one, which the product removed for footprint and which would hand a browser to
 * the service that will one day parse untrusted files.
 *
 * Every kind returns its body and the height it used, so the caller can wrap it once.
 */

export interface Drawing {
  readonly body: string;
  readonly height: number;
  readonly notes: readonly string[];
}

const ROW_HEIGHT = 22;
const HEADER_HEIGHT = 24;
const CARD_PADDING = 8;
const GAP = 8;

/** How many rows a drawing carries before it stops being readable rather than merely tall. */
export const ROW_CEILING = 60;

export function drawList(request: RenderRequest): Drawing {
  const { view, rows, schema, palette, width } = request;
  const columns = ['title', ...view.columns];
  const shown = rows.slice(0, ROW_CEILING);
  const columnWidth = width / columns.length;

  const parts: string[] = [
    rect({ x: 0, y: 0, width, height: HEADER_HEIGHT, fill: palette.surface }),
  ];

  columns.forEach((key, index) => {
    parts.push(
      text(truncate(key === 'title' ? 'Title' : labelOf(schema, key), 9, columnWidth - GAP), {
        x: index * columnWidth + CARD_PADDING,
        y: HEADER_HEIGHT - 8,
        size: 9,
        fill: palette.ink,
        bold: true,
      }),
    );
  });

  shown.forEach((row, rowIndex) => {
    const y = HEADER_HEIGHT + rowIndex * ROW_HEIGHT;

    parts.push(line(0, y, width, y, palette.divider));

    columns.forEach((key, index) => {
      const value = key === 'title' ? row.title : valueOf(row, key, schema);

      parts.push(
        text(truncate(value, 9, columnWidth - GAP * 2), {
          x: index * columnWidth + CARD_PADDING,
          y: y + ROW_HEIGHT - 7,
          size: 9,
          fill: key === 'title' ? palette.ink : palette.muted,
        }),
      );
    });
  });

  const height = HEADER_HEIGHT + shown.length * ROW_HEIGHT;

  return {
    body: parts.join(''),
    height: Math.max(height, HEADER_HEIGHT),
    notes: overflowNote(rows.length),
  };
}

/** A property-backed spreadsheet uses the same row data as a list, but owns a grid presentation. */
export function drawSheet(request: RenderRequest): Drawing {
  return drawList(request);
}

/** Smart-list results are rows after the server has applied the stored filter rules. */
export function drawQuery(request: RenderRequest): Drawing {
  return drawList(request);
}

export function drawForm(request: RenderRequest): Drawing {
  const { view, schema, palette, width } = request;
  const keys = view.columns.filter((key) => key !== 'title').slice(0, 8);
  const fields =
    keys.length > 0 ? keys : (schema?.properties.map((property) => property.key).slice(0, 8) ?? []);
  const parts: string[] = [
    text('New response', { x: 0, y: 14, size: 11, fill: palette.ink, bold: true }),
  ];
  let y = 28;
  for (const key of fields) {
    parts.push(
      text(truncate(labelOf(schema, key), 9, width), {
        x: 0,
        y: y + 9,
        size: 9,
        fill: palette.ink,
      }),
      rect({
        x: 0,
        y: y + 14,
        width,
        height: 24,
        fill: palette.surface,
        stroke: palette.divider,
        radius: 3,
      }),
    );
    y += 48;
  }
  parts.push(
    rect({ x: 0, y, width: 82, height: 24, fill: palette.accentFill, radius: 3 }),
    text('Add response', { x: 41, y: y + 16, size: 8, fill: palette.accentText, anchor: 'middle' }),
  );
  return { body: parts.join(''), height: y + 24, notes: [] };
}

export function drawInteractiveForm(request: RenderRequest): Drawing {
  const { view, palette, width } = request;
  const form = view.interactiveForm;
  const page = form?.pages[0];
  if (form == null || page === undefined) {
    return {
      body: text('This interactive form has no pages.', {
        x: 0,
        y: 14,
        size: 9,
        fill: palette.muted,
      }),
      height: 24,
      notes: [],
    };
  }

  const parts: string[] = [
    text(truncate(page.title, 12, width), {
      x: 0,
      y: 15,
      size: 12,
      fill: palette.ink,
      bold: true,
    }),
  ];
  if (form.pages.length > 1) {
    parts.push(
      text(`Page 1 of ${String(form.pages.length)}`, {
        x: width,
        y: 14,
        size: 8,
        fill: palette.muted,
        anchor: 'end',
      }),
    );
  }
  let y = 28;
  if (page.description !== null) {
    parts.push(
      text(truncate(page.description, 8, width), { x: 0, y: y + 8, size: 8, fill: palette.muted }),
    );
    y += 18;
  }
  for (const block of page.blocks.slice(0, 8)) {
    const label = block.required && block.kind === 'field' ? `${block.text} *` : block.text;
    parts.push(
      text(truncate(label, block.kind === 'heading' ? 10 : 9, width), {
        x: 0,
        y: y + 10,
        size: block.kind === 'heading' ? 10 : 9,
        fill: block.kind === 'paragraph' ? palette.muted : palette.ink,
        bold: block.kind === 'heading',
      }),
    );
    y += block.kind === 'field' ? 42 : 20;
    if (block.kind === 'field') {
      parts.push(
        rect({
          x: 0,
          y: y - 26,
          width,
          height: 24,
          fill: palette.surface,
          stroke: palette.divider,
          radius: 3,
        }),
      );
    }
  }
  const action = form.pages.length > 1 ? 'Continue' : 'Submit';
  parts.push(
    rect({ x: 0, y, width: 70, height: 24, fill: palette.accentFill, radius: 3 }),
    text(action, { x: 35, y: y + 16, size: 8, fill: palette.accentText, anchor: 'middle' }),
  );
  return {
    body: parts.join(''),
    height: y + 24,
    notes: overflowNote(page.blocks.length, 8),
  };
}

export function drawBoard(request: RenderRequest): Drawing {
  const { view, rows, schema, palette, width } = request;
  const groups = groupRows(rows, view.groupBy, view.groupOrder);
  const columnWidth = Math.max(
    90,
    (width - GAP * (groups.length - 1)) / Math.max(1, groups.length),
  );
  const cardHeight = 34;

  const tallest = Math.max(...groups.map((group) => group.rows.length), 0);
  const height = HEADER_HEIGHT + Math.min(tallest, ROW_CEILING) * (cardHeight + GAP) + GAP;

  const parts: string[] = [];

  groups.forEach((group, index) => {
    const x = index * (columnWidth + GAP);

    parts.push(
      text(
        truncate(`${group.label} (${String(group.rows.length)})`, 9, columnWidth - CARD_PADDING),
        { x, y: 12, size: 9, fill: palette.muted, bold: true },
      ),
    );

    group.rows.slice(0, ROW_CEILING).forEach((row, cardIndex) => {
      const y = HEADER_HEIGHT + cardIndex * (cardHeight + GAP);

      parts.push(
        rect({
          x,
          y,
          width: columnWidth,
          height: cardHeight,
          fill: palette.surface,
          stroke: palette.divider,
          radius: 3,
        }),
        text(truncate(row.title, 9, columnWidth - CARD_PADDING * 2), {
          x: x + CARD_PADDING,
          y: y + 15,
          size: 9,
          fill: palette.ink,
        }),
      );

      const secondary = view.columns[0];
      if (secondary !== undefined) {
        parts.push(
          text(truncate(valueOf(row, secondary, schema), 8, columnWidth - CARD_PADDING * 2), {
            x: x + CARD_PADDING,
            y: y + 27,
            size: 8,
            fill: palette.muted,
          }),
        );
      }
    });
  });

  return { body: parts.join(''), height, notes: overflowNote(tallest) };
}

export function drawGallery(request: RenderRequest): Drawing {
  const { view, rows, schema, palette, width } = request;
  const caption = view.columns[0];
  const perRow = 3;
  const tileWidth = (width - GAP * (perRow - 1)) / perRow;
  const tileHeight = tileWidth * 0.62;
  const shown = rows.slice(0, 24);
  const lines = Math.ceil(shown.length / perRow);

  const parts: string[] = [];

  shown.forEach((row, index) => {
    const x = (index % perRow) * (tileWidth + GAP);
    const y = Math.floor(index / perRow) * (tileHeight + GAP + 16);

    parts.push(
      rect({
        x,
        y,
        width: tileWidth,
        height: tileHeight,
        fill: palette.calloutFill,
        stroke: palette.divider,
        radius: 3,
      }),
      // The cover is deliberately not drawn: this runs with no network egress at all, so a picture
      // at a URL is unreachable by design rather than by omission. See ADR-0035.
      // A gallery with no cover property has nothing missing, so its tile shows a value instead.
      text(
        view.coverProperty !== null
          ? 'Cover not included'
          : caption === undefined
            ? ''
            : truncate(valueOf(row, caption, schema), 8, tileWidth - CARD_PADDING),
        {
          x: x + tileWidth / 2,
          y: y + tileHeight / 2 + 3,
          size: 8,
          fill: palette.muted,
          anchor: 'middle',
        },
      ),
      text(truncate(row.title, 9, tileWidth), {
        x,
        y: y + tileHeight + 12,
        size: 9,
        fill: palette.ink,
      }),
    );
  });

  const notes =
    view.coverProperty === null
      ? []
      : ['A gallery is drawn without its cover pictures, which live outside this file.'];

  return {
    body: parts.join(''),
    height: lines * (tileHeight + GAP + 16),
    notes: [...notes, ...overflowNote(rows.length, 24)],
  };
}

export function drawCalendar(request: RenderRequest): Drawing {
  const { view, rows, palette, width } = request;
  const cell = width / 7;
  const cellHeight = Math.max(38, cell * 0.62);
  const days = ['Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat', 'Sun'];

  const byDay = new Map<number, ViewRow[]>();
  let month: string | null = null;

  for (const row of rows) {
    const stamp = rawOf(row, view.dateProperty);
    if (stamp === null) {
      continue;
    }

    month ??= stamp.slice(0, 7);
    const day = Number(stamp.slice(8, 10));

    if (Number.isFinite(day) && day > 0) {
      byDay.set(day, [...(byDay.get(day) ?? []), row]);
    }
  }

  const shape = monthShape(month);

  // Sized to the month rather than fixed at five: a 31-day month starting on a Saturday needs six
  // rows, and a fixed grid simply loses the last days - which is how the 31st went missing.
  const weeks = shape.days === 0 ? 5 : Math.ceil((shape.leading + shape.days) / 7);

  const parts: string[] = [
    rect({ x: 0, y: 0, width, height: HEADER_HEIGHT, fill: palette.surface }),
  ];

  if (month !== null) {
    parts.push(
      text(month, { x: width, y: HEADER_HEIGHT - 8, size: 8, fill: palette.muted, anchor: 'end' }),
    );
  }

  days.forEach((day, index) => {
    parts.push(
      text(day, {
        x: index * cell + 6,
        y: HEADER_HEIGHT - 8,
        size: 8,
        fill: palette.muted,
        bold: true,
      }),
    );
  });

  // A real month, not a 5x7 grid of numbers. An earlier cut drew cells 1 to 35 and printed days
  // 32 to 35, which is not a shortcut but a falsehood - a reader would take them for dates.
  for (let week = 0; week < weeks; week += 1) {
    for (let day = 0; day < 7; day += 1) {
      const number = week * 7 + day + 1 - shape.leading;
      const x = day * cell;
      const y = HEADER_HEIGHT + week * cellHeight;
      const real = number >= 1 && number <= shape.days;

      parts.push(rect({ x, y, width: cell, height: cellHeight, stroke: palette.divider }));

      if (!real) {
        // Outside the month: drawn as an empty cell, because a blank is the truth about it.
        continue;
      }

      parts.push(text(String(number), { x: x + 5, y: y + 11, size: 7, fill: palette.muted }));

      (byDay.get(number) ?? []).slice(0, 2).forEach((row, index) => {
        parts.push(
          text(truncate(row.title, 7, cell - 10), {
            x: x + 5,
            y: y + 23 + index * 10,
            size: 7,
            fill: palette.accentText,
          }),
        );
      });
    }
  }

  return {
    body: parts.join(''),
    height: HEADER_HEIGHT + weeks * cellHeight,
    notes:
      month === null
        ? ['A calendar is drawn empty, because nothing inside it carries the date it reads.']
        : [],
  };
}

/**
 * How a month sits on a Monday-first grid.
 *
 * Derived from the month itself rather than assumed, so the numbers under the weekday headings are
 * the real ones. `Date.UTC` throughout: a local-time construction would shift the first of the
 * month across a day boundary for anybody west of Greenwich and slide the whole calendar by one.
 */
function monthShape(month: string | null): { leading: number; days: number } {
  if (month === null) {
    return { leading: 0, days: 0 };
  }

  const year = Number(month.slice(0, 4));
  const index = Number(month.slice(5, 7)) - 1;

  if (!Number.isFinite(year) || !Number.isFinite(index)) {
    return { leading: 0, days: 0 };
  }

  const first = new Date(Date.UTC(year, index, 1));

  // getUTCDay is Sunday-first; the grid is Monday-first, which is what the interface uses.
  const leading = (first.getUTCDay() + 6) % 7;
  const days = new Date(Date.UTC(year, index + 1, 0)).getUTCDate();

  return { leading, days };
}

export function drawTimeline(request: RenderRequest): Drawing {
  const { view, rows, palette, width } = request;
  const labelWidth = Math.min(140, width * 0.32);
  const trackWidth = width - labelWidth;
  const shown = rows.slice(0, ROW_CEILING);

  const stamps = shown
    .map((row) => rawOf(row, view.dateProperty))
    .filter((stamp): stamp is string => stamp !== null)
    .sort();

  const first = stamps[0] ?? null;
  // The axis ends at the latest end date, so a bar that outlasts every start is not cut short.
  const last =
    [
      ...stamps,
      ...shown
        .map((row) => rawOf(row, view.endDateProperty))
        .filter((stamp): stamp is string => stamp !== null),
    ]
      .sort()
      .pop() ?? null;

  const parts: string[] = [
    rect({ x: 0, y: 0, width, height: HEADER_HEIGHT, fill: palette.surface }),
    text(first === null ? 'No dates' : first.slice(0, 10), {
      x: labelWidth,
      y: HEADER_HEIGHT - 8,
      size: 8,
      fill: palette.muted,
    }),
  ];

  if (last !== null) {
    parts.push(
      text(last.slice(0, 10), {
        x: width,
        y: HEADER_HEIGHT - 8,
        size: 8,
        fill: palette.muted,
        anchor: 'end',
      }),
    );
  }

  const span = first === null || last === null ? 0 : Math.max(1, dayGap(first, last));

  shown.forEach((row, index) => {
    const y = HEADER_HEIGHT + index * ROW_HEIGHT;
    const start = rawOf(row, view.dateProperty);
    const end = rawOf(row, view.endDateProperty);

    parts.push(
      text(truncate(row.title, 9, labelWidth - GAP), {
        x: 0,
        y: y + ROW_HEIGHT - 7,
        size: 9,
        fill: palette.ink,
      }),
    );

    if (start === null || first === null || span === 0) {
      return;
    }

    const minimum = 10;

    // Pulled back off the right edge rather than clipped to it. The item on the last date sits at
    // the full track width, so clipping gave it a bar of zero width - the longest-running item in
    // the export was the one with nothing drawn for it.
    const offset = Math.min(
      (dayGap(first, start) / span) * trackWidth,
      Math.max(0, trackWidth - minimum),
    );

    const length =
      end === null ? minimum : Math.max(minimum, (dayGap(start, end) / span) * trackWidth);

    parts.push(
      rect({
        x: labelWidth + offset,
        y: y + 5,
        width: Math.max(minimum, Math.min(length, trackWidth - offset)),
        height: ROW_HEIGHT - 12,
        fill: palette.accentFill,
        radius: 2,
      }),
    );
  });

  return {
    body: parts.join(''),
    height: HEADER_HEIGHT + shown.length * ROW_HEIGHT,
    notes: overflowNote(rows.length),
  };
}

interface Group {
  readonly label: string;
  readonly rows: readonly ViewRow[];
}

/**
 * Cards by the property the board groups on, in the order the view stored.
 *
 * A row whose value is unset lands in a trailing group rather than being dropped: the interface
 * shows those cards, and a picture that quietly held fewer cards than the board would be the kind
 * of difference nobody notices until it matters.
 */
function groupRows(
  rows: readonly ViewRow[],
  groupBy: string | null,
  groupOrder: readonly string[],
): readonly Group[] {
  if (groupBy === null) {
    return [{ label: 'All', rows }];
  }

  const buckets = new Map<string, ViewRow[]>();

  for (const row of rows) {
    const key = rawOf(row, groupBy) ?? '';
    buckets.set(key, [...(buckets.get(key) ?? []), row]);
  }

  const ordered = groupOrder.filter((value) => buckets.has(value));
  const rest = [...buckets.keys()].filter((value) => !ordered.includes(value) && value !== '');

  return [...ordered, ...rest, ...(buckets.has('') ? [''] : [])].map((value) => ({
    label: value === '' ? 'No value' : value,
    rows: buckets.get(value) ?? [],
  }));
}

function overflowNote(total: number, ceiling: number = ROW_CEILING): readonly string[] {
  return total <= ceiling
    ? []
    : [`A view is drawn with its first ${String(ceiling)} items; it holds ${String(total)}.`];
}

/** Whole days between two ISO stamps, or zero when either is not one. */
function dayGap(from: string, to: string): number {
  const start = Date.parse(from.slice(0, 10));
  const end = Date.parse(to.slice(0, 10));

  if (!Number.isFinite(start) || !Number.isFinite(end)) {
    return 0;
  }

  return Math.max(0, (end - start) / 86_400_000);
}

/** A readable transcript. Drawings report their row ceiling; message text is never truncated. */
export function drawChat(request: RenderRequest): Drawing {
  const { rows, palette, width } = request;
  const parts: string[] = [];
  const messages = chatTranscript(rows.map((row) => row.properties));
  const capacity = Math.max(1, Math.floor(width / (9 * 0.55)));
  let y = 14;
  for (const message of messages.slice(0, ROW_CEILING)) {
    const heading = [message.role, message.createdAt].filter(Boolean).join(' · ');
    parts.push(text(heading, { x: 0, y, size: 9, fill: palette.ink, bold: true }));
    y += 14;
    for (const paragraph of message.text.split('\n')) {
      const characters = Array.from(paragraph);
      for (let offset = 0; offset < Math.max(characters.length, 1); offset += capacity) {
        parts.push(
          text(characters.slice(offset, offset + capacity).join(''), {
            x: 0,
            y,
            size: 9,
            fill: palette.ink,
          }),
        );
        y += 12;
      }
    }
    y += 12;
  }
  return {
    body: parts.join(''),
    height: y,
    notes:
      messages.length > ROW_CEILING
        ? [
            `Only the first ${String(ROW_CEILING)} of ${String(messages.length)} messages are drawn. The native archive retains all message children.`,
          ]
        : [],
  };
}

/** Cards in a grid: the board's columns across, a second property down. */
export function drawMatrix(request: RenderRequest): Drawing {
  const { view, rows, palette, width } = request;
  const columns = groupRows(rows, view.groupBy, view.groupOrder);
  const bands = groupRows(rows, view.rowBy ?? null, []);
  const labelWidth = 64;
  const cellWidth = (width - labelWidth) / Math.max(1, columns.length);
  const cardHeight = 16;
  const perCell = 4;
  const parts: string[] = [];
  let y = HEADER_HEIGHT;

  columns.forEach((column, index) => {
    parts.push(
      text(truncate(column.label, 9, cellWidth - GAP), {
        x: labelWidth + index * cellWidth + CARD_PADDING,
        y: 14,
        size: 9,
        fill: palette.muted,
        bold: true,
      }),
    );
  });

  for (const band of bands) {
    const cells = columns.map((column) => column.rows.filter((row) => band.rows.includes(row)));
    const tallest = Math.min(perCell, Math.max(1, ...cells.map((cell) => cell.length)));
    const bandHeight = tallest * (cardHeight + 4) + GAP;

    parts.push(
      text(truncate(band.label, 9, labelWidth - 4), {
        x: 0,
        y: y + 16,
        size: 9,
        fill: palette.muted,
        bold: true,
      }),
    );
    cells.forEach((cell, index) => {
      const x = labelWidth + index * cellWidth;
      parts.push(
        rect({
          x,
          y,
          width: cellWidth - 4,
          height: bandHeight,
          fill: palette.surface,
          stroke: palette.divider,
          radius: 3,
        }),
      );
      cell.slice(0, perCell).forEach((row, cardIndex) => {
        parts.push(
          text(truncate(row.title, 9, cellWidth - CARD_PADDING * 2), {
            x: x + CARD_PADDING,
            y: y + 15 + cardIndex * (cardHeight + 4),
            size: 9,
            fill: palette.ink,
          }),
        );
      });
    });
    y += bandHeight + 4;
  }

  return { body: parts.join(''), height: y, notes: overflowNote(rows.length) };
}

/** One bar per value of the grouping property: a count, or a property's total. */
export function drawChart(request: RenderRequest): Drawing {
  const { view, rows, schema, palette, width } = request;
  const sums = view.measure === 'sum' && view.measureProperty != null;
  const bars = groupRows(rows, view.groupBy, view.groupOrder).map((group) => ({
    label: group.label,
    value: sums
      ? group.rows.reduce((total, row) => {
          const amount = Number(row.properties[view.measureProperty ?? '']);
          return Number.isFinite(amount) ? total + amount : total;
        }, 0)
      : group.rows.length,
  }));
  const peak = Math.max(1, ...bars.map((bar) => bar.value));
  const labelWidth = 110;
  const barHeight = 16;
  const parts: string[] = [
    text(
      truncate(
        `${sums ? labelOf(schema, view.measureProperty ?? '') : 'Items'} by ${view.groupBy === null ? 'all' : labelOf(schema, view.groupBy)}`,
        9,
        width,
      ),
      { x: 0, y: 12, size: 9, fill: palette.muted, bold: true },
    ),
  ];

  bars.forEach((bar, index) => {
    const y = HEADER_HEIGHT + index * (barHeight + GAP);
    const length = ((width - labelWidth - 36) * bar.value) / peak;
    parts.push(
      text(truncate(bar.label, 9, labelWidth - GAP), {
        x: 0,
        y: y + 12,
        size: 9,
        fill: palette.ink,
      }),
      rect({
        x: labelWidth,
        y,
        width: Math.max(2, length),
        height: barHeight,
        fill: palette.accentFill,
        stroke: palette.accentText,
        radius: 2,
      }),
      text(String(Math.round(bar.value * 100) / 100), {
        x: labelWidth + Math.max(2, length) + 6,
        y: y + 12,
        size: 9,
        fill: palette.muted,
      }),
    );
  });

  return {
    body: parts.join(''),
    height: HEADER_HEIGHT + bars.length * (barHeight + GAP),
    notes: [],
  };
}

/** A tick box beside each title, under a line of progress. */
export function drawChecklist(request: RenderRequest): Drawing {
  const { view, rows, schema, palette, width } = request;
  const doneKey = view.doneProperty ?? 'done';
  const done = (row: ViewRow): boolean => row.properties[doneKey] === true;
  const shown = rows.slice(0, ROW_CEILING);
  const finished = rows.filter(done).length;
  const beside = view.columns[0];
  const parts: string[] = [
    text(`${String(finished)} of ${String(rows.length)} done`, {
      x: 0,
      y: 12,
      size: 9,
      fill: palette.muted,
      bold: true,
    }),
    rect({ x: 90, y: 5, width: width - 90, height: 6, fill: palette.surface, radius: 3 }),
    rect({
      x: 90,
      y: 5,
      width: rows.length === 0 ? 0 : ((width - 90) * finished) / rows.length,
      height: 6,
      fill: palette.accentText,
      radius: 3,
    }),
  ];

  shown.forEach((row, index) => {
    const y = HEADER_HEIGHT + index * ROW_HEIGHT;
    const ticked = done(row);
    parts.push(
      rect({
        x: 1,
        y: y + 4,
        width: 11,
        height: 11,
        fill: ticked ? palette.accentText : 'none',
        stroke: ticked ? palette.accentText : palette.muted,
        radius: 2,
      }),
      text(truncate(row.title, 9, width * 0.62), {
        x: 22,
        y: y + 14,
        size: 9,
        fill: ticked ? palette.muted : palette.ink,
      }),
    );
    if (beside !== undefined) {
      parts.push(
        text(truncate(valueOf(row, beside, schema), 8, width * 0.3), {
          x: width,
          y: y + 14,
          size: 8,
          fill: palette.muted,
          anchor: 'end',
        }),
      );
    }
  });

  return {
    body: parts.join(''),
    height: HEADER_HEIGHT + shown.length * ROW_HEIGHT,
    notes: overflowNote(rows.length),
  };
}

/** Titles as a bulleted tree. Rows arrive flat, so this draws the first level. */
export function drawOutline(request: RenderRequest): Drawing {
  const { rows, palette, width } = request;
  const shown = rows.slice(0, ROW_CEILING);
  const parts: string[] = [line(4, 4, 4, shown.length * ROW_HEIGHT - 8, palette.divider)];

  shown.forEach((row, index) => {
    const y = index * ROW_HEIGHT;
    parts.push(
      rect({ x: 2, y: y + 8, width: 5, height: 5, fill: palette.muted, radius: 2.5 }),
      text(truncate(row.title, 10, width - 24), { x: 18, y: y + 14, size: 10, fill: palette.ink }),
    );
  });

  return {
    body: parts.join(''),
    height: shown.length * ROW_HEIGHT,
    notes: overflowNote(rows.length),
  };
}

/** Files and pages as tiles (grid) or as a list. File sizes and thumbnails are not in a row. */
export function drawDrive(request: RenderRequest): Drawing {
  const { view, rows, schema, palette, width } = request;
  if (view.layout !== 'grid') return drawList(request);

  const perRow = 4;
  const tileWidth = (width - GAP * (perRow - 1)) / perRow;
  const tileHeight = 54;
  const shown = rows.slice(0, 24);
  const tag = view.columns[0];
  const parts: string[] = [];

  shown.forEach((row, index) => {
    const x = (index % perRow) * (tileWidth + GAP);
    const y = Math.floor(index / perRow) * (tileHeight + GAP);
    parts.push(
      rect({
        x,
        y,
        width: tileWidth,
        height: tileHeight,
        fill: palette.surface,
        stroke: palette.divider,
        radius: 3,
      }),
      rect({
        x: x + CARD_PADDING,
        y: y + 8,
        width: 14,
        height: 18,
        fill: palette.accentFill,
        stroke: palette.accentText,
        radius: 2,
      }),
      text(truncate(row.title, 9, tileWidth - CARD_PADDING * 2), {
        x: x + CARD_PADDING,
        y: y + 38,
        size: 9,
        fill: palette.ink,
      }),
    );
    if (tag !== undefined) {
      parts.push(
        text(truncate(valueOf(row, tag, schema), 8, tileWidth - CARD_PADDING * 2), {
          x: x + CARD_PADDING,
          y: y + 49,
          size: 8,
          fill: palette.muted,
        }),
      );
    }
  });

  return {
    body: parts.join(''),
    height: Math.ceil(shown.length / perRow) * (tileHeight + GAP),
    notes: overflowNote(rows.length, 24),
  };
}

/** Each habit beside an empty week: the check-in history lives outside a row. */
export function drawHabitGrid(request: RenderRequest): Drawing {
  const { rows, palette, width } = request;
  const days = ['M', 'T', 'W', 'T', 'F', 'S', 'S'];
  const shown = rows.slice(0, ROW_CEILING);
  const gridLeft = width - days.length * 26;
  const parts: string[] = [];

  days.forEach((day, index) => {
    parts.push(
      text(day, {
        x: gridLeft + index * 26 + 13,
        y: 14,
        size: 9,
        fill: palette.muted,
        bold: true,
        anchor: 'middle',
      }),
    );
  });
  shown.forEach((row, rowIndex) => {
    const y = HEADER_HEIGHT + rowIndex * 26;
    const target = row.properties.$habit_target;
    const unit = row.properties.$habit_unit;
    const goal =
      typeof target === 'number' && typeof unit === 'string' ? `${String(target)} ${unit}` : '';
    parts.push(
      line(0, y, width, y, palette.divider),
      text(truncate(row.title, 9, gridLeft - 80), { x: 0, y: y + 17, size: 9, fill: palette.ink }),
      text(truncate(goal, 8, 70), {
        x: gridLeft - 8,
        y: y + 17,
        size: 8,
        fill: palette.muted,
        anchor: 'end',
      }),
    );
    days.forEach((_, index) => {
      parts.push(
        rect({
          x: gridLeft + index * 26 + 5,
          y: y + 5,
          width: 16,
          height: 16,
          fill: palette.surface,
          stroke: palette.divider,
          radius: 8,
        }),
      );
    });
  });

  return {
    body: parts.join(''),
    height: HEADER_HEIGHT + shown.length * 26,
    notes: overflowNote(rows.length),
  };
}
