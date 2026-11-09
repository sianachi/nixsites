import { operationFromToolName } from './catalog.ts';
import {
  byteLen,
  goJson,
  isJsonObject,
  isRecord,
  jsonDepth,
  parseObject,
  UUID,
} from '../shared/util.ts';

type ArgKind = 'string' | 'objectJson' | 'specField';
interface ArgMapping {
  flat: string;
  kind: ArgKind;
}

const s = (flat: string): ArgMapping => ({ flat, kind: 'string' });
const o = (flat: string): ArgMapping => ({ flat, kind: 'objectJson' });
const f = (flat: string): ArgMapping => ({ flat, kind: 'specField' });

/**
 * Which native-JSON arguments each nix_<operation> tool accepts and which flat field each maps
 * onto: packages/structure-spec's TOOL_BUILDS table, stricter than its flattenToolExample.
 * templateId maps to itemId; the body edits reuse query for what they locate and markdown for
 * what replaces it; "spec"/"blueprint"/"properties" marshal to specJson/propertiesJson.
 */
const TOOL_ARG_SPECS: Readonly<Record<string, Readonly<Record<string, ArgMapping>>>> = {
  list_items: { parentId: s('parentId') },
  search: { query: s('query') },
  read_item: { itemId: s('itemId') },
  read_note: { itemId: s('itemId') },
  search_note: { itemId: s('itemId'), query: s('query') },
  remember: { fact: s('markdown') },
  read_structure: { itemId: s('itemId') },
  read_view: { itemId: s('itemId'), query: o('query') },
  create_note: { title: s('title'), markdown: s('markdown'), parentId: s('parentId') },
  append_note: { itemId: s('itemId'), markdown: s('markdown') },
  replace_section: { itemId: s('itemId'), heading: s('query'), markdown: s('markdown') },
  replace_passage: { itemId: s('itemId'), find: s('query'), replace: s('markdown') },
  rename_item: { itemId: s('itemId'), title: s('title') },
  move_item: {
    itemId: s('itemId'),
    parentId: s('parentId'),
    destinationWorkspaceId: f('specJson'),
  },
  set_properties: { itemId: s('itemId'), properties: o('propertiesJson') },
  trash_item: { itemId: s('itemId') },
  restore_item: { itemId: s('itemId') },
  create_structured: { title: s('title'), spec: o('specJson'), parentId: s('parentId') },
  add_view: { itemId: s('itemId'), spec: o('specJson') },
  update_view: { itemId: s('itemId'), spec: o('specJson') },
  create_entries: { parentId: s('parentId'), spec: o('specJson') },
  edit_fields: { itemId: s('itemId'), spec: o('specJson') },
  add_fields: { itemId: s('itemId'), spec: o('specJson') },
  edit_form: { itemId: s('itemId'), spec: o('specJson') },
  set_recurrence: { itemId: s('itemId'), spec: o('specJson') },
  list_templates: { query: s('query') },
  read_template: { templateId: s('itemId') },
  apply_template: {
    templateId: s('itemId'),
    title: s('title'),
    parentId: s('parentId'),
    spec: o('specJson'),
  },
  build_blueprint: { blueprint: o('specJson'), parentId: s('parentId') },
  save_as_template: { itemId: s('itemId'), title: s('title'), spec: o('specJson') },
  read_calendar: { from: f('specJson'), to: f('specJson') },
  complete_task: { itemId: s('itemId'), completed: f('specJson') },
  find_action: { query: s('query') },
  run_action: {
    actionId: s('query'),
    path: f('specJson'),
    params: f('specJson'),
    body: f('specJson'),
  },
};

export const TOOL_ARG_OPERATIONS: readonly string[] = Object.keys(TOOL_ARG_SPECS);
export const toolArgParams = (operation: string): string[] =>
  Object.keys(TOOL_ARG_SPECS[operation] ?? {});

const FLAT_STRING_FIELDS = [
  'itemId',
  'parentId',
  'title',
  'markdown',
  'query',
  'propertiesJson',
  'specJson',
] as const;
type FlatField = (typeof FLAT_STRING_FIELDS)[number];

export interface Flattened {
  flat: string;
  reason: '';
}
export interface Refused {
  flat: undefined;
  reason: string;
}

