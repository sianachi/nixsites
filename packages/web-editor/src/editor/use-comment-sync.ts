import { comments, isCanceledError, isNixApiError } from '@nix/api-client';
import type { Editor } from '@tiptap/core';
import { useEffect } from 'react';

import { useApiClient } from '@nix/web-platform/api/api-client-provider';
import {
  bindCommentItem,
  editorHandle,
  encodeRange,
  findQuote,
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

/**
 * Keeps one note's comment threads and suggestions in the comments store while it is open.
 *
 * Threads are read once, then followed with the watch long-poll (it answers when the revision
 * passes the one held, or after about 20 seconds). `ready` gates the highlights: before the body
 * has synced every anchor would decode to nothing and look detached.
 *
 * Detached threads are re-anchored here, once each, by finding their quote in the text.
 */
export function useCommentSync(editor: Editor, itemId: string, ready: boolean): void {
  const client = useApiClient();

  useEffect(() => {
    bindCommentItem(editor, itemId);
    const controller = new AbortController();
    const { signal } = controller;
    // An own action re-reads at once instead of waiting for the long-poll to notice.
    patchComments(itemId, {
      status: 'loading',
      refresh: () => {
        void client
          .query(comments.list(itemId), { signal, forceRefresh: true })
          .then((answer) => {
            patchComments(itemId, {
              threads: answer.threads,
              revision: answer.revision,
              status: 'ready',
              errorCode: null,
            });
          })
          .catch(() => undefined);
      },
    });

    void (async () => {
      let revision = -1;
      let failures = 0;
      while (!signal.aborted) {
        const asked = Date.now();
        try {
          const answer =
            revision < 0
              ? await client.query(comments.list(itemId), { signal, forceRefresh: true })
              : await client.query(comments.watch(itemId, revision), { signal });
          failures = 0;
          // A long-poll that answers at once with nothing new must not become a busy loop.
          const unchanged = answer.revision === revision;
          if (unchanged) await sleep(Math.max(0, MIN_POLL_MS - (Date.now() - asked)), signal);
          if (answer.revision !== revision || readComments(itemId).status !== 'ready') {
            revision = answer.revision;
            patchComments(itemId, {
              threads: answer.threads,
              revision,
              status: 'ready',
              errorCode: null,
            });
          }
        } catch (reason) {
          if (isCanceledError(reason) || controller.signal.aborted) return;
          const status = isNixApiError(reason) ? reason.status : undefined;
          if (status !== undefined && FINAL.has(status)) {
            patchComments(itemId, {
              status: 'error',
              errorCode: isNixApiError(reason) ? reason.code : null,
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
  }, [client, editor, itemId]);

  // The suggestions the document holds, and the handle the pane uses to act on them.
  useEffect(() => {
    if (!ready) return;
    let timer: ReturnType<typeof setTimeout> | undefined;
    const publish = (): void => {
      if (editor.isDestroyed) return;
      patchComments(itemId, {
        suggestions: listSuggestions(editor.state.doc),
        editor: editorHandle(editor),
      });
    };
    const schedule = (): void => {
      clearTimeout(timer);
      timer = setTimeout(publish, SUGGESTION_DEBOUNCE_MS);
    };
    publish();
    patchComments(itemId, { ready: true });
    editor.on('update', schedule);
    return () => {
      clearTimeout(timer);
      editor.off('update', schedule);
      patchComments(itemId, { ready: false, editor: null });
    };
  }, [editor, itemId, ready]);

  // Re-anchor the threads that lost their text, once each; a viewer's 403 ends the attempts.
  const { detached } = useItemComments(itemId);
  useEffect(() => {
    if (!ready || detached.length === 0) return;
    const { threads } = readComments(itemId);
    for (const id of detached) {
      if (attempted.has(`${itemId}:${id}`) || refused.has(itemId)) continue;
      attempted.add(`${itemId}:${id}`);
      const quote = threads.find((thread) => thread.id === id)?.quote;
      const found =
        quote === null || quote === undefined ? null : findQuote(editor.state.doc, quote);
      const range = found === null ? null : encodeRange(editor.state, found.from, found.to);
      if (range === null) continue;
      void client
        .execute(comments.setAnchor(itemId, id, range.start, range.end))
        .then(() => {
          readComments(itemId).refresh();
        })
        .catch((reason: unknown) => {
          if (isNixApiError(reason) && reason.status === 403) refused.add(itemId);
        });
    }
  }, [client, detached, editor, itemId, ready]);
}

/** Threads already tried this session, so a failed or repeated re-anchor never loops. */
const attempted = new Set<string>();
/** Notes where the viewer may not comment, so re-anchoring is not tried again. */
const refused = new Set<string>();
