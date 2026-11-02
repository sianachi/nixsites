/**
 * The match, order, group and fold of `QuerySql`, over the synced copy. Reads only what the mirror
 * holds: the server already withheld what the caller may not read, and hidden or trashed ancestors
 * are dropped here the way `NoHiddenAncestor` and `ItemIsNotUnderClosedLock` drop them.
 */

import type { MirrorItem } from '@nix/sync-core/mirror';

import { type Order, type Rule, isGroup, resolveDay } from './rules';
import {
  type Stamp,
  Unanswerable,
  addDaysClamped,
  collate,
  compareStamps,
  containsText,
  jsonType,
  left10,
  formatDay,
  parseFiniteNumber,
  parseStamp,
  startOfDayIn,
  storedNumber,
  textOf,
} from './text';

export interface Row {
  readonly item: MirrorItem;
  readonly props: Record<string, unknown>;
  readonly created: Stamp;
  /** Undefined for a locked item: the server withholds `last_modified_at` with the lock. */
  readonly modified: Stamp | undefined;
}

export interface Spec {
  readonly rules: readonly Rule[];
  readonly order: Order;
  readonly today: number;
  readonly excludedItemId?: string;
  readonly scope?: { readonly parentId: string; readonly descendants: boolean };
  readonly grouping?: { readonly key: string; readonly order: readonly string[] };
  /** IANA zone for `$created` / `$modified`; null is UTC. */
  readonly zone: string | null;
}

const ISO_GUID = /^[0-9a-f-]{36}$/i;

/** A property by own name only: `constructor` and `__proto__` are not stored values. */
const prop = (row: Row, key: string): unknown =>
  Object.hasOwn(row.props, key) ? row.props[key] : undefined;

/** The candidate rows: active, with every ancestor present and active, not under an expired grant. */
export function candidates(
  all: readonly MirrorItem[],
  now: Date,
): { rows: Map<string, Row>; byId: Map<string, MirrorItem> } {
  const byId = new Map(all.map((item) => [item.id, item]));
  const visible = new Map<string, boolean>();
  const isVisible = (item: MirrorItem): boolean => {
    const known = visible.get(item.id);
    if (known !== undefined) return known;
    visible.set(item.id, false); // a cycle reads as hidden
    let ok = item.lifecycleState === 'active' && !expiredGrant(item, now);
    if (ok && item.parentId !== null) {
      const parent = byId.get(item.parentId);
      ok = parent !== undefined && isVisible(parent);
    }
    visible.set(item.id, ok);
    return ok;
  };
  const rows = new Map<string, Row>();
  for (const item of all) {
    if (!isVisible(item)) continue;
    rows.set(item.id, {
      item,
      props: item.properties,
      created: parseStamp(item.createdAt),
      modified: item.locked ? undefined : parseStamp(item.updatedAt ?? item.createdAt),
    });
  }
  return { rows, byId };
}

/** A grant that has lapsed since the sync: Core's "closed lock" now hides the item. */
function expiredGrant(item: MirrorItem, now: Date): boolean {
  return (
    item.locked &&
    item.metadataExpiresAt !== null &&
    Date.parse(item.metadataExpiresAt) <= now.getTime()
  );
}

function isInside(row: Row, ancestorId: string, byId: Map<string, MirrorItem>): boolean {
  const target = ancestorId.toLowerCase();
  const seen = new Set<string>();
  for (let parent = row.item.parentId; parent !== null && !seen.has(parent);) {
    if (parent.toLowerCase() === target) return true;
    seen.add(parent);
    parent = byId.get(parent)?.parentId ?? null;
  }
  return false;
}

const lastModified = (row: Row): Stamp => {
  if (row.modified === undefined)
    throw new Unanswerable('last_modified_at is withheld for a locked item');
  return row.modified;
};

function dayText(row: Row, key: string): string | null {
  const text = textOf(prop(row, key));
  return text === null ? null : left10(text);
}