/**
 * Translates one typed nix_<operation> call's native-JSON arguments into the flat
 * {operation, itemId, parentId, title, markdown, query, propertiesJson, specJson} string
 * `ToolCall.arguments` stores. A malformed call returns a model-readable reason naming the
 * offending key and tool.
 */
export function flattenToolCall(tool: string, raw: unknown): Flattened | Refused {
  const operation = operationFromToolName(tool);
  const spec = TOOL_ARG_SPECS[operation];
  if (spec === undefined) return { flat: undefined, reason: `${tool} is not a supported tool.` };
  if (!isRecord(raw)) {
    return { flat: undefined, reason: `${tool} requires a JSON object of arguments.` };
  }
  const flat: Record<FlatField, string> = {
    itemId: '',
    parentId: '',
    title: '',
    markdown: '',
    query: '',
    propertiesJson: '',
    specJson: '',
  };
  const specFields: Record<string, unknown> = {};
  for (const [key, original] of Object.entries(raw)) {
    const mapping = Object.hasOwn(spec, key) ? spec[key] : undefined;
    if (mapping === undefined) {
      const accepted = Object.keys(spec).sort().join(', ');
      return {
        flat: undefined,
        reason: `${JSON.stringify(key)} is not a parameter of ${tool}; it accepts ${accepted}.`,
      };
    }
    switch (mapping.kind) {
      case 'string': {
        if (original !== null && typeof original !== 'string') {
          return { flat: undefined, reason: `${tool}.${key} must be a string.` };
        }
        flat[mapping.flat as FlatField] = original ?? '';
        break;
      }
      case 'objectJson': {
        // Some providers encode an object parameter as JSON text; normalise it first.
        let value: unknown = original;
        if (typeof original === 'string' || original === null) {
          try {
            value = JSON.parse(original ?? '') as unknown;
          } catch {
            return { flat: undefined, reason: `${tool}.${key} must be a JSON object.` };
          }
        }
        if (!isRecord(value)) {
          return { flat: undefined, reason: `${tool}.${key} must be a JSON object.` };
        }
        flat[mapping.flat as FlatField] = goJson(value);
        break;
      }
      case 'specField': {
        if (typeof original === 'string' || typeof original === 'boolean' || isRecord(original)) {
          specFields[key] = original;
        } else {
          return {
            flat: undefined,
            reason: `${tool}.${key} must be a string, a boolean or an object.`,
          };
        }
        break;
      }
    }
  }
  if (Object.keys(specFields).length > 0) flat.specJson = goJson(specFields);
  return { flat: goJson({ operation, ...flat }, false), reason: '' };
}

/** Which of flattenToolCall's fixed refusal templates reason came from, so logs never quote a key. */
export function argumentRefusalCode(reason: string): string {
  if (reason.includes(' is not a parameter of ')) return 'unknown_parameter';
  if (reason.endsWith(' must be a string.')) return 'not_string';
  if (reason.endsWith(' must be a JSON object.')) return 'not_object';
  if (reason.endsWith(' requires a JSON object of arguments.')) return 'arguments_not_object';
  if (reason.endsWith(' is not a supported tool.')) return 'unsupported_tool';
  if (reason.endsWith(' could not be processed.')) return 'unprocessable';
  return 'other';
}

export function toolOperation(flat: string): string {
  const parsed = parseObject(flat);
  return typeof parsed?.operation === 'string' ? parsed.operation : '';
}

const READ_ONLY = new Set([
  'list_items',
  'search',
  'read_item',
  'read_note',
  'search_note',
  'read_structure',
  'read_view',
  'list_templates',
  'read_template',
  'read_calendar',
  'remember',
  'find_action',
]);

/** A read-only operation never needs an approval card. */
export const isReadOnlyOperation = (operation: string): boolean => READ_ONLY.has(operation);

function canonicalField(args: Record<string, unknown>, field: string): void {
  const value = args[field];
  if (typeof value === 'string' && value !== '') {
    const object = parseObject(value);
    if (object !== undefined) args[field] = goJson(object);
  }
}

/**
 * Identity is scoped to one user turn and includes every argument; canonical JSON handles
 * reordered keys without treating a changed target or payload as approved. Empty fingerprint when
 * raw is not a JSON object.
 */
