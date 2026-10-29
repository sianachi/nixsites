import type { Blueprint } from '../blueprint/schema.js';
import type { WorkspaceOperation } from './tables.js';

/**
 * One valid, minimal set of arguments per `WorkspaceOperation`, in the shape a typed
 * `nix_<operation>` tool call carries them (native JSON, not a flat `specJson` string).
 * `tools.test.ts` flattens each of these with a TS reference implementation of the Go worker's
 * `flattenToolCall` and checks the result against `@nix/companion`'s `workspaceToolSchema`, so
 * both languages are checked against the same fixture; `scripts/build-catalog.ts` also writes
 * these to `apps/go-workers/internal/companion/catalog/tool-examples.json` so the Go worker's own
 * `flattenToolCall` tests read the identical fixture (`catalog_test.go` / a new
 * `tools_flatten_test.go`).
 *
 * A sample UUID that satisfies both the Go worker's `uuid` regex and Zod's `z.uuid()` (a `4` in
 * the version nibble, an `8` in the variant nibble) stands in for every item, template and
 * parent id.
 */
export const EXAMPLE_ITEM_ID = '11111111-1111-4111-8111-111111111111';

const EXAMPLE_BLUEPRINT: Blueprint = {
  version: 1,
  title: 'Reading log',
  summary: 'Track books being read with a status board.',
  root: {
    id: 'reading-log',
    title: 'Reading log',
    fields: [{ label: 'Status', type: 'select', options: ['To read', 'Reading', 'Done'] }],
    views: [{ kind: 'list' }, { kind: 'board', groupBy: 'status' }],
    children: [{ id: 'book-a', title: 'The Hobbit', sample: true, values: { status: 'Done' } }],
  },
};

export const TOOL_EXAMPLES: Readonly<
  Record<WorkspaceOperation, Readonly<Record<string, unknown>>>
> = {
  list_items: {},
  search: { query: 'reading' },
  read_item: { itemId: EXAMPLE_ITEM_ID },
  read_note: { itemId: EXAMPLE_ITEM_ID },
  search_note: { itemId: EXAMPLE_ITEM_ID, query: 'What does it say about the deadline?' },
  read_structure: { itemId: EXAMPLE_ITEM_ID },
  read_view: { itemId: EXAMPLE_ITEM_ID, query: { viewId: 'list-1', pageSize: 10 } },
  create_note: { title: 'Plan', markdown: 'Notes go here.' },
  append_note: { itemId: EXAMPLE_ITEM_ID, markdown: 'More notes.' },
  replace_section: {
    itemId: EXAMPLE_ITEM_ID,
    heading: 'Next steps',
    markdown: '- Book the venue\n- Send invites',
  },
  replace_passage: { itemId: EXAMPLE_ITEM_ID, find: 'teh plan', replace: 'the plan' },
  rename_item: { itemId: EXAMPLE_ITEM_ID, title: 'New title' },
  move_item: { itemId: EXAMPLE_ITEM_ID, parentId: '' },
  set_properties: { itemId: EXAMPLE_ITEM_ID, properties: { status: 'Done' } },
  trash_item: { itemId: EXAMPLE_ITEM_ID },
  restore_item: { itemId: EXAMPLE_ITEM_ID },
  create_structured: {
    title: 'Reading list',
    spec: {
      recipe: 'list',
      fields: [{ label: 'Status', type: 'select', options: ['To read', 'Reading', 'Done'] }],
      views: [{ kind: 'list' }],
    },
  },
  add_view: {
    itemId: EXAMPLE_ITEM_ID,
    spec: { views: [{ kind: 'board', groupBy: 'status' }] },
  },
  update_view: {
    itemId: EXAMPLE_ITEM_ID,
    spec: { viewId: 'list-1', patch: { name: 'By priority' } },
  },
  create_entries: {
    parentId: EXAMPLE_ITEM_ID,
    spec: { entries: [{ title: 'The Hobbit' }] },
  },
  edit_fields: {
    itemId: EXAMPLE_ITEM_ID,
    spec: {
      fields: [{ key: 'person', label: 'Person', type: 'text', choiceSource: { field: 'person' } }],
    },
  },
  add_fields: {
    itemId: EXAMPLE_ITEM_ID,
    spec: { fields: [{ label: 'Rating', type: 'number' }] },
  },
  edit_form: {
    itemId: EXAMPLE_ITEM_ID,
    spec: {
      viewId: 'form-1',
      form: { pages: [{ title: 'Details', blocks: [{ field: 'status' }] }] },
    },
  },
  set_recurrence: { itemId: EXAMPLE_ITEM_ID, spec: { frequency: 'weekly', interval: 1 } },
  list_templates: {},
  read_template: { templateId: EXAMPLE_ITEM_ID },
  apply_template: { templateId: EXAMPLE_ITEM_ID, title: 'New from template' },
  build_blueprint: { blueprint: EXAMPLE_BLUEPRINT, parentId: '' },
  save_as_template: { itemId: EXAMPLE_ITEM_ID, title: 'Reading log template' },
  read_calendar: { from: '2026-10-05', to: '2026-10-11' },
  complete_task: { itemId: EXAMPLE_ITEM_ID, completed: true },
};

