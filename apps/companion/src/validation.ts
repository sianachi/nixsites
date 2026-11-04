import {
  emptyRequest,
  type Message,
  type Request,
  type SharedItem,
  type WorkspaceMapEntry,
} from './types.ts';
import { byteLen, isRecord, UUID } from './util.ts';

type Kind = 'string' | 'boolean' | 'int' | 'strings' | 'messages' | 'map' | 'items';

const FIELDS: Readonly<Record<keyof Request, Kind>> = {
  tenantId: 'string',
  principalId: 'string',
  workspaceId: 'string',
  petId: 'string',
  operation: 'string',
  provider: 'string',
  apiKey: 'string',
  requestId: 'string',
  text: 'string',
  instructions: 'string',
  itemId: 'string',
  itemTitle: 'string',
  sharedText: 'string',
  model: 'string',
  mode: 'string',
  workspaceAccess: 'boolean',
  rootItemId: 'string',
  conversationItemId: 'string',
  sourceWorkspaceIds: 'strings',
  earlierMessages: 'messages',
  readOnly: 'boolean',
  toolId: 'string',
  toolResult: 'string',
  toolSuccess: 'boolean',
  toolLockedContent: 'boolean',
  toolImage: 'string',
  historyId: 'string',
  inlineKind: 'string',
  contextText: 'string',
  language: 'string',
  after: 'int',
  today: 'string',
  timeZone: 'string',
  workspaceMap: 'map',
  items: 'items',
  replaceFromMessageId: 'string',
};

/** Decodes an object whose every key is in `keys` and whose values pass `check`; null otherwise. */
function strictObject(value: unknown, keys: readonly string[]): Record<string, unknown> | null {
  if (!isRecord(value)) return null;
  return Object.keys(value).every((key) => keys.includes(key)) ? value : null;
}

function text(value: unknown): string | null {
  return value === undefined || value === null ? '' : typeof value === 'string' ? value : null;
}

function list<T>(value: unknown, item: (entry: unknown) => T | null): T[] | null {
  if (value === undefined || value === null) return [];
  if (!Array.isArray(value)) return null;
  const result: T[] = [];
  for (const entry of value) {
    const decoded = item(entry);
    if (decoded === null) return null;
    result.push(decoded);
  }
  return result;
}

function message(entry: unknown): Message | null {
  const o = strictObject(entry, ['id', 'role', 'text']);
  const id = text(o?.id);
  const role = text(o?.role);
  const body = text(o?.text);
  return o && id !== null && role !== null && body !== null ? { id, role, text: body } : null;
}

function sharedItem(entry: unknown): SharedItem | null {
  const o = strictObject(entry, ['id', 'title']);
  const id = text(o?.id);
  const title = text(o?.title);
  return o && id !== null && title !== null ? { id, title } : null;
}

function mapEntry(entry: unknown): WorkspaceMapEntry | null {
  const o = strictObject(entry, ['id', 'title', 'type', 'viewKinds']);
  const id = text(o?.id);
  const title = text(o?.title);
  const type = text(o?.type);
  const kinds = list(o?.viewKinds, (k) => (typeof k === 'string' ? k : null));
  return o && id !== null && title !== null && type !== null && kinds !== null
    ? { id, title, type, ...(kinds.length > 0 ? { viewKinds: kinds } : {}) }
    : null;
}

/**
 * Decodes a request body the way Go's decoder with DisallowUnknownFields does: one JSON object,
 * no unknown members (nested ones included), every present member of its declared type.
 */
export function parseRequest(body: string): Request | null {
  let raw: unknown;
  try {
    raw = JSON.parse(body);
  } catch {
    return null;
  }
  if (!isRecord(raw)) return null;
  const request = emptyRequest();
  const target = request as unknown as Record<string, unknown>;
  for (const [key, value] of Object.entries(raw)) {
    // hasOwn: "__proto__" or "constructor" must be unknown keys, not Object.prototype members.
    const kind = Object.hasOwn(FIELDS, key) ? FIELDS[key as keyof Request] : undefined;
    if (kind === undefined) return null;
    if (value === null) continue;
    let decoded: unknown;
    switch (kind) {
      case 'string':
        decoded = text(value);
        break;
      case 'boolean':
        decoded = typeof value === 'boolean' ? value : null;
        break;
      case 'int':
        decoded = typeof value === 'number' && Number.isSafeInteger(value) ? value : null;
        break;
      case 'strings':
        decoded = list(value, (s) => (typeof s === 'string' ? s : null));
        break;
      case 'messages':
        decoded = list(value, message);
        break;
      case 'map':
        decoded = list(value, mapEntry);
        break;
      case 'items':
        decoded = list(value, sharedItem);
        break;
    }
    if (decoded === null) return null;
    target[key] = decoded;
  }
  return request;
}

