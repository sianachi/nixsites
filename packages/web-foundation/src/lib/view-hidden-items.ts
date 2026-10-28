import { z } from 'zod';

import { browserStorage } from './browser-storage';

const hiddenIdsSchema = z.array(z.string().min(1).max(128)).max(4000);
const EMPTY: readonly string[] = [];
const snapshots = new Map<string, readonly string[]>();
const ephemeralKeys = new Set<string>();
const listeners = new Set<() => void>();
const sets = new WeakMap<readonly string[], ReadonlySet<string>>();
export function hiddenItemSet(ids: readonly string[]): ReadonlySet<string> {
  let set = sets.get(ids);
  if (set === undefined) {
    set = new Set(ids);
    sets.set(ids, set);
  }
  return set;
}
let revision = 0;
export function hiddenItemsRevision(): number {
  return revision;
}

/** A presentation preference: never used to decide who may read an item. */
export function hiddenItemsKey(subject: string, workspaceId: string): string {
  return `nix.workspace.hidden-items:${JSON.stringify([subject, workspaceId])}`;
}

export function readHiddenItems(key: string): readonly string[] {
  const cached = snapshots.get(key);
  if (cached !== undefined) return cached;
  let ids = EMPTY;
  try {
    const raw = browserStorage()?.getItem(key);
    const parsed = hiddenIdsSchema.safeParse(raw ? JSON.parse(raw) : []);
    if (parsed.success && parsed.data.length > 0) ids = [...new Set(parsed.data)];
  } catch {
    // Unavailable or malformed storage starts with every authorized item shown.
  }
  snapshots.set(key, ids);
  return ids;
}

/** Returns whether this browser retained the preference across reloads. */
export function writeHiddenItems(key: string, ids: readonly string[]): boolean {
  const next = hiddenIdsSchema.parse([...new Set(ids)]);
  let retained = false;
  try {
    const storage = browserStorage();
    if (storage !== undefined) {
      if (next.length === 0) storage.removeItem(key);
      else storage.setItem(key, JSON.stringify(next));
      retained = true;
    }
  } catch {
    // Keep the choice in memory and let the UI report that it could not be saved.
  }
  if (retained) ephemeralKeys.delete(key);
  else ephemeralKeys.add(key);
  snapshots.set(key, next.length === 0 ? EMPTY : next);
  revision += 1;
  for (const listener of listeners) listener();
  return retained;
}

function storageChanged(event: StorageEvent): void {
  if (event.key !== null && !event.key.startsWith('nix.workspace.hidden-items:')) return;
  if (event.key === null) snapshots.clear();
  else snapshots.delete(event.key);
  revision += 1;
  for (const listener of listeners) listener();
}

/** Shared across panes; other tabs invalidate their snapshot when browser storage changes. */
export function subscribeHiddenItems(listener: () => void): () => void {
  if (listeners.size === 0) {
    // Storage may have changed in another tab while every workspace surface was unmounted.
    for (const key of snapshots.keys()) if (!ephemeralKeys.has(key)) snapshots.delete(key);
    revision += 1;
    globalThis.addEventListener('storage', storageChanged);
  }
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
    if (listeners.size === 0) globalThis.removeEventListener('storage', storageChanged);
  };
}
