import { describe, expect, it } from 'vitest';

import type { StructureProperty, StructureView } from '../types.js';
import type { ValidationContext } from './report.js';
import { validateSpec } from './spec.js';

function context(overrides: Partial<ValidationContext> = {}): ValidationContext {
  return { inheritedFields: [], today: '2026-09-26', ...overrides };
}

const statusProperty: StructureProperty = {
  key: 'status',
  label: 'Status',
  type: 'select',
  options: ['To do', 'Done'],
  required: false,
};

const dueDateProperty: StructureProperty = {
  key: 'due_date',
  label: 'Due date',
  type: 'due_date',
  options: [],
  required: false,
};

function interactiveFormView(id = 'form'): StructureView {
  return {
    id,
    name: 'Intake',
    kind: 'interactive_form',
    columns: ['title'],
    groupBy: null,
    groupOrder: [],
    dateProperty: null,
    sortBy: null,
    sortDescending: false,
    mode: null,
    coverProperty: null,
    endDateProperty: null,
    cardSize: null,
    layout: null,
    filters: [],
    interactiveForm: {
      pages: [
        {
          id: 'p1',
          title: 'Details',
          description: null,
          visibleWhen: [],
          blocks: [
            {
              id: 'b1',
              kind: 'field',
              propertyKey: 'status',
              text: 'Status',
              help: null,
              required: false,
              identityRole: null,
              visibleWhen: [],
            },
          ],
        },
      ],
      titleMode: 'generated',
      titleFieldBlockId: null,
      confirmationTitle: 'Thanks',
      confirmationMessage: 'Received',
    },
  };
}