export const MAX_TOOL_IMAGE_LENGTH = 1_000_000;
const TOOL_IMAGE = /^data:image\/jpeg;base64,[A-Za-z0-9+/]+={0,2}$/;
const TIME_ZONE = /^[A-Za-z0-9_+\-/]{1,64}$/;
const MAX_SHARED_ITEMS = 5;
const MAX_WORKSPACE_MAP_ENTRIES = 40;

/** No picture, or a JPEG data URL with a tool result. */
export function validToolImage(r: Request): boolean {
  return (
    r.toolImage === '' ||
    (r.operation === 'tool_result' &&
      r.toolImage.length <= MAX_TOOL_IMAGE_LENGTH &&
      TOOL_IMAGE.test(r.toolImage))
  );
}

function isDate(value: string): boolean {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(value)) return false;
  const date = new Date(`${value}T00:00:00Z`);
  return !Number.isNaN(date.getTime()) && date.toISOString().startsWith(value);
}

export function validTurnContext(r: Request): boolean {
  if (!validConversationContext(r)) return false;
  if (r.today !== '' && !isDate(r.today)) return false;
  if (r.timeZone !== '' && !TIME_ZONE.test(r.timeZone)) return false;
  if (r.workspaceMap.length > MAX_WORKSPACE_MAP_ENTRIES || r.items.length > MAX_SHARED_ITEMS) {
    return false;
  }
  for (const item of r.items) {
    if (!UUID.test(item.id) || item.title.length > 240) return false;
  }
  if (
    r.replaceFromMessageId !== '' &&
    (r.operation !== 'send' || !UUID.test(r.replaceFromMessageId))
  ) {
    return false;
  }
  for (const entry of r.workspaceMap) {
    const kinds = entry.viewKinds ?? [];
    if (
      !UUID.test(entry.id) ||
      entry.title.length > 240 ||
      entry.type.length > 64 ||
      kinds.length > 12
    ) {
      return false;
    }
    if (kinds.some((kind) => kind.length > 40)) return false;
  }
  return true;
}

export function validConversationContext(r: Request): boolean {
  if (r.conversationItemId === '') {
    return r.sourceWorkspaceIds.length === 0 && r.earlierMessages.length === 0;
  }
  if (!['send', 'read', 'watch', 'interrupt'].includes(r.operation)) return false;
  if (
    !UUID.test(r.conversationItemId) ||
    r.rootItemId !== '' ||
    !r.readOnly ||
    !r.workspaceAccess ||
    r.sourceWorkspaceIds.length === 0 ||
    r.sourceWorkspaceIds.length > 40 ||
    r.earlierMessages.length > 128 ||
    r.replaceFromMessageId !== ''
  ) {
    return false;
  }
  const seen = new Set<string>();
  for (const id of r.sourceWorkspaceIds) {
    if (!UUID.test(id) || seen.has(id)) return false;
    seen.add(id);
  }
  let size = 0;
  for (const m of r.earlierMessages) {
    if (m.id === '' || byteLen(m.id) > 200 || !['user', 'assistant', 'system'].includes(m.role)) {
      return false;
    }
    size += m.text.length;
  }
  return size <= 128000;
}

/** The title rename carries: 1 to 120 UTF-16 units once trimmed, no control characters. */
export function validHistoryOp(r: Request): boolean {
  switch (r.operation) {
    case 'rename': {
      const title = r.text.trim();
      return (
        title !== '' &&
        title.length <= 120 &&
        !/\p{Cc}/u.test(title) &&
        (r.historyId === '' || UUID.test(r.historyId))
      );
    }
    case 'resume_history':
      return UUID.test(r.historyId);
    default:
      return true;
  }
}

const CONTEXT_OPERATIONS = [
  'read',
  'watch',
  'send',
  'interrupt',
  'reset',
  'tool_claim',
  'tool_result',
  'history',
  'read_history',
  'delete_history',
  'rename',
  'resume_history',
];

export function validRequest(r: Request): boolean {
  if (!UUID.test(r.tenantId) || !UUID.test(r.principalId)) return false;
  if (['status', 'connect', 'disconnect', 'models'].includes(r.operation)) return true;
  if (!CONTEXT_OPERATIONS.includes(r.operation)) return false;
  return (
    validHistoryOp(r) &&
    UUID.test(r.workspaceId) &&
    UUID.test(r.petId) &&
    (r.rootItemId === '' || UUID.test(r.rootItemId)) &&
    validTurnContext(r) &&
    r.text.length <= 8000 &&
    r.sharedText.length <= 16000 &&
    r.instructions.length <= 20000 &&
    byteLen(r.model) <= 160 &&
    r.toolResult.length <= 32000 &&
    validToolImage(r) &&
    byteLen(r.toolId) <= 200 &&
    (r.mode === '' || r.mode === 'chat' || r.mode === 'consult') &&
    (r.operation !== 'send' || (UUID.test(r.requestId) && r.text.trim() !== '')) &&
    (!r.operation.startsWith('tool_') || (UUID.test(r.requestId) && r.toolId !== ''))
  );
}
