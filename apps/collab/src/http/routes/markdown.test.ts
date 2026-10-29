import type { Pool } from 'pg';
import { afterEach, describe, expect, it } from 'vitest';

import type { Authorizer, ItemAuthorization } from '../../auth/authorize.ts';
import { MARKDOWN_CHAR_LIMIT } from '../../documents/markdown-body.ts';
import { createSessionAuthenticator } from '../../ws/session-auth.ts';
import { createServer } from '../server.ts';

const ITEM = 'c1000000-0000-4000-8000-000000000031';

const GRANTED: ItemAuthorization = {
  tenantId: 'c1000000-0000-4000-8000-000000000001',
  principalId: 'c1000000-0000-4000-8000-000000000021',
  workspaceId: 'c1000000-0000-4000-8000-000000000011',
  canWrite: true,
  bodyKind: 'note',
};

/** A pool that fails loudly. Reaching it means a refusal did not happen first. */
const refusingPool = new Proxy({} as Pool, {
  get() {
    throw new Error('The request reached the database, which it should have been refused before.');
  },
});

function server(authorization: ItemAuthorization | null, pool: Pool = refusingPool) {
  return createServer({
    pool,
    sessions: createSessionAuthenticator({
      tokens: { validate: () => Promise.resolve({ subject: 'subject', expiresAt: null }) },
      authorizer: {
        authorize: () => Promise.resolve(authorization),
      } satisfies Authorizer,
    }),
    core: {
      getItem: () => Promise.resolve(null),
      listChildren: () => Promise.resolve(null),
      getSchema: () => Promise.resolve(null),
      getViews: () => Promise.resolve(null),
      listComments: () => Promise.resolve(null),
    },
    internalSecret: 'test-internal-secret',
  });
}

const instances: { close: () => Promise<unknown> }[] = [];

function track<T extends { close: () => Promise<unknown> }>(app: T): T {
  instances.push(app);
  return app;
}

afterEach(async () => {
  await Promise.all(instances.splice(0).map((app) => app.close()));
});

describe('note body Markdown routes', () => {
  it('requires a bearer token before it looks at the body', async () => {
    const response = await track(server(GRANTED)).inject({
      method: 'PUT',
      url: `/documents/${ITEM}/markdown`,
      payload: { markdown: 'Hello' },
    });

    expect(response.statusCode).toBe(401);
    expect(response.json()).toMatchObject({ code: 'unauthenticated' });
  });

  it('refuses a reader without opening the document', async () => {
    const response = await track(server({ ...GRANTED, canWrite: false })).inject({
      method: 'POST',
      url: `/documents/${ITEM}/markdown`,
      headers: { authorization: 'Bearer session' },
      payload: { markdown: 'Hello' },
    });

    expect(response.statusCode).toBe(403);
    expect(response.json()).toMatchObject({ code: 'read_only' });
  });

  it.each(['canvas', 'spreadsheet'])('refuses a %s body before any write', async (bodyKind) => {
    const response = await track(server({ ...GRANTED, bodyKind })).inject({
      method: 'PUT',
      url: `/documents/${ITEM}/markdown`,
      headers: { authorization: 'Bearer session' },
      payload: { markdown: '# No' },
    });

    expect(response.statusCode).toBe(422);
    expect(response.json()).toMatchObject({ code: 'body_not_prose' });
  });

  it('refuses a missing markdown string and an over-long one before the database', async () => {
    const app = track(server(GRANTED));
    const missing = await app.inject({
      method: 'PUT',
      url: `/documents/${ITEM}/markdown`,
      headers: { authorization: 'Bearer session' },
      payload: {},
    });
    const tooLong = await app.inject({
      method: 'PUT',
      url: `/documents/${ITEM}/markdown`,
      headers: { authorization: 'Bearer session' },
      payload: { markdown: 'x'.repeat(MARKDOWN_CHAR_LIMIT + 1) },
    });
    const blankAppend = await app.inject({
      method: 'POST',
      url: `/documents/${ITEM}/markdown`,
      headers: { authorization: 'Bearer session' },
      payload: { markdown: ' \n' },
    });

    expect(missing.statusCode).toBe(400);
    expect(missing.json()).toMatchObject({ code: 'invalid_body' });
    expect(tooLong.statusCode).toBe(413);
    expect(tooLong.json()).toMatchObject({ code: 'markdown_too_large' });
    expect(blankAppend.statusCode).toBe(422);
    expect(blankAppend.json()).toMatchObject({ code: 'markdown_invalid' });
  });

  it('treats an unknown body kind as prose and continues to the document', async () => {
    const response = await track(server({ ...GRANTED, bodyKind: 'page' })).inject({
      method: 'GET',
      url: `/documents/${ITEM}/markdown`,
      headers: { authorization: 'Bearer session' },
    });

    expect(response.statusCode).toBe(500);
  });
});
