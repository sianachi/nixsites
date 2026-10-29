import {
  comments,
  isCanceledError,
  isNixApiError,
  type CommentsResponse,
  type CommentThread,
  type NixClient,
} from '@nix/api-client';
import type { Editor } from '@tiptap/core';
import { useEffect } from 'react';

import { useApiClient } from '@nix/web-platform/api/api-client-provider';
import {
  bindCommentItem,
  dropComments,
  editorHandle,
  encodeRange,
  findQuote,
  isAnchoredThread,
  patchComments,
  readComments,
  useItemComments,
} from './comment-anchors';
import { listSuggestions } from './suggesting';

const SUGGESTION_DEBOUNCE_MS = 300;
const RETRY_MS = 5000;
const MIN_POLL_MS = 1000;
const MAX_RETRY_MS = 30000;

/** Failures that will not change by asking again, so the loop stops. */
const FINAL = new Set([401, 403, 404, 409, 423]);

function sleep(ms: number, signal: AbortSignal): Promise<void> {
  return new Promise((resolve) => {
    const timer = setTimeout(resolve, ms);
    signal.addEventListener('abort', () => {
      clearTimeout(timer);
      resolve();
    });
  });
}

interface Feed {
  owners: number;
  stop: () => void;
}

/** One list/watch loop per note, shared by every owner (the editor, the comments pane). */
const feeds = new Map<string, Feed>();

function runFeed(client: NixClient, itemId: string): () => void {
  const controller = new AbortController();
  const { signal } = controller;
  // An older answer (a slow refresh passed by a newer long-poll) must not overwrite newer data.
  const apply = (answer: CommentsResponse): void => {
    if (signal.aborted || answer.revision < readComments(itemId).revision) return;
    patchComments(itemId, {
      threads: answer.threads,
      revision: answer.revision,
      canComment: answer.canComment,
      status: 'ready',
      errorCode: null,
      errorDetail: null,
    });
  };
  // An own action re-reads at once instead of waiting for the long-poll to notice.
  patchComments(itemId, {
    status: 'loading',
    refresh: () => {
      void client
        .query(comments.list(itemId), { signal, forceRefresh: true })
        .then(apply)
        .catch(() => undefined);
    },
  });

  void (async () => {
    let revision = -1;
    let failures = 0;
    while (!signal.aborted) {
      const asked = Date.now();
      try {
        // Both forced: the long-poll must reach the server, not a cached answer.
        const answer =
          revision < 0
            ? await client.query(comments.list(itemId), { signal, forceRefresh: true })
            : await client.query(comments.watch(itemId, revision), { signal, forceRefresh: true });
        failures = 0;
        // A long-poll that answers at once with nothing new must not become a busy loop.
        const unchanged = answer.revision === revision;
        if (unchanged) await sleep(Math.max(0, MIN_POLL_MS - (Date.now() - asked)), signal);
        if (answer.revision !== revision || readComments(itemId).status !== 'ready') {
          revision = answer.revision;
          apply(answer);
        }
      } catch (reason) {
        if (isCanceledError(reason) || signal.aborted) return;
        const status = isNixApiError(reason) ? reason.status : undefined;
        if (status !== undefined && FINAL.has(status)) {
          patchComments(itemId, {
            status: 'error',
            errorCode: isNixApiError(reason) ? reason.code : null,
            errorDetail: isNixApiError(reason) ? (reason.detail ?? null) : null,
          });
          return;
        }
        failures += 1;
        if (readComments(itemId).status !== 'ready') patchComments(itemId, { status: 'error' });
        const wait =
          isNixApiError(reason) && reason.retryAfterSeconds !== undefined
            ? reason.retryAfterSeconds * 1000
            : Math.min(RETRY_MS * 2 ** (failures - 1), MAX_RETRY_MS);
        await sleep(wait, signal);
      }
    }
  })();

  return () => {
    controller.abort();
  };
}

/**
 * Keeps one note's comment threads in the comments store while an owner (the note editor or the
 * comments pane) is mounted. Owners are counted: the loop starts with the first, stops and
 * forgets the note's entry with the last.
 *
 * Threads are read once, then followed with the watch long-poll (it answers when the revision
 * passes the one held, or after about 20 seconds).
 */
