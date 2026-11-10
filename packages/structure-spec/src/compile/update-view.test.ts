import { describe, expect, it } from 'vitest';
import { z } from 'zod';

import { normalizeForCodex } from '../catalog/tools.js';
import { updateViewSpecSchema } from '../spec/update-view.js';
import { validateSpec } from '../validate/spec.js';
import type { ValidationContext } from '../validate/report.js';
import type { StructureProperty, StructureView } from '../types.js';
import { describeSteps } from '../describe/steps.js';
import { compileUpdateView } from './update-view.js';
import { compileView } from './views.js';
import { viewSpecSchema } from '../spec/view.js';

const effective: StructureProperty[] = [
  { key: 'status', label: 'Status', type: 'select', options: ['New', 'Done'], required: false },
  {
    key: 'category',
    label: 'Category',
    type: 'select',
    options: ['Home', 'Work'],
    required: false,
  },
  { key: 'due', label: 'Due', type: 'due_date', options: [], required: false },
  { key: 'end', label: 'End', type: 'date', options: [], required: false },
  { key: 'amount', label: 'Amount', type: 'number', options: [], required: false },
  { key: 'done', label: 'Done', type: 'checkbox', options: [], required: false },
  { key: 'picture', label: 'Picture', type: 'image', options: [], required: false },
  { key: 'notes', label: 'Notes', type: 'text', options: [], required: false },
];

function view(overrides: Partial<StructureView> = {}): StructureView {
  return {
    id: 'list',
    name: 'All work',
    kind: 'list',
    columns: ['title', 'status'],
    groupBy: 'status',
    groupOrder: ['New', 'Done'],
    dateProperty: null,
    endDateProperty: null,
    sortBy: 'due',
    sortDescending: false,
    mode: null,
    coverProperty: null,
    cardSize: null,
    layout: null,
    filters: [{ property: 'status', operator: 'equals', value: 'New' }],
    sorts: [
      { property: 'due', descending: false },
      { property: 'amount', descending: true },
    ],
    collapsedGroups: ['Done'],
    groupLimits: [{ group: 'New', limit: 5 }],
    aggregates: [{ property: 'amount', function: 'sum' }],
    ...overrides,
  };
}

function context(views: StructureView[], defaultViewId: string | null = views[0]?.id ?? null) {
  return {
    itemId: 'container',
    existing: {
      declared: effective.filter((field) => field.key === 'status'),
      effective,
      inherit: true,
      views,
      defaultViewId,
    },
  };
}

function validation(views: StructureView[]): ValidationContext {
  return {
    inheritedFields: effective,
    existing: { declared: [], inherit: true, views, defaultViewId: views[0]?.id ?? null },
    today: '2026-10-09',
  };
}

function updated(spec: unknown, views: StructureView[]) {
  const [step] = compileUpdateView(updateViewSpecSchema.parse(spec), context(views));
  if (step?.kind !== 'replaceViewSetup') throw new Error('Expected replaceViewSetup.');
  const selected = step.views.find((candidate) => candidate.id === step.viewId);
  if (selected === undefined) throw new Error('Expected the selected view.');
  return { step, selected };
}