export function toolIdentity(raw: string): { fingerprint: string; readOnly: boolean } {
  const args = parseObject(raw);
  if (args === undefined) return { fingerprint: '', readOnly: false };
  const operation = typeof args.operation === 'string' ? args.operation : '';
  canonicalField(args, 'propertiesJson');
  canonicalField(args, 'specJson');
  if (operation === 'read_view') canonicalField(args, 'query');
  return { fingerprint: goJson(args), readOnly: READ_ONLY.has(operation) };
}

const FLAT_KEYS = ['operation', 'workspaceId', ...FLAT_STRING_FIELDS];
export const CALENDAR_MAX_DAYS = 31;

/** itemId is called templateId by the two template operations. */
function modelParamForItemId(operation: string): string {
  return operation === 'read_template' || operation === 'apply_template' ? 'templateId' : 'itemId';
}

function parseDay(value: unknown): number | undefined {
  if (typeof value !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(value)) return undefined;
  const ms = Date.parse(`${value}T00:00:00Z`);
  return Number.isNaN(ms) || new Date(ms).toISOString().slice(0, 10) !== value ? undefined : ms;
}

const NEEDS_ITEM = new Set([
  'read_item',
  'read_note',
  'read_structure',
  'append_note',
  'rename_item',
  'move_item',
  'set_properties',
  'trash_item',
  'restore_item',
  'read_template',
]);
const SPEC_ITEM_OPS = new Set(['add_view', 'update_view', 'add_fields', 'edit_fields']);

