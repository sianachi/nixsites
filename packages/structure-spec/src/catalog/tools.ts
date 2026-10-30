import { z } from 'zod';

import { blueprintSchema } from '../blueprint/schema.js';
import { TASK_SEMANTIC_FIELD_TYPES } from '../spec/field.js';
import { PROPERTY_FORMULA_GUIDANCE } from './formulas.js';
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
import { LIMITS, WORKSPACE_OPERATIONS, type WorkspaceOperation } from './tables.js';

/**
 * Generates the model-facing typed tools straight from the same Zod schemas
 * `@nix/companion/run.ts` parses with, so a wrong guess about spec shape (a `name` where the
 * validator wants `label`, `properties` where it wants `values`, a `groupBy` on a `list` view)
 * fails at the provider's own argument-schema layer instead of costing a full round trip.
 *
 * The worker still flattens every call back into today's `{operation, itemId, parentId, title,
 * markdown, query, propertiesJson, specJson}` shape before it reaches `@nix/companion`; nothing
 * downstream of the worker changes.
 */

const TASK_KEYS_DESCRIPTION = ` choiceSource:{} learns this field from sibling entries; set itemId for another note and field for a child field or title. Task fields use their type as the key: ${TASK_SEMANTIC_FIELD_TYPES.join(', ')}; omit key or set it to that type, with any label. ${PROPERTY_FORMULA_GUIDANCE}`;
const FORM_MODE_DESCRIPTION =
  ' For form and interactive_form views, mode:"temporary" keeps answers in memory and creates no entry; mode:"saved" creates entries. Put calculations in formula schema fields, not input blocks.';
const HABIT_DESCRIPTION =
  ' Habit configuration belongs on each child node.habit (frequency, weekdays, target, unit); habit_tracker has no column mappings.';

export type JsonObject = Record<string, unknown>;

export interface PetToolDefinition {
  readonly name: string;
  readonly description: string;
  readonly inputSchema: JsonObject;
}

/**
 * The JSON Schema keys Codex 0.153.4's dynamic-tool sanitizer keeps; every other key is dropped
 * before the schema ever reaches the model, and a boolean `true` sub-schema becomes a bare
 * string type (a `false` sub-schema has no stated replacement, so it is treated the same as "no
 * recognisable hint" and becomes `{}`, consistent with the sanitizer's fallback for a schema kind
 * it does not recognise). Keeping only these keys here - rather than trusting Codex to strip the
 * rest - is what lets the byte budget below be measured against the schema Codex actually uses,
 * not the fuller one Zod produces.
 */
const CODEX_SCHEMA_KEYS = new Set([
  '$ref',
  'type',
  'description',
  'enum',
  'items',
  'minItems',
  'properties',
  'required',
  'additionalProperties',
  'anyOf',
  'oneOf',
  'allOf',
]);

/**
 * Reduces an arbitrary JSON Schema (as `z.toJSONSchema` produces it) to exactly the shape
 * Codex 0.153.4 keeps for a dynamic tool's `inputSchema`. Every tool schema in this module is
 * normalized before it is measured or shipped, so the 4800-byte budget in `tools.test.ts` is the
 * budget Codex itself applies (see "Codex 0.153.4 facts" in
 * `docs/plans/pet-speed-accuracy-plan.md`), not a looser one this package might otherwise send.
 */
export function normalizeForCodex(schema: unknown): unknown {
  if (schema === true) return { type: 'string' };
  if (schema === false || schema === null || typeof schema !== 'object') return {};
  const input = schema as JsonObject;
  const output: JsonObject = {};

  if ('const' in input && !('enum' in input)) {
    output.enum = [input.const];
  }

  for (const key of Object.keys(input)) {
    if (key === 'const' || !CODEX_SCHEMA_KEYS.has(key)) continue;
    const value = input[key];
    if (key === 'items' || key === 'additionalProperties') {
      output[key] = typeof value === 'boolean' ? value : normalizeForCodex(value);
    } else if (key === 'properties') {
      const properties: JsonObject = {};
      for (const [propertyName, propertySchema] of Object.entries(value as JsonObject)) {
        properties[propertyName] = normalizeForCodex(propertySchema);
      }
      output[key] = properties;
    } else if (key === 'anyOf' || key === 'oneOf' || key === 'allOf') {
      output[key] = (value as unknown[]).map((entry) => normalizeForCodex(entry));
    } else {
      output[key] = value;
    }
  }

  const defsSource = (input.$defs ?? input.definitions) as JsonObject | undefined;
  if (defsSource) {
    const defs: JsonObject = {};
    for (const [defName, defSchema] of Object.entries(defsSource)) {
      defs[defName] = normalizeForCodex(defSchema);
    }
    output.$defs = defs;
  }

  return output;
}

