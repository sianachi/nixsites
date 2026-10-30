import { z } from 'zod';
import { FORMULA_FUNCTION_NAMES } from '@nix/sheet';
import { describe, expect, it } from 'vitest';

import type { StructureProperty, StructureView } from '../types.js';
import { blueprintSchema } from '../blueprint/schema.js';
import {
  applySpecSchema,
  entriesSpecSchema,
  fieldsSpecSchema,
  formEditSpecSchema,
  recurrenceSpecSchema,
  saveSpecSchema,
  structuredSpecSchema,
  viewSetupSpecSchema,
  updateViewSpecSchema,
} from '../spec/index.js';
import { validateBlueprint } from '../blueprint/validate.js';
import { validateSpec } from '../validate/spec.js';
import { buildPetTools, normalizeForCodex, omitCustomViews } from './tools.js';
import { WORKSPACE_OPERATIONS, LIMITS } from './tables.js';
import { flattenToolExample, TOOL_EXAMPLES } from './tool-examples.js';

/**
 * The Codex 0.153.4 dynamic-tool byte budget (Codex caps a dynamic tool schema at 4800
 * normalized bytes): a schema at or under this size is never compacted.
 */
const CODEX_SCHEMA_BUDGET = 4800;

function toolNames(): string[] {
  return buildPetTools().map((tool) => tool.name);
}

