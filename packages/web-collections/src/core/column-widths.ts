import { useSyncExternalStore } from 'react';

import { browserStorage } from '@nix/web-foundation/lib/browser-storage';

/**
 * Column widths a person has dragged in a grid-type view, kept per device.
 *
 * Per device rather than on the shared view record: a width is how one person's screen fits the
 * columns, not a property of the view somebody else opens later, and the record field would be
 * ADR-0020's nine-place threading for a number nobody else needs. The key is the view id, so a
 * width survives reopening; a view with nothing stored draws each kind's own defaults.
 */
const PREFIX = 'nix.view.column-widths:';

export const COLUMN_WIDTH = { min: 64, max: 800, step: 16 } as const;

export type ColumnWidths = Readonly<Record<string, number>>;

const listeners = new Set<() => void>();
const cache = new Map<string, ColumnWidths>();

function key(viewId: string): string {
  return `${PREFIX}${viewId}`;
}

export function clampWidth(width: number): number {
  if (!Number.isFinite(width)) return COLUMN_WIDTH.min;
  return Math.min(COLUMN_WIDTH.max, Math.max(COLUMN_WIDTH.min, Math.round(width)));
}

/** Stored widths for a view; a missing or malformed entry reads as no widths. */
export function readColumnWidths(viewId: string): ColumnWidths {
  const cached = cache.get(viewId);
  if (cached !== undefined) return cached;
  let parsed: ColumnWidths = {};
  try {
    const raw = browserStorage()?.getItem(key(viewId));
    const value: unknown = raw === null || raw === undefined ? null : JSON.parse(raw);
    if (value !== null && typeof value === 'object' && !Array.isArray(value)) {
      parsed = Object.fromEntries(
        Object.entries(value as Record<string, unknown>)
          .filter(([, width]) => typeof width === 'number' && Number.isFinite(width))
          .map(([column, width]) => [column, clampWidth(width as number)]),
      );
    }
  } catch {
    parsed = {};
  }
  cache.set(viewId, parsed);
  return parsed;
}

function write(viewId: string, widths: ColumnWidths): void {
  cache.set(viewId, widths);
  try {
    const storage = browserStorage();
    if (Object.keys(widths).length === 0) storage?.removeItem(key(viewId));
    else storage?.setItem(key(viewId), JSON.stringify(widths));
  } catch {
    /* The width still applies for this session. */
  }
  for (const listener of listeners) listener();
}

export function setColumnWidth(viewId: string, column: string, width: number): void {
  write(viewId, { ...readColumnWidths(viewId), [column]: clampWidth(width) });
}

/** Forgets one column's width, or every width of the view when no column is named. */
export function resetColumnWidth(viewId: string, column?: string): void {
  if (column === undefined) {
    write(viewId, {});
    return;
  }
  write(
    viewId,
    Object.fromEntries(Object.entries(readColumnWidths(viewId)).filter(([key]) => key !== column)),
  );
}

function subscribe(listener: () => void): () => void {
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
}

/** The stored widths of a view, re-rendering when any of them changes. Null view: nothing stored. */
export function useColumnWidths(viewId: string | null): ColumnWidths {
  return useSyncExternalStore(
    subscribe,
    () => (viewId === null ? EMPTY : readColumnWidths(viewId)),
    () => EMPTY,
  );
}

const EMPTY: ColumnWidths = {};
