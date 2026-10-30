import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

import { describe, expect, it } from 'vitest';

import type { Problem, ValidationContext } from '../validate/report.js';
import type { Blueprint, Node } from './schema.js';
import { validateBlueprint } from './validate.js';

const packageDir = dirname(fileURLToPath(import.meta.url));

function fixture(name: string): unknown {
  const text = readFileSync(join(packageDir, '..', '..', 'fixtures', 'blueprints', name), 'utf8');
  return JSON.parse(text);
}

function context(overrides: Partial<ValidationContext> = {}): ValidationContext {
  return { inheritedFields: [], today: '2026-09-26', ...overrides };
}

function blueprint(root: Node, overrides: Partial<Omit<Blueprint, 'root'>> = {}): Blueprint {
  return {
    version: 1,
    title: 'Test blueprint',
    summary: 'A blueprint built for one test.',
    root,
    ...overrides,
  };
}

function findProblem(problems: readonly Problem[], code: string): Problem | undefined {
  return problems.find((problem) => problem.code === code);
}

describe('validateBlueprint', () => {
  it('unknown formula reference is explained with the NAME help', () => {
    const report = validateBlueprint(
      blueprint({
        id: 'root',
        title: 'Root',
        fields: [{ label: 'Total', type: 'formula', formula: '[missing] + 1' }],
      }),
      context(),
    );
    const problem = findProblem(report.problems, 'formula.unknown_field');
    expect(problem?.message).toContain('nothing here declares');
    expect(problem?.message).toContain("refers to 'missing'");
  });

  it.each(['NOPE(1)', 'NOT(TRUE, FALSE)', 'SUM(A1:A3)'])(
    'refuses known-invalid formula %s before construction',
    (formula) => {
      const report = validateBlueprint(
        blueprint({
          id: 'root',
          title: 'Root',
          fields: [{ label: 'Total', type: 'formula', formula }],
        }),
        context(),
      );
      expect(findProblem(report.problems, 'formula.invalid_expression')).toBeDefined();
    },
  );

  it('cross-node cycle through inherited fields is refused', () => {
    const report = validateBlueprint(
      blueprint({
        id: 'root',
        title: 'Root',
        fields: [
          { label: 'A', key: 'a', type: 'formula', formula: '[b] + 1' },
          { label: 'B', key: 'b', type: 'formula', formula: '[a] + 1' },
        ],
        children: [{ id: 'child', title: 'Child', inherit: true }],
      }),
      context(),
    );
    expect(findProblem(report.problems, 'formula.cycle')).toBeDefined();
  });

  const warningCases: { code: string; title: string; trigger: Node; clear: Node }[] = [
    {
      code: 'warn.sibling_containers_same_fields',
      title: 'sibling containers with equal fields',
      trigger: {
        id: 'root',
        title: 'Root',
        children: [
          {
            id: 'one',
            title: 'One',
            fields: [{ label: 'Name', type: 'text' }],
            views: [{ kind: 'list' }],
          },
          {
            id: 'two',
            title: 'Two',
            fields: [{ label: 'Name', type: 'text' }],
            views: [{ kind: 'board', groupBy: 'name' }],
          },
        ],
      },
      clear: {
        id: 'root',
        title: 'Root',
        children: [
          {
            id: 'one',
            title: 'One',
            fields: [{ label: 'Name', type: 'text' }],
            views: [{ kind: 'list' }],
          },
          {
            id: 'two',
            title: 'Two',
            fields: [{ label: 'Status', type: 'select', options: ['New'] }],
            views: [{ kind: 'board', groupBy: 'status' }],
          },
        ],
      },
    },
    {
      code: 'warn.fields_repeated_on_children',
      title: 'fields declared on each child',
      trigger: {
        id: 'root',
        title: 'Root',
        children: [
          { id: 'one', title: 'One', fields: [{ label: 'Status', type: 'text' }] },
          { id: 'two', title: 'Two', fields: [{ label: 'Status', type: 'text' }] },
        ],
      },
      clear: {
        id: 'root',
        title: 'Root',
        children: [
          { id: 'one', title: 'One', fields: [{ label: 'Status', type: 'text' }] },
          { id: 'two', title: 'Two', fields: [{ label: 'Notes', type: 'text' }] },
        ],
      },
    },
    {
      code: 'warn.number_could_be_rollup',
      title: 'number field that could be a rollup',
      trigger: {
        id: 'root',
        title: 'Root',
        fields: [{ label: 'Hours', key: 'hours', type: 'number' }],
        children: [
          {
            id: 'child',
            title: 'Child',
            fields: [{ label: 'Hours', key: 'hours', type: 'number' }],
          },
        ],
      },
      clear: {
        id: 'root',
        title: 'Root',
        fields: [{ label: 'Hours', type: 'number' }],
        children: [
          {
            id: 'child',
            title: 'Child',
            inherit: false,
            fields: [{ label: 'Notes', type: 'number' }],
          },
        ],
      },
    },
    {
      code: 'warn.repeating_title_without_recurrence',
      title: 'repeating title without recurrence',
      trigger: { id: 'root', title: 'Weekly review' },
      clear: {
        id: 'root',
        title: 'Weekly review',
        recurrence: { frequency: 'weekly', interval: 1 },
      },
    },
    {
      code: 'warn.list_only_many_fields',
      title: 'list only with more than five fields',
      trigger: {
        id: 'root',
        title: 'Root',
        fields: ['A', 'B', 'C', 'D', 'E', 'F'].map((label) => ({ label, type: 'text' })),
        views: [{ kind: 'list' }],
      },
      clear: {
        id: 'root',
        title: 'Root',
        fields: ['A', 'B', 'C', 'D', 'E'].map((label) => ({ label, type: 'text' })),
        views: [{ kind: 'list' }],
      },
    },
    {
      code: 'warn.query_duplicates_smart_list',
      title: 'query duplicating a smart list preset',
      trigger: {
        id: 'root',
        title: 'Root',
        views: [{ kind: 'query', filters: [{ field: 'due_date', op: 'on', value: 'today' }] }],
      },
      clear: {
        id: 'root',
        title: 'Root',
        views: [{ kind: 'query', filters: [{ field: 'due_date', op: 'before', value: 'today' }] }],
      },
    },
  ];

  for (const warningCase of warningCases) {
    it(`${warningCase.title}: emits its warning for a triggering blueprint`, () => {
      const report = validateBlueprint(blueprint(warningCase.trigger), context());
      expect(findProblem(report.warnings, warningCase.code)).toBeDefined();
    });
    it(`${warningCase.title}: stays quiet for a non-triggering blueprint`, () => {
      const report = validateBlueprint(blueprint(warningCase.clear), context());
      expect(findProblem(report.warnings, warningCase.code)).toBeUndefined();
    });
  }

  it('keeps an empty child title instead of refusing or inventing one', () => {
    const report = validateBlueprint(
      blueprint({ id: 'root', title: 'Log', children: [{ id: 'entry', title: '' }] }),
      context(),
    );
    expect(report.problems).toEqual([]);
  });

  it('accepts the reading-log sample blueprint clean', () => {
    const report = validateBlueprint(fixture('reading-log.json'), context());
    expect(report.problems).toEqual([]);
    expect(report.ok).toBe(true);
    expect(report.stats).toEqual({ fields: 3, views: 4, entries: 2 });
  });

  it('check 1: refuses a blueprint with an unrecognised top-level key (strict, shape and limits)', () => {
    const report = validateBlueprint(
      { ...blueprint({ id: 'root', title: 'Root' }), extra: true },
      context(),
    );
    expect(report.ok).toBe(false);
    expect(report.problems.length).toBeGreaterThan(0);
  });

  it('check 2: refuses two fields on the same node sharing a key', () => {
    const bp = blueprint({
      id: 'root',
      title: 'Root',
      fields: [
        { label: 'A', type: 'text', key: 'x' },
        { label: 'B', type: 'text', key: 'x' },
      ],
    });
    const report = validateBlueprint(bp, context());
    expect(report.ok).toBe(false);
    expect(findProblem(report.problems, 'schema')).toBeDefined();
    expect(findProblem(report.problems, 'schema')?.path).toBe('root.fields');
  });

  it('check 3: a select field without options is refused at the shape level', () => {
    const bp = blueprint({
      id: 'root',
      title: 'Root',
      fields: [{ label: 'Category', type: 'select' }],
    });
    const report = validateBlueprint(bp, context());
    expect(report.ok).toBe(false);
  });

  it('check 4: inherit false cuts the chain, so a child cannot resolve a parent field', () => {
    const bp = blueprint({
      id: 'root',
      title: 'Root',
      fields: [{ label: 'Priority', type: 'text' }],
      children: [
        {
          id: 'child',
          title: 'Child',
          inherit: false,
          views: [{ kind: 'board', groupBy: 'priority' }],
        },
      ],
    });
    const report = validateBlueprint(bp, context());
    expect(report.ok).toBe(false);
    expect(findProblem(report.problems, 'unknown')?.path).toBe('root.children[0].views[0].groupBy');
  });

  it('refuses an ambiguous label when a view references two own fields with that label', () => {
    const bp = blueprint({
      id: 'root',
      title: 'Root',
      fields: [
        { label: 'Hours', key: 'hours_actual', type: 'number' },
        { label: 'Hours', key: 'hours_budget', type: 'number' },
      ],
      views: [{ kind: 'list', columns: ['Hours'] }],
    });

    const report = validateBlueprint(bp, context());
    expect(report.ok).toBe(false);
    expect(findProblem(report.problems, 'ambiguous')?.path).toBe('root.views[0].columns[0]');
  });

  it('check 5: a board view with no groupBy is refused', () => {
    const bp = blueprint({ id: 'root', title: 'Root', views: [{ kind: 'board' }] });
    const report = validateBlueprint(bp, context());
    expect(report.ok).toBe(false);
    expect(findProblem(report.problems, 'views')?.path).toBe('root.views[0]');
  });

  it('check 6: a within-next filter with a non-numeric value is refused', () => {
    const bp = blueprint({
      id: 'root',
      title: 'Root',
      views: [
        {
          kind: 'query',
          filters: [{ field: 'anything', op: 'within-next', value: 'soon' }],
        },
      ],
    });
    const report = validateBlueprint(bp, context());
    expect(report.ok).toBe(false);
    expect(findProblem(report.problems, 'views')).toBeDefined();
  });

  it('check 7: a form field block naming a computed property is refused', () => {
    const bp = blueprint({
      id: 'root',
      title: 'Root',
      fields: [{ label: 'Total', type: 'rollup', rollup: { aggregate: 'count' } }],
      views: [
        {
          kind: 'interactive_form',
          form: { pages: [{ title: 'Page 1', blocks: [{ field: 'total' }] }] },
        },
      ],
    });
    const report = validateBlueprint(bp, context());
    expect(report.ok).toBe(false);
    expect(findProblem(report.problems, 'views')).toBeDefined();
  });

  it('check 9: a rollup over an inherited numeric source passes and over a text source fails', () => {
    const passing = blueprint({
      id: 'root',
      title: 'Root',
      fields: [{ label: 'Hours', type: 'number' }],
      children: [
        {
          id: 'sessions',
          title: 'Sessions',
          views: [{ kind: 'list' }],
          fields: [
            { label: 'Total hours', type: 'rollup', rollup: { aggregate: 'sum', source: 'hours' } },
          ],
          children: [{ id: 'session-1', title: 'Session 1', values: { hours: 2 } }],
        },
      ],
    });
    expect(validateBlueprint(passing, context()).ok).toBe(true);

    const failing = blueprint({
      id: 'root',
      title: 'Root',
      fields: [{ label: 'Hours', type: 'text' }],
      children: [
        {
          id: 'sessions',
          title: 'Sessions',
          views: [{ kind: 'list' }],
          fields: [
            { label: 'Total hours', type: 'rollup', rollup: { aggregate: 'sum', source: 'hours' } },
          ],
          children: [{ id: 'session-1', title: 'Session 1', values: { hours: 'two' } }],
        },
      ],
    });
    const report = validateBlueprint(failing, context());
    expect(report.ok).toBe(false);
    expect(findProblem(report.problems, 'rollup-fit')?.path).toBe(
      'root.children[0].fields[0].rollup.source',
    );
  });

  it('check 9: a rollup source must fit every child effective schema', () => {
    const bp = blueprint({
      id: 'root',
      title: 'Root',
      fields: [
        { label: 'Total hours', type: 'rollup', rollup: { aggregate: 'sum', source: 'hours' } },
      ],
      children: [
        { id: 'numeric', title: 'Numeric', fields: [{ label: 'Hours', type: 'number' }] },
        { id: 'text', title: 'Text', fields: [{ label: 'Hours', type: 'text' }] },
        { id: 'sparse', title: 'Sparse' },
      ],
    });

    const report = validateBlueprint(bp, context());
    expect(report.ok).toBe(false);
    expect(findProblem(report.problems, 'rollup-fit')?.path).toBe('root.fields[0].rollup.source');
  });

  it('check 9: a rollup source with no property to fold is refused, unless the aggregate is count', () => {
    const bp = blueprint({
      id: 'root',
      title: 'Root',
      fields: [{ label: 'Total', type: 'rollup', rollup: { aggregate: 'sum' } }],
      children: [{ id: 'child', title: 'Child' }],
    });
    const report = validateBlueprint(bp, context());
    expect(report.ok).toBe(false);
    expect(findProblem(report.problems, 'rollup-source-required')).toBeDefined();
  });

  it('check 9: count may omit a source but an explicit source must exist', () => {
    const withoutSource = blueprint({
      id: 'root',
      title: 'Root',
      fields: [{ label: 'Total', type: 'rollup', rollup: { aggregate: 'count' } }],
      children: [{ id: 'child', title: 'Child' }],
    });
    expect(validateBlueprint(withoutSource, context()).ok).toBe(true);

    const textSource = blueprint({
      id: 'root',
      title: 'Root',
      fields: [{ label: 'Total', type: 'rollup', rollup: { aggregate: 'count', source: 'name' } }],
      children: [
        {
          id: 'child',
          title: 'Child',
          fields: [{ label: 'Name', type: 'text' }],
        },
      ],
    });
    expect(validateBlueprint(textSource, context()).ok).toBe(true);

    const unknownSource = blueprint({
      id: 'root',
      title: 'Root',
      fields: [
        { label: 'Total', type: 'rollup', rollup: { aggregate: 'count', source: 'missing' } },
      ],
      children: [{ id: 'child', title: 'Child' }],
    });
    const report = validateBlueprint(unknownSource, context());
    expect(report.ok).toBe(false);
    expect(findProblem(report.problems, 'unknown')?.path).toBe('root.fields[0].rollup.source');
  });

  it('check 10: a computed field cannot have a value set on it', () => {
    const bp = blueprint({
      id: 'root',
      title: 'Root',
      fields: [{ label: 'Total', type: 'rollup', rollup: { aggregate: 'count' } }],
      values: { total: 5 },
    });
    const report = validateBlueprint(bp, context());
    expect(report.ok).toBe(false);
    expect(findProblem(report.problems, 'value')?.path).toBe('root.values.total');
  });

  it('check 11: recurrence without an effective due date is refused', () => {
    const bp = blueprint({
      id: 'root',
      title: 'Root',
      recurrence: { frequency: 'daily', interval: 1 },
    });
    const report = validateBlueprint(bp, context());
    expect(report.ok).toBe(false);
    expect(findProblem(report.problems, 'recurrence-needs-due-date')).toBeDefined();
  });

  it('check 11: recurrence with a due date field but no due date value is refused', () => {
    const bp = blueprint({
      id: 'root',
      title: 'Root',
      fields: [{ label: 'Due', type: 'due_date' }],
      recurrence: { frequency: 'daily', interval: 1 },
    });
    const report = validateBlueprint(bp, context());
    expect(report.ok).toBe(false);
    expect(findProblem(report.problems, 'recurrence-needs-due-date-value')).toBeDefined();
  });

  it('check 11: recurrence with a due date value in effect passes', () => {
    const bp = blueprint({
      id: 'root',
      title: 'Root',
      fields: [{ label: 'Due', type: 'due_date' }],
      values: { due_date: '2026-10-01' },
      recurrence: { frequency: 'daily', interval: 1 },
    });
    expect(validateBlueprint(bp, context()).ok).toBe(true);
  });

  it('check 11: a habit node outside a habit tracker fails', () => {
    const bp = blueprint({
      id: 'root',
      title: 'Root',
      views: [{ kind: 'list' }],
      children: [
        {
          id: 'streak',
          title: 'Streak',
          habit: { frequency: 'daily', target: 1, unit: 'session' },
        },
      ],
    });
    const report = validateBlueprint(bp, context());
    expect(report.ok).toBe(false);
    expect(findProblem(report.problems, 'habit-needs-tracker-parent')?.path).toBe(
      'root.children[0].habit',
    );
  });

  it('check 11: a habit node under a habit tracker view passes', () => {
    const bp = blueprint({
      id: 'root',
      title: 'Root',
      views: [{ kind: 'habit_tracker' }],
      children: [
        {
          id: 'streak',
          title: 'Streak',
          habit: { frequency: 'daily', target: 1, unit: 'session' },
        },
      ],
    });
    expect(validateBlueprint(bp, context()).ok).toBe(true);
  });

  it('check 12: a rule naming an unknown node is refused', () => {
    const bp = blueprint(
      { id: 'root', title: 'Root', fields: [{ label: 'Status', type: 'text' }] },
      { rules: [{ node: 'nowhere', field: 'status', kind: 'keep' }] },
    );
    const report = validateBlueprint(bp, context());
    expect(report.ok).toBe(false);
    expect(findProblem(report.problems, 'unknown-node')?.path).toBe('rules[0].node');
  });

  it('check 12: two rules on the same node and field fail', () => {
    const bp = blueprint(
      { id: 'root', title: 'Root', fields: [{ label: 'Status', type: 'text' }] },
      {
        rules: [
          { node: 'root', field: 'status', kind: 'keep' },
          { node: 'root', field: 'status', kind: 'clear' },
        ],
      },
    );
    const report = validateBlueprint(bp, context());
    expect(report.ok).toBe(false);
    expect(findProblem(report.problems, 'duplicate-rule')?.path).toBe('rules[1]');
  });

  it('check 12: a relativeDate rule needs a date input', () => {
    const bp = blueprint(
      { id: 'root', title: 'Root', fields: [{ label: 'Due', type: 'due_date' }] },
      {
        inputs: [{ key: 'reader_name', label: 'Reader name', type: 'text' }],
        rules: [
          {
            node: 'root',
            field: 'due_date',
            kind: 'relativeDate',
            input: 'reader_name',
            offsetDays: 7,
          },
        ],
      },
    );
    const report = validateBlueprint(bp, context());
    expect(report.ok).toBe(false);
    expect(findProblem(report.problems, 'relative-date-needs-date-input')).toBeDefined();
  });

  it('check 12: an input rule needs an input of the matching type', () => {
    const bp = blueprint(
      { id: 'root', title: 'Root', fields: [{ label: 'Due', type: 'due_date' }] },
      {
        inputs: [{ key: 'reader_name', label: 'Reader name', type: 'text' }],
        rules: [{ node: 'root', field: 'due_date', kind: 'input', input: 'reader_name' }],
      },
    );
    const report = validateBlueprint(bp, context());
    expect(report.ok).toBe(false);
    expect(findProblem(report.problems, 'input-type-mismatch')).toBeDefined();
  });

  it('check 13: a sample node with children fails', () => {
    const bp = blueprint({
      id: 'root',
      title: 'Root',
      children: [
        {
          id: 'sample',
          title: 'Sample: A book',
          sample: true,
          children: [{ id: 'nested', title: 'Nested' }],
        },
      ],
    });
    const report = validateBlueprint(bp, context());
    expect(report.ok).toBe(false);
    expect(findProblem(report.problems, 'sample-not-leaf')?.path).toBe('root.children[0].children');
  });

  it('check 13: a non-sample title cannot start with "Sample: "', () => {
    const bp = blueprint({ id: 'root', title: 'Sample: Root' });
    const report = validateBlueprint(bp, context());
    expect(report.ok).toBe(false);
    expect(findProblem(report.problems, 'sample-title-reserved')).toBeDefined();
  });

  it('limits: refuses a blueprint with more than 40 nodes', () => {
    const children: Node[] = [];
    for (let i = 0; i < 41; i += 1) {
      children.push({ id: `child-${String(i)}`, title: `Child ${String(i)}` });
    }
    const bp = blueprint({ id: 'root', title: 'Root', children });
    const report = validateBlueprint(bp, context());
    expect(report.ok).toBe(false);
    expect(findProblem(report.problems, 'too-many-nodes')).toBeDefined();
  });

  it('limits: refuses a blueprint nested more than 4 levels deep', () => {
    let node: Node = { id: 'leaf', title: 'Leaf' };
    for (let i = 0; i < 4; i += 1) {
      node = { id: `level-${String(i)}`, title: `Level ${String(i)}`, children: [node] };
    }
    const bp = blueprint(node);
    const report = validateBlueprint(bp, context());
    expect(report.ok).toBe(false);
    expect(findProblem(report.problems, 'too-deep')).toBeDefined();
  });

  it('write budget counts markdown, recurrence and habit steps, not just nodes', () => {
    const children: Node[] = [];
    for (let i = 0; i < 20; i += 1) {
      children.push({
        id: `task-${String(i)}`,
        title: `Task ${String(i)}`,
        sample: true,
        markdown: 'Notes for this task.',
        values: { due_date: '2026-10-01' },
        recurrence: { frequency: 'daily', interval: 1 },
        habit: { frequency: 'daily', target: 1, unit: 'session' },
      });
    }
    const bp = blueprint({
      id: 'root',
      title: 'Root',
      fields: [{ label: 'Due', type: 'due_date' }],
      views: [{ kind: 'habit_tracker' }],
      children,
    });
    // 21 nodes + 20 markdown + 20 recurrence + 20 habit + 1 sandbox = 82, over the 80 budget - and
    // 21 nodes alone (well under the 40-node cap) would not have tripped it on their own, which is
    // what this test is proving: the extra per-detail writes are what pushes it over.
    const report = validateBlueprint(bp, context());
    expect(report.ok).toBe(false);
    expect(findProblem(report.problems, 'too-many-writes')).toBeDefined();
    expect(findProblem(report.problems, 'too-many-nodes')).toBeUndefined();
  });

  it('counts schema writes for field-bearing plain nodes before the 80-write limit', () => {
    const children: Node[] = Array.from({ length: 39 }, (_, index) => ({
      id: `node-${String(index)}`,
      title: `Node ${String(index)}`,
      ...(index >= 9 ? { sample: true } : {}),
      fields: [{ label: `Field ${String(index)}`, type: 'text' }],
    }));
    const report = validateBlueprint(
      blueprint({
        id: 'root',
        title: 'Root',
        fields: [{ label: 'Root field', type: 'text' }],
        children,
      }),
      context(),
    );
    expect(findProblem(report.problems, 'too-many-writes')).toBeDefined();
    expect(findProblem(report.problems, 'too-many-nodes')).toBeUndefined();
    expect(findProblem(report.problems, 'too-many-fields')).toBeUndefined();
  });

  it('paths are precise: a problem three levels deep names its exact position', () => {
    const bp = blueprint({
      id: 'root',
      title: 'Root',
      children: [
        {
          id: 'mid',
          title: 'Mid',
          children: [
            {
              id: 'deep',
              title: 'Deep',
              views: [{ kind: 'calendar' }],
            },
          ],
        },
      ],
    });
    const report = validateBlueprint(bp, context());
    expect(report.ok).toBe(false);
    expect(findProblem(report.problems, 'views')?.path).toBe(
      'root.children[0].children[0].views[0]',
    );
  });

  it('a duplicate node id anywhere in the tree is refused', () => {
    const bp = blueprint({
      id: 'root',
      title: 'Root',
      children: [
        { id: 'dup', title: 'One' },
        { id: 'dup', title: 'Two' },
      ],
    });
    const report = validateBlueprint(bp, context());
    expect(report.ok).toBe(false);
    expect(findProblem(report.problems, 'duplicate-node-id')?.path).toBe('root.children[1].id');
  });
});