describe('narrow update-view schema', () => {
  it('lets a pet change a form response mode while preserving its ordinary view kind', () => {
    const form = view({ kind: 'form', mode: 'saved' });
    const { selected } = updated({ viewId: form.id, patch: { mode: 'temporary' } }, [form]);
    expect(selected.kind).toBe('form');
    expect(selected.mode).toBe('temporary');
    expect(
      validateSpec('update_view', { viewId: form.id, patch: { mode: 'month' } }, validation([form]))
        .ok,
    ).toBe(false);
    expect(
      validateSpec(
        'update_view',
        { viewId: 'calendar', patch: { mode: 'saved' } },
        validation([view({ id: 'calendar', kind: 'calendar', dateProperty: 'due' })]),
      ).ok,
    ).toBe(false);
  });
  it.each([
    'id',
    'kind',
    'fields',
    'form',
    'interactiveForm',
    'default',
    'defaultViewId',
    'companionViewId',
    'companionPlacement',
    'habitWidgets',
    'sorts',
    'publishInteractiveFormViewId',
  ])('refuses forbidden %s edits rather than dropping them', (key) => {
    expect(
      updateViewSpecSchema.safeParse({ viewId: 'list', patch: { name: 'Renamed', [key]: [] } })
        .success,
    ).toBe(false);
  });

  it('refuses an empty patch, unknown envelope keys, nested groups and empty chart patches', () => {
    expect(updateViewSpecSchema.safeParse({ viewId: 'list', patch: {} }).success).toBe(false);
    expect(
      updateViewSpecSchema.safeParse({ viewId: 'list', patch: { name: 'Renamed' }, fields: [] })
        .success,
    ).toBe(false);
    expect(updateViewSpecSchema.safeParse({ viewId: 'chart', patch: { chart: {} } }).success).toBe(
      false,
    );
    expect(
      updateViewSpecSchema.safeParse({
        viewId: 'list',
        patch: { filters: [{ any: [{ any: [] }] }] },
      }).success,
    ).toBe(false);
  });

  it('fits the dynamic-tool budget with both kinds of filter and all chart options', () => {
    const schema = z.object({ itemId: z.string(), spec: updateViewSpecSchema }).strict();
    const normalized = normalizeForCodex(
      z.toJSONSchema(schema, { io: 'input', unrepresentable: 'any' }),
    );
    expect(Buffer.byteLength(JSON.stringify(normalized), 'utf8')).toBeLessThanOrEqual(4800);
  });
});

