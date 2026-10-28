import { isCanceledError, suggestions, type NixClient } from '@nix/api-client';

/**
 * The co-citation signal for the reference picker: which items are linked from the same documents
 * as the note being written, and how many such documents each shares.
 *
 * **Fetched lazily, once per note, refreshed rarely.** The first time the picker opens in a note
 * the request starts - not when the note opens, because most notes are read or edited without a
 * link ever being made, and a request per open would be a request per click in the tree. After
 * that the same answer serves every search in the note until it is `REFRESH_MS` old. The answer
 * describes how the workspace links, which changes slowly; a few minutes' staleness costs a
 * ranking hint nothing.
 *
 * **A failure is no signal, said in the console.** The picker still works without it, and the
 * server's order plus pick history is a good ranking on its own - so the person is not told, but a
 * developer looking at a strangely ranked picker can see why.
 */

/** How many related items to ask for: the server's ceiling. */
export const RELATED_POOL = 25;

/** How old an answer may be before the next picker opening asks again. */
export const REFRESH_MS = 5 * 60 * 1000;

/**
 * How long a search waits for a co-citation answer still in flight before ranking without it. The
 * request starts when the picker opens, so by the time three letters are typed it has usually
 * landed; a slow one must not hold the results back.
 */
export const RELATED_WAIT_MS = 300;

export type CoCitations = ReadonlyMap<string, number>;

export interface CoCitationSource {
  /** The current answer, starting or refreshing the request when due. Never rejects. */
  readonly get: () => Promise<CoCitations | undefined>;
  /** Abandons any request in flight. */
  readonly dispose: () => void;
}

export function coCitationSource(
  client: NixClient,
  itemId: string,
  now: () => number = Date.now,
): CoCitationSource {
  const controller = new AbortController();
  let fetchedAt: number | null = null;
  let answer: Promise<CoCitations | undefined> | null = null;

  return {
    get: () => {
      if (answer !== null && fetchedAt !== null && now() - fetchedAt < REFRESH_MS) {
        return answer;
      }
      const refreshing = fetchedAt !== null;
      fetchedAt = now();
      const request = (async (): Promise<CoCitations | undefined> => {
        try {
          const related = await client.query(suggestions.listRelatedItems(itemId, RELATED_POOL), {
            signal: controller.signal,
            // The client caches by key; past the refresh interval that cached answer is the one
            // being replaced, so it is bypassed.
            forceRefresh: refreshing,
          });
          // The contract allows the count as a numeric string (a 64-bit integer in JSON); either
          // way it is a small count here, and a value that is not one carries no signal.
          return new Map(
            related.related.flatMap((entry): [string, number][] => {
              const shared = Number(entry.sharedSources);
              return Number.isFinite(shared) && shared > 0 ? [[entry.item.id, shared]] : [];
            }),
          );
        } catch (cause) {
          if (!controller.signal.aborted && !isCanceledError(cause)) {
            console.warn('The related-items lookup failed; ranking without it.', cause);
          }
          return undefined;
        }
      })();
      answer = request;
      return request;
    },
    dispose: () => {
      controller.abort();
    },
  };
}

/**
 * `answer`, or `undefined` if it has not arrived within `ms`. The timer is cleared whichever wins,
 * so a search per keystroke does not leave a timer per keystroke behind.
 */
export function withinWait<T>(answer: Promise<T | undefined>, ms: number): Promise<T | undefined> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const timeout = new Promise<undefined>((resolve) => {
    timer = setTimeout(() => {
      resolve(undefined);
    }, ms);
  });
  return Promise.race([answer, timeout]).finally(() => {
    clearTimeout(timer);
  });
}
