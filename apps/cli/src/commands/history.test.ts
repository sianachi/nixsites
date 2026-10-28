import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest';
import { http, HttpResponse } from 'msw';
import { setupServer } from 'msw/node';
import { outputOptions } from '../output.ts';
import { captureStdout, makeProfile } from './cli.test-helper.ts';
import {
  listHistory,
  listHistoryVersions,
  nameHistoryVersion,
  restoreHistory,
  showHistory,
} from './history.ts';

const API = 'http://nix.test';
const COLLAB = 'http://nix.test:8100';
const ITEM = '11111111-1111-4111-8111-111111111111';

const server = setupServer(
  http.post(`${API}/public/v1/auth/token`, () =>
    HttpResponse.json({ accessToken: 'jwt-1', tokenType: 'Bearer', expiresInSeconds: 600 }),
  ),
);

beforeAll(() => {
  server.listen({ onUnhandledRequest: 'error' });
});
afterEach(() => {
  server.resetHandlers();
});
afterAll(() => {
  server.close();
});

const withProfile = () => makeProfile({ apiUrl: API, token: 'nixpat_abc', collabUrl: COLLAB });

describe('history list', () => {
  it('sends limit and before to the history route', async () => {
    const { env, done } = await withProfile();
    let seenUrl: string | null = null;
    server.use(
      http.get(`${COLLAB}/documents/:itemId/history`, ({ request }) => {
        seenUrl = request.url;
        return HttpResponse.json({ revisions: [], hasMore: false, headSeq: 0 });
      }),
    );

    await listHistory(
      'default',
      ITEM,
      { limit: 10, before: 99 },
      outputOptions(true, { isTTY: false }),
      { env },
    );

    expect(seenUrl).toBe(`${COLLAB}/documents/${ITEM}/history?limit=10&before=99`);
    await done();
  });

  it('prints a compact table for a person watching a terminal', async () => {
    const { env, done } = await withProfile();
    server.use(
      http.get(`${COLLAB}/documents/:itemId/history`, () =>
        HttpResponse.json({
          revisions: [
            {
              seq: 12,
              fromSeq: 8,
              actorId: 'user-1',
              startedAt: '2026-09-20T10:00:00.000Z',
              endedAt: '2026-09-20T10:05:00.000Z',
              updateCount: 4,
              name: null,
            },
          ],
          hasMore: false,
          headSeq: 12,
        }),
      ),
    );

    const out = await captureStdout(() =>
      listHistory('default', ITEM, {}, outputOptions(false, { isTTY: true }), { env }),
    );

    expect(out).toContain('SEQ');
    expect(out).toContain('12');
    expect(out).toContain('user-1');
    expect((): unknown => JSON.parse(out)).toThrow();
    await done();
  });

  it('prints the raw response when piped or --json is forced', async () => {
    const { env, done } = await withProfile();
    server.use(
      http.get(`${COLLAB}/documents/:itemId/history`, () =>
        HttpResponse.json({ revisions: [], hasMore: false, headSeq: 0 }),
      ),
    );

    const out = await captureStdout(() =>
      listHistory('default', ITEM, {}, outputOptions(true, { isTTY: true }), { env }),
    );

    expect(JSON.parse(out)).toEqual({ revisions: [], hasMore: false, headSeq: 0 });
    await done();
  });

  it('refuses a limit outside 1 through 100 before making a request', async () => {
    const { env, done } = await withProfile();
    await expect(
      listHistory('default', ITEM, { limit: 200 }, outputOptions(true, { isTTY: false }), { env }),
    ).rejects.toThrow(/--limit must be/);
    await done();
  });
});

describe('history show', () => {
  it('prints plaintext to a terminal by default', async () => {
    const { env, done } = await withProfile();
    server.use(
      http.get(`${COLLAB}/documents/:itemId/history/:seq`, () =>
        HttpResponse.json({
          seq: 5,
          document: { type: 'doc', content: [{ type: 'paragraph', content: [] }] },
          plaintext: 'Older words',
          headSeq: 9,
        }),
      ),
    );

    const out = await captureStdout(() =>
      showHistory('default', ITEM, 5, {}, outputOptions(false, { isTTY: true }), { env }),
    );

    expect(out).toBe('Older words\n');
    await done();
  });

  it('renders Markdown through @nix/markdown when --markdown is given', async () => {
    const { env, done } = await withProfile();
    server.use(
      http.get(`${COLLAB}/documents/:itemId/history/:seq`, () =>
        HttpResponse.json({
          seq: 5,
          document: {
            type: 'doc',
            content: [{ type: 'paragraph', content: [{ type: 'text', text: 'Older words' }] }],
          },
          plaintext: 'Older words',
          headSeq: 9,
        }),
      ),
    );

    const out = await captureStdout(() =>
      showHistory('default', ITEM, 5, { markdown: true }, outputOptions(false, { isTTY: true }), {
        env,
      }),
    );

    expect(out.trim()).toBe('Older words');
    await done();
  });

  it('prints the raw collab response when --json is forced', async () => {
    const { env, done } = await withProfile();
    const response = { seq: 5, document: { type: 'doc', content: [] }, plaintext: '', headSeq: 9 };
    server.use(
      http.get(`${COLLAB}/documents/:itemId/history/:seq`, () => HttpResponse.json(response)),
    );

    const out = await captureStdout(() =>
      showHistory('default', ITEM, 5, {}, outputOptions(true, { isTTY: true }), { env }),
    );

    expect(JSON.parse(out)).toEqual(response);
    await done();
  });

  it('maps a 404 for an unreachable seq to the CLI not-found exit code', async () => {
    const { env, done } = await withProfile();
    server.use(
      http.get(`${COLLAB}/documents/:itemId/history/:seq`, () =>
        HttpResponse.json(
          {
            type: 'about:blank',
            title: 'Request refused',
            status: 404,
            code: 'history_state_unavailable',
            detail: 'That revision is no longer retained.',
          },
          { status: 404, headers: { 'content-type': 'application/problem+json' } },
        ),
      ),
    );

    await expect(
      showHistory('default', ITEM, 1, {}, outputOptions(true, { isTTY: false }), { env }),
    ).rejects.toMatchObject({ status: 404, code: 'history_state_unavailable' });
    await done();
  });
});

