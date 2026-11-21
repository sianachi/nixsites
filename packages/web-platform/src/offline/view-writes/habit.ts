import type { PlanViewWrite } from '../mirror-writes';

const CHECK_IN = /^\/api\/v1\/items\/([0-9a-fA-F-]{36})\/habit\/check-ins\/(\d{4}-\d{2}-\d{2})$/;
const MAXIMUM_QUANTITY = 1_000_000;
const record = (value: unknown): Record<string, unknown> =>
  typeof value === 'object' && value !== null ? (value as Record<string, unknown>) : {};

/**
 * Offline habit check-ins (set and undo a day), queued as the request itself. Core's habit handler
 * is the only writer of the reserved `$habit_` keys, so a plain item write cannot carry them.
 * Settings and status changes rewrite the habit's versioned history and stay online-only.
 *
 * What Core would refuse is refused here where the copy can tell (not configured, paused, a day
 * that is not scheduled or is in the future); anything it cannot tell is refused on replay and
 * shown as a conflict.
 */
export const planHabitWrite: PlanViewWrite = async (store, method, path, body, read) => {
  const match = CHECK_IN.exec(path);
  const itemId = match?.[1];
  const day = match?.[2];
  if (itemId === undefined || day === undefined || (method !== 'PUT' && method !== 'DELETE'))
    return null;
  const item = (await store.readItems([itemId]))[0];
  // An item still waiting to be created has no server id to name in the request.
  if (
    item?.id !== itemId ||
    item.revision === '0' ||
    item.lifecycleState !== 'active' ||
    item.locked ||
    !item.canWrite
  )
    return null;
  const operationId = crypto.randomUUID();
  if (method === 'DELETE')
    return {
      kind: 'request',
      operationId,
      itemId,
      method,
      path,
      answer: { status: 204, body: null },
    };

  const sent = record(body);
  const quantity = sent.quantity ?? null;
  if (
    typeof sent.completed !== 'boolean' ||
    (quantity !== null &&
      (typeof quantity !== 'number' || !(quantity >= 0 && quantity <= MAXIMUM_QUANTITY)))
  )
    return null;
  const view = record(await read(`/api/v1/items/${itemId}/habit?from=${day}&to=${day}`));
  const occurrence = record((Array.isArray(view.occurrences) ? view.occurrences : [])[0]);
  const zone = view.timezone;
  if (
    view.status !== 'active' ||
    occurrence.scheduled !== true ||
    typeof occurrence.target !== 'number' ||
    typeof zone !== 'string' ||
    day > new Date().toLocaleDateString('en-CA', { timeZone: zone })
  )
    return null;
  // Core derives it: a quantity at or above the target is a completed day, whatever was sent.
  const completed = quantity === null ? sent.completed : quantity >= occurrence.target;
  return {
    kind: 'request',
    operationId,
    itemId,
    method,
    path,
    body: { completed, quantity },
    answer: {
      status: 200,
      body: { id: operationId, occurredOn: day, completed, quantity },
    },
  };
};
