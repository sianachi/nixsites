import { describe, expect, it } from 'vitest';

import {
  deleteNamedVersion,
  fetchStateAt,
  listNamedVersions,
  listRevisions,
  nameVersion,
  restoreRevision,
  type HistoryRequestConfig,
} from '../../history/history-api';
import { json } from '@nix/web-foundation/testing/json-response';

/**
 * `history-api.ts` against a hand-rolled `fetch`: the URLs and headers it actually sends, what it
 * does with a well-formed body, and what it does with one that is not - the same two questions
 * `note-body-writer.test.ts` asks of the sibling seam this module mirrors.
 */

const ITEM = '11111111-1111-4111-8111-111111111111';
const TOKEN = 'the-bearer-token';

interface Captured {
  readonly url: string;
  readonly method: string;
  readonly headers: Record<string, string>;
  readonly body: unknown;
}

function fakeFetch(answer: (captured: Captured) => Response): {
  readonly fetchImpl: (url: string, init?: RequestInit) => Promise<Response>;
  readonly calls: Captured[];
} {
  const calls: Captured[] = [];
  return {
    calls,
    fetchImpl: (url, init) => {
      const headers: Record<string, string> = {};
      const rawHeaders = init?.headers as Record<string, string> | undefined;
      if (rawHeaders !== undefined) {
        for (const [key, value] of Object.entries(rawHeaders)) headers[key.toLowerCase()] = value;
      }
      const captured: Captured = {
        url,
        method: init?.method ?? 'GET',
        headers,
        body: typeof init?.body === 'string' ? (JSON.parse(init.body) as unknown) : undefined,
      };
      calls.push(captured);
      return Promise.resolve(answer(captured));
    },
  };
}

function config(
  fetchImpl: (url: string, init?: RequestInit) => Promise<Response>,
): HistoryRequestConfig {
  return { itemId: ITEM, token: TOKEN, fetchImpl };
}

const revision = {
  seq: 42,
  fromSeq: 40,
  actorId: 'user-1',
  startedAt: '2026-09-20T10:00:00Z',
  endedAt: '2026-09-20T10:05:00Z',
  updateCount: 3,
  name: null,
};

describe('listRevisions', () => {
  it('requests the paged route with the bearer token and the query parameters', async () => {
    const { fetchImpl, calls } = fakeFetch(() =>
      json({ revisions: [revision], hasMore: true, headSeq: 100 }),
    );

    const result = await listRevisions(config(fetchImpl), { before: 50, limit: 20 });

    expect(result).toEqual({
      ok: true,
      value: { revisions: [revision], hasMore: true, headSeq: 100 },
    });
    expect(calls).toHaveLength(1);
    expect(calls[0]?.method).toBe('GET');
    expect(calls[0]?.headers.authorization).toBe(`Bearer ${TOKEN}`);
    const url = new URL(calls[0]?.url ?? '', 'http://localhost');
    expect(url.pathname).toBe(`/collab/documents/${ITEM}/history`);
    expect(url.searchParams.get('before')).toBe('50');
    expect(url.searchParams.get('limit')).toBe('20');
  });

  it('omits `before` when there is no earlier page to ask for', async () => {
    const { fetchImpl, calls } = fakeFetch(() =>
      json({ revisions: [], hasMore: false, headSeq: 0 }),
    );

    await listRevisions(config(fetchImpl), { limit: 20 });

    const url = new URL(calls[0]?.url ?? '', 'http://localhost');
    expect(url.searchParams.has('before')).toBe(false);
  });

  it('maps a refused request to a typed refusal carrying the service’s code and detail', async () => {
    const { fetchImpl } = fakeFetch(() =>
      json({ code: 'history.not_found', detail: 'No such document.' }, 404),
    );

    const result = await listRevisions(config(fetchImpl), { limit: 20 });

    expect(result).toEqual({
      ok: false,
      refusal: { code: 'history.not_found', detail: 'No such document.' },
    });
  });

  it('rejects a response whose shape the schema does not recognise', async () => {
    const { fetchImpl } = fakeFetch(() => json({ revisions: 'not-an-array', hasMore: true }));

    const result = await listRevisions(config(fetchImpl), { limit: 20 });

    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.refusal.code).toBe('history.malformed_response');
    }
  });

  it('builds a refusal from the status alone when the body carries no code', async () => {
    const { fetchImpl } = fakeFetch(() => new Response('not json', { status: 500 }));

    const result = await listRevisions(config(fetchImpl), { limit: 20 });

    expect(result).toEqual({
      ok: false,
      refusal: { code: 'http_500', detail: 'The request was refused.' },
    });
  });
});