describe('validateSpec create_structured', () => {
  it('keeps a built-in title column distinct from a property or interactive form field', () => {
    const form = validateSpec(
      'create_structured',
      {
        recipe: 'interactive-form',
        fields: [],
        views: [
          {
            kind: 'interactive_form',
            form: { pages: [{ title: 'Details', blocks: [{ field: 'title' }] }] },
          },
        ],
      },
      context(),
    );
    expect(form.ok).toBe(false);
    expect(form.problems.some((problem) => problem.path.endsWith('.field'))).toBe(true);
    const gallery = validateSpec(
      'create_structured',
      {
        recipe: 'gallery',
        fields: [],
        views: [{ kind: 'gallery', columns: ['title'], cover: 'title' }],
      },
      context(),
    );
    expect(gallery.problems).toContainEqual(expect.objectContaining({ path: 'views[0].cover' }));
    const unknownColumn = validateSpec(
      'create_structured',
      {
        recipe: 'gallery',
        fields: [],
        views: [{ kind: 'gallery', columns: ['missing'] }],
      },
      context(),
    );
    expect(unknownColumn.problems).toContainEqual(
      expect.objectContaining({ path: 'views[0].columns[0]' }),
    );
  });

  it('accepts a well-formed structured spec', () => {
    const report = validateSpec(
      'create_structured',
      {
        recipe: 'board',
        fields: [{ label: 'Status', type: 'select', options: ['To do', 'Done'] }],
      },
      context(),
    );
    expect(report.ok).toBe(true);
    expect(report.problems).toEqual([]);
    expect(report.stats.fields).toBe(1);
  });

  it('rejects a raw value that fails the Zod shape, with a bracketed path', () => {
    const report = validateSpec(
      'create_structured',
      { recipe: 'board', fields: [{ label: 'Status', type: 'select' }] },
      context(),
    );
    expect(report.ok).toBe(false);
    expect(report.problems.some((problem) => problem.path === 'fields[0].options')).toBe(true);
  });

  it('refuses an unstorable schema through refuseSchema and names the path', () => {
    const report = validateSpec(
      'create_structured',
      {
        recipe: 'sheet',
        // Both fields are task-semantic and keyed by their type, per `keyFor` - two of them
        // collide on the same key, which `fieldSpecSchema` cannot see (each field is valid on
        // its own) but `refuseSchema` refuses.
        fields: [
          { label: 'Ship by', type: 'due_date' },
          { label: 'Deadline', type: 'due_date' },
        ],
      },
      context(),
    );
    expect(report.ok).toBe(false);
    expect(
      report.problems.some((problem) => problem.path === 'fields' && problem.code === 'schema'),
    ).toBe(true);
  });

  it('refuses a view whose groupBy is not a select', () => {
    const report = validateSpec(
      'create_structured',
      {
        recipe: 'board',
        fields: [{ label: 'Notes', type: 'text' }],
        views: [{ kind: 'board', groupBy: 'notes' }],
      },
      context(),
    );
    expect(report.ok).toBe(false);
    expect(report.problems.some((problem) => problem.path === 'views[0]')).toBe(true);
  });

  // Grouping by a multi-select is decided (ADR-0054) but staged: the web board cannot draw one
  // item in several columns yet, so a board refuses it here exactly as a chart does.
  it.each(['board', 'chart'])('refuses a %s grouped by a multi-select', (kind) => {
    const report = validateSpec(
      'create_structured',
      {
        recipe: 'sheet',
        fields: [{ label: 'Tags', type: 'multi_select', options: ['Red', 'Blue'] }],
        views: [{ kind, groupBy: 'tags' }],
      },
      context(),
    );
    expect(report.ok).toBe(false);
    expect(report.problems.some((problem) => problem.path === 'views[0]')).toBe(true);
  });

  it('accepts a chart along a date, split by a select, drawn as a line', () => {
    const report = validateSpec(
      'create_structured',
      {
        recipe: 'sheet',
        fields: [
          { label: 'Spent on', type: 'date' },
          { label: 'Category', type: 'select', options: ['Food', 'Rent'] },
        ],
        views: [{ kind: 'chart', groupBy: 'spent_on', chartKind: 'line', splitBy: 'category' }],
      },
      context(),
    );
    expect(report.problems).toEqual([]);
  });

  it.each([
    ['priority', { label: 'Severity', type: 'priority' }, 'severity'],
    ['checkbox', { label: 'Resolved', type: 'checkbox' }, 'resolved'],
  ])('accepts a bar and a pie chart grouped by a %s', (_name, field, key) => {
    for (const chartKind of ['bar', 'pie']) {
      const report = validateSpec(
        'create_structured',
        { recipe: 'sheet', fields: [field], views: [{ kind: 'chart', groupBy: key, chartKind }] },
        context(),
      );
      expect(report.problems, chartKind).toEqual([]);
    }
  });

  it('names the date requirement when a period chart has no date to group by', () => {
    const fields = [
      { label: 'Severity', type: 'priority' },
      { label: 'Wrote on', type: 'date' },
    ];
    for (const view of [
      { kind: 'chart', groupBy: 'severity', chartKind: 'line', period: 'week' },
      { kind: 'chart', groupBy: 'severity', period: 'month' },
      { kind: 'chart', chartKind: 'area', period: 'week' },
    ]) {
      const report = validateSpec(
        'create_structured',
        { recipe: 'sheet', fields, views: [view] },
        context(),
      );
      expect(report.ok, JSON.stringify(view)).toBe(false);
      expect(JSON.stringify(report.problems), JSON.stringify(view)).toContain(
        'needs a date property to group by',
      );
    }
  });

  it('refuses a line chart over categories, a split by free text, and a year grid by month', () => {
    const fields = [
      { label: 'Status', type: 'select', options: ['Open', 'Done'] },
      { label: 'Notes', type: 'text' },
      { label: 'Done on', type: 'date' },
    ];
    for (const view of [
      { kind: 'chart', groupBy: 'status', chartKind: 'line' },
      { kind: 'chart', groupBy: 'status', splitBy: 'notes' },
      { kind: 'chart', groupBy: 'status', period: 'week' },
    ]) {
      const report = validateSpec(
        'create_structured',
        { recipe: 'sheet', fields, views: [view] },
        context(),
      );
      expect(report.ok, JSON.stringify(view)).toBe(false);
    }
  });

  it('refuses chart options on a view that is not a chart', () => {
    const report = validateSpec(
      'create_structured',
      {
        recipe: 'board',
        fields: [{ label: 'Status', type: 'select', options: ['Open', 'Done'] }],
        views: [{ kind: 'board', groupBy: 'status', chartKind: 'pie' }],
      },
      context(),
    );
    expect(report.ok).toBe(false);
  });

  it('reports an unknown form field at its page and block indices', () => {
    const report = validateSpec(
      'create_structured',
      {
        recipe: 'form',
        fields: [{ label: 'Name', type: 'text' }],
        views: [
          {
            kind: 'interactive_form',
            form: {
              pages: [{ title: 'Details', blocks: [{ heading: 'About' }, { field: 'missing' }] }],
            },
          },
        ],
      },
      context(),
    );
    expect(
      report.problems.some((problem) => problem.path === 'views[0].form.pages[0].blocks[1].field'),
    ).toBe(true);
  });

  it('reports a problem for every bad view, not just the first', () => {
    const report = validateSpec(
      'create_structured',
      {
        recipe: 'sheet',
        fields: [{ label: 'Notes', type: 'text' }],
        views: [
          { kind: 'board', groupBy: 'notes' },
          { kind: 'calendar', date: 'notes' },
        ],
      },
      context(),
    );
    expect(report.ok).toBe(false);
    expect(report.problems.some((problem) => problem.path === 'views[0]')).toBe(true);
    expect(report.problems.some((problem) => problem.path === 'views[1]')).toBe(true);
  });

  it('reports every problem, not only the first', () => {
    const report = validateSpec(
      'create_structured',
      {
        recipe: 'sheet',
        fields: [
          { label: 'Effort', type: 'rollup', rollup: { aggregate: 'sum', source: 'nonexistent' } },
        ],
        views: [{ kind: 'board', groupBy: 'also-nonexistent' }],
      },
      context(),
    );
    expect(report.ok).toBe(false);
    // The unresolved rollup source and the unresolved groupBy are unrelated mistakes; both must
    // be reported, not just whichever one this validator noticed first.
    expect(report.problems.some((problem) => problem.path === 'fields[0].rollup.source')).toBe(
      true,
    );
    expect(report.problems.some((problem) => problem.path === 'views[0].groupBy')).toBe(true);
  });

  it('names both candidates when a ref matches more than one newly added field by label', () => {
    const report = validateSpec(
      'create_structured',
      {
        recipe: 'board',
        fields: [
          { label: 'Owner', key: 'lead', type: 'text' },
          { label: 'Lead', key: 'owner', type: 'text' },
        ],
        views: [{ kind: 'board', groupBy: 'owner' }],
      },
      context(),
    );
    expect(report.ok).toBe(false);
    const problem = report.problems.find((candidate) => candidate.path === 'views[0].groupBy');
    expect(problem?.code).toBe('ambiguous');
    expect(problem?.message).toContain('could mean');
  });

  it('accepts an interactive form with a page condition and a title taken from a field', () => {
    const report = validateSpec(
      'create_structured',
      {
        recipe: 'form',
        fields: [
          { label: 'Name', type: 'text' },
          { label: 'Subscribe', type: 'checkbox' },
        ],
        views: [
          {
            kind: 'interactive_form',
            form: {
              pages: [
                {
                  title: 'Your response',
                  blocks: [{ field: 'name', required: true }, { field: 'subscribe' }],
                },
                {
                  title: 'Thanks for subscribing',
                  showWhen: [{ field: 'subscribe', op: 'checked' }],
                  blocks: [{ heading: 'You are on the list' }],
                },
              ],
              title: { from: 'field', field: 'name' },
            },
          },
        ],
      },
      context(),
    );
    expect(report.ok).toBe(true);
  });

  it('refuses a form condition that references a field not yet declared on an earlier block', () => {
    const report = validateSpec(
      'create_structured',
      {
        recipe: 'form',
        fields: [
          { label: 'Name', type: 'text' },
          { label: 'Subscribe', type: 'checkbox' },
        ],
        views: [
          {
            kind: 'interactive_form',
            form: {
              pages: [
                {
                  title: 'Your response',
                  showWhen: [{ field: 'subscribe', op: 'checked' }],
                  blocks: [{ field: 'name' }, { field: 'subscribe' }],
                },
              ],
            },
          },
        ],
      },
      context(),
    );
    expect(report.ok).toBe(false);
    expect(
      report.problems.some(
        (problem) => problem.path === 'views[0].form.pages[0].showWhen[0].field',
      ),
    ).toBe(true);
  });
});

