import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useRef,
  useState,
  type ReactNode,
} from 'react';

import { isCanceledError, references } from '@nix/api-client';
import { useApiClient } from '../api/api-client-provider';

/**
 * What a document's references point at, resolved against the server.
 *
 * **A reference stores an identifier and a cached label, and the label is not a title anybody is
 * entitled to.** It is written when the link is made, from the title the author could see. A
 * reader who cannot open the target must therefore never be shown it - which means resolution is
 * not a nicety that keeps titles fresh, it is the thing that decides whether a title may be
 * displayed at all. That is why the four states below are four and not two.
 *
 * The server refuses to say *why* an identifier did not resolve - deleted, never existed, and not
 * visible to you are one answer - so `refused` covers all three. `unavailable` is different in
 * kind: it means nobody has answered yet, which is a statement about the network and not about
 * the reader's permission, and it must not be drawn as a refusal.
 */

/** One reference's answer. */
export type ReferenceState =
  /** Nobody has answered yet. The stored label stands in, which is what it is for. */
  | { readonly status: 'loading' }
  /** Resolved, and readable. The title is the item's current one, not the stored copy. */
  | {
      readonly status: 'resolved';
      readonly title: string | null;
      readonly workspaceId: string;
      readonly type: string;
    }
  /** Resolved, and not for this reader. Renders a stub and never the stored label. */
  | { readonly status: 'refused' }
  /** The lookup failed. Not a refusal, and deliberately not drawn as one. */
  | { readonly status: 'unavailable' };

/** The most identifiers one request may name; the server refuses more. */
const BATCH_LIMIT = 200;

interface ReferenceResolver {
  readonly refresh: (targetId: string, clear?: boolean) => void;
  readonly stateOf: (targetId: string) => ReferenceState;
  readonly request: (targetId: string) => void;
}

const ReferenceResolutionContext = createContext<ReferenceResolver | null>(null);

/**
 * Resolves every reference on screen, in as few requests as it can.
 *
 * **Batched, because a document is a page of references and not one.** Each rendered reference
 * asks for itself; the asks are collected across a microtask and sent as one request. A note with
 * forty links would otherwise open forty connections, and the browser would queue most of them
 * behind each other.
 *
 * **Answers are kept for the life of the provider**, which is one open document. A reference that
 * scrolls out of view and back does not ask again, and neither do two references to the same item
 * in the same paragraph.
 */