/** Typed parameters that are neither a flat field nor a whole JSON object: each one becomes a
 * key of the flat shape's `specJson` object, under its own name. The Go worker's `argSpecField`
 * mappings (`toolArgSpecs` in `tools.go`) are the same list. */
export const SPEC_FIELD_PARAMETERS: ReadonlySet<string> = new Set(['from', 'to', 'completed']);

/** The flat shape `@nix/companion`'s `workspaceToolSchema` parses, and the Go worker's
 * `ToolCall.Arguments` stores - unchanged by this task. */
export interface FlatWorkspaceToolArgs {
  operation: WorkspaceOperation;
  itemId: string;
  parentId: string;
  title: string;
  markdown: string;
  query: string;
  propertiesJson: string;
  specJson: string;
}

/**
 * A TS reference implementation of the Go worker's `flattenToolCall` (`apps/go-workers/internal
 * /companion/tools.go`): translates one typed `nix_<operation>` call's native-JSON arguments back
 * into the flat shape `workspaceToolSchema` and `@nix/companion/run.ts` have always parsed.
 * `templateId` maps to `itemId`; `heading` and `find` map to `query` and `replace` to `markdown`
 * (the body edits); `properties` marshals to `propertiesJson`; `spec` and `blueprint` both
 * marshal to `specJson`; the scalar `SPEC_FIELD_PARAMETERS` gather into one `specJson` object;
 * every other flat field defaults to `""`. Used by
 * `tools.test.ts`'s and `@nix/companion`'s round-trip tests, by `scripts/build-catalog.ts` (which
 * writes its output next to `TOOL_EXAMPLES` in the generated `tool-examples.json` so the Go
 * worker's own flattening test reads the identical expectation), and at runtime as
 * `flattenToolCall` for a generated component's `Mutation("<operation>", {...})`, which takes the
 * same typed parameters as the pet's `nix_<operation>` tool. Pet tool calls are still flattened by
 * the worker itself.
 */
export function flattenToolExample(
  operation: WorkspaceOperation,
  args: Readonly<Record<string, unknown>>,
): FlatWorkspaceToolArgs {
  const flat: FlatWorkspaceToolArgs = {
    operation,
    itemId: '',
    parentId: '',
    title: '',
    markdown: '',
    query: '',
    propertiesJson: '',
    specJson: '',
  };
  const specFields: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(args)) {
    if (SPEC_FIELD_PARAMETERS.has(key)) {
      specFields[key] = value;
      continue;
    }
    switch (key) {
      case 'itemId':
      case 'parentId':
      case 'title':
      case 'markdown':
        flat[key] = String(value);
        break;
      case 'query':
        if (typeof value !== 'object' && typeof value !== 'string')
          throw new Error('query must be text or an object.');
        flat.query = typeof value === 'object' ? JSON.stringify(value) : value;
        break;
      case 'templateId':
        flat.itemId = String(value);
        break;
      case 'heading':
      case 'find':
        flat.query = String(value);
        break;
      case 'replace':
        flat.markdown = String(value);
        break;
      case 'properties':
        flat.propertiesJson = JSON.stringify(value);
        break;
      case 'spec':
      case 'blueprint':
        flat.specJson = JSON.stringify(value);
        break;
      default:
        throw new Error(`flattenToolExample: unexpected argument "${key}" for ${operation}`);
    }
  }
  if (Object.keys(specFields).length > 0) flat.specJson = JSON.stringify(specFields);
  return flat;
}
