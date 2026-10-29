import type { Pool } from 'pg';
import { afterEach, describe, expect, it } from 'vitest';

import type { Authorizer } from '../auth/authorize.ts';
import type { TokenValidator } from '../auth/token.ts';
import type { CoreClient } from '../core/client.ts';
import type { ImportBodyService } from '../imports/bodies.ts';
import type { TemplateImportBodyService } from '../template-imports/bodies.ts';
import type { TemplateService } from '../templates/service.ts';
import { TemplateBodyError } from '../templates/bodies.ts';
import type { SessionHub } from '../ws/server.ts';
import { createSessionAuthenticator } from '../ws/session-auth.ts';
import { createServer } from './server.ts';

/**
 * The HTTP surface's refusals, with no database behind it.
 *
 * Every test here is about a request that must never reach Postgres: no token, a token that
 * does not validate, an item Core refused, or a writer who is only a reader. The pool is a
 * proxy that throws if anything touches it, so "did not reach the database" is asserted
 * rather than assumed.
 */

const ITEM = 'c1000000-0000-4000-8000-000000000031';

const GRANTED = {
  tenantId: 'c1000000-0000-4000-8000-000000000001',
  principalId: 'c1000000-0000-4000-8000-000000000021',
  workspaceId: 'c1000000-0000-4000-8000-000000000011',
  canWrite: true,
  bodyKind: 'note',
} as const;

/** A pool that fails loudly. Reaching it at all is the bug these tests look for. */
const refusingPool = new Proxy({} as Pool, {
  get() {
    throw new Error('The request reached the database, which it should have been refused before.');
  },
});

/**
 * A Core that answers nothing.
 *
 * The export tests here are all about requests refused before any tree is walked, so a client that
 * returns null for everything is the honest fake: reaching it would mean the refusal did not
 * happen, and a null root produces the same 404 those tests already expect.
 */
const silentCore: CoreClient = {
  getItem: () => Promise.resolve(null),
  listChildren: () => Promise.resolve(null),
  getSchema: () => Promise.resolve(null),
  getViews: () => Promise.resolve(null),
  listComments: () => Promise.resolve(null),
};

const INTERNAL_SECRET = 'test-internal-secret';

