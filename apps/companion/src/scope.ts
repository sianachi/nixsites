import { toolSchema, workspaceTools, type DynamicTool } from './catalog.ts';
import { flattenToolCall, isReadOnlyOperation, toolIdentity, toolOperation } from './flatten.ts';
import type { Request } from './types.ts';
import { goJson, isRecord, parseObject, UUID } from './util.ts';

const CONVERSATION_READS = new Set([
  'list_items',
  'search',
  'read_item',
  'read_note',
  'search_note',
  'read_structure',
  'read_view',
]);
export const conversationReadOperation = (op: string): boolean => CONVERSATION_READS.has(op);

const NOTE_SCOPED = new Set([
  'list_items',
  'search',
  'read_item',
  'read_note',
  'search_note',
  'read_structure',
  'create_note',
  'append_note',
  'replace_section',
  'replace_passage',
  'rename_item',
  'move_item',
  'set_properties',
  'trash_item',
  'create_structured',
  'add_view',
  'update_view',
  'create_entries',
  'add_fields',
  'edit_fields',
  'edit_form',
  'set_recurrence',
]);

/** What scope refusal reads of a conversation. */
export interface ScopeState {
  conversationItemId: string;
  sourceWorkspaceIds: string[];
  rootItemId: string;
  readOnly: boolean;
}

/** A saved cross-workspace conversation offers only the read tools, each with a workspaceId. */
export function conversationTools(tools: DynamicTool[]): DynamicTool[] {
  const result: DynamicTool[] = [];
  for (const tool of tools) {
    if (!conversationReadOperation(tool.name.replace(/^nix_/, ''))) continue;
    const { properties, required } = toolSchema(tool);
    properties.workspaceId = {
      type: 'string',
      description: 'A sourceWorkspaceIds UUID; Core rechecks access.',
    };
    tool.inputSchema.required = [...required, 'workspaceId'];
    result.push(tool);
  }
  return result;
}

export function flattenConversationToolCall(
  state: ScopeState,
  tool: string,
  raw: unknown,
): { flat: string; reason: '' } | { flat: undefined; reason: string } {
  if (state.conversationItemId === '') return flattenToolCall(tool, raw);
  if (!isRecord(raw)) return { flat: undefined, reason: 'Tool arguments must be an object.' };
  const { workspaceId, ...rest } = raw;
  if (typeof workspaceId !== 'string' || !UUID.test(workspaceId)) {
    return { flat: undefined, reason: 'workspaceId must be a selected source UUID.' };
  }
  const flattened = flattenToolCall(tool, rest);
  if (flattened.flat === undefined) return { flat: undefined, reason: flattened.reason };
  const result = parseObject(flattened.flat) ?? {};
  result.workspaceId = workspaceId;
  return { flat: goJson(result), reason: '' };
}

export function conversationToolRefusal(state: ScopeState, flat: string): string {
  if (state.conversationItemId === '') return '';
  const args = parseObject(flat);
  const operation = typeof args?.operation === 'string' ? args.operation : '';
  if (!conversationReadOperation(operation))
    return 'Saved conversations allow read-only analysis. No change ran.';
  const workspaceId = typeof args?.workspaceId === 'string' ? args.workspaceId : '';
  if (!state.sourceWorkspaceIds.includes(workspaceId))
    return 'This workspace is outside the selected sources. No action ran.';
  return '';
}

export function noteScopeToolRefusal(state: ScopeState, flat: string): string {
  if (state.rootItemId === '') return '';
  const operation = toolOperation(flat);
  if (!NOTE_SCOPED.has(operation))
    return 'This operation cannot be limited to this note and its children. No action ran.';
  if (state.readOnly && !toolIdentity(flat).readOnly) {
    return 'This note conversation is read-only. No change ran. Ask the owner to enable approved edits before proposing changes.';
  }
  return '';
}

/** The tools thread/start offers for this request's scope. */
export function workspaceToolsForRequest(r: Request): DynamicTool[] {
  const tools = workspaceTools();
  if (r.conversationItemId !== '') return conversationTools(tools);
  if (r.rootItemId === '') return tools;
  const state = {
    conversationItemId: '',
    sourceWorkspaceIds: [],
    rootItemId: r.rootItemId,
    readOnly: r.readOnly,
  };
  return tools.filter(
    (tool) =>
      noteScopeToolRefusal(state, `{"operation":"${tool.name.replace(/^nix_/, '')}"}`) === '',
  );
}

export { isReadOnlyOperation };