export function useCommentFeed(itemId: string): void {
  const client = useApiClient();
  useEffect(() => {
    const feed = feeds.get(itemId) ?? { owners: 0, stop: runFeed(client, itemId) };
    feed.owners += 1;
    feeds.set(itemId, feed);
    return () => {
      feed.owners -= 1;
      if (feed.owners > 0) return;
      feed.stop();
      feeds.delete(itemId);
      dropComments(itemId);
    };
  }, [client, itemId]);
}

/** The editors showing each note, so closing one pane leaves the other's handle in place. */
const editors = new Map<string, Set<Editor>>();

function publishEditor(itemId: string, editor: Editor): void {
  if (editor.isDestroyed) return;
  patchComments(itemId, {
    suggestions: listSuggestions(editor.state.doc),
    editor: editorHandle(editor),
    ready: true,
  });
}

/**
 * Publishes the open editor into the comments store (suggestions, the handle the pane acts
 * through) and re-anchors threads that lost their text. `ready` gates the highlights: before the
 * body has synced every anchor would decode to nothing and look detached.
 */
export function useCommentSync(editor: Editor, itemId: string, ready: boolean): void {
  const client = useApiClient();

  useEffect(() => {
    bindCommentItem(editor, itemId);
  }, [editor, itemId]);

  // The suggestions the document holds, and the handle the pane uses to act on them.
  useEffect(() => {
    if (!ready) return;
    let timer: ReturnType<typeof setTimeout> | undefined;
    const owners = editors.get(itemId) ?? new Set<Editor>();
    owners.add(editor);
    editors.set(itemId, owners);
    const schedule = (): void => {
      clearTimeout(timer);
      timer = setTimeout(() => {
        publishEditor(itemId, editor);
      }, SUGGESTION_DEBOUNCE_MS);
    };
    publishEditor(itemId, editor);
    editor.on('update', schedule);
    return () => {
      clearTimeout(timer);
      editor.off('update', schedule);
      owners.delete(editor);
      const [next] = owners;
      if (next !== undefined) {
        publishEditor(itemId, next);
      } else {
        editors.delete(itemId);
        patchComments(itemId, { ready: false, editor: null });
      }
    };
  }, [editor, itemId, ready]);

  // Re-anchor the threads that lost their text, one at a time, and only for someone who may
  // comment (the server says so with every list). Only detached threads get here
  // (never anchored, or anchors that decode to nothing), and `findQuote` answers only for a
  // quote that occurs exactly once.
  const { detached: lost, threads, canComment } = useItemComments(itemId);
  useEffect(() => {
    if (!ready || canComment !== true) return;
    const detached = reanchorCandidates(itemId, threads, lost);
    if (detached.length === 0) return;
    let cancelled = false;
    void (async () => {
      for (const id of detached) {
        if (cancelled) return;
        if (attempted.has(`${itemId}:${id}`)) continue;
        attempted.add(`${itemId}:${id}`);
        const quote = readComments(itemId).threads.find((thread) => thread.id === id)?.quote;
        const found =
          quote === null || quote === undefined ? null : findQuote(editor.state.doc, quote);
        const range = found === null ? null : encodeRange(editor.state, found.from, found.to);
        if (range === null) continue;
        try {
          await client.execute(comments.setAnchor(itemId, id, range.start, range.end));
          readComments(itemId).refresh();
        } catch {
          // Only the author may move an anchor, or the thread is gone: it is in `attempted`, so it is not retried.
        }
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [client, lost, threads, canComment, editor, itemId, ready]);

  // Last, so it cleans up last on unmount and no cleanup above writes into a forgotten entry.
  useCommentFeed(itemId);
}

/** Threads seen attached to text this session, so one that loses its text later stays detached. */
const attached = new Set<string>();

/**
 * The detached threads worth re-anchoring: never anchored (MCP, import) or detached when first
 * seen. A thread seen attached whose text was then deleted stays detached rather than jumping to
 * another copy of its quote. Also records which threads are attached now.
 */
export function reanchorCandidates(
  itemId: string,
  threads: readonly CommentThread[],
  detached: readonly string[],
): string[] {
  const eligible = detached.filter((id) => {
    const thread = threads.find((candidate) => candidate.id === id);
    return (
      thread !== undefined && (thread.anchorStart === null || !attached.has(`${itemId}:${id}`))
    );
  });
  for (const thread of threads) {
    if (isAnchoredThread(thread) && !detached.includes(thread.id)) {
      attached.add(`${itemId}:${thread.id}`);
    }
  }
  return eligible;
}

/** Threads already tried this session, so a failed or repeated re-anchor never loops. */
const attempted = new Set<string>();
