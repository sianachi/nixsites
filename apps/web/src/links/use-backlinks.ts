import { isCanceledError, references, type Backlink } from '@nix/api-client';
import { useCallback, useEffect, useState } from 'react';

import { useApiClient } from '@nix/web-platform/api/api-client-provider';

/**
 * What points at an item.
 *
 * Uses the configured `NixClient` so the panel shares the application's authentication,
 * cancellation, error mapping and response parsing path.
 *
 * **Every state the panel renders is represented separately**, because the panel renders them
 * separately. Loading is not empty, and a failed request is not an item nothing points at -
 * collapsing them is how somebody concludes their links are broken when the network hiccupped.
 */

export type BacklinksStatus = 'loading' | 'ready' | 'error';

export interface Backlinks {
  readonly status: BacklinksStatus;
  readonly backlinks: readonly Backlink[];

  /**
   * Whether the server's ceiling was reached, so the panel can say "the first twenty-five" rather
   * than implying it has shown everything.
   */
  readonly truncated: boolean;

  /** Asks again, for the control a failed read offers. */
  readonly retry: () => void;
}

/** One completed read, tagged with the request it answers. */
interface BacklinksAnswer {
  readonly request: string;
  readonly backlinks: readonly Backlink[];
  readonly truncated: boolean;
  readonly failed: boolean;
}

/** One empty array, so "nothing points here" does not change identity on every render. */
const NONE: readonly Backlink[] = [];

export function useBacklinks(itemId: string | null): Backlinks {
  const client = useApiClient();
  const [answer, setAnswer] = useState<BacklinksAnswer | null>(null);
  const [attempt, setAttempt] = useState(0);

  const retry = useCallback(() => {
    setAttempt((previous) => previous + 1);
  }, []);

  // Which read the state below would have to be an answer to. Anything else is stale, which is
  // what makes "loading" a derived fact rather than a flag an effect has to set - and setting one
  // synchronously in an effect is a cascading render for something the render already knew.
  const request = `${itemId ?? ''}:${String(attempt)}`;
  const current = answer !== null && answer.request === request ? answer : null;

  useEffect(() => {
    if (itemId === null) {
      return;
    }

    const controller = new AbortController();

    // A box rather than a bare flag: narrowing would let the second read of a plain boolean be
    // elided, which is the bug `use-item-properties.ts` documents at length.
    const live = { current: true };

    void (async () => {
      try {
        const parsed = await client.query(references.listBacklinks(itemId), {
          signal: controller.signal,
        });
        if (!live.current) {
          return;
        }

        setAnswer({
          request,
          backlinks: parsed.backlinks,
          truncated: parsed.truncated,
          failed: false,
        });
      } catch (cause) {
        if (controller.signal.aborted || !live.current || isCanceledError(cause)) {
          return;
        }

        console.warn('The backlinks read failed.', cause);
        setAnswer({ request, backlinks: NONE, truncated: false, failed: true });
      }
    })();

    return () => {
      live.current = false;
      controller.abort();
    };
  }, [client, itemId, request]);

  return {
    status: current === null ? 'loading' : current.failed ? 'error' : 'ready',
    backlinks: current?.backlinks ?? NONE,
    truncated: current?.truncated ?? false,
    retry,
  };
}