function timestampRange(rule: Rule, row: Row, spec: Spec): boolean {
  const stamp = rule.property === '$created' ? row.created : lastModified(row);
  const day = (value: string): number => {
    const resolved = resolveDay(value, spec.today);
    if (resolved === null) throw new Unanswerable('day');
    return resolved;
  };
  const count = Number(rule.value);
  let from: number | null = null;
  let through: number | null = null;
  switch (rule.operator) {
    case 'on':
      from = through = day(rule.value);
      break;
    case 'before':
      // Before the first day there is holds for nothing.
      if (day(rule.value) <= MIN_DAY) return false;
      through = day(rule.value) - 1;
      break;
    case 'on-or-after':
      from = day(rule.value);
      break;
    case 'within-next':
      from = spec.today;
      through = addDaysClamped(spec.today, count);
      break;
    case 'within-last':
      from = addDaysClamped(spec.today, -count);
      through = spec.today;
      break;
    default:
      throw new Unanswerable('Core faults on this operator for a timestamp field');
  }
  if (from !== null && stamp.ms < startOfDayIn(from, spec.zone)) return false;
  if (through !== null && through < MAX_DAY && stamp.ms >= startOfDayIn(through + 1, spec.zone))
    return false;
  return true;
}

const MIN_DAY = -719162; // 0001-01-01
const MAX_DAY = 2932896; // 9999-12-31

function structural(rule: Rule, row: Row, spec: Spec, byId: Map<string, MirrorItem>): boolean {
  const negated = rule.operator === 'not-equals';
  switch (rule.property) {
    case '$type':
      return negated ? row.item.type !== rule.value : row.item.type === rule.value;
    case '$inside': {
      if (!ISO_GUID.test(rule.value)) throw new Unanswerable('Core faults on a non-id');
      const inside = isInside(row, rule.value, byId);
      return negated ? !inside : inside;
    }
    case '$done': {
      const wantsDone = (rule.value === 'true') !== negated;
      const completion = textOf(prop(row, 'completion'));
      return wantsDone ? completion === 'true' : completion !== 'true';
    }
    case '$created':
    case '$modified':
      return timestampRange(rule, row, spec);
    default:
      throw new Unanswerable('Core faults on this field');
  }
}

function leaf(rule: Rule, row: Row, spec: Spec, byId: Map<string, MirrorItem>): boolean {
  if (rule.property.startsWith('$')) return structural(rule, row, spec, byId);
  const value = prop(row, rule.property);
  const text = textOf(value);
  switch (rule.operator) {
    case 'equals':
      return text !== null && text === rule.value;
    case 'not-equals':
      return text !== rule.value;
    case 'on':
    case 'before':
    case 'on-or-after': {
      const wanted = resolveDay(rule.value, spec.today);
      const day = dayText(row, rule.property);
      if (wanted === null || day === null) return false;
      const order = collate(day, formatDay(wanted));
      return rule.operator === 'on'
        ? day === formatDay(wanted)
        : rule.operator === 'before'
          ? order < 0
          : order >= 0;
    }
    case 'within-next':
    case 'within-last': {
      const days = Number(rule.value);
      const [start, end] =
        rule.operator === 'within-next'
          ? [spec.today, spec.today + days]
          : [spec.today - days, spec.today];
      const day = dayText(row, rule.property);
      return (
        day !== null && collate(day, formatDay(start)) >= 0 && collate(day, formatDay(end)) <= 0
      );
    }
    case 'contains':
      return containsValue(value, rule.value);
    case 'not-contains':
      return !containsValue(value, rule.value);
    case 'greater-than':
    case 'less-than': {
      const stored = storedNumber(value);
      const literal = parseFiniteNumber(rule.value);
      if (stored === null || literal === null) return false;
      return rule.operator === 'greater-than' ? stored > literal : stored < literal;
    }
    case 'is-empty':
      return isEmpty(value);
    case 'is-not-empty':
      return !isEmpty(value);
    default:
      throw new Unanswerable('Core faults on this operator');
  }
}

