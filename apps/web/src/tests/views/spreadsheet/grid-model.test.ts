import { describe, expect, it } from 'vitest';

import { rangeToTsv } from '@nix/web-collections/sheet/clipboard';
import type { Item } from '@nix/web-collections/core/container-model';
import {
  cellDisplay,
  cellText,
  clearPlan,
  coerceCellText,
  columnWidth,
  fillPlan,
  pastePlan,
  rangeTextMap,
  resolveColumns,
  type SpreadsheetColumn,
} from '../../../views/spreadsheet/grid-model';
import { aView, property, schemaOf } from '@nix/web-collections/testing/view-fixture';

function item(id: string, title: string, properties: Record<string, unknown> = {}): Item {
  return {
    id,
    workspaceId: 'workspace-1',
    parentId: 'folder-1',
    type: 'note',
    title,
    hasChildren: false,
    seq: 1,
    lifecycleState: 'active',
    properties,
    createdAt: '2026-01-01T00:00:00Z',
    updatedAt: '2026-01-01T00:00:00Z',
  };
}

const SCHEMA = schemaOf(
  property('status', 'Status', 'select'),
  property('count', 'Count', 'number'),
  property('done', 'Done', 'checkbox'),
);

/** The column for a key, checked - so a wrong key fails the test naming it, not a later line. */
function columnFor(columns: readonly SpreadsheetColumn[], key: string): SpreadsheetColumn {
  const column = columns.find((entry) => entry.key === key);
  if (column === undefined) {
    throw new Error(`No column resolved for "${key}".`);
  }
  return column;
}

describe('column resolution', () => {
  it('leads with the title and follows the declared order when the view names nothing', () => {
    const columns = resolveColumns(aView(), SCHEMA);

    expect(columns.map((column) => column.key)).toEqual(['title', 'status', 'count', 'done']);
    expect(columns[0]?.editable).toBe(false);
  });

  it('follows the view when it names columns, deduplicated and with the title dropped', () => {
    const columns = resolveColumns(
      aView({ columns: ['count', 'title', 'count', 'status'] }),
      SCHEMA,
    );

    expect(columns.map((column) => column.key)).toEqual(['title', 'count', 'status']);
  });

  it('keeps a configured column the schema no longer describes, headed by its key and read-only', () => {
    const columns = resolveColumns(aView({ columns: ['ghost'] }), SCHEMA);
    const ghost = columns.find((column) => column.key === 'ghost');

    expect(ghost?.label).toBe('ghost');
    expect(ghost?.editable).toBe(false);
  });

  it('reads but never edits a property type this build does not know', () => {
    const columns = resolveColumns(aView(), schemaOf(property('shape', 'Shape', 'polygon')));
    const shape = columns.find((column) => column.key === 'shape');

    expect(shape?.editable).toBe(false);
  });

  it('sizes a column by its type rather than one width for all', () => {
    const columns = resolveColumns(aView(), SCHEMA);
    const byKey = new Map(columns.map((column) => [column.key, columnWidth(column)]));

    expect(byKey.get('title')).toBeGreaterThan(byKey.get('count') ?? Number.POSITIVE_INFINITY);
    expect(byKey.get('done')).toBeLessThan(byKey.get('status') ?? 0);
  });
});

describe('coercion', () => {
  it('stores a number as a number and refuses what is not one', () => {
    expect(coerceCellText('42.5', 'number')).toEqual({ ok: true, value: 42.5 });
    expect(coerceCellText('not a number', 'number')).toMatchObject({ ok: false });
  });

  it('reads the words a person types for a checkbox, and refuses the ones it cannot', () => {
    expect(coerceCellText('Yes', 'checkbox')).toEqual({ ok: true, value: true });
    expect(coerceCellText('x', 'checkbox')).toEqual({ ok: true, value: true });
    expect(coerceCellText('no', 'checkbox')).toEqual({ ok: true, value: false });
    expect(coerceCellText('maybe', 'checkbox')).toMatchObject({ ok: false });
  });

  it('clears with empty text, except a checkbox whose unchecked is a value', () => {
    expect(coerceCellText('', 'text')).toEqual({ ok: true, value: null });
    expect(coerceCellText('  ', 'number')).toEqual({ ok: true, value: null });
    expect(coerceCellText('', 'checkbox')).toEqual({ ok: true, value: false });
  });

  it('splits a multi-select on commas, matching what the cell shows for one', () => {
    expect(coerceCellText('red, green ,blue', 'multi_select')).toEqual({
      ok: true,
      value: ['red', 'green', 'blue'],
    });
  });

  it('passes text through for the server to judge, so a bad date is refused by the owner of the rule', () => {
    expect(coerceCellText('2026-13-99', 'date')).toEqual({ ok: true, value: '2026-13-99' });
    expect(coerceCellText('Blocked', 'select')).toEqual({ ok: true, value: 'Blocked' });
  });
});

