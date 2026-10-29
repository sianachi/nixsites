import { nixSchema } from '@nix/editor-schema';
import { yXmlFragmentToProseMirrorRootNode } from 'y-prosemirror';
import * as Y from 'yjs';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { writeImportedBody } from '../../import/note-body-writer';

const ITEM = '11111111-1111-4111-8111-111111111111';
const DOC = {
  type: 'doc',
  content: [{ type: 'paragraph', content: [{ type: 'text', text: 'Hello import' }] }],
};

interface CapturedPost {
  url: string;
  body: { update: string; clientId: string };
}

function collab(answer: () => Response): {
  fetchImpl: (url: string, init?: RequestInit) => Promise<Response>;
  posts: CapturedPost[];
} {
  const posts: CapturedPost[] = [];
  return {
    posts,
    fetchImpl: (url, init) => {
      if (init?.signal?.aborted === true) {
        return Promise.reject(new DOMException('Aborted', 'AbortError'));
      }
      posts.push({
        url,
        body: JSON.parse(typeof init?.body === 'string' ? init.body : '{}') as CapturedPost['body'],
      });
      return Promise.resolve(answer());
    },
  };
}

afterEach(() => {
  vi.restoreAllMocks();
});

describe('writing an imported body', () => {
  it('posts one update that a fresh document replays back into the same body', async () => {
    const { fetchImpl, posts } = collab(
      () => new Response(JSON.stringify({ seq: 's1' }), { status: 200 }),
    );

    const outcome = await writeImportedBody({ itemId: ITEM, doc: DOC, token: 't', fetchImpl });

    expect(outcome.ok).toBe(true);
    expect(posts).toHaveLength(1);
    expect(posts[0]?.url).toBe(`/collab/documents/${ITEM}/updates`);
    expect(posts[0]?.body.clientId).toMatch(/^web-import-/);

    // The round trip is the claim: apply the posted update to an empty doc and read it back.
    const replay = new Y.Doc();
    Y.applyUpdate(
      replay,
      Uint8Array.from(atob(posts[0]?.body.update ?? ''), (c) => c.charCodeAt(0)),
    );
    const rebuilt = yXmlFragmentToProseMirrorRootNode(replay.getXmlFragment('default'), nixSchema);
    expect(rebuilt.textContent).toBe('Hello import');
  });

  it('returns the service refusal in its own words, never a throw', async () => {
    const { fetchImpl } = collab(
      () => new Response(JSON.stringify({ detail: 'not yours to write' }), { status: 403 }),
    );

    const outcome = await writeImportedBody({ itemId: ITEM, doc: DOC, token: 't', fetchImpl });

    expect(outcome).toEqual({ ok: false, error: 'not yours to write' });
  });

  it('reports a cancellation as cancelled, not as a network failure', async () => {
    const controller = new AbortController();
    controller.abort();
    const { fetchImpl } = collab(
      () => new Response(JSON.stringify({ seq: 's1' }), { status: 200 }),
    );

    const outcome = await writeImportedBody({
      itemId: ITEM,
      doc: DOC,
      token: 't',
      signal: controller.signal,
      fetchImpl,
    });

    expect(outcome).toEqual({ ok: false, error: 'The import was cancelled.' });
  });

  it('turns a document the schema rejects into a reported failure, and logs the bug', async () => {
    const log = vi.spyOn(console, 'error').mockImplementation(() => undefined);
    const { fetchImpl, posts } = collab(
      () => new Response(JSON.stringify({ seq: 's1' }), { status: 200 }),
    );

    const outcome = await writeImportedBody({
      itemId: ITEM,
      doc: { type: 'no-such-node' },
      token: 't',
      fetchImpl,
    });

    expect(outcome.ok).toBe(false);
    if (!outcome.ok) {
      expect(outcome.error).toContain('could not be prepared');
    }
    expect(posts).toHaveLength(0);
    expect(log).toHaveBeenCalled();
  });
});