describe('buildPetTools', () => {
  it('teaches the supported property grammar to formula-writing tools', () => {
    const tools = new Map(buildPetTools().map((tool) => [tool.name, tool]));
    for (const operation of [
      'create_structured',
      'add_view',
      'add_fields',
      'edit_form',
      'build_blueprint',
    ]) {
      const description = tools.get(`nix_${operation}`)?.description ?? '';
      expect(description).toContain('case-sensitive property keys as [key]');
      expect(description).toContain('without a leading =');
      expect(description).toContain('never labels, prop() or PROPERTY()');
      expect(description).toContain('TODAY and NOW are unsupported');
      expect(description).toContain(FORMULA_FUNCTION_NAMES.join(', '));
    }
  });
  it('keeps per-call and total capacity guidance after provider schema normalization', () => {
    const tools = new Map(buildPetTools().map((tool) => [tool.name, tool]));
    expect(tools.get('nix_create_structured')?.description).toContain('up to 6 views per call');
    expect(tools.get('nix_create_structured')?.description).toContain('at most 12 views total');
    expect(tools.get('nix_add_view')?.description).toContain('up to 4 views per call');
    expect(tools.get('nix_add_view')?.description).toContain('12-view total limit');
    expect(tools.get('nix_add_view')?.description).toContain('viewCapacity');
    for (const operation of [
      'create_structured',
      'add_view',
      'add_fields',
      'edit_form',
      'build_blueprint',
    ]) {
      expect(tools.get(`nix_${operation}`)?.description).toContain(
        'due_date, start_date, completion, priority, estimate, reminder',
      );
      expect(tools.get(`nix_${operation}`)?.description).toContain(
        'omit key or set it to that type',
      );
    }
    expect(tools.get('nix_build_blueprint')?.description).toContain('child node.habit');
    expect(tools.get('nix_build_blueprint')?.description).toContain('no column mappings');
    const views = (count: number) => Array.from({ length: count }, () => ({ kind: 'list' }));
    expect(
      structuredSpecSchema.safeParse({
        recipe: 'list',
        fields: [],
        views: views(LIMITS.viewsPerNode),
      }).success,
    ).toBe(true);
    expect(
      structuredSpecSchema.safeParse({
        recipe: 'list',
        fields: [],
        views: views(LIMITS.viewsPerNode + 1),
      }).success,
    ).toBe(false);
    expect(viewSetupSpecSchema.safeParse({ views: views(LIMITS.viewsPerAddView) }).success).toBe(
      true,
    );
    expect(
      viewSetupSpecSchema.safeParse({ views: views(LIMITS.viewsPerAddView + 1) }).success,
    ).toBe(false);
  });

  it('names every tool nix_<operation>, offering every operation', () => {
    expect(toolNames()).toEqual(WORKSPACE_OPERATIONS.map((operation) => `nix_${operation}`));
  });

  it('offers exactly one tool per operation, with no duplicates', () => {
    const names = toolNames();
    expect(new Set(names).size).toBe(names.length);
  });

  it('every tool has a non-empty description and a well-formed object inputSchema', () => {
    for (const tool of buildPetTools()) {
      expect(tool.description.length).toBeGreaterThan(0);
      expect(tool.inputSchema.type).toBe('object');
      expect(tool.inputSchema.additionalProperties).toBe(false);
      expect(Array.isArray(tool.inputSchema.required)).toBe(true);
      expect(typeof tool.inputSchema.properties).toBe('object');
    }
  });

  it('keeps every tool schema at or under the Codex 4800-byte budget once normalized', () => {
    const sizes: Record<string, number> = {};
    for (const tool of buildPetTools()) {
      const size = JSON.stringify(normalizeForCodex(tool.inputSchema)).length;
      sizes[tool.name] = size;
      expect(
        size,
        `${tool.name} is ${String(size)} bytes, want <= ${String(CODEX_SCHEMA_BUDGET)}`,
      ).toBeLessThanOrEqual(CODEX_SCHEMA_BUDGET);
    }
    // nix_build_blueprint carries the largest schema in the catalog (the
    // recursive blueprint tree) - printed here as a record of the measured size after L1.2's
    // reduction (omitting the interactive_form view kind's `form` detail from the advertised
    // blueprint schema only; blueprintSchema itself, and what validateBlueprint accepts, is
    // unchanged). Before that reduction the wrapped tool was over budget (5823 bytes for the
    // blueprint sub-schema alone, per the plan's own measurement).
    expect(sizes.nix_build_blueprint).toBeLessThanOrEqual(CODEX_SCHEMA_BUDGET);
  });

  it('generates each spec parameter from the exact schema object run.ts parses with (import identity)', () => {
    const bySpecSchema: [string, string, z.ZodType][] = [
      ['create_structured', 'spec', structuredSpecSchema],
      ['add_view', 'spec', viewSetupSpecSchema],
      ['update_view', 'spec', updateViewSpecSchema],
      ['create_entries', 'spec', entriesSpecSchema],
      ['add_fields', 'spec', fieldsSpecSchema],
      ['edit_form', 'spec', formEditSpecSchema],
      ['set_recurrence', 'spec', recurrenceSpecSchema],
      ['apply_template', 'spec', applySpecSchema],
      ['save_as_template', 'spec', saveSpecSchema],
    ];
    const tools = new Map(buildPetTools().map((tool) => [tool.name, tool]));
    for (const [operation, property, schema] of bySpecSchema) {
      const tool = tools.get(`nix_${operation}`);
      expect(tool, `nix_${operation} is missing`).toBeDefined();
      const full = normalizeForCodex(
        z.toJSONSchema(schema, { io: 'input', unrepresentable: 'any', cycles: 'ref' }),
      );
      const expected = operation === 'create_structured' ? omitCustomViews(full) : full;
      const inputSchema = tool?.inputSchema as { properties: Record<string, unknown> } | undefined;
      expect(inputSchema?.properties[property]).toEqual(expected);
    }
  });

  it("omits the interactive_form view kind's form detail from the blueprint tools only, never from add_view or edit_form", () => {
    const tools = new Map(buildPetTools().map((tool) => [tool.name, tool]));
    const addView = tools.get('nix_add_view');
    const editForm = tools.get('nix_edit_form');
    const buildBlueprint = tools.get('nix_build_blueprint');
    expect(addView).toBeDefined();
    expect(editForm).toBeDefined();
    expect(buildBlueprint).toBeDefined();

    // add_view and edit_form keep the interactive_form view kind's own form detail (a
    // paragraph block, part of formSpecSchema's block union) in full.
    expect(JSON.stringify(addView?.inputSchema)).toContain('"paragraph"');
    expect(JSON.stringify(editForm?.inputSchema)).toContain('"paragraph"');

    // The blueprint tool still names interactive_form as a valid view kind; they just no
    // longer carry that kind's own form (pages/blocks/conditions) detail.
    const json = JSON.stringify(buildBlueprint?.inputSchema);
    expect(json).toContain('interactive_form');
    expect(json).not.toContain('"paragraph"');
  });

  it('advertises the custom view kind and its program on add_view and update_view only', () => {
    const tools = new Map(buildPetTools().map((tool) => [tool.name, tool]));
    const json = (name: string) => JSON.stringify(tools.get(name)?.inputSchema);
    expect(json('nix_add_view')).toContain('"custom"');
    expect(json('nix_add_view')).toContain('"program"');
    expect(json('nix_update_view')).toContain('"program"');
    for (const name of ['nix_create_structured', 'nix_build_blueprint']) {
      expect(json(name)).not.toContain('"custom"');
      expect(json(name)).not.toContain('"program"');
    }
  });
});