describe('compileUpdateView', () => {
  it('preserves all omitted settings, grouped filters, current inheritance and companion configuration', () => {
    const companion = view({ id: 'companion', name: 'Companion', groupBy: null });
    const target = view({
      companionViewId: 'companion',
      companionPlacement: 'below',
      filters: [
        {
          property: null,
          operator: null,
          value: null,
          any: [
            { property: 'status', operator: 'equals', value: 'New' },
            { property: 'category', operator: 'equals', value: 'Work' },
          ],
        },
      ],
    });
    const original = structuredClone([target, companion]);
    const { step, selected } = updated({ viewId: 'list', patch: { name: 'Review' } }, [
      target,
      companion,
    ]);
    expect(step).toMatchObject({
      itemId: 'container',
      viewId: 'list',
      schema: { properties: [], inherit: true },
      originalPropertyKeys: [],
      viewUpdate: true,
    });
    expect(selected).toEqual({ ...target, name: 'Review' });
    expect(step.views[1]).toEqual(companion);
    expect([target, companion]).toEqual(original);
  });

  it.each([false, true])(
    'preserves the full view order with companion-before-target=%s, its default and inherit=false',
    (companionFirst) => {
      const companion = view({ id: 'companion', groupBy: null });
      const target = view({ companionViewId: 'companion', companionPlacement: 'below' });
      const unrelated = view({ id: 'unrelated' });
      const originalViews = companionFirst
        ? [companion, target, unrelated]
        : [target, companion, unrelated];
      const ctx = context(originalViews, 'companion');
      ctx.existing.inherit = false;
      const [step] = compileUpdateView({ viewId: 'list', patch: { name: 'Review' } }, ctx);
      expect(step).toMatchObject({
        schema: { properties: [], inherit: false },
        views: originalViews.map((view) => ({ id: view.id })),
        defaultViewId: 'companion',
        hideDocument: false,
      });
    },
  );

  it('keeps a hidden body and null default without exposing a default change in the patch', () => {
    const ctx = {
      ...context([view()], null),
      existing: { ...context([view()], null).existing, hideDocument: true },
    };
    const [step] = compileUpdateView({ viewId: 'list', patch: { name: 'Review' } }, ctx);
    expect(step).toMatchObject({ defaultViewId: null, hideDocument: true });
  });

  it('carries a read version into the write step only when the context provides one', () => {
    const base = context([view()]);
    const [legacy] = compileUpdateView({ viewId: 'list', patch: { name: 'Review' } }, base);
    expect(legacy).not.toHaveProperty('expectedVersion');
    const version = 'a'.repeat(64);
    const [conditional] = compileUpdateView(
      { viewId: 'list', patch: { name: 'Review' } },
      { ...base, existing: { ...base.existing, version } },
    );
    expect(conditional).toMatchObject({ expectedVersion: version });
  });

  it('does not overwrite omitted scalar or nested chart fields with explicit undefined input', () => {
    const target = view({
      id: 'chart',
      kind: 'chart',
      groupBy: 'due',
      chart: {
        kind: 'line',
        period: 'month',
        splitBy: null,
        lastPeriods: 6,
        from: null,
        to: null,
        cumulative: true,
        rollingAverage: false,
        stacked: false,
      },
    });
    const [step] = compileUpdateView(
      { viewId: 'chart', patch: { name: undefined, chart: { kind: 'area', period: undefined } } },
      context([target]),
    );
    expect(step?.kind === 'replaceViewSetup' && step.views[0]?.name).toBe(target.name);
    expect(step?.kind === 'replaceViewSetup' && step.views[0]?.chart).toMatchObject({
      kind: 'area',
      period: 'month',
      lastPeriods: 6,
    });
  });

  it('normalizes a newly supplied any-of filter without changing its conditions', () => {
    const any = [
      { property: 'status', operator: 'equals', value: 'New' },
      { property: 'category', operator: 'equals', value: 'Work' },
    ];
    const { selected } = updated({ viewId: 'list', patch: { filters: [{ any }] } }, [view()]);
    expect(selected.filters).toEqual([{ property: null, operator: null, value: null, any }]);
  });

  it('can rename an existing form while preserving every page and condition unchanged', () => {
    const target = view({
      id: 'intake',
      kind: 'interactive_form',
      interactiveForm: {
        pages: [
          {
            id: 'details',
            title: 'Details',
            description: 'Tell us what is needed.',
            visibleWhen: [],
            blocks: [
              {
                id: 'status-question',
                kind: 'field',
                propertyKey: 'status',
                text: 'Status',
                help: null,
                required: true,
                identityRole: null,
                visibleWhen: [],
              },
              {
                id: 'follow-up',
                kind: 'field',
                propertyKey: 'notes',
                text: 'Details',
                help: 'A few sentences.',
                required: false,
                identityRole: null,
                visibleWhen: [
                  { fieldBlockId: 'status-question', operator: 'equals', value: 'New' },
                ],
              },
            ],
          },
        ],
        titleMode: 'generated',
        titleFieldBlockId: null,
        confirmationTitle: 'Thank you',
        confirmationMessage: 'We received your submission.',
      },
    });
    const { selected } = updated({ viewId: 'intake', patch: { name: 'Project intake' } }, [target]);
    expect(selected).toEqual({ ...target, name: 'Project intake' });
  });

  it('changes the primary sort while retaining distinct secondary sorts, and can clear sorting', () => {
    const { selected } = updated(
      { viewId: 'list', patch: { sortBy: 'status', sortDescending: true } },
      [view()],
    );
    expect(selected.sorts).toEqual([
      { property: 'status', descending: true },
      { property: 'amount', descending: true },
    ]);
    const cleared = updated({ viewId: 'list', patch: { sortBy: null } }, [view()]);
    expect(cleared.selected.sorts).toEqual([]);
    expect(cleared.selected.sortBy).toBeNull();
  });

  it('merges chart options without resetting an existing time window or trend settings', () => {
    const target = view({
      id: 'chart',
      kind: 'chart',
      groupBy: 'due',
      measure: 'count',
      measureProperty: null,
      chart: {
        kind: 'line',
        period: 'month',
        splitBy: null,
        lastPeriods: 6,
        from: null,
        to: null,
        cumulative: true,
        rollingAverage: true,
        stacked: false,
      },
    });
    const { selected } = updated(
      { viewId: 'chart', patch: { chart: { kind: 'area', splitBy: 'status' } } },
      [target],
    );
    expect(selected.chart).toEqual({ ...target.chart, kind: 'area', splitBy: 'status' });
  });

  it('clears optional references but refuses to clear a required grouping', () => {
    const { selected } = updated({ viewId: 'list', patch: { groupBy: null } }, [view()]);
    expect(selected.groupBy).toBeNull();
    expect(() =>
      updated({ viewId: 'board', patch: { groupBy: null } }, [
        view({ id: 'board', kind: 'board' }),
      ]),
    ).toThrow(/board needs/);
  });
});