describe('history restore', () => {
  it('refuses without --yes and never reaches collab', async () => {
    const { env, done } = await withProfile();
    let called = false;
    server.use(
      http.post(`${COLLAB}/documents/:itemId/history/:seq/restore`, () => {
        called = true;
        return HttpResponse.json({ headSeq: 1 });
      }),
    );

    await expect(
      restoreHistory('default', ITEM, 5, false, outputOptions(true, { isTTY: false }), { env }),
    ).rejects.toThrow('requires --yes');
    expect(called).toBe(false);
    await done();
  });

  it('restores and prints the new head once confirmed', async () => {
    const { env, done } = await withProfile();
    server.use(
      http.post(`${COLLAB}/documents/:itemId/history/:seq/restore`, () =>
        HttpResponse.json({ headSeq: 21 }),
      ),
    );

    const out = await captureStdout(() =>
      restoreHistory('default', ITEM, 12, true, outputOptions(true, { isTTY: false }), { env }),
    );

    expect(JSON.parse(out)).toEqual({ restored: true, itemId: ITEM, seq: 12, headSeq: 21 });
    await done();
  });
});

describe('history name', () => {
  it('posts the seq and name and prints the named version', async () => {
    const { env, done } = await withProfile();
    let posted: unknown = null;
    server.use(
      http.post(`${COLLAB}/documents/:itemId/versions`, async ({ request }) => {
        posted = await request.json();
        return HttpResponse.json(
          {
            seq: 12,
            name: 'Before the rewrite',
            createdBy: 'user-1',
            createdAt: '2026-09-20T10:00:00Z',
          },
          { status: 201 },
        );
      }),
    );

    const out = await captureStdout(() =>
      nameHistoryVersion(
        'default',
        ITEM,
        12,
        'Before the rewrite',
        outputOptions(true, { isTTY: false }),
        { env },
      ),
    );

    expect(posted).toEqual({ seq: 12, name: 'Before the rewrite' });
    expect(JSON.parse(out)).toMatchObject({ seq: 12, name: 'Before the rewrite' });
    await done();
  });

  it('refuses an empty or over-long name before making a request', async () => {
    const { env, done } = await withProfile();
    await expect(
      nameHistoryVersion('default', ITEM, 12, '', outputOptions(true, { isTTY: false }), { env }),
    ).rejects.toThrow(/1 through 120/);
    await expect(
      nameHistoryVersion(
        'default',
        ITEM,
        12,
        'x'.repeat(121),
        outputOptions(true, { isTTY: false }),
        { env },
      ),
    ).rejects.toThrow(/1 through 120/);
    await done();
  });
});

describe('history versions', () => {
  it('prints a compact table for a person watching a terminal', async () => {
    const { env, done } = await withProfile();
    server.use(
      http.get(`${COLLAB}/documents/:itemId/versions`, () =>
        HttpResponse.json({
          versions: [
            {
              seq: 12,
              name: 'Before the rewrite',
              createdBy: 'user-1',
              createdAt: '2026-09-20T10:00:00Z',
            },
          ],
        }),
      ),
    );

    const out = await captureStdout(() =>
      listHistoryVersions('default', ITEM, outputOptions(false, { isTTY: true }), { env }),
    );

    expect(out).toContain('NAME');
    expect(out).toContain('Before the rewrite');
    expect((): unknown => JSON.parse(out)).toThrow();
    await done();
  });

  it('prints the raw response otherwise', async () => {
    const { env, done } = await withProfile();
    server.use(
      http.get(`${COLLAB}/documents/:itemId/versions`, () => HttpResponse.json({ versions: [] })),
    );

    const out = await captureStdout(() =>
      listHistoryVersions('default', ITEM, outputOptions(true, { isTTY: true }), { env }),
    );

    expect(JSON.parse(out)).toEqual({ versions: [] });
    await done();
  });
});
