import type { PlanViewWrite } from '../mirror-writes';

const COMPLETION = /^\/api\/v1\/items\/([0-9a-fA-F-]{36})\/recurrence\/completions$/;

/**
 * Offline completion of one occurrence of a repeating item, queued as the request itself: it
 * rewrites the item's `recurrence` rule, which no plain item write carries. Setting or clearing
 * the rule stays online-only. Whether the day is one the series lands on, and whether the item
 * has a due date to anchor it, is Core's to judge on replay (a refusal shows as a conflict).
 */
export const planRecurrenceWrite: PlanViewWrite = async (store, method, path, body) => {
  const itemId = COMPLETION.exec(path)?.[1];
  const day =
    typeof body === 'object' && body !== null
      ? (body as { occurredOn?: unknown }).occurredOn
      : null;
  if (
    itemId === undefined ||
    method !== 'POST' ||
    typeof day !== 'string' ||
    !/^\d{4}-\d{2}-\d{2}$/.test(day)
  )
    return null;
  const item = (await store.readItems([itemId]))[0];
  const rule = item?.recurrence;
  if (
    item?.id !== itemId ||
    !rule ||
    item.revision === '0' ||
    item.lifecycleState !== 'active' ||
    item.locked ||
    !item.canWrite
  )
    return null;
  const through = typeof rule.completedThrough === 'string' ? rule.completedThrough : null;
  const kept = Array.isArray(rule.completed) ? (rule.completed as string[]) : [];
  const completed = [...new Set([...kept, day])]
    .filter((d) => through === null || d > through)
    .sort();
  return {
    kind: 'request',
    operationId: crypto.randomUUID(),
    itemId,
    method,
    path,
    body: { occurredOn: day },
    answer: {
      status: 200,
      body: {
        rule: {
          freq: rule.freq,
          interval: rule.interval,
          weekdays: rule.weekdays ?? [],
          until: rule.until ?? null,
          completedThrough: through,
          completed,
        },
        occurredOn: day,
      },
    },
  };
};