describe('formula fields in every structural write', () => {
  const operations = ['create_structured', 'add_view', 'add_fields', 'edit_form'] as const;
  const formulaContext = context({
    inheritedFields: [
      { key: 'price', label: 'Price', type: 'number', options: [], required: false },
    ],
    existing: { declared: [statusProperty], views: [interactiveFormView()] },
  });
  const specFor = (op: (typeof operations)[number], fields: unknown[]) => {
    if (op === 'create_structured') return { recipe: 'list', fields };
    if (op === 'add_view') return { fields, views: [{ kind: 'list' }] };
    if (op === 'edit_form')
      return {
        fields,
        viewId: 'form',
        form: { pages: [{ title: 'Details', blocks: [{ field: 'status' }] }] },
      };
    return { fields };
  };

  it.each(operations)('refuses invalid formulas in %s before writing', (op) => {
    for (const formula of [
      'PROPERTY("price")',
      'prop("price")',
      'TODAY()',
      'NOT(TRUE, FALSE)',
      'SUM(A1:A3)',
      '=[price] * 2',
      '[price] == 2',
      '[Price] * 2',
      '[missing] + 1',
    ]) {
      const report = validateSpec(
        op,
        specFor(op, [{ key: 'total', label: 'Total', type: 'formula', formula }]),
        formulaContext,
      );
      expect(report.ok, `${op}: ${formula}`).toBe(false);
      expect(report.problems).toContainEqual(
        expect.objectContaining({
          path: 'fields[0].formula',
          code: 'formula.invalid_expression',
        }),
      );
    }
  });

  it.each(operations)('accepts exact inherited and same-call keys in %s', (op) => {
    const report = validateSpec(
      op,
      specFor(op, [
        {
          key: 'total',
          label: 'Total',
          type: 'formula',
          formula: 'ROUND([price] * [quantity], 2)',
        },
        { key: 'quantity', label: 'Quantity', type: 'number' },
      ]),
      formulaContext,
    );
    expect(report.problems).toEqual([]);
  });

  it('does not prevent an unrelated addition because an existing formula is invalid', () => {
    const report = validateSpec(
      'add_fields',
      { fields: [{ label: 'Comment', type: 'text' }] },
      context({
        inheritedFields: [
          {
            key: 'old',
            label: 'Old',
            type: 'formula',
            expression: 'NOPE(1)',
            options: [],
            required: false,
          },
        ],
      }),
    );
    expect(report.problems).toEqual([]);
  });
});