export function ReferenceResolutionProvider({
  children,
}: {
  readonly children: ReactNode;
}): ReactNode {
  const client = useApiClient();
  const [answers, setAnswers] = useState<ReadonlyMap<string, ReferenceState>>(new Map());

  // Held in refs rather than state: they are bookkeeping for the next flush, and a render caused
  // by changing them would be a render with nothing new to show.
  const pending = useRef(new Set<string>());
  const asked = useRef(new Set<string>());
  const flushScheduled = useRef(false);
  const live = useRef(true);

  // One controller per *mount*, so closing a document with two hundred references in flight
  // cancels them rather than leaving the browser parsing responses nobody will read.
  const abort = useRef(new AbortController());

  useEffect(() => {
    // Replaced on every mount, not created once with the instance. The instance's controller
    // was aborted by StrictMode's probe unmount, and a controller aborted once is aborted
    // forever - so after the remount every flush this provider ever ran started with a dead
    // signal, was cancelled before it reached the wire, and returned through the cancellation
    // branch below. No request, no warning, and every reference in every document stayed
    // `loading` - which draws the stored label and, deliberately, nothing clickable - for as
    // long as the note was open. The probe is development-only, but the pattern was wrong for
    // any remount.
    const controller = new AbortController();
    abort.current = controller;
    live.current = true;

    return () => {
      live.current = false;
      controller.abort();
    };
  }, []);

  // `flush` and `scheduleFlush` call each other - a batch re-arms for its own tail - so one of them
  // is reached through a ref. Written this way rather than as a loop because the scheduling is a
  // microtask either way, and a `while` here would send every batch in the same tick.
  const flushRef = useRef<() => void>(() => undefined);

  const scheduleFlush = useCallback((): void => {
    if (flushScheduled.current) {
      return;
    }

    flushScheduled.current = true;
    // A microtask, so every reference that renders in the same commit lands in one request.
    queueMicrotask(() => {
      flushScheduled.current = false;
      flushRef.current();
    });
  }, []);

  const flush = useCallback(async (): Promise<void> => {
    // The controller as of this flush's start. Teardown aborts exactly this one, so the catch
    // below can tell "cancelled on purpose" from "failed" - which reading the ref at catch time
    // cannot, because a remount has already swapped a fresh controller in by then.
    const controller = abort.current;

    const ids = [...pending.current].slice(0, BATCH_LIMIT);
    for (const id of ids) {
      pending.current.delete(id);
    }

    if (ids.length === 0) {
      return;
    }

    // **The tail is re-armed before the request is made, not after.** The server refuses more than
    // `BATCH_LIMIT` identifiers at once, so a document with more references than that arrives here
    // in several batches - and the surplus is already in `asked`, so nothing would ever ask for it
    // again. Dropped, those references stay `loading` for the life of the document, and `loading`
    // draws the stored label: a cached title that was never checked against this reader's
    // permissions, shown indefinitely, on exactly the documents most likely to link widely.
    if (pending.current.size > 0) {
      scheduleFlush();
    }

    try {
      const parsed = await client.query(references.resolveReferences(ids), {
        signal: controller.signal,
        forceRefresh: true,
      });
      if (!live.current) {
        return;
      }
      setAnswers((previous) => {
        const next = new Map(previous);
        for (const entry of parsed.references) {
          next.set(
            entry.id,
            entry.readable && entry.item !== null
              ? {
                  status: 'resolved',
                  title: entry.item.title,
                  workspaceId: entry.item.workspaceId,
                  type: entry.item.type,
                }
              : { status: 'refused' },
          );
        }
        return next;
      });
    } catch (cause) {
      if (controller.signal.aborted || !live.current || isCanceledError(cause)) {
        return;
      }

      // Reported, not swallowed. A Zod parse failure and a 503 are different problems and both
      // reach an operator here; parse failures are telemetry rather than a silent fallback.
      console.warn('The reference lookup failed.', cause);

      // Left as `unavailable`, never as `refused`. Drawing a failed lookup as "not yours to see"
      // would tell a reader something about their own permissions that nobody actually checked.

      // Cleared from `asked` so a later render tries again: a reader who reconnects should see
      // their links resolve without reopening the document.
      for (const id of ids) {
        asked.current.delete(id);
      }

      setAnswers((previous) => {
        const next = new Map(previous);
        for (const id of ids) {
          next.set(id, { status: 'unavailable' });
        }
        return next;
      });
    }
  }, [client, scheduleFlush]);

  // Assigned in an effect rather than during render: writing a ref while rendering is a side
  // effect React is entitled to discard, and the rule that forbids it is the React Compiler's own.
  // An effect is soon enough - nothing can call `flushRef` before the first commit, because the
  // only thing that schedules one is a reference asking to be resolved, and that happens in an
  // effect too.
  useEffect(() => {
    flushRef.current = () => {
      void flush();
    };
  }, [flush]);

  const request = useCallback(
    (targetId: string) => {
      if (asked.current.has(targetId)) {
        return;
      }

      asked.current.add(targetId);
      pending.current.add(targetId);
      scheduleFlush();
    },
    [scheduleFlush],
  );

  const refresh = useCallback(
    (targetId: string, clear = true): void => {
      asked.current.delete(targetId);
      if (clear)
        setAnswers((previous) => {
          const next = new Map(previous);
          next.delete(targetId);
          return next;
        });
      request(targetId);
    },
    [request],
  );

  const resolver = useMemo<ReferenceResolver>(
    // The identity is a dependency of the context consumers' effects: an unstable one would make
    // every reference on the page re-request itself on every render of this provider.
    () => ({
      stateOf: (targetId) => answers.get(targetId) ?? { status: 'loading' },
      request,
      refresh,
    }),
    [answers, request, refresh],
  );

  return (
    <ReferenceResolutionContext.Provider value={resolver}>
      {children}
    </ReferenceResolutionContext.Provider>
  );
}

/**
 * One reference's state, asking for it if nobody has yet.
 *
 * Returns `loading` outside a provider rather than throwing. A reference can be rendered by an
 * editor mounted in a test or a story that has no resolver, and a document that refuses to render
 * because its links cannot be checked is a worse failure than links that show their stored labels.
 */
export function useReference(targetId: string | null): ReferenceState {
  const resolver = useContext(ReferenceResolutionContext);

  useEffect(() => {
    if (resolver !== null && targetId !== null && targetId.length > 0) {
      resolver.request(targetId);
    }
  }, [resolver, targetId]);

  if (resolver === null || targetId === null || targetId.length === 0) {
    return { status: 'loading' };
  }

  return resolver.stateOf(targetId);
}

const ignoreRefresh = (): void => {
  /* Standalone previews have no resolver. */
};
export function useRefreshReference(): (targetId: string, clear?: boolean) => void {
  return useContext(ReferenceResolutionContext)?.refresh ?? ignoreRefresh;
}