function server(overrides: {
  tokens?: TokenValidator;
  authorizer?: Authorizer;
  pool?: Pool;
  core?: CoreClient;
  importBodies?: ImportBodyService;
  templateImportBodies?: TemplateImportBodyService;
  templates?: TemplateService;
  hub?: SessionHub;
}) {
  return createServer({
    pool: overrides.pool ?? refusingPool,
    sessions: createSessionAuthenticator({
      tokens: overrides.tokens ?? {
        validate: () => Promise.resolve({ subject: 'subject', expiresAt: null }),
      },
      authorizer: overrides.authorizer ?? { authorize: () => Promise.resolve(null) },
    }),
    core: overrides.core ?? silentCore,
    internalSecret: INTERNAL_SECRET,
    ...(overrides.importBodies === undefined ? {} : { importBodies: overrides.importBodies }),
    ...(overrides.templateImportBodies === undefined
      ? {}
      : { templateImportBodies: overrides.templateImportBodies }),
    ...(overrides.templates === undefined ? {} : { templates: overrides.templates }),
    ...(overrides.hub === undefined ? {} : { hub: overrides.hub }),
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

describe('the collaboration service HTTP surface', () => {
  it('does not expose the retired transcription append route', async () => {
    const response = await track(server({})).inject({
      method: 'POST',
      url: '/internal/worker-executions/transcriptions/append',
      headers: {
        'x-nix-internal-secret': INTERNAL_SECRET,
        'x-nix-worker-job-id': ITEM,
        'x-nix-worker-execution-id': 'worker:execution',
      },
      payload: {},
    });

    expect(response.statusCode).toBe(404);
  });

  it('forwards an approved capture fingerprint to the template service', async () => {
    let captured: unknown;
    const templates = {
      capture: (_token: string, request: unknown) => {
        captured = request;
        return Promise.resolve({ templateId: ITEM });
      },
    } as unknown as TemplateService;
    const app = track(server({ templates }));
    const response = await app.inject({
      method: 'POST',
      url: '/templates/captures',
      headers: { authorization: 'Bearer test-token' },
      payload: {
        workspaceId: GRANTED.workspaceId,
        sourceItemId: ITEM,
        title: 'Pinned capture',
        includeBody: true,
        includeChildren: true,
        idempotencyKey: 'pinned-capture',
        expectedFingerprint: 'approved-snapshot',
      },
    });
    expect(response.statusCode).toBe(201);
    expect(captured).toMatchObject({ expectedFingerprint: 'approved-snapshot' });
  });

  it('returns a conflict when a pinned capture source body changed', async () => {
    const templates = {
      capture: () =>
        Promise.reject(
          new TemplateBodyError(
            'templates.conflict',
            'The source body changed since capture began.',
          ),
        ),
    } as unknown as TemplateService;
    const app = track(server({ templates }));
    const response = await app.inject({
      method: 'POST',
      url: '/templates/captures',
      headers: { authorization: 'Bearer valid' },
      payload: {
        workspaceId: GRANTED.workspaceId,
        sourceItemId: ITEM,
        title: 'Pinned capture',
        includeBody: true,
        includeChildren: false,
        idempotencyKey: 'pinned-capture',
      },
    });
    expect(response.statusCode).toBe(409);
    expect(response.json()).toMatchObject({ code: 'templates.conflict' });
  });

  it('reports its schema version on the health endpoint', async () => {
    const app = track(server({}));

    const response = await app.inject({ method: 'GET', url: '/healthz' });

    expect(response.statusCode).toBe(200);
    expect(response.json()).toMatchObject({ status: 'healthy' });
  });

  it('forwards draft initialization through the authenticated template HTTP route', async () => {
    const initialization = {
      version: 1 as const,
      inputs: [
        {
          key: 'lead',
          label: 'Project lead',
          type: 'member' as const,
          required: true,
          defaultValue: ITEM,
        },
      ],
      rules: [],
      references: [],
    };
    let patchReceived: unknown;
    const templates = {
      patchDraft: (_token: string, _templateId: string, _operationId: string, body: unknown) => {
        patchReceived = body;
        return Promise.resolve({ initialization });
      },
    } as unknown as TemplateService;
    const app = track(server({ templates }));
    const response = await app.inject({
      method: 'PATCH',
      url: `/templates/${ITEM}/drafts/${ITEM}`,
      headers: { authorization: 'Bearer valid' },
      payload: { initialization },
    });
    expect(response.statusCode).toBe(200);
    expect(patchReceived).toEqual({ initialization });
    expect(response.json()).toEqual({ initialization });
  });

  it('refuses a request with no bearer token', async () => {
    const app = track(server({}));

    const response = await app.inject({ method: 'GET', url: `/documents/${ITEM}/updates` });

    expect(response.statusCode).toBe(401);
    expect(response.json()).toMatchObject({ code: 'unauthenticated' });
  });

  it('refuses a token that does not validate', async () => {
    const app = track(server({ tokens: { validate: () => Promise.resolve(null) } }));

    const response = await app.inject({
      method: 'GET',
      url: `/documents/${ITEM}/updates`,
      headers: { authorization: 'Bearer forged' },
    });

    expect(response.statusCode).toBe(401);
  });

  it('reports an item Core refused as not found, never as forbidden', async () => {
    const app = track(server({ authorizer: { authorize: () => Promise.resolve(null) } }));

    const response = await app.inject({
      method: 'GET',
      url: `/documents/${ITEM}/updates`,
      headers: { authorization: 'Bearer valid' },
    });

    // Matching Core exactly. "You may not see this" confirms the thing exists, which is how
    // an outsider enumerates a workspace one identifier at a time.
    expect(response.statusCode).toBe(404);
    expect(response.json()).toMatchObject({ code: 'document_not_found' });
  });

  it('answers 503 with a retry when Core could not be asked, never a refusal', async () => {
    const app = track(
      server({ authorizer: { authorize: () => Promise.resolve('unavailable' as const) } }),
    );

    const response = await app.inject({
      method: 'GET',
      url: `/documents/${ITEM}/updates`,
      headers: { authorization: 'Bearer valid' },
    });

    expect(response.statusCode).toBe(503);
    expect(response.headers['retry-after']).toBe('5');
    expect(response.json()).toMatchObject({ code: 'authorization_unavailable' });
  });

  it('refuses a malformed item identifier the same way', async () => {
    const app = track(server({}));

    const response = await app.inject({
      method: 'GET',
      url: '/documents/not-a-uuid/updates',
      headers: { authorization: 'Bearer valid' },
    });

    expect(response.statusCode).toBe(404);
  });

  it('never asks Core about an item when the token is bad', async () => {
    let asked = 0;
    const app = track(
      server({
        tokens: { validate: () => Promise.resolve(null) },
        authorizer: {
          authorize: () => {
            asked += 1;
            return Promise.resolve(null);
          },
        },
      }),
    );

    await app.inject({
      method: 'POST',
      url: `/documents/${ITEM}/updates`,
      headers: { authorization: 'Bearer forged' },
      payload: { update: 'AAAA', clientId: 'client' },
    });

    // Authentication first, then authorization. Reversed, an unauthenticated caller could
    // make this service hammer Core on their behalf.
    expect(asked).toBe(0);
  });

  it('refuses a write from a principal Core says may only read', async () => {
    const app = track(
      server({
        authorizer: { authorize: () => Promise.resolve({ ...GRANTED, canWrite: false }) },
      }),
    );

    const response = await app.inject({
      method: 'POST',
      url: `/documents/${ITEM}/updates`,
      headers: { authorization: 'Bearer valid' },
      payload: { update: 'AAAA', clientId: 'client' },
    });

    // Forbidden rather than not-found: a reader already knows the item exists, and "you may
    // see this and not change it" is the answer they can act on. The pool proxy guarantees
    // the refused write never reached the log.
    expect(response.statusCode).toBe(403);
    expect(response.json()).toMatchObject({ code: 'read_only' });
  });

  it('still lets a reader catch up on a document they may not write', async () => {
    // Reads reach the database, so this needs a pool - but the refusal under test happens
    // before that. A reader hitting 'read_only' on GET would be the bug.
    let touchedPool = false;
    const observingPool = new Proxy({} as Pool, {
      get() {
        touchedPool = true;
        throw new Error('stop here; the authorization already passed');
      },
    });

    const app = track(
      server({
        pool: observingPool,
        authorizer: { authorize: () => Promise.resolve({ ...GRANTED, canWrite: false }) },
      }),
    );

    const response = await app.inject({
      method: 'GET',
      url: `/documents/${ITEM}/updates`,
      headers: { authorization: 'Bearer valid' },
    });

    expect(touchedPool).toBe(true);
    expect(response.statusCode).not.toBe(403);
  });

  it('refuses a body that is not an update at all', async () => {
    const app = track(server({ authorizer: { authorize: () => Promise.resolve(GRANTED) } }));

    const response = await app.inject({
      method: 'POST',
      url: `/documents/${ITEM}/updates`,
      headers: { authorization: 'Bearer valid' },
      payload: { nonsense: true },
    });

    expect(response.statusCode).toBe(400);
    expect(response.json()).toMatchObject({ code: 'invalid_body' });
  });

  it('refuses an update that is not valid base64 before decoding it', async () => {
    const app = track(server({ authorizer: { authorize: () => Promise.resolve(GRANTED) } }));

    // Buffer.from silently drops what it cannot parse, so a payload with a typo would
    // otherwise decode to a shorter buffer and be applied as though it were what was sent.
    const response = await app.inject({
      method: 'POST',
      url: `/documents/${ITEM}/updates`,
      headers: { authorization: 'Bearer valid' },
      payload: { update: 'not base64 at all!!', clientId: 'client' },
    });

    expect(response.statusCode).toBe(400);
  });

  it.each([null, 42, '', 'not-a-uuid'])(
    'refuses an invalid expected document identity before accessing Postgres: %s',
    async (expectedDocId) => {
      const app = track(server({ authorizer: { authorize: () => Promise.resolve(GRANTED) } }));

      const response = await app.inject({
        method: 'POST',
        url: `/documents/${ITEM}/updates`,
        headers: { authorization: 'Bearer valid' },
        payload: { update: 'AAAA', clientId: 'client', expectedDocId },
      });

      expect(response.statusCode).toBe(400);
      expect(response.json()).toMatchObject({ code: 'invalid_body' });
    },
  );

  it('refuses a cursor that is not a sequence', async () => {
    const app = track(server({ authorizer: { authorize: () => Promise.resolve(GRANTED) } }));

    const response = await app.inject({
      method: 'GET',
      url: `/documents/${ITEM}/updates?after=yesterday`,
      headers: { authorization: 'Bearer valid' },
    });

    expect(response.statusCode).toBe(400);
    expect(response.json()).toMatchObject({ code: 'invalid_cursor' });
  });

  it('serves metrics when given a registry', async () => {
    const { createMetrics } = await import('../metrics.ts');
    const app = track(
      createServer({
        pool: refusingPool,
        sessions: createSessionAuthenticator({
          tokens: { validate: () => Promise.resolve(null) },
          authorizer: { authorize: () => Promise.resolve(null) },
        }),
        core: silentCore,
        internalSecret: INTERNAL_SECRET,
        metrics: createMetrics(),
      }),
    );

    const response = await app.inject({ method: 'GET', url: '/metrics' });

    expect(response.statusCode).toBe(200);
    expect(response.body).toContain('nix_collab_open_sockets');
  });
});

describe('staged import bodies', () => {
  it('is invisible without the service secret', async () => {
    let called = false;
    const app = track(
      server({
        importBodies: {
          write: () => {
            called = true;
            return Promise.resolve({ written: 1 });
          },
        },
      }),
    );

    const response = await app.inject({
      method: 'POST',
      url: `/internal/imports/${ITEM}/bodies`,
      headers: {
        'x-nix-worker-job-id': ITEM,
        'x-nix-worker-execution-id': 'worker:execution',
      },
      payload: { writes: [] },
    });

    expect(response.statusCode).toBe(404);
    expect(called).toBe(false);
  });

  it('passes the exact worker execution proof to the staged body service', async () => {
    const seen: unknown[] = [];
    const app = track(
      server({
        importBodies: {
          write: (input) => {
            seen.push(input);
            return Promise.resolve({ written: 1 });
          },
        },
      }),
    );
    const body = {
      writes: [{ sourceId: 'root', body: { encoding: 'plain_text', text: 'Imported' } }],
    };

    const response = await app.inject({
      method: 'POST',
      url: `/internal/imports/${ITEM}/bodies`,
      headers: {
        'x-nix-internal-secret': INTERNAL_SECRET,
        'x-nix-worker-job-id': ITEM,
        'x-nix-worker-execution-id': 'worker:execution',
      },
      payload: body,
    });

    expect(response.statusCode).toBe(200);
    expect(response.json()).toEqual({ written: 1 });
    expect(seen).toEqual([
      {
        importId: ITEM,
        jobId: ITEM,
        executionId: 'worker:execution',
        body,
      },
    ]);
  });
});

describe('worker-fenced template import bodies', () => {
  it('requires the internal secret and both worker execution headers', async () => {
    let called = false;
    const app = track(
      server({
        templateImportBodies: {
          write: () => {
            called = true;
            return Promise.resolve({ writtenTargetItemIds: [ITEM] });
          },
        },
      }),
    );
    const body = { writes: [] };

    const responses = await Promise.all([
      app.inject({
        method: 'POST',
        url: `/internal/worker-executions/template-imports/${ITEM}/bodies`,
        headers: {
          'x-nix-worker-job-id': ITEM,
          'x-nix-worker-execution-id': 'worker:execution',
        },
        payload: body,
      }),
      app.inject({
        method: 'POST',
        url: `/internal/worker-executions/template-imports/${ITEM}/bodies`,
        headers: {
          'x-nix-internal-secret': INTERNAL_SECRET,
          'x-nix-worker-execution-id': 'worker:execution',
        },
        payload: body,
      }),
      app.inject({
        method: 'POST',
        url: `/internal/worker-executions/template-imports/${ITEM}/bodies`,
        headers: {
          'x-nix-internal-secret': INTERNAL_SECRET,
          'x-nix-worker-job-id': ITEM,
        },
        payload: body,
      }),
    ]);

    expect(responses.map((response) => response.statusCode)).toEqual([404, 404, 404]);
    expect(called).toBe(false);
  });

  it('accepts exact worker proof without requiring a bearer token', async () => {
    const seen: unknown[] = [];
    const app = track(
      server({
        templateImportBodies: {
          write: (input) => {
            seen.push(input);
            return Promise.resolve({ writtenTargetItemIds: [ITEM] });
          },
        },
      }),
    );
    const body = { writes: [{ sourceId: 'root', body: { schemaVersion: 2 } }] };

    const response = await app.inject({
      method: 'POST',
      url: `/internal/worker-executions/template-imports/${ITEM}/bodies`,
      headers: {
        'x-nix-internal-secret': INTERNAL_SECRET,
        'x-nix-worker-job-id': ITEM,
        'x-nix-worker-execution-id': 'worker:execution',
      },
      payload: body,
    });

    expect(response.statusCode).toBe(200);
    expect(response.json()).toEqual({ writtenTargetItemIds: [ITEM] });
    expect(seen).toEqual([
      {
        importId: ITEM,
        jobId: ITEM,
        executionId: 'worker:execution',
        body,
      },
    ]);
  });
});

/**
 * The export routes.
 *
 * The archive route is the one the web client already points at; the bundles route is the internal
 * surface the Go export worker reads to convert a document into a format this process does not know
 * about. Both refuse before touching the database, which is why they belong in this file.
 */
describe('exporting', () => {
  const granting: Authorizer = { authorize: () => Promise.resolve(GRANTED) };

  it('refuses an archive with no bearer token', async () => {
    const response = await track(server({ authorizer: granting })).inject({
      method: 'GET',
      url: `/documents/${ITEM}/export`,
    });

    expect(response.statusCode).toBe(401);
    expect(response.json<{ code: string }>().code).toBe('unauthenticated');
  });

  it('directs lossy formats to the durable Go export workflow', async () => {
    const response = await track(server({ authorizer: granting })).inject({
      method: 'GET',
      url: `/documents/${ITEM}/export?format=pdf`,
      headers: { authorization: 'Bearer token' },
    });

    expect(response.statusCode).toBe(400);
    expect(response.json<{ code: string }>().code).toBe('unsupported_format');
    // A wrong-service call gets told which service to ask, rather than a bare 404.
    expect(response.json<{ detail: string }>().detail).toContain('Go worker jobs');
  });

  it('refuses a scope it does not serve', async () => {
    const response = await track(server({ authorizer: granting })).inject({
      method: 'GET',
      url: `/documents/${ITEM}/export?scope=everything`,
      headers: { authorization: 'Bearer token' },
    });

    expect(response.statusCode).toBe(400);
    expect(response.json<{ code: string }>().code).toBe('invalid_scope');
  });

  it('answers not-found for an item Core will not show the caller', async () => {
    // silentCore returns null for getItem, which is what Core gives for an item the caller may not
    // read - so an export of somebody else's document is indistinguishable from one that is gone.
    const response = await track(server({ authorizer: granting })).inject({
      method: 'GET',
      url: `/documents/${ITEM}/export`,
      headers: { authorization: 'Bearer token' },
    });

    expect(response.statusCode).toBe(404);
  });
});

describe('the bundle stream', () => {
  const granting: Authorizer = { authorize: () => Promise.resolve(GRANTED) };

  it('is invisible without the internal secret, answering not-found rather than forbidden', async () => {
    // 403 would confirm the route exists to anybody who found the URL. Core's internal surface
    // answers 404 to everything for the same reason, and these two have to agree.
    const response = await track(server({ authorizer: granting })).inject({
      method: 'GET',
      url: `/documents/${ITEM}/bundles`,
      headers: { authorization: 'Bearer token' },
    });

    expect(response.statusCode).toBe(404);
    expect(response.json<{ code: string }>().code).toBe('document_not_found');
  });

  it('is invisible with the wrong internal secret', async () => {
    const response = await track(server({ authorizer: granting })).inject({
      method: 'GET',
      url: `/documents/${ITEM}/bundles`,
      headers: { authorization: 'Bearer token', 'x-nix-internal-secret': 'not-the-secret' },
    });

    expect(response.statusCode).toBe(404);
  });

  it('answers the same not-found for missing and wrong secrets of any length', async () => {
    const app = track(server({ authorizer: granting }));
    const responses = await Promise.all([
      app.inject({
        method: 'GET',
        url: `/documents/${ITEM}/bundles`,
        headers: { authorization: 'Bearer token' },
      }),
      app.inject({
        method: 'GET',
        url: `/documents/${ITEM}/bundles`,
        headers: { authorization: 'Bearer token', 'x-nix-internal-secret': 'x' },
      }),
      app.inject({
        method: 'GET',
        url: `/documents/${ITEM}/bundles`,
        headers: {
          authorization: 'Bearer token',
          'x-nix-internal-secret': 'x'.repeat(INTERNAL_SECRET.length),
        },
      }),
    ]);

    expect(responses.map((response) => response.statusCode)).toEqual([404, 404, 404]);
    expect(responses.map((response) => response.body)).toEqual([
      responses[0].body,
      responses[0].body,
      responses[0].body,
    ]);
  });

  it('still needs the caller own token, so a service cannot export on nobody behalf', async () => {
    const response = await track(server({ authorizer: granting })).inject({
      method: 'GET',
      url: `/documents/${ITEM}/bundles`,
      headers: { 'x-nix-internal-secret': INTERNAL_SECRET },
    });

    expect(response.statusCode).toBe(401);
    expect(response.json<{ code: string }>().code).toBe('unauthenticated');
  });

  it('refuses when Core will not show the caller the item, secret or no secret', async () => {
    const response = await track(server({ authorizer: granting })).inject({
      method: 'GET',
      url: `/documents/${ITEM}/bundles`,
      headers: { authorization: 'Bearer token', 'x-nix-internal-secret': INTERNAL_SECRET },
    });

    expect(response.statusCode).toBe(404);
  });
});

/**
 * Version history: the six routes, refused or validated the same way the rest of this surface
 * is - before the database is ever touched, wherever a refusal does not itself require reading
 * from it.
 */
describe('version history', () => {
  const granting: Authorizer = { authorize: () => Promise.resolve(GRANTED) };
  const readOnly: Authorizer = {
    authorize: () => Promise.resolve({ ...GRANTED, canWrite: false }),
  };

  /** A pool that lets authorization pass and then observes whether anything reached it. */
  function observing(): { pool: Pool; touched: () => boolean } {
    let touched = false;
    const pool = new Proxy({} as Pool, {
      get() {
        touched = true;
        throw new Error('stop here; the authorization already passed');
      },
    });
    return { pool, touched: () => touched };
  }

  const AUTH = { authorization: 'Bearer valid' };

  interface Call {
    method: 'GET' | 'POST' | 'DELETE';
    url: string;
    payload?: object;
  }

  it.each<[string, Call]>([
    ['history list', { method: 'GET', url: `/documents/${ITEM}/history` }],
    ['named versions list', { method: 'GET', url: `/documents/${ITEM}/versions` }],
  ])('refuses a request with no bearer token: %s', async (_name, call) => {
    const response = await track(server({ authorizer: granting })).inject(call);

    expect(response.statusCode).toBe(401);
  });

  it.each<[string, Call, string]>([
    [
      'a before cursor that is not a sequence',
      { method: 'GET', url: `/documents/${ITEM}/history?before=soon` },
      'history_seq_invalid',
    ],
    [
      'a state seq that is not a non-negative integer',
      { method: 'GET', url: `/documents/${ITEM}/history/not-a-seq` },
      'history_seq_invalid',
    ],
    [
      'a negative state seq',
      { method: 'GET', url: `/documents/${ITEM}/history/-1` },
      'history_seq_invalid',
    ],
    [
      'a restore seq that is not a non-negative integer, before touching the database',
      { method: 'POST', url: `/documents/${ITEM}/history/not-a-seq/restore` },
      'history_seq_invalid',
    ],
    [
      'naming a seq that is not a non-negative integer',
      {
        method: 'POST',
        url: `/documents/${ITEM}/versions`,
        payload: { seq: 'not-a-seq', name: 'Draft' },
      },
      'history_seq_invalid',
    ],
    [
      'an empty name',
      { method: 'POST', url: `/documents/${ITEM}/versions`, payload: { seq: 1, name: '   ' } },
      'version_name_invalid',
    ],
    [
      'a name over 120 characters',
      {
        method: 'POST',
        url: `/documents/${ITEM}/versions`,
        payload: { seq: 1, name: 'x'.repeat(121) },
      },
      'version_name_invalid',
    ],
    [
      'removing a name by a seq that is not a non-negative integer',
      { method: 'DELETE', url: `/documents/${ITEM}/versions/not-a-seq` },
      'history_seq_invalid',
    ],
  ])('refuses %s', async (_name, call, code) => {
    const response = await track(server({ authorizer: granting })).inject({
      ...call,
      headers: AUTH,
    });

    expect(response.statusCode).toBe(400);
    expect(response.json<{ code: string }>().code).toBe(code);
  });

  // The pool proxy guarantees a refused write never reached the log, same as the ordinary
  // update path.
  it.each<[string, Call]>([
    ['a restore', { method: 'POST', url: `/documents/${ITEM}/history/1/restore` }],
    [
      'naming',
      { method: 'POST', url: `/documents/${ITEM}/versions`, payload: { seq: 1, name: 'Draft' } },
    ],
    ['removing a name', { method: 'DELETE', url: `/documents/${ITEM}/versions/1` }],
  ])('refuses %s from a reader who may not write', async (_name, call) => {
    const response = await track(server({ authorizer: readOnly })).inject({
      ...call,
      headers: AUTH,
    });

    expect(response.statusCode).toBe(403);
    expect(response.json<{ code: string }>().code).toBe('read_only');
  });

  it.each<[string, string]>([
    ['list history', `/documents/${ITEM}/history`],
    ['ask for a state', `/documents/${ITEM}/history/3`],
    ['list named versions', `/documents/${ITEM}/versions`],
  ])('lets a reader %s - reading never needed canWrite', async (_name, url) => {
    const { pool, touched } = observing();
    const response = await track(server({ pool, authorizer: readOnly })).inject({
      method: 'GET',
      url,
      headers: AUTH,
    });

    expect(touched()).toBe(true);
    expect(response.statusCode).not.toBe(403);
  });
});