function jsonSchemaOf(schema: z.ZodType): unknown {
  return normalizeForCodex(
    z.toJSONSchema(schema, { io: 'input', unrepresentable: 'any', cycles: 'ref' }),
  );
}

function stringProperty(description?: string): JsonObject {
  return description === undefined ? { type: 'string' } : { type: 'string', description };
}

/**
 * The shape `run.ts` accepts for `set_properties`' values: a JSON object whose values are a
 * string, number, boolean, string array, or null - `run.ts` itself only checks `typeof ===
 * 'object'` (via `workspaceToolSchema`'s `propertiesJson`), so this is written out by hand rather
 * than derived from a Zod schema that does not exist for it.
 */
function propertiesValueProperty(): JsonObject {
  return {
    type: 'object',
    description: 'One or more property values, keyed by field key (see nix_read_structure).',
    additionalProperties: {
      anyOf: [
        { type: 'string' },
        { type: 'number' },
        { type: 'boolean' },
        { type: 'array', items: { type: 'string' } },
        { type: 'null' },
      ],
    },
  };
}

/**
 * Walks a normalized JSON Schema and removes the `interactive_form` view kind's `form` detail
 * (a full page/block/condition tree - see `formSpecSchema`) wherever it appears. Applied only to
 * the blueprint tool (L1.2 tactic 3): the same view schema is small enough to keep whole in
 * `add_view` and `edit_form`'s own tools, but repeated at every depth of a blueprint's recursive
 * node tree it is the single largest contributor to the schema's size (roughly 1790 of 5823
 * bytes before this reduction - measured with `z.toJSONSchema`'s default `reused: 'inline'`;
 * `reused: 'ref'` was tried first per L1.2's step 1 and made the schema larger, not smaller,
 * because Codex's normalized keys leave little duplication for `$ref` extraction to remove once
 * `pattern`/`minLength`/`maxLength` are already stripped - so this tactic is applied instead).
 * `blueprintSchema` itself is unchanged: a pet-authored `interactive_form` view still parses and
 * validates; the model is simply not shown that one kind's detail when designing a whole
 * structure from scratch, where `add_view`/`edit_form` are the tools for going deeper on a form
 * afterwards.
 */
function omitBlueprintInteractiveFormDetail(schema: unknown): unknown {
  if (Array.isArray(schema)) {
    return schema.map((entry) => omitBlueprintInteractiveFormDetail(entry));
  }
  if (schema === null || typeof schema !== 'object') return schema;
  const node = schema as JsonObject;
  const properties = node.properties as JsonObject | undefined;
  if (properties) {
    const kind = properties.kind as { enum?: unknown[] } | undefined;
    if (
      kind &&
      Array.isArray(kind.enum) &&
      kind.enum.includes('interactive_form') &&
      'form' in properties
    ) {
      const rest = { ...properties };
      delete rest.form;
      node.properties = rest;
    }
  }
  for (const key of Object.keys(node)) {
    node[key] = omitBlueprintInteractiveFormDetail(node[key]);
  }
  return node;
}

/**
 * Removes the `custom` view kind and its `program` wherever a view schema appears. The two
 * create tools are at the Codex budget, so a custom view is advertised on `add_view` and
 * `update_view` only; the specs still accept one.
 */
