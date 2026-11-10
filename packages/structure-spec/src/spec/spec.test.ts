import { describe, expect, it } from 'vitest';

import { PROPERTY_TYPES, ROLLUP_AGGREGATES } from '../vocabulary/property-types.js';
import { STRUCTURED_RECIPES } from '../vocabulary/recipes.js';
import { FIELD_SPEC_TYPES, ROLLUP_SPEC_AGGREGATES, fieldSpecSchema } from './field.js';
import { condSchema, formSpecSchema } from './form.js';
import { keyFor } from './keys.js';
import {
  STRUCTURED_SPEC_RECIPE_IDS,
  entriesSpecSchema,
  structuredSpecSchema,
  viewSetupSpecSchema,
} from './operations.js';
import { resolveFieldRef } from './refs.js';
import { viewSpecSchema } from './view.js';

describe('vocabulary parity', () => {
  it('allows saved and temporary modes only on forms, keeping date mode grammars intact', () => {
    for (const kind of ['form', 'interactive_form']) {
      expect(viewSpecSchema.safeParse({ kind, mode: 'temporary' }).success).toBe(true);
      expect(viewSpecSchema.safeParse({ kind, mode: 'saved' }).success).toBe(true);
      expect(viewSpecSchema.safeParse({ kind, mode: 'month' }).success).toBe(false);
    }
    expect(viewSpecSchema.safeParse({ kind: 'calendar', mode: 'temporary' }).success).toBe(false);
    expect(viewSpecSchema.safeParse({ kind: 'timeline', mode: 'saved' }).success).toBe(false);
    expect(viewSpecSchema.safeParse({ kind: 'board', mode: 'temporary' }).success).toBe(false);
  });
  it('field types are every property type except assignee', () => {
    const vocabulary = PROPERTY_TYPES.map((entry) => entry.value).filter(
      (value) => value !== 'assignee',
    );
    expect([...FIELD_SPEC_TYPES].sort()).toEqual([...vocabulary].sort());
  });

  it('rollup aggregates match the vocabulary exactly', () => {
    const vocabulary = ROLLUP_AGGREGATES.map((entry) => entry.value);
    expect([...ROLLUP_SPEC_AGGREGATES].sort()).toEqual([...vocabulary].sort());
  });

  it('structured recipe ids are every recipe except drive', () => {
    const vocabulary = STRUCTURED_RECIPES.map((recipe) => recipe.id).filter((id) => id !== 'drive');
    expect([...STRUCTURED_SPEC_RECIPE_IDS].sort()).toEqual([...vocabulary].sort());
  });
});

describe('fieldSpecSchema', () => {
  it('refuses assignee fields', () => {
    const result = fieldSpecSchema.safeParse({ label: 'Owner', type: 'assignee' });
    expect(result.success).toBe(false);
  });

  it('select needs options, text refuses options', () => {
    const selectWithoutOptions = fieldSpecSchema.safeParse({ label: 'Status', type: 'select' });
    expect(selectWithoutOptions.success).toBe(false);
    if (!selectWithoutOptions.success) {
      expect(selectWithoutOptions.error.issues[0]?.path).toEqual(['options']);
    }

    const selectWithOptions = fieldSpecSchema.safeParse({
      label: 'Status',
      type: 'select',
      options: ['To do', 'Done'],
    });
    expect(selectWithOptions.success).toBe(true);

    const textWithOptions = fieldSpecSchema.safeParse({
      label: 'Notes',
      type: 'text',
      options: ['a'],
    });
    expect(textWithOptions.success).toBe(false);
    if (!textWithOptions.success) {
      expect(textWithOptions.error.issues[0]?.path).toEqual(['options']);
    }
  });

  it('computed fields cannot be required', () => {
    const requiredFormula = fieldSpecSchema.safeParse({
      label: 'Total',
      type: 'formula',
      formula: '[price] * [quantity]',
      required: true,
    });
    expect(requiredFormula.success).toBe(false);
    if (!requiredFormula.success) {
      expect(requiredFormula.error.issues[0]?.path).toEqual(['required']);
    }

    const optionalFormula = fieldSpecSchema.safeParse({
      label: 'Total',
      type: 'formula',
      formula: '[price] * [quantity]',
    });
    expect(optionalFormula.success).toBe(true);

    const requiredRollup = fieldSpecSchema.safeParse({
      label: 'Count',
      type: 'rollup',
      rollup: { aggregate: 'count' },
      required: true,
    });
    expect(requiredRollup.success).toBe(false);
  });

  it('formula is required for a formula field and refused elsewhere', () => {
    const missingFormula = fieldSpecSchema.safeParse({ label: 'Total', type: 'formula' });
    expect(missingFormula.success).toBe(false);
    if (!missingFormula.success) {
      expect(missingFormula.error.issues[0]?.path).toEqual(['formula']);
    }

    const strayFormula = fieldSpecSchema.safeParse({
      label: 'Notes',
      type: 'text',
      formula: '[a] + [b]',
    });
    expect(strayFormula.success).toBe(false);
    if (!strayFormula.success) {
      expect(strayFormula.error.issues[0]?.path).toEqual(['formula']);
    }
  });

  it('rollup is required for a rollup field and refused elsewhere', () => {
    const missingRollup = fieldSpecSchema.safeParse({ label: 'Count', type: 'rollup' });
    expect(missingRollup.success).toBe(false);
    if (!missingRollup.success) {
      expect(missingRollup.error.issues[0]?.path).toEqual(['rollup']);
    }

    const strayRollup = fieldSpecSchema.safeParse({
      label: 'Notes',
      type: 'text',
      rollup: { aggregate: 'count' },
    });
    expect(strayRollup.success).toBe(false);
    if (!strayRollup.success) {
      expect(strayRollup.error.issues[0]?.path).toEqual(['rollup']);
    }
  });

  it('a task-semantic type refuses a key that does not name it', () => {
    const mismatched = fieldSpecSchema.safeParse({
      label: 'Kicks off',
      key: 'kicks_off',
      type: 'start_date',
    });
    expect(mismatched.success).toBe(false);
    if (!mismatched.success) {
      expect(mismatched.error.issues[0]?.path).toEqual(['key']);
    }

    const matching = fieldSpecSchema.safeParse({
      label: 'Kicks off',
      key: 'start_date',
      type: 'start_date',
    });
    expect(matching.success).toBe(true);

    const omitted = fieldSpecSchema.safeParse({ label: 'Kicks off', type: 'start_date' });
    expect(omitted.success).toBe(true);
  });

  it('a plain field refuses a key reserved for a task-semantic type', () => {
    const collision = fieldSpecSchema.safeParse({
      label: 'Deadline',
      key: 'due_date',
      type: 'text',
    });
    expect(collision.success).toBe(false);
    if (!collision.success) {
      expect(collision.error.issues[0]?.path).toEqual(['key']);
    }
  });

  it('strict objects reject unknown keys', () => {
    const result = fieldSpecSchema.safeParse({
      label: 'Status',
      type: 'text',
      unexpected: 'value',
    });
    expect(result.success).toBe(false);
  });
});