describe('validateSpec add_view', () => {
  it.each([
    [10, 4, false, 2],
    [10, 2, true, 2],
    [12, 1, false, 0],
    [0, 4, true, 12],
  ])(
    'checks %i existing plus %i requested views before approval',
    (existingCount, requestedCount, ok, remaining) => {
      const result = validateSpec(
        'add_view',
        {
          views: Array.from({ length: requestedCount }, (_, i) => ({
            kind: 'list',
            name: `New ${String(i)}`,
          })),
        },
        context({
          existing: {
            declared: [],
            views: Array.from({ length: existingCount }, (_, i) => ({
              ...interactiveFormView(`existing-${String(i)}`),
              kind: 'list',
              interactiveForm: null,
            })),
          },
        }),
      );
      expect(result.ok).toBe(ok);
      if (!ok)
        expect(result.problems).toContainEqual({
          path: 'views',
          code: 'view-capacity',
          message: `This item has ${String(existingCount)} views and room for ${String(remaining)} more (12 total). Adding ${String(requestedCount)} would create ${String(existingCount + requestedCount)}; request at most ${String(remaining)}.`,
        });
    },
  );

  it('counts all requested views even when a new view also has an invalid field', () => {
    const result = validateSpec(
      'add_view',
      {
        views: [
          { kind: 'board', groupBy: 'missing' },
          { kind: 'list' },
          { kind: 'list' },
          { kind: 'list' },
        ],
      },
      context({
        existing: {
          declared: [],
          views: Array.from({ length: 10 }, (_, i) => interactiveFormView(`form-${String(i)}`)),
        },
      }),
    );
    const capacity = result.problems.find((problem) => problem.code === 'view-capacity');
    expect(capacity?.message).toContain('Adding 4 would create 14');
    expect(result.problems).toContainEqual(expect.objectContaining({ path: 'views[0].groupBy' }));
  });

  it('does not reject an additive repair because an existing view is unrenderable', () => {
    const existing = {
      ...interactiveFormView(),
      kind: 'board',
      groupBy: 'deleted',
      interactiveForm: null,
    };
    expect(
      validateSpec(
        'add_view',
        { views: [{ kind: 'list' }] },
        context({ existing: { declared: [], views: [existing] } }),
      ).ok,
    ).toBe(true);
  });

  it('refuses a new field whose key already exists in the effective schema', () => {
    const report = validateSpec(
      'add_view',
      {
        fields: [{ label: 'Status again', key: 'status', type: 'text' }],
        views: [{ kind: 'list' }],
      },
      context({ inheritedFields: [statusProperty] }),
    );
    expect(report.ok).toBe(false);
    expect(report.problems.some((problem) => problem.code === 'collision')).toBe(true);
  });

  it('accepts an additive view over an existing effective schema', () => {
    const report = validateSpec(
      'add_view',
      { views: [{ kind: 'board', groupBy: 'status' }] },
      context({ inheritedFields: [statusProperty] }),
    );
    expect(report.ok).toBe(true);
  });

  it('refuses two newly added fields that collide with each other, not only with an existing one', () => {
    const report = validateSpec(
      'add_view',
      {
        fields: [
          { label: 'Owner', key: 'owner', type: 'text' },
          { label: 'Owner again', key: 'owner', type: 'text' },
        ],
        views: [{ kind: 'list' }],
      },
      context(),
    );
    expect(report.ok).toBe(false);
    const problem = report.problems.find((candidate) => candidate.path === 'fields[1].key');
    expect(problem?.code).toBe('collision');
  });

  it('reports a field collision and a bad view from the same request', () => {
    const report = validateSpec(
      'add_view',
      {
        fields: [{ label: 'Status again', key: 'status', type: 'text' }],
        views: [{ kind: 'board', groupBy: 'nonexistent' }],
      },
      context({ inheritedFields: [statusProperty] }),
    );
    expect(report.ok).toBe(false);
    expect(report.problems.some((problem) => problem.code === 'collision')).toBe(true);
    expect(
      report.problems.some(
        (problem) => problem.path === 'views[0]' || problem.path === 'views[0].groupBy',
      ),
    ).toBe(true);
  });
});