describe('flattenToolExample (TS reference implementation)', () => {
  for (const operation of WORKSPACE_OPERATIONS) {
    it(`flattens the ${operation} example into the operation and every required flat field`, () => {
      const example = TOOL_EXAMPLES[operation];
      const flat = flattenToolExample(operation, example);
      expect(flat.operation).toBe(operation);
      for (const key of [
        'itemId',
        'parentId',
        'title',
        'markdown',
        'query',
        'propertiesJson',
        'specJson',
      ] as const) {
        expect(typeof flat[key]).toBe('string');
      }
    });
  }

  it('maps templateId to itemId', () => {
    const flat = flattenToolExample('read_template', TOOL_EXAMPLES.read_template);
    expect(flat.itemId).toBe(TOOL_EXAMPLES.read_template.templateId);
  });

  it('marshals properties, spec and blueprint to canonical JSON strings', () => {
    const flat = flattenToolExample('set_properties', TOOL_EXAMPLES.set_properties);
    expect(JSON.parse(flat.specJson || '{}')).toEqual({});
    expect(JSON.parse(flat.propertiesJson)).toEqual(TOOL_EXAMPLES.set_properties.properties);

    const structured = flattenToolExample('create_structured', TOOL_EXAMPLES.create_structured);
    expect(JSON.parse(structured.specJson)).toEqual(TOOL_EXAMPLES.create_structured.spec);
  });

  it('gathers the scalar calendar and task parameters into one specJson object', () => {
    const calendar = flattenToolExample('read_calendar', TOOL_EXAMPLES.read_calendar);
    expect(JSON.parse(calendar.specJson)).toEqual({ from: '2026-10-05', to: '2026-10-11' });
    expect(calendar.itemId).toBe('');

    const task = flattenToolExample('complete_task', TOOL_EXAMPLES.complete_task);
    expect(task.itemId).toBe(TOOL_EXAMPLES.complete_task.itemId);
    expect(JSON.parse(task.specJson)).toEqual({ completed: true });
  });

  it('types complete_task.completed as a boolean and requires both calendar bounds', () => {
    const tools = buildPetTools();
    const task = tools.find((tool) => tool.name === 'nix_complete_task');
    const calendar = tools.find((tool) => tool.name === 'nix_read_calendar');
    const taskProperties = task?.inputSchema.properties as Record<string, { type?: string }>;
    expect(taskProperties.completed?.type).toBe('boolean');
    expect(calendar?.inputSchema.required).toEqual(['from', 'to']);
  });
});

describe('every tool example is accepted by the same validator run.ts calls', () => {
  const statusProperty: StructureProperty = {
    key: 'status',
    label: 'Status',
    type: 'select',
    options: ['To read', 'Reading', 'Done'],
    required: false,
  };
  const dueDateProperty: StructureProperty = {
    key: 'due_date',
    label: 'Due date',
    type: 'due_date',
    options: [],
    required: false,
  };
  function interactiveFormView(id: string): StructureView {
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
        confirmationTitle: '',
        confirmationMessage: '',
      },
    };
  }

  it('create_structured', () => {
    const example = TOOL_EXAMPLES.create_structured as { spec: unknown };
    const report = validateSpec('create_structured', example.spec, {
      inheritedFields: [],
      today: '2026-09-27',
    });
    expect(report.ok, JSON.stringify(report.problems)).toBe(true);
  });

  it('add_view', () => {
    const example = TOOL_EXAMPLES.add_view as { spec: unknown };
    const report = validateSpec('add_view', example.spec, {
      inheritedFields: [],
      existing: { declared: [statusProperty], inherit: true, views: [] },
      today: '2026-09-27',
    });
    expect(report.ok, JSON.stringify(report.problems)).toBe(true);
  });

  it('add_fields', () => {
    const example = TOOL_EXAMPLES.add_fields as { spec: unknown };
    const report = validateSpec('add_fields', example.spec, {
      inheritedFields: [],
      existing: { declared: [], inherit: true, views: [] },
      today: '2026-09-27',
    });
    expect(report.ok, JSON.stringify(report.problems)).toBe(true);
  });

  it('edit_form', () => {
    const example = TOOL_EXAMPLES.edit_form as { spec: { viewId: string } };
    const report = validateSpec('edit_form', example.spec, {
      inheritedFields: [],
      existing: {
        declared: [statusProperty],
        inherit: true,
        views: [interactiveFormView(example.spec.viewId)],
      },
      today: '2026-09-27',
    });
    expect(report.ok, JSON.stringify(report.problems)).toBe(true);
  });

  it('set_recurrence', () => {
    const example = TOOL_EXAMPLES.set_recurrence as { spec: unknown };
    const report = validateSpec('set_recurrence', example.spec, {
      inheritedFields: [],
      existing: { declared: [dueDateProperty], inherit: true, views: [] },
      itemValues: { due_date: '2026-10-01' },
      today: '2026-09-27',
    });
    expect(report.ok, JSON.stringify(report.problems)).toBe(true);
  });

  it('build_blueprint carries a blueprint that validateBlueprint accepts', () => {
    const example = TOOL_EXAMPLES.build_blueprint as { blueprint: unknown };
    const parsed = blueprintSchema.parse(example.blueprint);
    const report = validateBlueprint(parsed, { inheritedFields: [], today: '2026-09-27' });
    expect(report.ok, JSON.stringify(report.problems)).toBe(true);
  });
});