export function omitCustomViews(schema: unknown): unknown {
  if (Array.isArray(schema)) return schema.map((entry) => omitCustomViews(entry));
  if (schema === null || typeof schema !== 'object') return schema;
  const node = schema as JsonObject;
  const properties = node.properties as JsonObject | undefined;
  const kind = properties?.kind as { enum?: unknown[] } | undefined;
  if (properties && kind && Array.isArray(kind.enum) && kind.enum.includes('custom')) {
    const rest: JsonObject = {
      ...properties,
      kind: { ...kind, enum: kind.enum.filter((k) => k !== 'custom') },
    };
    delete rest.program;
    node.properties = rest;
  }
  for (const key of Object.keys(node)) node[key] = omitCustomViews(node[key]);
  return node;
}

function blueprintProperty(): JsonObject {
  return omitCustomViews(
    omitBlueprintInteractiveFormDetail(jsonSchemaOf(blueprintSchema)),
  ) as JsonObject;
}

function wrap(properties: JsonObject, required: readonly string[]): JsonObject {
  return {
    type: 'object',
    properties,
    required: [...required],
    additionalProperties: false,
  };
}

function booleanProperty(description: string): JsonObject {
  return { type: 'boolean', description };
}

const ITEM_ID_DESCRIPTION =
  'The exact item UUID. Discover it with nix_list_items or nix_search first if not already known.';
const PARENT_ID_DESCRIPTION = 'Parent, or root.';
const TEMPLATE_ID_DESCRIPTION = 'The template item UUID.';

interface ToolBuild {
  readonly description: string;
  readonly properties: JsonObject;
  readonly required: readonly string[];
}

/**
 * One entry per `WorkspaceOperation` (see `tables.ts`), in that same order. This is the mapping
 * table L1.1 describes: what a typed tool's own parameters are, and - by construction, since
 * `@nix/companion/run.ts` reads the identical flat shape regardless of how the argument arrived -
 * how each maps back onto it. A tool's own parameter names differ from the flat shape only where
 * that removes an ambiguity the flat shape lives with: `read_template` and `apply_template` take
 * `templateId`, not `itemId`, because the id they need is a template's, and `set_properties`,
 * `create_structured`, `add_view`, `create_entries`, `add_fields`, `edit_form`, `set_recurrence`,
 * `apply_template` and `save_as_template` take `properties`/`spec`/`blueprint` as a native JSON
 * value, not a JSON-encoded string. `read_calendar`'s `from`/`to` and `complete_task`'s
 * `completed` are plain scalar parameters that the worker gathers into one `specJson` object
 * (`SPEC_FIELD_PARAMETERS` in `tool-examples.ts`), so the flat shape gains no new field.
 */
