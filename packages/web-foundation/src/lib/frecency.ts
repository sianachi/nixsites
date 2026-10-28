import { z } from 'zod';

import { browserStorage } from './browser-storage';

/**
 * How often and how recently somebody picked a thing, remembered per browser.
 *
 * **One small store for every "rank what I usually choose" question.** The reference picker, the
 * slash menu and select-property values all ask the same thing - of these candidates, which does
 * this person reach for - and a score per namespace answers it without a server round trip. The
 * namespaces are opaque to this module: a caller scopes its own (`links:<workspace>`, `slash`,
 * `select:<property>`), so a workspace's picks never rank candidates in another one.
 *
 * **No document text, but not content-free.** An entry is a key, a count and a time. A key is an
 * item id, a command id or a select value. Item and command ids are identifiers; a select value is
 * an option label, which is workspace content somebody typed into a property definition. So the
 * store is cleared whenever the signed-in subject changes - at sign-out (`clearSession`), when
 * another tab signs out (`nix:signed-out-elsewhere`), and when the body cache finds a different
 * subject than the one that wrote it - so the next person on the browser inherits neither the
 * habits nor the labels.
 *
 * **Read through a module-level cache.** A picker asks for scores on every render and every
 * keystroke; parsing the namespace from storage each time was the dominant cost of a ranked menu.
 * The cache is keyed by namespace, written through by `recordPick`, dropped by `clearFrecency`
 * and by another tab's `storage` event for a key under this prefix, and holds at most
 * {@link MAX_CACHED_NAMESPACES} namespaces, least recently used dropped first.
 *
 * **Decayed, not counted.** A raw count lets last year's favourite outrank this week's project
 * forever. Each pick adds one to a score that halves every `HALF_LIFE_MS`, which is the usual
 * frecency shape: recent picks dominate, repeated picks accumulate, and nothing needs a sweep.
 *
 * Pure apart from `browserStorage`, and every storage failure degrades to "no history" - a ranking
 * aid that throws would take the picker down with it.
 */

const PREFIX = 'nix.frecency.';

/** How long a pick takes to count for half as much. */
export const HALF_LIFE_MS = 14 * 24 * 60 * 60 * 1000;

/** The most keys one namespace keeps; the weakest are dropped past it. */
export const MAX_ENTRIES = 200;

const entrySchema = z.object({
  key: z.string().min(1).max(256),
  score: z.number().nonnegative(),
  at: z.number().nonnegative(),
});

const storeSchema = z.array(entrySchema).max(MAX_ENTRIES * 2);

/** The most namespaces the read cache holds; the least recently used is dropped past it. */
export const MAX_CACHED_NAMESPACES = 64;

/** Parsed namespaces, in least-recently-used-first order (a `Map` keeps insertion order). */
const cache = new Map<string, readonly FrecencyEntry[]>();
/** The storage the cache was filled from; a different one (a test, a reset) empties it. */
let cachedFrom: Storage | undefined;
let listening = false;

function listen(): void {
  if (listening || typeof globalThis.addEventListener !== 'function') {
    return;
  }
  listening = true;
  globalThis.addEventListener('storage', (event: StorageEvent) => {
    if (event.key === null) {
      cache.clear();
    } else if (event.key.startsWith(PREFIX)) {
      cache.delete(event.key.slice(PREFIX.length));
    }
  });
}

function remember(namespace: string, entries: readonly FrecencyEntry[]): void {
  cache.delete(namespace);
  cache.set(namespace, entries);
  while (cache.size > MAX_CACHED_NAMESPACES) {
    const oldest = cache.keys().next();
    if (oldest.done === true) {
      break;
    }
    cache.delete(oldest.value);
  }
}

export interface FrecencyEntry {
  readonly key: string;
  /** The decayed score as of `at`. */
  readonly score: number;
  /** When the score was last brought up to date, in epoch milliseconds. */
  readonly at: number;
}

/** A score carried forward from `entry.at` to `now`. */
export function decayedScore(entry: FrecencyEntry, now: number): number {
  const elapsed = Math.max(0, now - entry.at);
  return entry.score * Math.pow(0.5, elapsed / HALF_LIFE_MS);
}

/**
 * The entries after one more pick of `key`, strongest first and bounded.
 *
 * Pure so the arithmetic is testable without storage.
 */
export function withPick(
  entries: readonly FrecencyEntry[],
  key: string,
  now: number,
): FrecencyEntry[] {
  const next = entries.map((entry) => {
    const score = decayedScore(entry, now);
    return entry.key === key
      ? { key, score: score + 1, at: now }
      : { key: entry.key, score, at: now };
  });
  if (!entries.some((entry) => entry.key === key)) {
    next.push({ key, score: 1, at: now });
  }
  next.sort((a, b) => b.score - a.score);
  return next.slice(0, MAX_ENTRIES);
}

function read(storage: Storage, namespace: string): readonly FrecencyEntry[] {
  if (cachedFrom !== storage) {
    cache.clear();
    cachedFrom = storage;
  }
  listen();
  const cached = cache.get(namespace);
  if (cached !== undefined) {
    remember(namespace, cached);
    return cached;
  }
  let entries: readonly FrecencyEntry[] = [];
  try {
    const raw = storage.getItem(PREFIX + namespace);
    if (raw !== null) {
      const parsed = storeSchema.safeParse(JSON.parse(raw));
      entries = parsed.success ? parsed.data : [];
    }
  } catch {
    entries = [];
  }
  remember(namespace, entries);
  return entries;
}

/** Records that `key` was chosen in `namespace`. Best-effort: a full or blocked store is ignored. */
export function recordPick(namespace: string, key: string, now: number = Date.now()): void {
  if (key.length === 0 || key.length > 256) {
    return;
  }
  const storage = browserStorage();
  if (storage === undefined) {
    return;
  }
  const next = withPick(read(storage, namespace), key, now);
  // The cache takes the pick even when the write fails, so this session still ranks by it.
  remember(namespace, next);
  try {
    storage.setItem(PREFIX + namespace, JSON.stringify(next));
  } catch {
    // Quota or policy. A ranking hint is not worth surfacing an error for.
  }
}

/**
 * Every remembered key in `namespace` with its score as of `now`.
 *
 * A map rather than a list because callers look scores up per candidate.
 */
export function frecencyScores(
  namespace: string,
  now: number = Date.now(),
): ReadonlyMap<string, number> {
  const scores = new Map<string, number>();
  const storage = browserStorage();
  if (storage === undefined) {
    return scores;
  }
  for (const entry of read(storage, namespace)) {
    scores.set(entry.key, decayedScore(entry, now));
  }
  return scores;
}

/** Removes every namespace. Called when the subject changes so habits never cross to the next person. */
export function clearFrecency(): void {
  cache.clear();
  const storage = browserStorage();
  if (storage === undefined) {
    return;
  }
  try {
    const doomed: string[] = [];
    for (let index = 0; index < storage.length; index += 1) {
      const key = storage.key(index);
      if (key?.startsWith(PREFIX) === true) {
        doomed.push(key);
      }
    }
    for (const key of doomed) {
      storage.removeItem(key);
    }
  } catch {
    // Nothing useful to do; the cache is already empty and storage refused the removal.
  }
}
