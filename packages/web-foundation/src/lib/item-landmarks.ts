import { z } from 'zod';

import { browserStorage } from './browser-storage';

export const landmarkIconIds = [
  'page',
  'notebook',
  'book',
  'calendar',
  'briefcase',
  'wallet',
  'heart',
] as const;
export const landmarkToneIds = ['muted', 'accent', 'foreground'] as const;
const landmarkSchema = z.object({
  icon: z.enum(landmarkIconIds),
  tone: z.enum(landmarkToneIds),
});
const landmarksSchema = z
  .record(z.string().min(1).max(128), landmarkSchema)
  .refine((value) => Object.keys(value).length <= 2000);
export type ItemLandmark = z.infer<typeof landmarkSchema>;
export type ItemLandmarks = Readonly<Record<string, ItemLandmark>>;
export const DEFAULT_LANDMARK: ItemLandmark = { icon: 'page', tone: 'muted' };
const EMPTY: ItemLandmarks = {};
const snapshots = new Map<string, ItemLandmarks>();
const ephemeralKeys = new Set<string>();
const listeners = new Set<() => void>();
const PREFIX = 'nix.workspace.item-landmarks:';

/** Device-local presentation choices, isolated between people and workspaces. */
export function itemLandmarksKey(subject: string, workspaceId: string): string {
  return `${PREFIX}${JSON.stringify([subject, workspaceId])}`;
}

export function readItemLandmarks(key: string): ItemLandmarks {
  const cached = snapshots.get(key);
  if (cached !== undefined) return cached;
  let landmarks = EMPTY;
  try {
    const raw = browserStorage()?.getItem(key);
    const parsed = landmarksSchema.safeParse(raw ? JSON.parse(raw) : {});
    if (parsed.success) landmarks = parsed.data;
  } catch {
    // An unavailable or malformed preference falls back to the ordinary page icon.
  }
  snapshots.set(key, landmarks);
  return landmarks;
}

/** Keeps changes in memory if storage fails; the caller must report the limited lifetime. */
export function writeItemLandmark(
  key: string,
  itemId: string,
  landmark: ItemLandmark | null,
): boolean {
  const current = readItemLandmarks(key);
  const next =
    landmark === null
      ? Object.fromEntries(Object.entries(current).filter(([id]) => id !== itemId))
      : { ...current, [itemId]: landmark };
  const parsed = landmarksSchema.parse(next);
  let retained = false;
  try {
    const storage = browserStorage();
    if (storage !== undefined) {
      if (Object.keys(parsed).length === 0) storage.removeItem(key);
      else storage.setItem(key, JSON.stringify(parsed));
      retained = true;
    }
  } catch {
    // The current page can still show the choice without implying it survived a reload.
  }
  if (retained) ephemeralKeys.delete(key);
  else ephemeralKeys.add(key);
  snapshots.set(key, parsed);
  for (const listener of listeners) listener();
  return retained;
}

function storageChanged(event: StorageEvent): void {
  if (event.key !== null && !event.key.startsWith(PREFIX)) return;
  if (event.key === null) snapshots.clear();
  else snapshots.delete(event.key);
  for (const listener of listeners) listener();
}

export function subscribeItemLandmarks(listener: () => void): () => void {
  if (listeners.size === 0) {
    for (const key of snapshots.keys()) if (!ephemeralKeys.has(key)) snapshots.delete(key);
    globalThis.addEventListener('storage', storageChanged);
  }
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
    if (listeners.size === 0) {
      globalThis.removeEventListener('storage', storageChanged);
      for (const key of snapshots.keys()) if (!ephemeralKeys.has(key)) snapshots.delete(key);
    }
  };
}

export function emptyItemLandmarks(): ItemLandmarks {
  return EMPTY;
}