/** The empty string when the flat arguments are acceptable, else a model-readable refusal. */
export function validateToolArguments(raw: string): string {
  const object = parseObject(raw);
  if (object === undefined) return 'Tool arguments must be a JSON object with string fields.';
  const p: Record<string, string> = {};
  for (const [key, value] of Object.entries(object)) {
    if (!FLAT_KEYS.includes(key) || (value !== null && typeof value !== 'string')) {
      return 'Tool arguments must be a JSON object with string fields.';
    }
    p[key] = value ?? '';
  }
  const operation = p.operation ?? '';
  const itemId = p.itemId ?? '';
  const parentId = p.parentId ?? '';
  const title = p.title ?? '';
  const markdown = p.markdown ?? '';
  const query = p.query ?? '';
  const properties = p.propertiesJson ?? '';
  const spec = p.specJson ?? '';
  const itemParam = modelParamForItemId(operation);
  const needsItem = (name = operation): string =>
    `nix_${name} requires the exact ${itemParam} UUID. Discover it with nix_list_items or nix_search if it is not already known.`;
  const specRequired = (name = operation): string => `nix_${name} requires spec (a JSON object).`;

  if (operation === 'replace_passage' && byteLen(query) > 240) {
    return 'nix_replace_passage find is limited to 240 characters. Use a shorter passage that occurs once, or nix_replace_section.';
  }
  if (
    byteLen(title) > 240 ||
    byteLen(markdown) > 16000 ||
    byteLen(query) > 240 ||
    byteLen(properties) > 8000
  ) {
    return 'Tool arguments exceed the supported size limit.';
  }
  if (byteLen(spec) > 24000) return 'The design is too large. Use fewer items and fields.';
  if (spec !== '' && markdown !== '') return 'Put markdown inside spec entries, not alongside it.';
  if (spec !== '' && jsonDepth(spec) > 24)
    return 'The design is too large. Use fewer items and fields.';
  if (parentId !== '' && !UUID.test(parentId)) {
    return 'parentId must be a Nix item UUID or empty for the workspace root.';
  }
  if (itemId !== '' && !UUID.test(itemId)) return `${itemParam} must be a Nix item UUID.`;

  switch (operation) {
    case 'remember': {
      const fact = markdown.trim();
      if (fact === '' || fact.length > 280)
        return 'nix_remember needs one fact of at most 280 characters.';
      // The owner reviews memories in Settings; text they cannot see there must not reach the model.
      for (const ch of markdown) {
        if (ch === ' ') continue;
        if (
          /[\p{Cc}\p{Cf}\p{Co}\p{Cs}\p{Zl}\p{Zp}]/u.test(ch) ||
          (!/[\p{L}\p{M}\p{N}\p{P}\p{S}\p{Zs}]/u.test(ch) && !/\s/.test(ch))
        ) {
          return 'nix_remember takes visible text only.';
        }
      }
      return '';
    }
    case 'list_items':
    case 'list_templates':
      return '';
    case 'search':
      return query.trim() === '' ? 'nix_search requires a nonempty query.' : '';
    case 'create_note':
      return title.trim() === '' ? 'nix_create_note requires a title.' : '';
    case 'search_note':
      if (!UUID.test(itemId)) {
        return 'nix_search_note requires the exact itemId UUID. Discover it with nix_list_items or nix_search if it is not already known.';
      }
      return query.trim() === '' ? 'nix_search_note requires a nonempty query.' : '';
    case 'read_view':
      if (!UUID.test(itemId)) return 'nix_read_view requires the exact itemId UUID.';
      return isJsonObject(query)
        ? ''
        : 'nix_read_view requires query with an exact viewId and optional pageSize (1 to 25).';
    case 'replace_section':
    case 'replace_passage':
      if (!UUID.test(itemId)) return needsItem();
      if (operation === 'replace_section') {
        if (query.trim() === '')
          return 'nix_replace_section requires the heading of the section to replace.';
        if (markdown.trim() === '')
          return 'nix_replace_section requires nonempty markdown; it never empties a section.';
      } else if (query === '') return 'nix_replace_passage requires the exact text to find.';
      return '';
    case 'create_structured':
      if (title.trim() === '') return 'nix_create_structured requires a title.';
      return isJsonObject(spec) ? '' : 'nix_create_structured requires spec (a JSON object).';
    case 'create_entries':
      if (!UUID.test(parentId)) {
        return 'nix_create_entries requires the exact parentId UUID. Discover it with nix_list_items or nix_search if it is not already known.';
      }
      return isJsonObject(spec) ? '' : specRequired();
    case 'edit_form':
    case 'set_recurrence':
      if (!UUID.test(itemId)) return needsItem();
      return isJsonObject(spec) ? '' : specRequired();
    case 'apply_template':
      if (!UUID.test(itemId)) return needsItem();
      if (title.trim() === '') return 'nix_apply_template requires a title.';
      return spec !== '' && !isJsonObject(spec)
        ? 'nix_apply_template requires spec (a JSON object) when supplied.'
        : '';
    case 'build_blueprint':
      return isJsonObject(spec) ? '' : 'nix_build_blueprint requires blueprint (a JSON object).';
    case 'save_as_template':
      if (!UUID.test(itemId)) return needsItem();
      return title.trim() === '' ? 'nix_save_as_template requires a title.' : '';
    case 'read_calendar': {
      const window = parseObject(spec);
      const from = parseDay(window?.from);
      const to = parseDay(window?.to);
      if (from === undefined || to === undefined)
        return 'nix_read_calendar requires from and to as yyyy-MM-dd days.';
      if (to < from) return 'nix_read_calendar requires from on or before to.';
      if (to - from > (CALENDAR_MAX_DAYS - 1) * 24 * 3600 * 1000) {
        return `nix_read_calendar reads at most ${String(CALENDAR_MAX_DAYS)} days at a time. Split the range.`;
      }
      return '';
    }
    case 'find_action':
      return query.trim() === '' ? 'nix_find_action requires a nonempty query.' : '';
    case 'run_action':
      if (query.trim() === '')
        return 'nix_run_action requires actionId, an id from nix_find_action.';
      return spec !== '' && !isJsonObject(spec)
        ? 'nix_run_action path, params and body must be JSON objects.'
        : '';
    case 'complete_task': {
      if (!UUID.test(itemId)) {
        return 'nix_complete_task requires the exact itemId UUID. Discover it with nix_list_items or nix_search if it is not already known.';
      }
      const task = parseObject(spec);
      return typeof task?.completed === 'boolean'
        ? ''
        : 'nix_complete_task requires completed (true or false).';
    }
    default:
      break;
  }
  if (NEEDS_ITEM.has(operation) || SPEC_ITEM_OPS.has(operation)) {
    if (!UUID.test(itemId)) return needsItem();
    if (operation === 'rename_item' && title.trim() === '')
      return 'nix_rename_item requires a title.';
    if (operation === 'append_note' && markdown.trim() === '')
      return 'nix_append_note requires nonempty markdown.';
    if (operation === 'set_properties' && parseObject(properties) === undefined) {
      return 'nix_set_properties requires properties (a JSON object).';
    }
    if (SPEC_ITEM_OPS.has(operation) && !isJsonObject(spec)) return specRequired();
    return '';
  }
  return 'Unsupported workspace operation.';
}
