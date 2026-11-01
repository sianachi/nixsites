/**
 * Which of Core's write routes the replay endpoint can carry (create, rename, move, trash,
 * property edits), read off a request. Anything else is not here and stays "needs a connection".
 */
export type PlannedWrite =
  | {
      readonly kind: 'create';
      readonly workspaceId: string;
      readonly type: string;
      readonly title: string;
      readonly parentId: string | null;
      readonly properties: Readonly<Record<string, unknown>> | undefined;
      readonly key: string | undefined;
    }
  | { readonly kind: 'rename'; readonly itemId: string; readonly title: string }
  | {
      readonly kind: 'move';
      readonly itemId: string;
      readonly parentId: string | null;
      readonly afterId: string | null;
    }
  | { readonly kind: 'archive'; readonly itemId: string }
  | {
      readonly kind: 'properties';
      readonly itemId: string;
      readonly changes: Readonly<Record<string, unknown>>;
    };

const UUID = '[0-9a-fA-F-]{36}';
const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === 'object' && value !== null && !Array.isArray(value);
const uuidOrNull = (value: unknown): string | null | undefined =>
  value === null || value === undefined
    ? null
    : typeof value === 'string' && new RegExp(`^${UUID}$`).test(value)
      ? value
      : undefined;

/** Null when the request is not a write the replay endpoint supports (or is malformed). */
export function planWrite(method: string, path: string, body: unknown): PlannedWrite | null {
  const record = isRecord(body) ? body : {};
  const create = new RegExp(`^/api/v1/workspaces/(${UUID})/items$`).exec(path);
  if (method === 'POST' && create?.[1] !== undefined) {
    const parentId = uuidOrNull(record.parentId);
    const key = record.idempotencyKey;
    if (
      typeof record.type !== 'string' ||
      typeof record.title !== 'string' ||
      parentId === undefined ||
      (key !== undefined && typeof uuidOrNull(key) !== 'string')
    )
      return null;
    return {
      kind: 'create',
      workspaceId: create[1],
      type: record.type,
      title: record.title,
      parentId,
      properties: isRecord(record.properties) ? record.properties : undefined,
      key: typeof key === 'string' ? key : undefined,
    };
  }
  const item = new RegExp(`^/api/v1/items/(${UUID})(/move|/properties)?$`).exec(path);
  const itemId = item?.[1];
  if (itemId === undefined) return null;
  const part = item?.[2];
  if (part === undefined && method === 'DELETE') return { kind: 'archive', itemId };
  if (part === undefined && method === 'PATCH')
    return typeof record.title === 'string' && Object.keys(record).length === 1
      ? { kind: 'rename', itemId, title: record.title }
      : null;
  if (part === '/properties' && method === 'PATCH')
    return isRecord(record.properties)
      ? { kind: 'properties', itemId, changes: record.properties }
      : null;
  if (part === '/move' && method === 'POST') {
    const parentId = uuidOrNull(record.parentId);
    const afterId = uuidOrNull(record.afterId);
    // A move into another workspace changes ownership, which a replay does not do.
    if (parentId === undefined || afterId === undefined || record.workspaceId !== undefined)
      return null;
    return { kind: 'move', itemId, parentId, afterId };
  }
  return null;
}