describe('validate update-view patches', () => {
  it.each(['list', 'sheet', 'form', 'gallery', 'checklist', 'matrix'])(
    'preserves the built-in title marker among supported %s columns',
    (kind) => {
      const target = view({
        kind,
        filters: [],
        groupBy: kind === 'matrix' ? 'status' : null,
        rowBy: kind === 'matrix' ? 'category' : null,
      });
      const spec = { viewId: 'list', patch: { columns: ['title', 'notes'] } };
      expect(validateSpec('update_view', spec, validation([target])).ok).toBe(true);
      expect(updated(spec, [target]).selected.columns).toEqual(['title', 'notes']);
    },
  );

  it('accepts and compiles Gallery card fields while retaining its cover and card size', () => {
    const gallery = view({
      kind: 'gallery',
      coverProperty: 'picture',
      cardSize: 'small',
      groupBy: null,
    });
    const spec = { viewId: 'list', patch: { columns: ['title', 'status', 'notes'] } };
    expect(validateSpec('update_view', spec, validation([gallery])).ok).toBe(true);
    expect(updated(spec, [gallery]).selected).toMatchObject({
      columns: ['title', 'status', 'notes'],
      coverProperty: 'picture',
      cardSize: 'small',
    });
    expect(
      validateSpec(
        'update_view',
        { viewId: 'list', patch: { columns: ['Status'] } },
        validation([gallery]),
      ).problems,
    ).toContainEqual(expect.objectContaining({ path: 'patch.columns[0]', code: 'unknown-field' }));
  });

  it('refuses ignored Smart list columns and preserves existing columns when renaming', () => {
    const query = view({ kind: 'query', columns: ['notes'], groupBy: null });
    expect(
      validateSpec(
        'update_view',
        { viewId: 'list', patch: { columns: ['status'] } },
        validation([query]),
      ).problems,
    ).toContainEqual(expect.objectContaining({ path: 'patch.columns', code: 'view-kind' }));
    expect(
      updated({ viewId: 'list', patch: { name: 'Saved work' } }, [query]).selected.columns,
    ).toEqual(['notes']);
  });

  it.each(['form', 'interactive_form', 'habit_tracker', 'drive', 'outline'])(
    'refuses filters and sorts that the %s view does not apply',
    (kind) => {
      const target = view({ kind });
      const result = validateSpec(
        'update_view',
        { viewId: 'list', patch: { sortBy: 'status', sortDescending: true, filters: [] } },
        validation([target]),
      );
      for (const path of ['patch.sortBy', 'patch.sortDescending', 'patch.filters'])
        expect(result.problems).toContainEqual(
          expect.objectContaining({ path, code: 'view-kind' }),
        );
    },
  );
  it('refuses ineffective chart filter changes and warns when an existing ignored filter is retained', () => {
    const chart = view({ id: 'chart', kind: 'chart', groupBy: 'status' });
    const refused = validateSpec(
      'update_view',
      {
        viewId: 'chart',
        patch: { filters: [{ property: 'status', operator: 'equals', value: 'Done' }] },
      },
      validation([chart]),
    );
    expect(refused.problems).toContainEqual(
      expect.objectContaining({ path: 'patch.filters', code: 'unsupported-setting' }),
    );
    const retained = validateSpec(
      'update_view',
      { viewId: 'chart', patch: { name: 'Counts by status' } },
      validation([chart]),
    );
    expect(retained.ok).toBe(true);
    expect(retained.warnings).toContainEqual(
      expect.objectContaining({ code: 'filters-not-applied' }),
    );
    const noFilters = validateSpec(
      'update_view',
      { viewId: 'chart', patch: { name: 'Counts by status' } },
      validation([view({ id: 'chart', kind: 'chart', groupBy: 'status', filters: [] })]),
    );
    expect(noFilters.warnings).toEqual([]);
  });
  it.each([
    ['board', { coverProperty: 'picture' }],
    ['list', { dateProperty: 'due' }],
    ['list', { layout: 'grid' }],
    ['gallery', { groupBy: 'status' }],
  ])('refuses settings that %s cannot use', (kind, patch) => {
    const target = view({ kind });
    expect(
      validateSpec('update_view', { viewId: 'list', patch }, validation([target])).problems,
    ).toEqual(expect.arrayContaining([expect.objectContaining({ code: 'view-kind' })]));
  });

  it.each([
    ['calendar', { dateProperty: 'notes' }],
    ['timeline', { endDateProperty: 'notes' }],
    ['gallery', { coverProperty: 'notes' }],
    ['list', { groupBy: 'notes' }],
    ['checklist', { doneProperty: 'notes' }],
    ['chart', { measure: 'sum', measureProperty: 'notes' }],
    ['matrix', { rowBy: 'status' }],
  ])('refuses incompatible field types or dimensions on %s', (kind, patch) => {
    const target = view({
      kind,
      dateProperty: kind === 'calendar' || kind === 'timeline' ? 'due' : null,
      rowBy: kind === 'matrix' ? 'category' : null,
    });
    expect(validateSpec('update_view', { viewId: 'list', patch }, validation([target])).ok).toBe(
      false,
    );
  });

  it('requires exact field keys and an existing view instead of guessing labels or ids', () => {
    const target = view();
    expect(
      validateSpec(
        'update_view',
        { viewId: 'list', patch: { columns: ['Status'] } },
        validation([target]),
      ).problems,
    ).toEqual(expect.arrayContaining([expect.objectContaining({ code: 'unknown-field' })]));
    expect(
      validateSpec(
        'update_view',
        { viewId: 'missing', patch: { name: 'Review' } },
        validation([target]),
      ).problems[0]?.code,
    ).toBe('unknown-view');
  });

  it('counts conditions within groups, checks filter grammar and refuses invalid date windows', () => {
    const conditions = Array.from({ length: 8 }, () => ({
      property: 'status',
      operator: 'equals',
      value: 'New',
    }));
    expect(
      validateSpec(
        'update_view',
        { viewId: 'list', patch: { filters: [{ any: conditions }, conditions[0]] } },
        validation([view()]),
      ).ok,
    ).toBe(false);
    expect(
      validateSpec(
        'update_view',
        {
          viewId: 'list',
          patch: { filters: [{ property: 'due', operator: 'on', value: '2026-02-30' }] },
        },
        validation([view()]),
      ).ok,
    ).toBe(false);
    const target = view({
      id: 'chart',
      kind: 'chart',
      groupBy: 'due',
      chart: {
        kind: 'line',
        period: 'month',
        splitBy: null,
        lastPeriods: null,
        from: null,
        to: null,
        cumulative: null,
        rollingAverage: null,
        stacked: null,
      },
    });
    expect(
      validateSpec(
        'update_view',
        { viewId: 'chart', patch: { chart: { from: '2026-02-30' } } },
        validation([target]),
      ).ok,
    ).toBe(false);
    expect(
      validateSpec(
        'update_view',
        { viewId: 'chart', patch: { chart: { lastPeriods: 3, from: '2026-02-20' } } },
        validation([target]),
      ).ok,
    ).toBe(false);
  });

  it('checks retained companion linkage rather than silently losing a missing companion', () => {
    expect(() =>
      updated({ viewId: 'list', patch: { name: 'Review' } }, [
        view({ companionViewId: 'missing', companionPlacement: 'below' }),
      ]),
    ).toThrow(/companion/);
  });
});

