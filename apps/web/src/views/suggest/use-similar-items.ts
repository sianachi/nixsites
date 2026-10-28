import { isCanceledError, search } from '@nix/api-client';
import { useEffect, useMemo, useState } from 'react';

import { useOptionalApiClient } from '../../api/api-client-provider';
import {
  DUPLICATE_THRESHOLD,
  MINIMUM_DUPLICATE_QUERY,
  similarTitles,
  type SimilarTitle,
  type TitledCandidate,
} from '@nix/web-foundation/lib/suggest/duplicates';

/**
 * Whether a title being typed for a new item already names something - here, or anywhere in the
 * workspace.
 *
 * Two sources, answered separately because they fail separately:
 *
 * - **The container's loaded children**, compared locally. Cheap, always available, and the most
 *   likely place for the duplicate to be.
 * - **Workspace search**, for the copy that lives somewhere else. The search endpoint ranks by
 *   relevance, not by similarity, so its hits are re-scored here with the same trigram measure
 *   and the same bar, and only hits in the current workspace count - the endpoint searches every
 *   workspace the caller can read, and a duplicate in somebody's other workspace is not a reason
 *   to hesitate here.
 *
 * **A failed search says nothing.** Not "no duplicates": the honest answer to a request that did
 * not complete is no answer, and a sentence claiming the workspace was checked would be a claim
 * about results that never arrived. The local comparison still stands on its own.
 *
 * **Debounced and cancellable** on the reference picker's pattern (`editor/reference-menu.tsx`): a
 * request per settled title rather than per keystroke, each aborted when the title moves on or the
 * control closes, and an answer that carries the query it answers so a late response for an old
 * title is never shown against a new one. Outside an `ApiClientProvider` - a story, a unit test, a
 * public page - the search half simply does not run.
 */

/** How long a title must sit still before it is checked. */
export const SIMILAR_DEBOUNCE_MS = 250;

/** How many search hits to re-score. The endpoint caps at 50; this many is plenty for a title. */
const SEARCH_LIMIT = 20;

export interface SimilarItems {
  /** Children of this container at or above the similarity bar, most similar first. */
  readonly local: readonly SimilarTitle[];

  /**
   * Items elsewhere in the workspace at or above the bar, most similar first - or null when the
   * search has not answered for this title (not run, still running, or failed).
   */
  readonly elsewhere: readonly SimilarTitle[] | null;
}

interface SearchAnswer {
  readonly query: string;
  readonly hits: readonly SimilarTitle[] | null;
}

/**
 * The debounced form of `value`: what it was once it stopped changing for `delay` milliseconds.
 *
 * The answer carries the value it settled on, and anything else is treated as not yet settled - the
 * reference picker's trick, which needs no state reset when the value changes again.
 */
export function useSettledValue(value: string, delay: number): string | null {
  const [settled, setSettled] = useState<string | null>(null);

  useEffect(() => {
    const timer = setTimeout(() => {
      setSettled(value);
    }, delay);
    return () => {
      clearTimeout(timer);
    };
  }, [value, delay]);

  return settled === value ? settled : null;
}

export function useSimilarItems(
  title: string,
  candidates: readonly TitledCandidate[],
  workspaceId: string | null,
): SimilarItems {
  const client = useOptionalApiClient();
  const query = title.trim();
  const settled = useSettledValue(query, SIMILAR_DEBOUNCE_MS);
  const [answer, setAnswer] = useState<SearchAnswer | null>(null);

  useEffect(() => {
    if (client === null || workspaceId === null || settled === null) {
      return;
    }
    if (settled.length < MINIMUM_DUPLICATE_QUERY) {
      return;
    }

    const controller = new AbortController();
    void (async () => {
      try {
        const response = await client.query(search.searchItems(settled, SEARCH_LIMIT), {
          signal: controller.signal,
        });
        const local = new Set(candidates.map((candidate) => candidate.id));
        const hits = response.results
          .filter((hit) => hit.workspaceId === workspaceId && !local.has(hit.id))
          .map((hit) => ({ id: hit.id, title: hit.title ?? '' }));
        setAnswer({ query: settled, hits: similarTitles(settled, hits, DUPLICATE_THRESHOLD) });
      } catch (cause) {
        if (controller.signal.aborted || isCanceledError(cause)) {
          return;
        }
        // Said nowhere on screen, deliberately - see the module comment. Logged so a broken search
        // is still findable by somebody looking.
        console.warn('The duplicate check could not search the workspace.', cause);
        setAnswer({ query: settled, hits: null });
      }
    })();

    return () => {
      controller.abort();
    };
  }, [client, workspaceId, settled, candidates]);

  // The local half is computed from the settled title too, so the sentence does not flicker
  // through every partial word on the way to the one somebody meant. Memoised for a profiled cost:
  // scoring 4,000 children measured 9-18ms in Node, and the field re-renders on every keystroke
  // while the settled title - the only input that changes the answer - stays put.
  const local = useMemo(
    () => (settled === null ? [] : similarTitles(settled, candidates, DUPLICATE_THRESHOLD)),
    [settled, candidates],
  );
  const elsewhere = answer !== null && answer.query === settled ? answer.hits : null;

  return { local, elsewhere };
}