describe('validateSpec list sections', () => {
  const owner: StructureProperty = {
    key: 'owner',
    label: 'Owner',
    type: 'text',
    options: [],
    required: false,
  };
  const done: StructureProperty = {
    key: 'done',
    label: 'Done',
    type: 'checkbox',
    options: [],
    required: false,
  };

  it('accepts a list sectioned by a select, a checkbox or the body kind', () => {
    for (const groupBy of ['status', 'done', '$type']) {
      const report = validateSpec(
        'add_view',
        { views: [{ kind: 'list', groupBy }] },
        context({ inheritedFields: [statusProperty, done] }),
      );
      expect(report.ok, groupBy).toBe(true);
    }
  });

  it('refuses a list sectioned by free text, which would draw a heading per value', () => {
    const report = validateSpec(
      'add_view',
      { views: [{ kind: 'list', groupBy: 'owner' }] },
      context({ inheritedFields: [owner] }),
    );
    expect(report.ok).toBe(false);
    expect(report.problems[0]?.message).toContain('a list makes sections only from');
  });

  it('still refuses $type on a board, whose columns must be a select', () => {
    const report = validateSpec(
      'add_view',
      { views: [{ kind: 'board', groupBy: '$type' }] },
      context({ inheritedFields: [statusProperty] }),
    );
    expect(report.ok).toBe(false);
  });
});

