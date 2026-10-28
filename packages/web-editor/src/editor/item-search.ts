import { isCanceledError, search, type NixClient, type SearchResults } from '@nix/api-client';
import { useEffect, useState } from 'react';

/**
 * The item search both link pickers share: the rich editor's `[[` menu and the Markdown-mode
 * textarea's. They differ in what they do with the candidates (the rich picker re-ranks them), not
 * in how they are asked for, debounced, or reported when the request fails.
 */

/** How long to wait after the last keystroke before asking the server. */
export const DEBOUNCE_MS = 150;

/** The most candidates to offer. A picker is scanned, not read. */
export const RESULT_LIMIT = 8;

/**
 * How many candidates to ask the server for, of which `RESULT_LIMIT` are shown.
 *
 * The pool is what gives the re-rank (`rank-references.ts`) something to choose between: an item
 * the person links to every day but which the server ranked eleventh can only be promoted if the
 * eleventh result was fetched. Twenty-five is half the server's ceiling
 * (`SearchItemsHandler.MaximumLimit`), enough to reach past a page of near-identical title matches
 * without asking for rows nobody will see.
 */
export const CANDIDATE_POOL = 25;

/**
 * The shortest query sent to the server, matching `SearchItemsHandler.MinimumQueryLength`.
 *
 * Below three characters there is no trigram to look up and the server falls back to reading every
 * item the caller can reach. The picker opens on the trigger and offers a prompt until then.
 */
export const MINIMUM_QUERY = 3;

export type SearchHit = SearchResults['results'][number];

/** The server's candidates for a query, in its order. */
export async function fetchCandidates(
  client: NixClient,
  query: string,
  signal: AbortSignal,
): Promise<readonly SearchHit[]> {
  const response = await client.query(search.searchItems(query, CANDIDATE_POOL), { signal });
  return response.results;
}

/** One completed search, tagged with the query it answers. */
interface SearchAnswer {
  readonly query: string;
  readonly hits: readonly SearchHit[];
  readonly failed: boolean;
}

/** One empty array, so "no results" does not change identity on every render. */
const EMPTY_HITS: readonly SearchHit[] = [];

/**
 * Debounced search for `query`; `null` means the picker is closed and nothing is asked.
 *
 * The answer carries the query it answers, and anything else is ignored. That is what keeps the
 * previous query's results off the screen while this one is still being debounced - and it is why
 * closing the picker sets no state at all: there is nothing to clear.
 *
 * `find` is an effect dependency, so a caller that builds it from props gives it a stable identity.
 */
export function useItemSearch(
  query: string | null,
  find: (query: string, signal: AbortSignal) => Promise<readonly SearchHit[]>,
): { readonly hits: readonly SearchHit[]; readonly failed: boolean; readonly answered: boolean } {
  const [answer, setAnswer] = useState<SearchAnswer | null>(null);

  useEffect(() => {
    if (query === null || query.length < MINIMUM_QUERY) {
      return;
    }

    const controller = new AbortController();
    const timer = setTimeout(() => {
      void (async () => {
        try {
          const hits = await find(query, controller.signal);
          if (!controller.signal.aborted) {
            setAnswer({ query, hits, failed: false });
          }
        } catch (cause) {
          if (controller.signal.aborted || isCanceledError(cause)) {
            return;
          }

          // Said out loud rather than shown as "no matches". A picker that reports an empty
          // workspace when the request failed sends somebody off to create a document they
          // already have.
          console.warn('The reference search failed.', cause);
          setAnswer({ query, hits: EMPTY_HITS, failed: true });
        }
      })();
    }, DEBOUNCE_MS);

    return () => {
      controller.abort();
      clearTimeout(timer);
    };
  }, [find, query]);

  const current = answer !== null && answer.query === query ? answer : null;
  return {
    hits: current?.hits ?? EMPTY_HITS,
    failed: current?.failed ?? false,
    answered: current !== null,
  };
}

/** What a picker says when it has nothing to list. */
export function itemSearchEmptyMessage(
  query: string,
  state: { readonly failed: boolean; readonly answered: boolean },
): string {
  if (state.failed) {
    return 'Could not search just now. Check your connection and try again.';
  }
  if (query.length < MINIMUM_QUERY) {
    return `Type ${String(MINIMUM_QUERY)} letters or more to find an item.`;
  }
  return state.answered ? 'No item matches that.' : 'Searching…';
}