function containsValue(value: unknown, wanted: string): boolean {
  switch (jsonType(value)) {
    case 'string':
      return containsText(value as string, wanted);
    case 'array':
      return (value as unknown[]).some(
        (element) => typeof element === 'string' && element === wanted,
      );
    default:
      return false;
  }
}

const isEmpty = (value: unknown): boolean =>
  value === undefined ||
  value === null ||
  value === '' ||
  (Array.isArray(value) && value.length === 0);

/** Every rule must hold; a group holds when any of its rules does. */
function matches(row: Row, spec: Spec, byId: Map<string, MirrorItem>): boolean {
  return spec.rules.every((rule) =>
    isGroup(rule)
      ? (rule.any ?? []).some((inner) => leaf(inner, row, spec, byId))
      : leaf(rule, row, spec, byId),
  );
}

export function match(rows: Map<string, Row>, byId: Map<string, MirrorItem>, spec: Spec): Row[] {
  const out: Row[] = [];
  for (const row of rows.values()) {
    if (spec.excludedItemId !== undefined && row.item.id === spec.excludedItemId) continue;
    if (spec.scope !== undefined) {
      const { parentId, descendants } = spec.scope;
      if (descendants ? !isInside(row, parentId, byId) : row.item.parentId !== parentId) continue;
    }
    if (matches(row, spec, byId)) out.push(row);
  }
  return out;
}

/** The group a row falls in: a string, boolean or number names it; everything else is "no value". */
export function groupKey(row: Row, key: string): string | null {
  if (key === '$type') return row.item.type;
  const value = prop(row, key);
  switch (jsonType(value)) {
    case 'string':
      return value === '' ? null : (value as string);
    case 'boolean':
    case 'number':
      return textOf(value);
    default:
      return null;
  }
}

const nullsLast = (a: string | null, b: string | null, descending = false): number => {
  if (a === null || b === null) return a === b ? 0 : a === null ? 1 : -1;
  const order = collate(a, b);
  return descending ? -order : order;
};

const byId = (a: Row, b: Row): number =>
  a.item.id < b.item.id ? -1 : a.item.id > b.item.id ? 1 : 0;

function orderComparator(order: Order): (a: Row, b: Row) => number {
  const sign = order.descending ? -1 : 1;
  if (order.key === null)
    return (a, b) => -compareStamps(lastModified(a), lastModified(b)) || byId(a, b);
  switch (order.key) {
    case '$created':
      return (a, b) => sign * compareStamps(a.created, b.created) || byId(a, b);
    case '$modified':
      return (a, b) => sign * compareStamps(lastModified(a), lastModified(b)) || byId(a, b);
    case '$type':
      return (a, b) => sign * collate(a.item.type, b.item.type) || byId(a, b);
  }
  const key = order.key;
  const read = order.isDay ? (row: Row) => dayText(row, key) : (row: Row) => textOf(prop(row, key));
  return (a, b) => nullsLast(read(a), read(b), order.descending) || byId(a, b);
}

function rank(order: readonly string[], key: string | null): number | null {
  if (key === null) return null;
  const at = order.indexOf(key);
  return at < 0 ? null : at;
}

/** ORDER BY array_position(order, key) ASC NULLS LAST, key ASC NULLS LAST. */
export function groupComparator(
  order: readonly string[],
): (a: string | null, b: string | null) => number {
  return (a, b) => {
    if (order.length > 0) {
      const [x, y] = [rank(order, a), rank(order, b)];
      if (x !== y) return x === null ? 1 : y === null ? -1 : x - y;
    }
    return nullsLast(a, b);
  };
}

export function sortRows(matched: Row[], spec: Spec): Row[] {
  const order = orderComparator(spec.order);
  if (spec.grouping === undefined) return matched.sort(order);
  const { key, order: wanted } = spec.grouping;
  const groups = groupComparator(wanted);
  return matched.sort((a, b) => groups(groupKey(a, key), groupKey(b, key)) || order(a, b));
}