describe('update-view approval preview', () => {
  it('shows full before and after names, field labels, filters and sorting', () => {
    const target = view();
    const { step } = updated(
      {
        viewId: 'list',
        patch: {
          name: 'By category',
          groupBy: 'category',
          sortBy: 'status',
          filters: [
            {
              any: [
                { property: 'status', operator: 'equals', value: 'Done' },
                { property: 'amount', operator: 'greater-than', value: '100' },
              ],
            },
          ],
        },
      },
      [target],
    );
    const preview = describeSteps([step], {
      destination: { title: 'Projects', path: ['Projects'] },
      existing: { declared: [], effective, views: [target] },
      problems: [],
      warnings: [],
      truncate: false,
    });
    expect(preview.counts).toEqual({ items: 0, fields: 0, views: 1, entries: 0, writes: 1 });
    expect(preview.headline).toBe('I will update the All work view on Projects.');
    expect(preview.tree[0]?.children).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          label: 'Name',
          detail: ['Before: All work', 'After: By category'],
        }),
        expect.objectContaining({
          label: 'Group by',
          detail: ['Before: Status (status)', 'After: Category (category)'],
        }),
        expect.objectContaining({
          label: 'Filters',
          detail: [
            'Before: Status (status) equals New',
            'After: Any of (Status (status) equals Done or Amount (amount) greater-than 100)',
          ],
        }),
        expect.objectContaining({ label: 'Sort order' }),
      ]),
    );
    expect(preview.problems).toEqual([]);
  });
});

