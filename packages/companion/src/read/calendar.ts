import { workspaceCalendar } from '@nix/api-client';
import { petSourceIds } from '../guards.js';
import type { CompanionPorts } from '../ports.js';
import { isDay, WorkspaceToolRefusal } from '../tool-args.js';

/** The widest window `nix_read_calendar` reads, in days, both ends included. */
export const CALENDAR_MAX_DAYS = 31;

/** The most rows one calendar read returns; a busier window says it was cut and asks for less. */
export const CALENDAR_MAX_ROWS = 100;

const DAY_MS = 24 * 60 * 60 * 1000;

export interface CalendarRange {
  from: string;
  to: string;
}

export interface CalendarRow {
  itemId: string;
  title: string | null;
  containerTitle: string | null;
  value: string;
  endValue?: string;
  completed?: boolean;
  generated?: true;
}

export interface CalendarRead {
  from: string;
  to: string;
  entries: CalendarRow[];
  truncated: boolean;
  unplaceable?: number;
  hint?: string;
}

/** Parses and bounds the range a `read_calendar` call carries in `specJson`, refusing anything
 * that is not two real days, in order, at most `CALENDAR_MAX_DAYS` apart (inclusive). */
export function calendarRange(specJson: string): CalendarRange {
  let raw: unknown;
  try {
    raw = JSON.parse(specJson);
  } catch {
    raw = undefined;
  }
  const range = (typeof raw === 'object' && raw !== null ? raw : {}) as Record<string, unknown>;
  const { from, to } = range;
  if (!isDay(from) || !isDay(to))
    throw new WorkspaceToolRefusal('nix_read_calendar needs from and to as yyyy-MM-dd days.');
  const days = Math.round(
    (Date.parse(`${to}T00:00:00Z`) - Date.parse(`${from}T00:00:00Z`)) / DAY_MS,
  );
  if (days < 0) throw new WorkspaceToolRefusal('nix_read_calendar needs from on or before to.');
  if (days + 1 > CALENDAR_MAX_DAYS)
    throw new WorkspaceToolRefusal(
      `nix_read_calendar reads at most ${String(CALENDAR_MAX_DAYS)} days at a time. Split the range.`,
    );
  return { from, to };
}

/** `read_calendar`: every dated entry the caller may read across the workspace's calendars in
 * the window, trimmed to what answers "what is on" - the item, where it lives, when, and whether a
 * repeating occurrence is done. Core filters by permission while the query runs; nothing here
 * widens what the owner could see in the calendar view itself. */
export async function readCalendar(
  ports: CompanionPorts,
  workspaceId: string,
  range: CalendarRange,
  signal: AbortSignal,
): Promise<{ read: CalendarRead; containerIds: string[] }> {
  const calendar = await ports.core.query(
    workspaceCalendar.workspaceCalendar(workspaceId, range.from, range.to),
    { signal, forceRefresh: true },
  );
  const sample = calendar.entries.slice(0, CALENDAR_MAX_ROWS);
  const unplaceable = calendar.unplaceable.slice(0, CALENDAR_MAX_ROWS);
  const visible = await petSourceIds(
    ports,
    workspaceId,
    [...sample, ...unplaceable].flatMap(({ itemId, containerId }) => [itemId, containerId]),
    signal,
  );
  const entries = sample
    .filter((entry) => visible.has(entry.itemId))
    .map((entry) => {
      const row: CalendarRow = {
        itemId: entry.itemId,
        title: entry.title,
        containerTitle: visible.has(entry.containerId) ? entry.containerTitle : null,
        value: entry.value,
      };
      if (entry.endValue !== null) row.endValue = entry.endValue;
      if (entry.completed !== null) row.completed = entry.completed;
      if (entry.generated) row.generated = true;
      return row;
    });
  const cut = calendar.entries.length > CALENDAR_MAX_ROWS || entries.length < sample.length;
  const result: CalendarRead = {
    from: calendar.from,
    to: calendar.to,
    entries,
    truncated: cut || calendar.entriesTruncated || calendar.seriesTruncated,
  };
  const unplaceableCount = unplaceable.filter(({ itemId, containerId }) =>
    visible.has(itemId ?? containerId),
  ).length;
  if (unplaceableCount > 0) result.unplaceable = unplaceableCount;
  if (result.truncated) result.hint = 'More entries exist. Read a shorter range for the rest.';
  // The containers the returned rows came from, so the caller can tell whether any sits under a
  // lock (`anyUnderLock`); never part of what the model reads.
  const containerIds = sample.flatMap((entry) =>
    visible.has(entry.itemId) && visible.has(entry.containerId) ? [entry.containerId] : [],
  );
  return { read: result, containerIds };
}