describe('validateSpec checklist', () => {
  const done: StructureProperty = {
    key: 'done',
    label: 'Done',
    type: 'checkbox',
    options: [],
    required: false,
  };
  const complete: StructureProperty = {
    key: 'completion',
    label: 'Complete',
    type: 'completion',
    options: [],
    required: false,
  };

  it('accepts a checklist that falls back to a done checkbox or the task completion', () => {
    for (const fields of [[done], [complete]]) {
      const report = validateSpec(
        'add_view',
        { views: [{ kind: 'checklist' }] },
        context({ inheritedFields: fields }),
      );
      expect(report.ok).toBe(true);
    }
  });

  it('accepts a named checkbox and refuses a named property that is not one', () => {
    const named = validateSpec(
      'add_view',
      { views: [{ kind: 'checklist', doneProperty: 'completion' }] },
      context({ inheritedFields: [complete, statusProperty] }),
    );
    expect(named.ok).toBe(true);

    const wrong = validateSpec(
      'add_view',
      { views: [{ kind: 'checklist', doneProperty: 'status' }] },
      context({ inheritedFields: [statusProperty] }),
    );
    expect(wrong.ok).toBe(false);
    expect(wrong.problems[0]?.message).toContain('ticks a checkbox');
  });

  it('refuses a checklist with nothing to tick, and doneProperty on any other kind', () => {
    const nothing = validateSpec(
      'add_view',
      { views: [{ kind: 'checklist' }] },
      context({ inheritedFields: [statusProperty] }),
    );
    expect(nothing.ok).toBe(false);

    const elsewhere = validateSpec(
      'add_view',
      { views: [{ kind: 'list', doneProperty: 'done' }] },
      context({ inheritedFields: [done] }),
    );
    expect(elsewhere.ok).toBe(false);
  });
});

describe('validateSpec matrix', () => {
  const urgent: StructureProperty = {
    key: 'urgent',
    label: 'Urgent',
    type: 'checkbox',
    options: [],
    required: false,
  };

  it('accepts two different select or checkbox axes and stores the columns as groupBy', () => {
    const report = validateSpec(
      'add_view',
      { views: [{ kind: 'matrix', rowBy: 'urgent', columnBy: 'status' }] },
      context({ inheritedFields: [statusProperty, urgent] }),
    );
    expect(report.ok).toBe(true);
  });

  it('refuses a matrix missing an axis, or with one property on both', () => {
    for (const view of [
      { kind: 'matrix', columnBy: 'status' },
      { kind: 'matrix', rowBy: 'urgent' },
      { kind: 'matrix', rowBy: 'status', columnBy: 'status' },
    ]) {
      const report = validateSpec(
        'add_view',
        { views: [view] },
        context({ inheritedFields: [statusProperty, urgent] }),
      );
      expect(report.ok, JSON.stringify(view)).toBe(false);
    }
  });

  it('refuses groupBy on a matrix, whose columns are spelled columnBy', () => {
    const report = validateSpec(
      'add_view',
      { views: [{ kind: 'matrix', rowBy: 'urgent', groupBy: 'status' }] },
      context({ inheritedFields: [statusProperty, urgent] }),
    );
    expect(report.ok).toBe(false);
  });
});

describe('validateSpec create_entries', () => {
  it('accepts entries whose values fit the effective schema', () => {
    const report = validateSpec(
      'create_entries',
      { entries: [{ title: 'First', values: { status: 'Done' } }] },
      context({ inheritedFields: [statusProperty] }),
    );
    expect(report.ok).toBe(true);
    expect(report.stats.entries).toBe(1);
  });

  it('reports an unknown field name at entries[1].values.rating', () => {
    const report = validateSpec(
      'create_entries',
      {
        entries: [{ title: 'First' }, { title: 'Second', values: { rating: 5 } }],
      },
      context({ inheritedFields: [statusProperty] }),
    );
    expect(report.ok).toBe(false);
    expect(report.problems.some((problem) => problem.path === 'entries[1].values.rating')).toBe(
      true,
    );
  });

  it('refuses a select value outside its options', () => {
    const report = validateSpec(
      'create_entries',
      { entries: [{ title: 'First', values: { status: 'Archived' } }] },
      context({ inheritedFields: [statusProperty] }),
    );
    expect(report.ok).toBe(false);
    expect(report.problems.some((problem) => problem.path === 'entries[0].values.status')).toBe(
      true,
    );
  });

  it('reports a bad value in every entry, not only the first', () => {
    const report = validateSpec(
      'create_entries',
      {
        entries: [
          { title: 'First', values: { status: 'Archived' } },
          { title: 'Second', values: { rating: 5 } },
        ],
      },
      context({ inheritedFields: [statusProperty] }),
    );
    expect(report.ok).toBe(false);
    expect(report.problems.some((problem) => problem.path === 'entries[0].values.status')).toBe(
      true,
    );
    expect(report.problems.some((problem) => problem.path === 'entries[1].values.rating')).toBe(
      true,
    );
  });

  it('refuses a value set on a computed field', () => {
    const total: StructureProperty = {
      key: 'total',
      label: 'Total',
      type: 'formula',
      options: [],
      required: false,
      expression: '1 + 1',
    };
    const report = validateSpec(
      'create_entries',
      { entries: [{ title: 'First', values: { total: 5 } }] },
      context({ inheritedFields: [total] }),
    );
    expect(report.ok).toBe(false);
    expect(report.problems.some((problem) => problem.path === 'entries[0].values.total')).toBe(
      true,
    );
  });
});

