/**
 * The order the reference picker offers its candidates in: the server's search order, adjusted by
 * what this browser knows about what the person links to.
 *
 * **A re-rank, not a search.** The server decides what matches - and only it can, because only it
 * sees every item the caller may read. The picker asks it for a pool larger than it shows, and
 * this function decides which of that pool are worth the eight rows on screen. Nothing it does can
 * add a candidate the server did not return, so nothing it does can widen what anybody sees.
 *
 * **A sum of named parts.** Each signal adds a bounded amount to a candidate's score, the weights
 * are the constants below, and `RankedReference.parts` carries the breakdown - so "why is this
 * first" is always answerable by reading one object, and a weight can be argued about in review
 * with the arithmetic in front of everyone. Ties keep the server's order, which makes the result
 * deterministic for the same inputs and means a person with no history sees exactly the server's
 * ranking.
 *
 * **Signals that do not exist yet are simply absent.** Where an item lives (`parentId`), when it
 * last changed (`updatedAt`) and what tends to be cited alongside this note (`coCited`) are
 * optional: a caller that has them passes them, a caller that does not gets a ranking without
 * those parts. Pure, no I/O, no clock unless `now` is omitted.
 */

/** One candidate as the server returned it, plus whatever placement facts are known about it. */
export interface ReferenceCandidate {
  readonly id: string;
  readonly title: string | null;
  /** The item's parent, when the search reports it. */
  readonly parentId?: string | null | undefined;
  /** When the item last changed, as an ISO-8601 instant, when the search reports it. */
  readonly updatedAt?: string | null | undefined;
}

/** What is known about the person and the note the link is being written in. */
export interface ReferenceSignals {
  /** What was typed after the trigger. */
  readonly query: string;
  /** Decayed pick counts by item id, from `frecencyScores('links:<workspace>')`. */
  readonly frecency?: ReadonlyMap<string, number> | undefined;
  /** Items this note already links to. */
  readonly linkedHere?: ReadonlySet<string> | undefined;
  /** The note being written in, for "a child of this note". */
  readonly currentItemId?: string | undefined;
  /** That note's parent, for "a sibling of this note" and "this note's parent". */
  readonly currentParentId?: string | null | undefined;
  /**
   * How strongly each item is cited together with this note's existing links, in any positive
   * unit: the scores are normalised to the strongest candidate in the pool.
   */
  readonly coCited?: ReadonlyMap<string, number> | undefined;
  /** The clock, for recency. Epoch milliseconds. */
  readonly now?: number | undefined;
}

/**
 * The weights, each the most its signal can add.
 *
 * Read them against `prior`: the server's first result gets 1 and its last close to 0, so a
 * signal worth 1 can carry a candidate from the bottom of the pool to the top on its own, and a
 * signal worth 0.3 can only reorder neighbours.
 *
 * - `titleWordStart` / `titleContains`: the query appears in the title, at the start of a word or
 *   anywhere. The server already prefers title matches; restating it here keeps a frequently
 *   picked item that matched only on its body from outranking an item named what was typed.
 * - `frecency`: how often and how recently this person picked the item in this workspace, as
 *   `f / (f + 1)` of the decayed count - one recent pick is worth half, many approach the whole.
 *   The strongest signal after a title match, because it is this person's own behaviour.
 * - `linkedHere`: already linked from this note. A note returns to its subjects; small, because a
 *   second link to the same item is useful but rarer than a first link to a new one.
 * - `nearby`: a sibling, child or parent of this note. Placement is weak evidence on its own.
 * - `recency`: changed recently, halving every `RECENCY_HALF_LIFE_MS`. A tiebreaker, no more.
 * - `coCited`: cited together with what this note already cites. Strong when present, because it
 *   is the workspace's own record of what belongs with what.
 */
export const REFERENCE_WEIGHTS = {
  prior: 1,
  titleWordStart: 1,
  titleContains: 0.5,
  frecency: 1.5,
  linkedHere: 0.4,
  nearby: 0.4,
  recency: 0.3,
  coCited: 0.8,
} as const;

/** How long an edit takes to count half as much toward recency. */
export const RECENCY_HALF_LIFE_MS = 30 * 24 * 60 * 60 * 1000;

/** Each signal's contribution to one candidate's score. */
export interface ReferenceScoreParts {
  readonly prior: number;
  readonly title: number;
  readonly frecency: number;
  readonly linkedHere: number;
  readonly nearby: number;
  readonly recency: number;
  readonly coCited: number;
}