describe('paste', () => {
  const ITEMS = [item('a', 'Alpha'), item('b', 'Beta')];
  const COLUMNS = resolveColumns(aView(), SCHEMA);

  it('lands one bag per row, anchored at the cell, with every field coerced', () => {
    const plan = pastePlan(
      { row: 0, col: 1 },
      [
        ['open', '3'],
        ['done', '4'],
      ],
      ITEMS,
      COLUMNS,
    );

    expect(plan.writes).toEqual([
      { item: ITEMS[0], bag: { status: 'open', count: 3 } },
      { item: ITEMS[1], bag: { status: 'done', count: 4 } },
    ]);
    expect(plan.readOnly).toBe(0);
    expect(plan.unusable).toBe(0);
  });

  it('clips at the last child rather than growing the container', () => {
    const plan = pastePlan({ row: 1, col: 1 }, [['open'], ['stray']], ITEMS, COLUMNS);

    expect(plan.writes).toEqual([{ item: ITEMS[1], bag: { status: 'open' } }]);
    // Structural, not about the pasted value - counted apart so it is not announced as a failure.
    expect(plan.readOnly).toBe(1);
    expect(plan.unusable).toBe(0);
  });

  it('counts the title column as read-only rather than as a failed value', () => {
    const plan = pastePlan({ row: 0, col: 0 }, [['New name', 'open']], ITEMS, COLUMNS);

    expect(plan.writes).toEqual([{ item: ITEMS[0], bag: { status: 'open' } }]);
    expect(plan.readOnly).toBe(1);
    expect(plan.unusable).toBe(0);
  });

  it('counts a value that cannot become the column value as unusable rather than writing a guess', () => {
    const plan = pastePlan({ row: 0, col: 2 }, [['not a number']], ITEMS, COLUMNS);

    expect(plan.writes).toEqual([]);
    expect(plan.readOnly).toBe(0);
    expect(plan.unusable).toBe(1);
  });
});

describe('fill', () => {
  const ITEMS = [
    item('a', 'Alpha', { status: 'open', count: 7 }),
    item('b', 'Beta'),
    item('c', 'Gamma'),
  ];
  const COLUMNS = resolveColumns(aView(), SCHEMA);

  it('repeats the first row of the range over every row below it', () => {
    const plan = fillPlan({ startRow: 0, endRow: 2, startCol: 1, endCol: 2 }, ITEMS, COLUMNS);

    expect(plan.writes).toEqual([
      { item: ITEMS[1], bag: { status: 'open', count: 7 } },
      { item: ITEMS[2], bag: { status: 'open', count: 7 } },
    ]);
  });

  it('does nothing with a single-row range, which has nothing below its pattern', () => {
    const plan = fillPlan({ startRow: 1, endRow: 1, startCol: 1, endCol: 1 }, ITEMS, COLUMNS);

    expect(plan.writes).toEqual([]);
  });
});

describe('clear', () => {
  it('clears every editable cell in the range, with unchecked standing in for a cleared checkbox', () => {
    const items = [item('a', 'Alpha', { status: 'open', done: true })];
    const columns = resolveColumns(aView(), SCHEMA);

    const plan = clearPlan({ startRow: 0, endRow: 0, startCol: 0, endCol: 3 }, items, columns);

    expect(plan.writes).toEqual([
      { item: items[0], bag: { status: null, count: null, done: false } },
    ]);
    // The title cell is read-only by construction - the most ordinary gesture in the grid clears
    // a whole row, and a count that read as a failure would make it sound broken every time.
    expect(plan.readOnly).toBe(1);
    expect(plan.unusable).toBe(0);
  });
});

describe('copy', () => {
  it('round-trips a range through the TSV the clipboard carries', () => {
    const items = [
      item('a', 'Alpha', { status: 'open', count: 3 }),
      item('b', 'Beta', { done: true }),
    ];
    const columns = resolveColumns(aView(), SCHEMA);
    const range = { startRow: 0, endRow: 1, startCol: 0, endCol: 3 };

    const tsv = rangeToTsv(rangeTextMap(range, items, columns), range);

    expect(tsv).toBe('Alpha\topen\t3\t\nBeta\t\t\tYes');
  });

  it('shows a multi-select as its comma-joined values, which is what coercion reads back', () => {
    const alpha = item('a', 'Alpha', { tags: ['red', 'blue'] });
    const columns = resolveColumns(aView(), schemaOf(property('tags', 'Tags', 'multi_select')));

    expect(cellText(alpha, columnFor(columns, 'tags'))).toBe('red, blue');
  });
});