describe('validateSpec apply_template', () => {
  it('accepts an empty inputs object', () => {
    const report = validateSpec('apply_template', {}, context());
    expect(report.ok).toBe(true);
  });
});

describe('validateSpec edit operations', () => {
  it('refuses add_fields that collide with the effective schema', () => {
    const report = validateSpec(
      'add_fields',
      { fields: [{ label: 'Another Status', key: 'status', type: 'text' }] },
      context({ existing: { declared: [statusProperty], views: [] } }),
    );
    expect(report.ok).toBe(false);
    expect(report.problems.some((problem) => problem.code === 'collision')).toBe(true);
  });

  it('refuses edit_form when the named view is not an interactive form', () => {
    const board = { ...interactiveFormView('board'), kind: 'board', interactiveForm: null };
    const report = validateSpec(
      'edit_form',
      {
        viewId: 'board',
        form: { pages: [{ title: 'Details', blocks: [{ heading: 'Info' }] }] },
      },
      context({ existing: { declared: [], views: [board] } }),
    );
    expect(report.ok).toBe(false);
    expect(report.problems.some((problem) => problem.path === 'viewId')).toBe(true);
  });

  it('refuses edit_form blocks that name computed fields', () => {
    const total: StructureProperty = {
      key: 'total',
      label: 'Total',
      type: 'formula',
      options: [],
      required: false,
      expression: '1 + 1',
    };
    const report = validateSpec(
      'edit_form',
      {
        viewId: 'form',
        form: { pages: [{ title: 'Details', blocks: [{ field: 'total' }] }] },
      },
      context({
        inheritedFields: [total],
        existing: { declared: [], views: [interactiveFormView()] },
      }),
    );
    expect(report.ok).toBe(false);
    expect(report.problems.some((problem) => problem.code === 'views')).toBe(true);
  });

  it('set_recurrence needs an effective due_date field and a value on the item', () => {
    const missingValue = validateSpec(
      'set_recurrence',
      { frequency: 'daily', interval: 1 },
      context({ existing: { declared: [dueDateProperty], views: [] } }),
    );
    expect(missingValue.ok).toBe(false);
    expect(
      missingValue.problems.some((problem) => problem.code === 'recurrence-needs-due-date-value'),
    ).toBe(true);

    const presentValue = validateSpec(
      'set_recurrence',
      { frequency: 'daily', interval: 1 },
      context({
        existing: { declared: [dueDateProperty], views: [] },
        itemValues: { due_date: '2026-10-01' },
      }),
    );
    expect(presentValue.ok).toBe(true);
  });
});

describe('chat view schema', () => {
  it('requires message fields instead of treating arbitrary children as messages', () => {
    const fields = [
      { key: 'chat_role', label: 'Role', type: 'select', options: ['user', 'assistant', 'system'] },
      { key: 'chat_text', label: 'Message', type: 'text' },
      { key: 'chat_created_at', label: 'Sent', type: 'date' },
      { key: 'chat_author', label: 'Author', type: 'text' },
    ];
    expect(validateSpec('add_view', { views: [{ kind: 'chat' }] }, context()).ok).toBe(false);
    expect(
      validateSpec(
        'create_structured',
        { recipe: 'list', fields, views: [{ kind: 'chat' }] },
        context(),
      ).ok,
    ).toBe(true);
  });
});