describe('fetchStateAt', () => {
  it('requests the state route and validates the document, plaintext and headSeq', async () => {
    const { fetchImpl, calls } = fakeFetch(() =>
      json({ seq: 42, document: { type: 'doc' }, plaintext: 'hello', headSeq: 100 }),
    );

    const result = await fetchStateAt(config(fetchImpl), 42);

    expect(result).toEqual({
      ok: true,
      value: { seq: 42, document: { type: 'doc' }, plaintext: 'hello', headSeq: 100 },
    });
    expect(calls[0]?.url).toBe(`/collab/documents/${ITEM}/history/42`);
  });

  it('returns null, not a refusal, when the server says the state is unavailable', async () => {
    const { fetchImpl } = fakeFetch(() =>
      json({ code: 'history_state_unavailable', detail: 'Too old to reconstruct.' }, 404),
    );

    const result = await fetchStateAt(config(fetchImpl), 1);

    expect(result).toEqual({ ok: true, value: null });
  });

  it('still refuses a 404 that is not the unavailable-state case', async () => {
    const { fetchImpl } = fakeFetch(() => json({ code: 'items.not_found', detail: 'Gone.' }, 404));

    const result = await fetchStateAt(config(fetchImpl), 1);

    expect(result).toEqual({ ok: false, refusal: { code: 'items.not_found', detail: 'Gone.' } });
  });
});

describe('restoreRevision', () => {
  it('posts an empty body to the restore route and returns the new head', async () => {
    const { fetchImpl, calls } = fakeFetch(() => json({ headSeq: 101 }));

    const result = await restoreRevision(config(fetchImpl), 42);

    expect(result).toEqual({ ok: true, value: { headSeq: 101 } });
    expect(calls[0]?.url).toBe(`/collab/documents/${ITEM}/history/42/restore`);
    expect(calls[0]?.method).toBe('POST');
    expect(calls[0]?.body).toEqual({});
  });

  it('surfaces a write refusal, such as a read-only grant', async () => {
    const { fetchImpl } = fakeFetch(() =>
      json({ code: 'history.forbidden', detail: 'You cannot write this document.' }, 403),
    );

    const result = await restoreRevision(config(fetchImpl), 42);

    expect(result).toEqual({
      ok: false,
      refusal: { code: 'history.forbidden', detail: 'You cannot write this document.' },
    });
  });
});

describe('named versions', () => {
  const namedVersion = {
    seq: 42,
    name: 'Draft complete',
    createdBy: 'user-1',
    createdAt: '2026-09-20T10:05:00Z',
  };

  it('lists the versions unwrapped from their envelope', async () => {
    const { fetchImpl, calls } = fakeFetch(() => json({ versions: [namedVersion] }));

    const result = await listNamedVersions(config(fetchImpl));

    expect(result).toEqual({ ok: true, value: [namedVersion] });
    expect(calls[0]?.url).toBe(`/collab/documents/${ITEM}/versions`);
  });

  it('posts the seq and name to create one', async () => {
    const { fetchImpl, calls } = fakeFetch(() => json(namedVersion, 201));

    const result = await nameVersion(config(fetchImpl), 42, 'Draft complete');

    expect(result).toEqual({ ok: true, value: namedVersion });
    expect(calls[0]?.method).toBe('POST');
    expect(calls[0]?.url).toBe(`/collab/documents/${ITEM}/versions`);
    expect(calls[0]?.body).toEqual({ seq: 42, name: 'Draft complete' });
  });

  it('deletes one by seq and reports true on a bare 204', async () => {
    const { fetchImpl, calls } = fakeFetch(() => new Response(null, { status: 204 }));

    const result = await deleteNamedVersion(config(fetchImpl), 42);

    expect(result).toEqual({ ok: true, value: true });
    expect(calls[0]?.method).toBe('DELETE');
    expect(calls[0]?.url).toBe(`/collab/documents/${ITEM}/versions/42`);
  });
});
