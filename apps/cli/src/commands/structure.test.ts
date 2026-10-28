import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest';
import { http, HttpResponse } from 'msw';
import { setupServer } from 'msw/node';
import { writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { captureJson, makeProfile } from './cli.test-helper.ts';
import {
  getSchema,
  parseAssignments,
  readStructureOutline,
  setProps,
  setSchema,
} from './structure.ts';

const API = 'http://nix.test';
const ITEM = '11111111-1111-4111-8111-111111111111';

/** A full ItemResponse, so the client's item schema parses a properties write. */
function item(props: Record<string, unknown>): Record<string, unknown> {
  return {
    id: ITEM,
    workspaceId: '22222222-2222-4222-8222-222222222222',
    parentId: null,
    type: 'note',
    title: 'Soup',
    hasChildren: false,
    seq: '1',
    lifecycleState: 'active',
    properties: props,
    createdAt: '2026-01-01T00:00:00Z',
    updatedAt: '2026-01-01T00:00:00Z',
  };
}

function propertyDef(key: string, type: string): Record<string, unknown> {
  // `expression` is what a formula property carries and null on every other type; the client's
  // parse fills it in, so a file that omits it is still sent with it.
  return {
    key,
    label: key,
    type,
    options: [],
    required: false,
    expression: null,
    aggregate: null,
    source: null,
    choiceSource: null,
  };
}

function formulaDef(key: string, expression: string): Record<string, unknown> {
  return {
    key,
    label: key,
    type: 'formula',
    options: [],
    required: false,
    expression,
    aggregate: null,
    source: null,
    choiceSource: null,
  };
}

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

const withProfile = () => makeProfile({ apiUrl: API, token: 'nixpat_abc' });

describe('parseAssignments', () => {
  it('parses JSON values where they parse and plain strings otherwise', () => {
    const bag = parseAssignments([
      'status=done',
      'count=5',
      'archived=null',
      'due=2026-01-01',
      'flag=true',
    ]);
    // A bare word is a string; a number is a number; null clears; a date is a string; a bool is a bool.
    expect(bag).toEqual({
      status: 'done',
      count: 5,
      archived: null,
      due: '2026-01-01',
      flag: true,
    });
  });

  it('refuses a pair with no key before the equals', () => {
    expect(() => parseAssignments(['=value'])).toThrow(/key=value/);
    expect(() => parseAssignments(['loose'])).toThrow(/key=value/);
  });
});

describe('nixctl props set', () => {
  it('sends the merged bag and reports which keys it set', async () => {
    const { env, done } = await withProfile();
    let sentBody: unknown;
    server.use(
      http.patch(`${API}/api/v1/items/:itemId/properties`, async ({ request }) => {
        sentBody = await request.json();
        return HttpResponse.json(item({ status: 'done', count: 5 }));
      }),
    );

    const printed = (await captureJson((json) =>
      setProps('default', ITEM, ['status=done', 'count=5', 'archived=null'], json, { env }),
    )) as { id: string; set: string[] };

    expect(sentBody).toEqual({ properties: { status: 'done', count: 5, archived: null } });
    expect(printed.set).toEqual(['status', 'count', 'archived']);
    expect(printed.id).toBe(ITEM);
    await done();
  });

  it('maps a not-found item to exit 4', async () => {
    const { env, done } = await withProfile();
    server.use(
      http.patch(`${API}/api/v1/items/:itemId/properties`, () =>
        HttpResponse.json(
          { code: 'items.not_found', detail: 'No item is visible.' },
          { status: 404 },
        ),
      ),
    );
    await expect(
      captureJson((json) => setProps('default', ITEM, ['a=1'], json, { env })),
    ).rejects.toMatchObject({
      status: 404,
    });
    await done();
  });
});

describe('nixctl structure read', () => {
  it('prints fields, views and the bounded child count from the shared companion reader', async () => {
    const { env, done } = await withProfile();
    const field = {
      key: 'status',
      label: 'Status',
      type: 'select',
      options: ['To read', 'Done'],
      required: false,
      expression: null,
      aggregate: null,
      source: null,
      choiceSource: null,
    };
    server.use(
      http.get(`${API}/api/v1/items/:itemId`, () => HttpResponse.json(item({}))),
      http.get(`${API}/api/v1/items/:itemId/schema`, () =>
        HttpResponse.json({ properties: [field], declared: [field], inherit: true }),
      ),
      http.get(`${API}/api/v1/items/:itemId/views`, () =>
        HttpResponse.json({
          views: [
            {
              id: 'view-board',
              name: 'Board',
              kind: 'board',
              groupBy: 'status',
              dateProperty: null,
              columns: [],
              interactiveForm: null,
            },
          ],
          unrenderable: [],
          default: 'view-board',
        }),
      ),
      http.get(`${API}/api/v1/workspaces/:workspaceId/items`, () =>
        HttpResponse.json({ items: [], nextCursor: null }),
      ),
    );

    const printed = (await captureJson((json) =>
      readStructureOutline('default', ITEM, json, { env }),
    )) as {
      item: { id: string; title: string };
      fields: { key: string; label: string; inherited: boolean; computed: boolean }[];
      views: { name: string; kind: string }[];
      childCount: number | 'many';
    };

    expect(printed.item).toMatchObject({ id: ITEM, title: 'Soup' });
    expect(printed.fields).toMatchObject([
      { key: 'status', label: 'Status', inherited: false, computed: false },
    ]);
    expect(printed.views).toMatchObject([{ name: 'Board', kind: 'board' }]);
    expect(printed.childCount).toBe(0);
    await done();
  });
});

describe('nixctl schema get', () => {
  it('prints the resolved schema, what is declared, and whether it inherits', async () => {
    const { env, done } = await withProfile();
    server.use(
      http.get(`${API}/api/v1/items/:itemId/schema`, () =>
        HttpResponse.json({
          properties: [propertyDef('status', 'select'), propertyDef('due', 'date')],
          declared: [propertyDef('due', 'date')],
          inherit: true,
        }),
      ),
    );

    const printed = (await captureJson((json) => getSchema('default', ITEM, json, { env }))) as {
      count: number;
      inherit: boolean;
      declared: unknown[];
    };

    expect(printed.count).toBe(2);
    expect(printed.inherit).toBe(true);
    expect(printed.declared).toHaveLength(1);
    await done();
  });
});

describe('nixctl schema set', () => {
  it('reads the file, sends the declared set, and prints the effective count', async () => {
    const { env, dir, done } = await withProfile();
    const file = join(dir, 'schema.json');
    await writeFile(
      file,
      // Written without `expression`, as somebody would author it: the parse fills the null in,
      // which is what keeps a schema file from before the field valid.
      JSON.stringify({
        properties: [
          { key: 'status', label: 'status', type: 'select', options: [], required: false },
        ],
        inherit: false,
      }),
      'utf8',
    );
    let sentBody: unknown;
    server.use(
      http.put(`${API}/api/v1/items/:itemId/schema`, async ({ request }) => {
        sentBody = await request.json();
        return HttpResponse.json({
          properties: [propertyDef('status', 'select')],
          declared: [propertyDef('status', 'select')],
          inherit: false,
        });
      }),
    );

    const printed = (await captureJson((json) =>
      setSchema('default', ITEM, file, json, { env }),
    )) as {
      count: number;
      inherit: boolean;
    };

    expect(sentBody).toEqual({ properties: [propertyDef('status', 'select')], inherit: false });
    expect(printed.count).toBe(1);
    expect(printed.inherit).toBe(false);
    await done();
  });

  it('carries a rollup property fold through to Core', async () => {
    const { env, dir, done } = await withProfile();
    const file = join(dir, 'schema.json');
    const rollup = {
      key: 'hours',
      label: 'hours',
      type: 'rollup',
      options: [],
      required: false,
      expression: null,
      aggregate: 'sum',
      source: 'estimate',
      choiceSource: null,
    };
    await writeFile(file, JSON.stringify({ properties: [rollup], inherit: true }), 'utf8');
    let sentBody: unknown;
    server.use(
      http.put(`${API}/api/v1/items/:itemId/schema`, async ({ request }) => {
        sentBody = await request.json();
        return HttpResponse.json({ properties: [rollup], declared: [rollup], inherit: true });
      }),
    );

    await captureJson((json) => setSchema('default', ITEM, file, json, { env }));

    expect(sentBody).toEqual({ properties: [rollup], inherit: true });
    await done();
  });

  it('carries a formula property expression through to Core', async () => {
    const { env, dir, done } = await withProfile();
    const file = join(dir, 'schema.json');
    await writeFile(
      file,
      JSON.stringify({ properties: [formulaDef('total', '[price] * 2')], inherit: true }),
      'utf8',
    );
    let sentBody: unknown;
    server.use(
      http.put(`${API}/api/v1/items/:itemId/schema`, async ({ request }) => {
        sentBody = await request.json();
        return HttpResponse.json({
          properties: [formulaDef('total', '[price] * 2')],
          declared: [formulaDef('total', '[price] * 2')],
          inherit: true,
        });
      }),
    );

    await captureJson((json) => setSchema('default', ITEM, file, json, { env }));

    // Dropped on the way through, the property would reach Core as a formula with nothing to
    // evaluate - which Core refuses, naming a field the file did supply.
    expect(sentBody).toEqual({ properties: [formulaDef('total', '[price] * 2')], inherit: true });
    await done();
  });

  it('refuses a file missing the inherit flag before any request', async () => {
    const { env, dir, done } = await withProfile();
    const file = join(dir, 'bad.json');
    await writeFile(file, JSON.stringify({ properties: [] }), 'utf8');
    // onUnhandledRequest:'error' would fail the test if it reached the network; it must not.
    await expect(
      captureJson((json) => setSchema('default', ITEM, file, json, { env })),
    ).rejects.toThrow(/inherit/);
    await done();
  });
});
