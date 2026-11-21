import type { PlanViewWrite } from '../mirror-writes';

const STRUCTURE = /^\/api\/v1\/items\/([0-9a-fA-F-]{36})\/(protection|views|schema)$/;
const record = (value: unknown): Record<string, unknown> =>
  typeof value === 'object' && value !== null && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : {};
const flag = (value: unknown): boolean =>
  value === undefined || value === null || typeof value === 'boolean';

/**
 * Offline protection, views and schema edits, queued as the request itself with what this device
 * last saw, so Core refuses one that would undo a change made meanwhile (a conflict, never a silent
 * overwrite). Everything else about them (pet protection, view setups, structured create) stays
 * online-only.
 */
export const planStructureWrite: PlanViewWrite = async (store, method, path, body) => {
  const match = STRUCTURE.exec(path);
  const itemId = match?.[1];
  const part = match?.[2];
  if (itemId === undefined || part === undefined || method !== 'PUT') return null;
  const item = (await store.readItems([itemId]))[0];
  if (
    item?.id !== itemId ||
    item.revision === '0' ||
    item.lifecycleState !== 'active' ||
    item.locked ||
    !item.canWrite
  )
    return null;
  const sent = record(body);
  const operationId = crypto.randomUUID();
  const plan = (planned: unknown, reread: string) =>
    ({
      kind: 'request',
      operationId,
      itemId,
      method: 'PUT',
      path,
      body: planned,
      answer: { reread },
    }) as const;

  if (part === 'protection') {
    // Pet protection and collaboration are other routes and fields; the item's managed protection is Core's.
    if (
      (typeof sent.noDelete !== 'boolean' && typeof sent.noChildren !== 'boolean') ||
      !flag(sent.noDelete) ||
      !flag(sent.noChildren) ||
      Object.keys(sent).some((key) => key !== 'noDelete' && key !== 'noChildren') ||
      (typeof sent.noDelete === 'boolean' && item.managedBy !== null)
    )
      return null;
    return plan(
      { ...sent, base: { noDelete: item.noDelete, noChildren: item.noChildren } },
      `/api/v1/items/${itemId}`,
    );
  }
  if (part === 'views') {
    // The version is what the person saw; with none (already edited, or an older Core) it needs a connection.
    if (
      !Array.isArray(sent.views) ||
      typeof sent.expectedVersion !== 'string' ||
      sent.expectedVersion === '' ||
      typeof item.viewsVersion !== 'string'
    )
      return null;
    return plan(sent, `/api/v1/items/${itemId}/views`);
  }
  if (!Array.isArray(sent.properties) || typeof sent.inherit !== 'boolean') return null;
  const stored = record(item.schema);
  return plan(
    {
      properties: sent.properties,
      inherit: sent.inherit,
      base: {
        properties: Array.isArray(stored.properties) ? stored.properties : [],
        inherit: stored.inherit !== false,
      },
    },
    `/api/v1/items/${itemId}/schema`,
  );
};