describe('custom views', () => {
  const program = 'root = Stack([heading])\nheading = Text("Items", "title")';
  const custom = view({
    id: 'custom',
    name: 'Mine',
    kind: 'custom',
    groupBy: null,
    filters: [],
    program,
  });

  it('needs a program on a custom view and refuses one on any other kind', () => {
    expect(viewSpecSchema.safeParse({ kind: 'custom', program }).success).toBe(true);
    expect(viewSpecSchema.safeParse({ kind: 'custom' }).success).toBe(false);
    expect(viewSpecSchema.safeParse({ kind: 'custom', program: '  ' }).success).toBe(false);
    expect(viewSpecSchema.safeParse({ kind: 'list', program }).success).toBe(false);
  });

  it('compiles the program into the stored view and shows it on the approval card', () => {
    const compiled = compileView({ kind: 'custom', program }, effective, new Set());
    expect(compiled).toMatchObject({ id: 'custom', kind: 'custom', program });
    expect(compileView({ kind: 'list' }, effective, new Set())).not.toHaveProperty('program');
    const preview = describeSteps(
      [
        {
          kind: 'appendViewSetup',
          itemId: 'container',
          properties: [],
          views: [compiled],
          makeDefault: false,
        },
      ],
      {
        destination: { title: 'Projects', path: ['Projects'] },
        existing: { declared: [], effective, views: [] },
        problems: [],
        warnings: [],
        truncate: false,
      },
    );
    expect(JSON.stringify(preview.tree)).toContain(JSON.stringify(`Program:\n${program}`));
  });

  it('replaces the program of a custom view only', () => {
    const next = `${program}\nnote = Text("More", "note")`;
    const spec = { viewId: 'custom', patch: { program: next } };
    expect(validateSpec('update_view', spec, validation([custom])).ok).toBe(true);
    const { step, selected } = updated(spec, [custom]);
    expect(selected.program).toBe(next);
    const preview = describeSteps([step], {
      destination: { title: 'Projects', path: ['Projects'] },
      existing: { declared: [], effective, views: [custom] },
      problems: [],
      warnings: [],
      truncate: false,
    });
    expect(preview.tree[0]?.children).toEqual([
      expect.objectContaining({
        label: 'Program',
        detail: [`Before: ${program}`, `After: ${next}`],
      }),
    ]);
    expect(
      validateSpec('update_view', { viewId: 'list', patch: { program } }, validation([view()])).ok,
    ).toBe(false);
  });
});