export interface RankedReference<T extends ReferenceCandidate> {
  readonly candidate: T;
  /** Where the server put it, zero-based. Ties are broken by this. */
  readonly serverIndex: number;
  readonly score: number;
  readonly parts: ReferenceScoreParts;
}

/** Whether `needle` occurs in `haystack` at the start of a word, both already lower-cased. */
function atWordStart(haystack: string, needle: string): boolean {
  let from = haystack.indexOf(needle);
  while (from >= 0) {
    const before = from === 0 ? undefined : haystack[from - 1];
    if (before === undefined || !/[\p{L}\p{N}]/u.test(before)) {
      return true;
    }
    from = haystack.indexOf(needle, from + 1);
  }
  return false;
}

function titlePart(title: string | null, query: string): number {
  const needle = query.trim().toLowerCase();
  if (needle.length === 0 || title === null) {
    return 0;
  }
  const haystack = title.toLowerCase();
  if (atWordStart(haystack, needle)) {
    return REFERENCE_WEIGHTS.titleWordStart;
  }
  return haystack.includes(needle) ? REFERENCE_WEIGHTS.titleContains : 0;
}

function nearbyPart(candidate: ReferenceCandidate, signals: ReferenceSignals): number {
  const { currentItemId, currentParentId } = signals;
  const parentId = candidate.parentId ?? null;
  const sibling =
    parentId !== null && currentParentId !== undefined && parentId === currentParentId;
  const child = parentId !== null && currentItemId !== undefined && parentId === currentItemId;
  const parent =
    currentParentId !== undefined && currentParentId !== null && candidate.id === currentParentId;
  return sibling || child || parent ? REFERENCE_WEIGHTS.nearby : 0;
}

function recencyPart(updatedAt: string | null | undefined, now: number): number {
  if (updatedAt === null || updatedAt === undefined) {
    return 0;
  }
  const at = Date.parse(updatedAt);
  if (Number.isNaN(at)) {
    return 0;
  }
  const age = Math.max(0, now - at);
  return REFERENCE_WEIGHTS.recency * Math.pow(0.5, age / RECENCY_HALF_LIFE_MS);
}

/**
 * The candidates in the order to offer them, at most `limit`.
 *
 * Duplicate ids keep their first occurrence. A pool of one or zero comes back as it went in.
 */
export function rankReferences<T extends ReferenceCandidate>(
  candidates: readonly T[],
  signals: ReferenceSignals,
  limit: number = candidates.length,
): RankedReference<T>[] {
  const seen = new Set<string>();
  const unique = candidates.filter((candidate) => {
    if (seen.has(candidate.id)) return false;
    seen.add(candidate.id);
    return true;
  });

  const pool = unique.length;
  const now = signals.now ?? Date.now();
  let strongestCoCitation = 0;
  for (const candidate of unique) {
    strongestCoCitation = Math.max(strongestCoCitation, signals.coCited?.get(candidate.id) ?? 0);
  }

  const ranked = unique.map((candidate, serverIndex): RankedReference<T> => {
    const picks = Math.max(0, signals.frecency?.get(candidate.id) ?? 0);
    const coCitation = Math.max(0, signals.coCited?.get(candidate.id) ?? 0);
    const parts: ReferenceScoreParts = {
      prior: REFERENCE_WEIGHTS.prior * (pool === 0 ? 0 : 1 - serverIndex / pool),
      title: titlePart(candidate.title, signals.query),
      frecency: REFERENCE_WEIGHTS.frecency * (picks / (picks + 1)),
      linkedHere: signals.linkedHere?.has(candidate.id) === true ? REFERENCE_WEIGHTS.linkedHere : 0,
      nearby: nearbyPart(candidate, signals),
      recency: recencyPart(candidate.updatedAt, now),
      coCited:
        strongestCoCitation > 0
          ? REFERENCE_WEIGHTS.coCited * (coCitation / strongestCoCitation)
          : 0,
    };
    const score =
      parts.prior +
      parts.title +
      parts.frecency +
      parts.linkedHere +
      parts.nearby +
      parts.recency +
      parts.coCited;
    return { candidate, serverIndex, score, parts };
  });

  ranked.sort((a, b) => b.score - a.score || a.serverIndex - b.serverIndex);
  return ranked.slice(0, Math.max(0, limit));
}