describe('display', () => {
  it('shows the first line of a multi-line text with a mark that more follows, copying it whole', () => {
    const alpha = item('a', 'Alpha', {
      notes: 'First\nSecond',
      summary: 'One\nTwo',
      short: 'Only',
    });
    const columns = resolveColumns(
      aView(),
      schemaOf(
        property('notes', 'Notes', 'long_text'),
        property('summary', 'Summary', 'text'),
        property('short', 'Short', 'long_text'),
      ),
    );

    expect(cellDisplay(alpha, columnFor(columns, 'notes'))).toBe('First …');
    expect(cellDisplay(alpha, columnFor(columns, 'summary'))).toBe('One …');
    expect(cellDisplay(alpha, columnFor(columns, 'short'))).toBe('Only');
    expect(cellText(alpha, columnFor(columns, 'notes'))).toBe('First\nSecond');
  });

  it('shows a timestamp as the reader’s own clock while copying the stored string', () => {
    const stored = '2026-03-17T09:00:00+00:00[Etc/UTC]';
    const alpha = item('a', 'Alpha', { when: stored });
    const columns = resolveColumns(aView(), schemaOf(property('when', 'When', 'timestamp')));
    const when = columnFor(columns, 'when');

    // Storage syntax - the offset, the bracketed zone - never reaches the cell; what does is a
    // clock. The exact wall time depends on the machine's zone, so the shape is asserted rather
    // than a literal.
    expect(cellDisplay(alpha, when)).toMatch(/^\d{4}-\d{2}-\d{2} \d{2}:\d{2}$/);
    expect(cellText(alpha, when)).toBe(stored);
  });

  it('never offers to edit a timestamp or an image as free text', () => {
    // A timestamp is stored in a bracketed-zone format nobody would type and the server refuses
    // anything else; an image is an asset reference. Both read; neither edits.
    const columns = resolveColumns(
      aView(),
      schemaOf(property('when', 'When', 'timestamp'), property('shot', 'Shot', 'image')),
    );

    expect(columnFor(columns, 'when').editable).toBe(false);
    expect(columnFor(columns, 'shot').editable).toBe(false);
  });

  it('reads and copies an assignee but never offers it as free text, though its shape is text', () => {
    // `valueShapeOf('assignee')` is `text`, deliberately - so width and clearing stay on the same
    // switch as every other string-shaped property - but a person typing a UUID into a cell is not
    // a workflow, so this column reads and copies exactly like a timestamp or an image column.
    const assigneeId = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
    const alpha = item('a', 'Alpha', { owner: assigneeId });
    const columns = resolveColumns(aView(), schemaOf(property('owner', 'Owner', 'assignee')));
    const owner = columnFor(columns, 'owner');

    expect(owner.editable).toBe(false);
    expect(cellText(alpha, owner)).toBe(assigneeId);
    expect(cellDisplay(alpha, owner)).toBe(assigneeId);
  });

  it('treats the task types exactly as the shapes they store, in editing and coercion alike', () => {
    // The type carries the meaning; the value keeps the plain shape - so a due-date cell edits
    // like a date cell, a completion cell clears to false like a checkbox, and a priority cell
    // coerces its text to a number the way any number does.
    const columns = resolveColumns(
      aView(),
      schemaOf(
        property('due_date', 'Due', 'due_date'),
        property('completion', 'Done', 'completion'),
        property('priority', 'Urgency', 'priority'),
        property('estimate', 'Hours', 'estimate'),
      ),
    );

    expect(columnFor(columns, 'due_date').editable).toBe(true);
    expect(columnFor(columns, 'completion').editable).toBe(true);
    expect(columnFor(columns, 'priority').editable).toBe(true);
    expect(columnFor(columns, 'estimate').editable).toBe(true);

    expect(coerceCellText('yes', 'completion')).toEqual({ ok: true, value: true });
    expect(coerceCellText('', 'completion')).toEqual({ ok: true, value: false });
    expect(coerceCellText('2', 'priority')).toEqual({ ok: true, value: 2 });
    expect(coerceCellText('2.5', 'estimate')).toEqual({ ok: true, value: 2.5 });
    expect(coerceCellText('2026-09-01', 'due_date')).toEqual({ ok: true, value: '2026-09-01' });
  });
});

describe('a computed column in the grid', () => {
  it('is not editable, so a paste over it is skipped rather than refused per row', () => {
    // Stated rather than inherited from a shape switch's default: a formula column came out
    // uneditable only because 'formula' happens not to be a text-editable shape, and that would
    // reverse the day that list grew.
    const columns = resolveColumns(
      aView({ kind: 'sheet', columns: ['total'] }),
      schemaOf(property('total', 'Total', 'formula')),
    );

    expect(columnFor(columns, 'total').editable).toBe(false);
  });

  it('reports a paste into it as read-only rather than writing a computed key', () => {
    const columns = resolveColumns(
      aView({ kind: 'sheet', columns: ['total', 'count'] }),
      schemaOf(property('total', 'Total', 'formula'), property('count', 'Count', 'number')),
    );
    const rows = [item('item-1', 'One')];

    const plan = pastePlan({ row: 0, col: 1 }, [['9', '4']], rows, columns);

    expect(plan.writes.map((write) => write.bag)).toEqual([{ count: 4 }]);
    expect(plan.readOnly).toBe(1);
  });
});