describe('viewSpecSchema', () => {
  it('accepts Gallery card fields and refuses ignored Smart list columns', () => {
    expect(
      viewSpecSchema.safeParse({ kind: 'gallery', columns: ['title', 'status'] }).success,
    ).toBe(true);
    const query = viewSpecSchema.safeParse({ kind: 'query', columns: ['status'] });
    expect(query.success).toBe(false);
    if (!query.success) expect(query.error.issues[0]?.path).toEqual(['columns']);
  });

  it('board views only accept groupBy and groupOrder', () => {
    const boardWithAllowedFields = viewSpecSchema.safeParse({
      kind: 'board',
      groupBy: 'status',
      groupOrder: ['To do', 'Done'],
    });
    expect(boardWithAllowedFields.success).toBe(true);

    const boardWithDate = viewSpecSchema.safeParse({
      kind: 'board',
      groupBy: 'status',
      date: 'due_date',
    });
    expect(boardWithDate.success).toBe(false);
    if (!boardWithDate.success) {
      expect(boardWithDate.error.issues[0]?.path).toEqual(['date']);
    }
  });

  it('calendar mode quarter is refused', () => {
    const calendarQuarter = viewSpecSchema.safeParse({
      kind: 'calendar',
      date: 'due_date',
      mode: 'quarter',
    });
    expect(calendarQuarter.success).toBe(false);
    if (!calendarQuarter.success) {
      expect(calendarQuarter.error.issues[0]?.path).toEqual(['mode']);
    }

    const calendarWeek = viewSpecSchema.safeParse({
      kind: 'calendar',
      date: 'due_date',
      mode: 'week',
    });
    expect(calendarWeek.success).toBe(true);
  });

  it('timeline accepts quarter but refuses day', () => {
    const timelineQuarter = viewSpecSchema.safeParse({
      kind: 'timeline',
      date: 'starts',
      mode: 'quarter',
    });
    expect(timelineQuarter.success).toBe(true);

    const timelineDay = viewSpecSchema.safeParse({
      kind: 'timeline',
      date: 'starts',
      mode: 'day',
    });
    expect(timelineDay.success).toBe(false);
  });

  it('strict objects reject unknown keys', () => {
    const result = viewSpecSchema.safeParse({ kind: 'list', unexpected: 'value' });
    expect(result.success).toBe(false);
  });
});

describe('condSchema', () => {
  it('accepts an equality condition with a value and a checked condition without one', () => {
    const equals = condSchema.safeParse({ field: 'status', op: 'equals', value: 'Done' });
    expect(equals.success).toBe(true);

    const checked = condSchema.safeParse({ field: 'done', op: 'checked' });
    expect(checked.success).toBe(true);
  });
});

