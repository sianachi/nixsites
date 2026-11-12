import { addDays, dayFromText, dayText } from '@nix/web-collections/core/calendar-dates';
import type { Item } from '@nix/web-collections/core/container-model';
import { dayFor, readTimestampValue, readerZone } from '@nix/web-collections/core/timestamps';

export const DEPENDENCY_KEY = 'nix_depends_on';

export function prerequisites(item: Item): readonly string[] {
  const value = item.properties[DEPENDENCY_KEY];
  return typeof value === 'string' ? [...new Set(value.split(/\s+/).filter(Boolean))] : [];
}

export function dependsOn(id: string, target: string, items: ReadonlyMap<string, Item>): boolean {
  const pending = [id];
  const seen = new Set<string>();
  for (const current of pending) {
    if (current === target) return true;
    if (seen.has(current)) continue;
    seen.add(current);
    const item = items.get(current);
    if (item !== undefined) pending.push(...prerequisites(item));
  }
  return false;
}

export function scheduledDay(item: Item, key: string): string | null {
  const value = item.properties[key];
  if (typeof value !== 'string') return null;
  if (dayFromText(value) !== null) return value;
  const moment = readTimestampValue(item.properties, key);
  return moment === null ? null : dayFor(moment, readerZone());
}

function offset(start: string, end: string): number {
  return (Date.parse(`${end}T00:00:00Z`) - Date.parse(`${start}T00:00:00Z`)) / 86_400_000;
}

export function previewDependencyDates(
  rootId: string,
  newStart: string,
  items: readonly Item[],
  startKey: string,
  endKey: string | null,
): readonly { readonly item: Item; readonly before: string; readonly after: string }[] {
  const starts = new Map<string, string>();
  const durations = new Map<string, number>();
  const outgoing = new Map<string, Item[]>();
  for (const item of items) {
    const start = scheduledDay(item, startKey);
    if (start !== null) {
      starts.set(item.id, start);
      const end = endKey === null ? null : scheduledDay(item, endKey);
      durations.set(item.id, end === null ? 0 : Math.max(0, offset(start, end)));
    }
    for (const id of prerequisites(item)) {
      const dependents = outgoing.get(id);
      if (dependents === undefined) outgoing.set(id, [item]);
      else dependents.push(item);
    }
  }
  if (!starts.has(rootId) || dayFromText(newStart) === null) return [];
  const proposed = new Map([[rootId, newStart]]);
  // Relax each edge once per pass. The bound prevents malformed, pre-existing cycles from
  // producing a runaway preview; the editor refuses to create new cycles.
  let remaining = items.length;
  while (remaining > 0) {
    remaining -= 1;
    let changed = false;
    for (const [id, start] of proposed) {
      const day = dayFromText(start);
      if (day === null) continue;
      const end = dayText(addDays(day, durations.get(id) ?? 0));
      for (const item of outgoing.get(id) ?? []) {
        if (item.id === rootId) continue;
        const before = proposed.get(item.id) ?? starts.get(item.id);
        if (before !== undefined && before < end) {
          proposed.set(item.id, end);
          changed = true;
        }
      }
    }
    if (!changed) break;
  }
  return items.flatMap((item) => {
    const before = starts.get(item.id);
    const after = proposed.get(item.id);
    return before === undefined || after === undefined || before === after
      ? []
      : [{ item, before, after }];
  });
}
