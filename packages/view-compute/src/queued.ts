import type { MirrorItem } from '@nix/sync-core/mirror';

import type { ViewSource } from './types';

/**
 * A habit check-in or recurrence completion a device has queued but Core has not yet applied
 * (the outbox's "request" operation). Reading through `withQueuedRequests` shows these writes in
 * the recalculated views the way Core will once they replay.
 */
export interface QueuedRequest {
  readonly operationId: string;
  readonly itemId: string;
  readonly method: string;
  readonly path: string;
  readonly body?: unknown;
}

const CHECK_IN = /^\/api\/v1\/items\/([0-9a-fA-F-]{36})\/habit\/check-ins\/(\d{4}-\d{2}-\d{2})$/;
const COMPLETION = /^\/api\/v1\/items\/([0-9a-fA-F-]{36})\/recurrence\/completions$/;
const DAY = /^\d{4}-\d{2}-\d{2}$/;
const record = (value: unknown): Record<string, unknown> =>
  typeof value === 'object' && value !== null ? (value as Record<string, unknown>) : {};

const checkInDay = (item: MirrorItem): unknown => item.properties.$habit_check_in_date;

/** The item's rule with the days queued as completed marked, as Core's completion leaves it. */
function withCompletions(item: MirrorItem, ops: readonly QueuedRequest[]): MirrorItem {
  if (item.recurrence === null) return item;
  const days = new Set<string>();
  for (const op of ops) {
    const day = record(op.body).occurredOn;
    if (
      op.itemId === item.id &&
      op.method === 'POST' &&
      COMPLETION.test(op.path) &&
      typeof day === 'string' &&
      DAY.test(day)
    )
      days.add(day);
  }
  if (days.size === 0) return item;
  const through = item.recurrence.completedThrough;
  const kept = Array.isArray(item.recurrence.completed)
    ? (item.recurrence.completed as unknown[]).filter(
        (day): day is string => typeof day === 'string',
      )
    : [];
  const completed = [...new Set([...kept, ...days])]
    .filter((day) => typeof through !== 'string' || day > through)
    .sort();
  return { ...item, recurrence: { ...item.recurrence, completed } };
}

/** A habit's check-in children with the queued sets and undos applied, in Core's order. */
function withCheckIns(
  parent: MirrorItem,
  children: readonly MirrorItem[],
  ops: readonly QueuedRequest[],
): MirrorItem[] {
  let rows = [...children];
  for (const op of ops) {
    const match = CHECK_IN.exec(op.path);
    if (op.itemId !== parent.id || match?.[2] === undefined) continue;
    const day = match[2];
    if (op.method === 'DELETE') {
      rows = rows.filter((row) => checkInDay(row) !== day);
      continue;
    }
    if (op.method !== 'PUT') continue;
    const body = record(op.body);
    const properties = {
      $habit_check_in_date: day,
      $habit_check_in_completed: body.completed === true,
      $habit_check_in_quantity: typeof body.quantity === 'number' ? body.quantity : null,
    };
    const existing = rows.find((row) => checkInDay(row) === day);
    if (existing !== undefined)
      rows = rows.map((row) =>
        row === existing ? { ...row, properties: { ...row.properties, ...properties } } : row,
      );
    else
      rows.push({
        ...parent,
        id: op.operationId,
        parentId: parent.id,
        type: 'note',
        title: `Check-in · ${day}`,
        seq: Math.max(0, ...rows.map((row) => Number(row.seq))) + 1000,
        revision: '0',
        properties: { title: `Check-in · ${day}`, ...properties },
        computedProperties: null,
        schema: null,
        views: null,
        recurrence: null,
        settings: null,
        noDelete: false,
        noChildren: false,
        managedBy: null,
        bodyDocId: null,
        bodyHeadSeq: null,
        file: null,
      });
  }
  return rows;
}

export function withQueuedRequests(
  source: ViewSource,
  queued: (workspaceId: string) => Promise<readonly QueuedRequest[]>,
): ViewSource {
  const habitParents = (ops: readonly QueuedRequest[]): Set<string> =>
    new Set(ops.filter((op) => CHECK_IN.test(op.path)).map((op) => op.itemId));
  const children = source.children?.bind(source);
  return {
    ...source,
    item: async (id) => {
      const found = await source.item(id);
      return found === undefined
        ? undefined
        : withCompletions(found, await queued(found.workspaceId));
    },
    workspaceItems: async (workspaceId) => {
      const all = await source.workspaceItems(workspaceId);
      const ops = await queued(workspaceId);
      if (ops.length === 0) return all;
      let items = all.map((item) => withCompletions(item, ops));
      for (const parentId of habitParents(ops)) {
        const parent = items.find((item) => item.id === parentId);
        if (parent === undefined) continue;
        const rows = withCheckIns(
          parent,
          items.filter((item) => item.parentId === parentId),
          ops,
        );
        const at = items.findIndex((item) => item.parentId === parentId);
        const rest = items.filter((item) => item.parentId !== parentId);
        items = [
          ...rest.slice(0, at < 0 ? rest.length : at),
          ...rows,
          ...rest.slice(at < 0 ? rest.length : at),
        ];
      }
      return items;
    },
    ...(children === undefined
      ? {}
      : {
          children: async (workspaceId: string, parentId: string) => {
            const rows = await children(workspaceId, parentId);
            const ops = await queued(workspaceId);
            if (ops.length === 0) return rows;
            const marked = rows.map((row) => withCompletions(row, ops));
            const parent = habitParents(ops).has(parentId)
              ? await source.item(parentId)
              : undefined;
            return parent === undefined ? marked : withCheckIns(parent, marked, ops);
          },
        }),
  };
}