const TOOL_BUILDS: Readonly<Record<WorkspaceOperation, () => ToolBuild>> = {
  list_items: () => ({
    description:
      "List an item's direct children (id, title, type, whether it has children) with their property values: dueDate, startDate and completed when the task fields exist, other values under properties. Omit parentId to list the workspace root. Read-only; reads may run without a card; changes always ask for approval.",
    properties: { parentId: stringProperty(PARENT_ID_DESCRIPTION) },
    required: [],
  }),
  search: () => ({
    description:
      'Search this workspace by title or content: returns matching items and the passages that best answer the query, matched by meaning as well as words. Read-only; reads may run without a card; changes always ask for approval.',
    properties: { query: stringProperty('What to search for.') },
    required: ['query'],
  }),
  read_item: () => ({
    description: "Read one item's id, title, type and workspace. Read-only.",
    properties: { itemId: stringProperty(ITEM_ID_DESCRIPTION) },
    required: ['itemId'],
  }),
  read_note: () => ({
    description:
      "Read a note's text, or a file item's content: text, CSV, JSON and PDF as text, images as a picture. Read-only.",
    properties: { itemId: stringProperty(ITEM_ID_DESCRIPTION) },
    required: ['itemId'],
  }),
  search_note: () => ({
    description:
      "Find the passages that best answer a question in a note and every note under it, with each passage's note, heading and position. Use for a note too long to read whole (nix_read_note returned partial) or a question about a note's children. Read-only.",
    properties: {
      itemId: stringProperty(
        'The note (or folder or collection) whose text, and whose descendants’ text, to search.',
      ),
      query: stringProperty('The question or topic, in plain words.'),
    },
    required: ['itemId', 'query'],
  }),
  read_structure: () => ({
    description:
      "Read an item's effective and declared fields, complete view configuration, default and companion views, renderability and child count. Start an existing-view review here. Read-only.",
    properties: { itemId: stringProperty(ITEM_ID_DESCRIPTION) },
    required: ['itemId'],
  }),
  read_view: () => ({
    description:
      'Read at most 25 permission-filtered results for one saved view. Read nix_read_structure first for its exact viewId. Returns configuration, counts, truncation and display limitations; a sample cannot prove the whole view. Read-only.',
    properties: {
      itemId: stringProperty(ITEM_ID_DESCRIPTION),
      query: {
        type: 'object',
        properties: {
          viewId: stringProperty('The exact saved view id, from nix_read_structure.'),
          pageSize: { type: 'integer', description: 'Maximum rows, 1 to 25; default 25.' },
        },
        required: ['viewId'],
        additionalProperties: false,
      },
    },
    required: ['itemId', 'query'],
  }),
  create_note: () => ({
    description:
      'Create a new note with title and markdown, under parentId (omit for the workspace root). Shown for approval before it runs.',
    properties: {
      title: stringProperty('The new note title.'),
      markdown: stringProperty('Markdown for the note body.'),
      parentId: stringProperty(PARENT_ID_DESCRIPTION),
    },
    required: ['title', 'markdown'],
  }),
  append_note: () => ({
    description: "Append Markdown to a note's body. Never replaces existing content.",
    properties: {
      itemId: stringProperty(ITEM_ID_DESCRIPTION),
      markdown: stringProperty('Markdown to append.'),
    },
    required: ['itemId', 'markdown'],
  }),
  replace_section: () => ({
    description:
      "Replace one section of a note: the blocks from the heading named heading up to the next heading of the same or higher level. The rest of the note is untouched. If markdown does not start with a heading, the original heading is kept. Refuses when the heading is missing or not unique. Call nix_read_note first. Never replaces a whole note's body.",
    properties: {
      itemId: stringProperty(ITEM_ID_DESCRIPTION),
      heading: stringProperty(
        'The exact heading text, without # marks (case is ignored); must be unique in the note.',
      ),
      markdown: stringProperty('The new Markdown for that section.'),
    },
    required: ['itemId', 'heading', 'markdown'],
  }),
  replace_passage: () => ({
    description:
      'Fix text inside one paragraph, heading, list item text or code block: find must occur exactly once in the note and inside a single block (no list markers). Only that block is rewritten. Call nix_read_note first.',
    properties: {
      itemId: stringProperty(ITEM_ID_DESCRIPTION),
      find: stringProperty('The exact Markdown text to replace, up to 240 characters.'),
      replace: stringProperty('The Markdown text to put in its place; may be empty.'),
    },
    required: ['itemId', 'find', 'replace'],
  }),
  rename_item: () => ({
    description: 'Rename an item. Never changes anything else about it.',
    properties: {
      itemId: stringProperty(ITEM_ID_DESCRIPTION),
      title: stringProperty('The new title.'),
    },
    required: ['itemId', 'title'],
  }),
  move_item: () => ({
    description:
      "Move an item under a new parent. Supply an empty parentId to move it to the workspace root. To move it to another workspace, also give destinationWorkspaceId; parentId is then a parent there, or empty for that workspace's root.",
    properties: {
      itemId: stringProperty(ITEM_ID_DESCRIPTION),
      parentId: stringProperty(PARENT_ID_DESCRIPTION),
      destinationWorkspaceId: stringProperty('Another workspace UUID to move the item into.'),
    },
    required: ['itemId', 'parentId'],
  }),
  set_properties: () => ({
    description: "Set one or more of an item's property values. Call nix_read_structure first.",
    properties: {
      itemId: stringProperty(ITEM_ID_DESCRIPTION),
      properties: propertiesValueProperty(),
    },
    required: ['itemId', 'properties'],
  }),
  trash_item: () => ({
    description: 'Move an item to trash. Recoverable with nix_restore_item; never permanent.',
    properties: { itemId: stringProperty(ITEM_ID_DESCRIPTION) },
    required: ['itemId'],
  }),
  restore_item: () => ({
    description: 'Restore a trashed item.',
    properties: { itemId: stringProperty(ITEM_ID_DESCRIPTION) },
    required: ['itemId'],
  }),
  create_structured: () => ({
    description: `Create a new item with a recipe, fields and up to ${String(LIMITS.viewsPerNode)} views per call, under parentId (omit for the workspace root). Items support at most ${String(LIMITS.viewsPerContainer)} views total. Shown for approval before it runs.${TASK_KEYS_DESCRIPTION}${FORM_MODE_DESCRIPTION}`,
    properties: {
      title: stringProperty(),
      spec: omitCustomViews(jsonSchemaOf(structuredSpecSchema)),
      parentId: stringProperty(),
    },
    required: ['title', 'spec'],
  }),
  add_view: () => ({
    description: `Add fields and up to ${String(LIMITS.viewsPerAddView)} views per call to an item's existing schema, within its ${String(LIMITS.viewsPerContainer)}-view total limit. Read nix_read_structure.viewCapacity first and split batches within remaining capacity. Never removes or retypes a field, never deletes an existing view. A custom view takes program, an openui-lang program (see Custom views).${TASK_KEYS_DESCRIPTION}${FORM_MODE_DESCRIPTION}`,
    properties: {
      itemId: stringProperty(ITEM_ID_DESCRIPTION),
      spec: jsonSchemaOf(viewSetupSpecSchema),
    },
    required: ['itemId', 'spec'],
  }),
  update_view: () => ({
    description:
      'Refine one existing view using exact field keys from nix_read_structure. Only patch named settings; unmentioned settings, fields, kind, default and companions stay intact. Shows before and after and always asks for approval. Use nix_edit_form for form pages; read structure and results back after success. On a custom view, patch.program replaces its whole program.' +
      FORM_MODE_DESCRIPTION,
    properties: {
      itemId: stringProperty(ITEM_ID_DESCRIPTION),
      spec: jsonSchemaOf(updateViewSpecSchema),
    },
    required: ['itemId', 'spec'],
  }),
  create_entries: () => ({
    description: 'Create up to 25 child entries under parentId in one call.',
    properties: {
      parentId: stringProperty("The container item's UUID."),
      spec: jsonSchemaOf(entriesSpecSchema),
    },
    required: ['parentId', 'spec'],
  }),
  edit_fields: () => ({
    description:
      'Edit existing locally declared fields, including type and choiceSource. Read nix_read_structure first and supply exact keys and complete field definitions. Existing values are retained without conversion; always requires approval. Cannot remove fields.',
    properties: {
      itemId: stringProperty(ITEM_ID_DESCRIPTION),
      spec: jsonSchemaOf(fieldsSpecSchema),
    },
    required: ['itemId', 'spec'],
  }),
  add_fields: () => ({
    description:
      "Add up to 20 new fields to an item's existing schema. Never removes or retypes an existing field." +
      TASK_KEYS_DESCRIPTION,
    properties: {
      itemId: stringProperty(ITEM_ID_DESCRIPTION),
      spec: jsonSchemaOf(fieldsSpecSchema),
    },
    required: ['itemId', 'spec'],
  }),
  edit_form: () => ({
    description:
      'Replace one existing interactive form view, optionally adding new fields to the item at the same time.' +
      TASK_KEYS_DESCRIPTION,
    properties: {
      itemId: stringProperty(ITEM_ID_DESCRIPTION),
      spec: jsonSchemaOf(formEditSpecSchema),
    },
    required: ['itemId', 'spec'],
  }),
  set_recurrence: () => ({
    description: 'Set or replace a recurring due-date rule on an item.',
    properties: {
      itemId: stringProperty(ITEM_ID_DESCRIPTION),
      spec: jsonSchemaOf(recurrenceSpecSchema),
    },
    required: ['itemId', 'spec'],
  }),
  list_templates: () => ({
    description:
      'List templates available in this workspace, optionally filtered by query. Read-only.',
    properties: { query: stringProperty('Optional filter text.') },
    required: [],
  }),
  read_template: () => ({
    description: "Read one template's details. Read-only.",
    properties: { templateId: stringProperty(TEMPLATE_ID_DESCRIPTION) },
    required: ['templateId'],
  }),
  apply_template: () => ({
    description:
      'Apply a template to create a new item under parentId (omit for the workspace root), filling any inputs the template declares. Shown for approval before it runs.',
    properties: {
      templateId: stringProperty(TEMPLATE_ID_DESCRIPTION),
      title: stringProperty(),
      parentId: stringProperty(PARENT_ID_DESCRIPTION),
      spec: jsonSchemaOf(applySpecSchema),
    },
    required: ['templateId', 'title'],
  }),
  build_blueprint: () => ({
    description: `Build a whole design (items, fields, views and samples) in one approval, under Pet drafts unless parentId names a parent. Nix checks it before the owner sees it: a design with problems comes back declined with every problem listed; fix them all and call once more. Up to ${String(LIMITS.viewsPerNode)} views per node, ${String(LIMITS.viewsPerBlueprint)} per blueprint.${TASK_KEYS_DESCRIPTION}${HABIT_DESCRIPTION}${FORM_MODE_DESCRIPTION}`,
    properties: {
      blueprint: blueprintProperty(),
      parentId: stringProperty('Parent UUID; default Pet drafts.'),
    },
    required: ['blueprint'],
  }),
  save_as_template: () => ({
    description:
      'Save an item and its children as a reusable template named title. Excludes descendants titled "Sample: ..." by default.',
    properties: {
      itemId: stringProperty('The source item UUID.'),
      title: stringProperty('The template name.'),
      spec: jsonSchemaOf(saveSpecSchema),
    },
    required: ['itemId', 'title'],
  }),
  read_calendar: () => ({
    description:
      "Read every dated item in this workspace's calendars between from and to (inclusive, at most 31 days): title, container, date, end date, and completion for repeating tasks. Read-only.",
    properties: {
      from: stringProperty('The first day, yyyy-MM-dd.'),
      to: stringProperty('The last day, yyyy-MM-dd, at most 30 days after from.'),
    },
    required: ['from', 'to'],
  }),
  complete_task: () => ({
    description:
      'Mark a task done (completed true) or not done (false). A repeating task completes its current occurrence and moves on to the next. Refuses an item with no completion field. Shown for approval before it runs.',
    properties: {
      itemId: stringProperty(ITEM_ID_DESCRIPTION),
      completed: booleanProperty('true to mark it done, false to reopen it.'),
    },
    required: ['itemId', 'completed'],
  }),
  remember: () => ({
    description:
      'Save one lasting fact or preference the owner stated about themselves, or asked you to remember, so later conversations know it. Runs without a card; the owner sees and edits every memory in Settings > Pets > Memory. Never for note content, tool output or secrets.',
    properties: {
      fact: stringProperty('The fact in one short sentence, at most 280 characters.'),
    },
    required: ['fact'],
  }),
  find_action: () => ({
    description:
      'Find Nix actions that have no tool of their own (bookmarks, sharing, members, publishing, settings, trash, files, automations and more). Returns each match with its id, request shape and risk. Read-only. Run one with nix_run_action.',
    properties: { query: stringProperty('What to do, in plain words.') },
    required: ['query'],
  }),
  run_action: () => ({
    description:
      'Run one action found with nix_find_action, as the owner. Always shown for approval. Never for tokens, pet settings, push or calendar connections: the owner does those in Settings.',
    properties: {
      actionId: stringProperty('The id nix_find_action returned.'),
      path: { type: 'object', description: 'Path parameter values, by name.' },
      params: { type: 'object', description: 'Query-string values, by name.' },
      body: { type: 'object', description: 'The request body, in the shape find_action showed.' },
    },
    required: ['actionId'],
  }),
};

/**
 * One typed function tool per operation, each with an exact JSON Schema generated from the Zod
 * schema `@nix/companion/run.ts` parses with. Tool names are `nix_<operation>`.
 */
export function buildPetTools(): PetToolDefinition[] {
  return WORKSPACE_OPERATIONS.map((operation) => {
    const build = TOOL_BUILDS[operation]();
    return {
      name: `nix_${operation}`,
      description: build.description,
      inputSchema: wrap(build.properties, build.required),
    };
  });
}