describe('formSpecSchema', () => {
  it('compiles a field block, a heading and a paragraph on one page', () => {
    const result = formSpecSchema.safeParse({
      pages: [
        {
          title: 'Your response',
          blocks: [
            { heading: 'Welcome' },
            { paragraph: 'Tell us about yourself.' },
            { field: 'response', required: true },
          ],
        },
      ],
      title: { from: 'field', field: 'response' },
      confirmation: { title: 'Thanks', message: 'Your response has been recorded.' },
    });
    expect(result.success).toBe(true);
  });

  it('refuses a block that matches no known shape', () => {
    const result = formSpecSchema.safeParse({
      pages: [{ title: 'Page', blocks: [{ field: 'response', heading: 'Also a heading' }] }],
    });
    expect(result.success).toBe(false);
  });

  it('caps pages at 10 and blocks at 30', () => {
    const tooManyPages = formSpecSchema.safeParse({
      pages: Array.from({ length: 11 }, (_, index) => ({
        title: `Page ${String(index)}`,
        blocks: [{ heading: 'Section' }],
      })),
    });
    expect(tooManyPages.success).toBe(false);

    const tooManyBlocks = formSpecSchema.safeParse({
      pages: [
        {
          title: 'Page',
          blocks: Array.from({ length: 31 }, () => ({ heading: 'Section' })),
        },
      ],
    });
    expect(tooManyBlocks.success).toBe(false);
  });
});

describe('viewSetupSpecSchema', () => {
  it('needs at least one view and refuses more than four', () => {
    const noViews = viewSetupSpecSchema.safeParse({ views: [] });
    expect(noViews.success).toBe(false);

    const oneView = viewSetupSpecSchema.safeParse({ views: [{ kind: 'list' }] });
    expect(oneView.success).toBe(true);

    const fiveViews = viewSetupSpecSchema.safeParse({
      views: Array.from({ length: 5 }, () => ({ kind: 'list' })),
    });
    expect(fiveViews.success).toBe(false);
  });
});

describe('entriesSpecSchema', () => {
  it('entries are capped at 25', () => {
    const entries = Array.from({ length: 25 }, (_, index) => ({ title: `Entry ${String(index)}` }));
    const atCap = entriesSpecSchema.safeParse({ entries });
    expect(atCap.success).toBe(true);

    const overCap = entriesSpecSchema.safeParse({
      entries: [...entries, { title: 'Entry 25' }],
    });
    expect(overCap.success).toBe(false);

    const empty = entriesSpecSchema.safeParse({ entries: [] });
    expect(empty.success).toBe(false);
  });
});

describe('structuredSpecSchema', () => {
  it('recipe drive is refused', () => {
    const drive = structuredSpecSchema.safeParse({ recipe: 'drive', fields: [] });
    expect(drive.success).toBe(false);

    const board = structuredSpecSchema.safeParse({ recipe: 'board', fields: [] });
    expect(board.success).toBe(true);
  });
});

describe('keyFor', () => {
  it('task-semantic types are keyed by their type', () => {
    const dueDate = fieldSpecSchema.parse({ label: 'Ship by', type: 'due_date' });
    expect(keyFor(dueDate)).toBe('due_date');

    const startDate = fieldSpecSchema.parse({ label: 'Kicks off', type: 'start_date' });
    expect(keyFor(startDate)).toBe('start_date');

    const completion = fieldSpecSchema.parse({ label: 'Finished', type: 'completion' });
    expect(keyFor(completion)).toBe('completion');

    const priority = fieldSpecSchema.parse({ label: 'How urgent', type: 'priority' });
    expect(keyFor(priority)).toBe('priority');

    const estimate = fieldSpecSchema.parse({ label: 'Effort', type: 'estimate' });
    expect(keyFor(estimate)).toBe('estimate');

    const explicitKey = fieldSpecSchema.parse({ label: 'Owner', key: 'owner_name', type: 'text' });
    expect(keyFor(explicitKey)).toBe('owner_name');

    const slugged = fieldSpecSchema.parse({ label: 'Rating (1-5)', type: 'number' });
    expect(keyFor(slugged)).toBe('rating_1_5');
  });
});

describe('resolveFieldRef', () => {
  it('labels resolve only for new fields', () => {
    const existing = [
      { key: 'status', label: 'Status', type: 'select', options: [], required: false },
    ];
    const added = [{ key: 'priority', label: 'Priority' }];

    const byExistingKey = resolveFieldRef('status', { existing, added });
    expect(byExistingKey).toEqual({ ok: true, key: 'status' });

    const byExistingLabel = resolveFieldRef('Status', { existing, added });
    expect(byExistingLabel).toEqual({ ok: false, code: 'unknown', candidates: [] });

    const byAddedLabel = resolveFieldRef('priority', { existing, added });
    expect(byAddedLabel).toEqual({ ok: true, key: 'priority' });

    const byAddedLabelCaseInsensitive = resolveFieldRef('PRIORITY', { existing, added });
    expect(byAddedLabelCaseInsensitive).toEqual({ ok: true, key: 'priority' });
  });

  it('ambiguous label names both candidates', () => {
    const existing: never[] = [];
    const added = [
      { key: 'rating', label: 'Priority' },
      { key: 'priority', label: 'Something else' },
    ];

    const result = resolveFieldRef('priority', { existing, added });
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.code).toBe('ambiguous');
      expect(result.candidates.sort()).toEqual(['priority', 'rating']);
    }
  });
});
