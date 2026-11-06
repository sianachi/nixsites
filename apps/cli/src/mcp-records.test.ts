import { afterEach, describe, expect, it, vi } from 'vitest';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import { createWorkspaceMcpServer } from './mcp.ts';
import { openSession } from './session.ts';

import {
  API,
  ITEM,
  OTHER,
  UPLOAD,
  VERSION,
  WORKSPACE,
  fakeApi,
  type Call,
} from './commands/agent-api.test-helper.ts';

const NEW_TOOLS = [
  'find_items_by_property',
  'query_items',
  'upsert_record',
  'batch_records',
  'set_item_schema',
  'add_item_reference',
  'remove_item_reference',
  'list_item_references',
  'list_referenced_by',
  'list_backlinks',
  'set_file_version_state',
  'export_note_to_file',
  'begin_file_upload',
  'complete_file_upload',
  'get_file_download_url',
  'set_item_expiry',
  'get_public_link',
  'create_public_link',
  'revoke_public_link',
  'list_attachments',
];

type Kind = 'token' | 'login';

async function connect(kind: Kind, transport: 'stdio' | 'http' = 'stdio') {
  const calls: Call[] = [];
  const fetchImpl = fakeApi(calls);
  vi.stubGlobal('fetch', fetchImpl);
  const server = await createWorkspaceMcpServer({
    transport,
    resolve: () =>
      Promise.resolve(
        openSession({
          profile:
            kind === 'token'
              ? { apiUrl: API, token: 'nixpat_agent' }
              : {
                  apiUrl: API,
                  token: '',
                  interactiveSession: {
                    refreshToken: 'nixcli_x',
                    expiresAt: '2099-01-01T00:00:00.000Z',
                  },
                },
          fetchImpl,
        }),
      ),
  });
  const client = new Client({ name: 'test', version: '0.0.0' });
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  await Promise.all([server.connect(serverTransport), client.connect(clientTransport)]);
  const call = async (name: string, args: Record<string, unknown>) => {
    const result = await client.callTool({ name, arguments: args });
    const text = (result.content as { text: string }[])[0]?.text ?? '';
    return {
      isError: result.isError === true,
      text,
      json: result.isError ? undefined : (JSON.parse(text) as unknown),
    };
  };
  return {
    calls,
    call,
    client,
    close: async () => {
      await client.close();
      await server.close();
    },
  };
}

const api = (calls: Call[]) => calls.filter((c) => c.path.startsWith('/api/'));

afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

describe('agent record tools: transports', () => {
  it('lists every new tool on stdio and on HTTP, and keeps host-disk tools off HTTP', async () => {
    const stdio = await connect('token');
    const http = await connect('token', 'http');
    try {
      const stdioNames = (await stdio.client.listTools()).tools.map((t) => t.name);
      const httpNames = (await http.client.listTools()).tools.map((t) => t.name);
      for (const name of NEW_TOOLS) {
        expect(stdioNames).toContain(name);
        expect(httpNames).toContain(name);
      }
      for (const hostOnly of ['upload_file', 'replace_file', 'download_file', 'import_document'])
        expect(httpNames).not.toContain(hostOnly);
      expect(stdioNames).toContain('upload_file');
    } finally {
      await stdio.close();
      await http.close();
    }
  });
});

describe('agent record tools: request shapes', () => {
  it('looks up, queries and upserts', async () => {
    const c = await connect('token');
    try {
      await c.call('find_items_by_property', {
        workspaceId: WORKSPACE,
        key: 'url',
        value: 'https://Example.com/a',
        parentId: OTHER,
      });
      await c.call('query_items', {
        workspaceId: WORKSPACE,
        parentId: OTHER,
        filters: [{ property: 'status', operator: 'not-equals', value: 'retired' }],
        sort: { property: '$modified', descending: true },
        limit: 20,
      });
      const upsert = await c.call('upsert_record', {
        parentId: OTHER,
        keyField: 'url',
        keyValue: 'https://example.com/a',
        properties: { status: 'new' },
        idempotencyKey: 'k1',
      });
      expect(upsert.json).toMatchObject({ outcome: 'created' });
      const [lookup, query, up] = api(c.calls);
      expect(lookup).toMatchObject({
        method: 'POST',
        path: `/api/v1/workspaces/${WORKSPACE}/lookup`,
        body: { key: 'url', value: 'https://Example.com/a', parentId: OTHER },
      });
      expect(query?.body).toMatchObject({
        scope: { parentId: OTHER },
        filters: [{ property: 'status', operator: 'not-equals', value: 'retired' }],
        sort: { property: '$modified', descending: true },
        limit: 20,
      });
      expect(up).toMatchObject({
        path: `/api/v1/items/${OTHER}/records/upsert`,
        body: {
          keyField: 'url',
          strict: true,
          idempotencyKey: 'k1',
          properties: { status: 'new' },
        },
      });
    } finally {
      await c.close();
    }
  });

  it('batches, reports counts, and refuses a keyless create before sending', async () => {
    const c = await connect('token');
    try {
      const refused = await c.call('batch_records', {
        workspaceId: WORKSPACE,
        rows: [{ parentId: OTHER, title: 'x' }],
      });
      expect(refused.isError).toBe(true);
      expect(refused.text).toContain('idempotencyKey');
      expect(api(c.calls)).toHaveLength(0);
      const ok = await c.call('batch_records', {
        workspaceId: WORKSPACE,
        rows: [
          { parentId: OTHER, title: 'x', idempotencyKey: 'a' },
          { parentId: OTHER, keyField: 'url', keyValue: 'https://example.com/b' },
        ],
      });
      expect(ok.json).toMatchObject({ created: 1, failed: 1 });
      expect(api(c.calls)[0]).toMatchObject({
        path: `/api/v1/workspaces/${WORKSPACE}/records/batch`,
        body: { strict: true },
      });
    } finally {
      await c.close();
    }
  });

  it('sets a unique field in the schema and extends create and property writes', async () => {
    const c = await connect('token');
    try {
      await c.call('set_item_schema', {
        itemId: OTHER,
        properties: [{ key: 'url', type: 'url', unique: true }],
      });
      await c.call('create_item', {
        workspaceId: WORKSPACE,
        title: 'T',
        parentId: OTHER,
        properties: { url: 'https://example.com/a' },
        idempotencyKey: 'k',
      });
      await c.call('create_item', { workspaceId: WORKSPACE, title: 'T', strict: false });
      await c.call('set_item_properties', { itemId: ITEM, properties: { status: 'x' } });
      await c.call('set_item_properties', {
        itemId: ITEM,
        properties: { status: 'x' },
        strict: false,
      });
      const [schema, strictCreate, lenientCreate, strictSet, lenientSet] = api(c.calls);
      expect(schema).toMatchObject({
        method: 'PUT',
        body: {
          inherit: true,
          properties: [{ key: 'url', label: 'url', type: 'url', unique: true, required: false }],
        },
      });
      expect(strictCreate?.body).toMatchObject({
        properties: { url: 'https://example.com/a' },
        idempotencyKey: 'k',
        strict: true,
        parentId: OTHER,
      });
      expect(lenientCreate?.body).toMatchObject({ strict: false });
      expect(strictSet?.body).toEqual({ properties: { status: 'x' }, strict: true });
      expect(lenientSet?.body).toEqual({ properties: { status: 'x' }, strict: false });
    } finally {
      await c.close();
    }
  });

  it('manages references, pins, backlinks and expiry', async () => {
    const c = await connect('token');
    try {
      await c.call('add_item_reference', {
        itemId: ITEM,
        targetItemId: OTHER,
        targetFileVersionId: VERSION,
        role: 'cv',
      });
      await c.call('remove_item_reference', { itemId: ITEM, referenceId: OTHER });
      await c.call('list_item_references', { itemId: ITEM, limit: 5 });
      await c.call('list_referenced_by', { itemId: ITEM });
      await c.call('list_backlinks', { itemId: ITEM, limit: 7 });
      await c.call('set_item_expiry', { itemId: ITEM, expiresAt: '2099-01-01' });
      await c.call('set_item_expiry', { itemId: ITEM, expiresAt: null });
      const [add, remove, list, usedBy, back, expire, clear] = api(c.calls);
      expect(add).toMatchObject({
        method: 'POST',
        path: `/api/v1/items/${ITEM}/references`,
        body: { targetItemId: OTHER, targetFileVersionId: VERSION, role: 'cv' },
      });
      expect(remove).toMatchObject({
        method: 'DELETE',
        path: `/api/v1/items/${ITEM}/references/${OTHER}`,
      });
      expect(list).toMatchObject({
        path: `/api/v1/items/${ITEM}/references`,
        query: { limit: '5' },
      });
      expect(usedBy?.path).toBe(`/api/v1/items/${ITEM}/referenced-by`);
      expect(back).toMatchObject({
        path: `/api/v1/items/${ITEM}/backlinks`,
        query: { limit: '7' },
      });
      expect(expire).toMatchObject({
        method: 'PATCH',
        body: { properties: { expiry: '2099-01-01' } },
      });
      expect(clear?.body).toEqual({ properties: { expiry: null } });
    } finally {
      await c.close();
    }
  });

  it('moves a file through upload, state, download, export, links and the attachments list', async () => {
    const c = await connect('token');
    try {
      const begun = await c.call('begin_file_upload', {
        workspaceId: WORKSPACE,
        fileName: 'a.pdf',
        byteLength: 10,
        targetItemId: ITEM,
      });
      expect(begun.json).toMatchObject({
        uploadId: UPLOAD,
        method: 'PUT',
        uploadUrl: 'https://store.example.com/put?sig=1',
        headers: { 'content-type': 'application/octet-stream' },
      });
      const done = await c.call('complete_file_upload', { uploadId: UPLOAD });
      expect(done.json).toEqual({ itemId: ITEM, publishedVersionId: VERSION, status: 'completed' });
      await c.call('set_file_version_state', {
        itemId: ITEM,
        versionId: VERSION,
        state: 'approved',
      });
      const download = await c.call('get_file_download_url', { itemId: ITEM, versionId: VERSION });
      expect(download.json).toMatchObject({ url: 'https://store.example.com/get?sig=1' });
      const exported = await c.call('export_note_to_file', {
        itemId: ITEM,
        format: 'pdf',
        targetItemId: OTHER,
      });
      expect(exported.json).toMatchObject({ itemId: ITEM, publishedVersionId: VERSION });
      await c.call('get_public_link', { itemId: ITEM });
      await c.call('create_public_link', { itemId: ITEM, versionId: VERSION, confirm: true });
      await c.call('revoke_public_link', { itemId: ITEM });
      await c.call('list_attachments', {
        workspaceId: WORKSPACE,
        state: 'approved',
        includeImages: true,
      });
      const calls = api(c.calls);
      expect(
        calls.find((x) => x.path === '/api/v1/files/uploads' && x.method === 'POST')?.body,
      ).toMatchObject({
        byteLength: 10,
        targetItemId: ITEM,
        mediaType: 'application/octet-stream',
      });
      expect(calls.find((x) => x.path.endsWith('/state'))).toMatchObject({
        method: 'PUT',
        path: `/api/v1/items/${ITEM}/file/versions/${VERSION}/state`,
        body: { state: 'approved' },
      });
      expect(calls.find((x) => x.path.endsWith('/file/download'))?.query).toMatchObject({
        versionId: VERSION,
      });
      expect(calls.find((x) => x.path === '/api/v1/exports')?.body).toMatchObject({
        itemId: ITEM,
        format: 'pdf',
        scope: 'item',
        toFile: true,
        targetItemId: OTHER,
      });
      expect(calls.filter((x) => x.path.endsWith('/public-link')).map((x) => x.method)).toEqual([
        'GET',
        'PUT',
        'DELETE',
      ]);
      expect(
        calls.find((x) => x.method === 'PUT' && x.path.endsWith('/public-link'))?.body,
      ).toEqual({ versionId: VERSION });
      expect(calls.find((x) => x.path.endsWith('/attachments'))?.query).toMatchObject({
        state: 'approved',
        includeImages: 'true',
      });
    } finally {
      await c.close();
    }
  });
});

describe('the mistake guard', () => {
  const approve = { itemId: ITEM, versionId: VERSION, state: 'approved' };
  const generic = (operationId: string, body: unknown, path: Record<string, string>) => ({
    operationId,
    path,
    body,
    confirm: true,
  });

  it('refuses approve, revoke and public links on a browser-approved login, typed and generic, before any request', async () => {
    const c = await connect('login');
    try {
      const refusals = [
        await c.call('set_file_version_state', approve),
        await c.call('set_file_version_state', { ...approve, state: 'revoked' }),
        await c.call('create_public_link', { itemId: ITEM, confirm: true }),
        await c.call(
          'run_nix_action',
          generic(
            'SetFileVersionState',
            { state: 'approved' },
            { itemId: ITEM, versionId: VERSION },
          ),
        ),
        await c.call(
          'run_nix_action',
          generic(
            'SetFileVersionState',
            { state: 'revoked' },
            { itemId: ITEM, versionId: VERSION },
          ),
        ),
        await c.call('run_nix_action', generic('CreatePublicLink', {}, { itemId: ITEM })),
      ];
      for (const refusal of refusals) {
        expect(refusal.isError).toBe(true);
        expect(refusal.text).toContain('access token');
        expect(refusal.text).toContain('not a security boundary');
      }
      expect(c.calls).toEqual([]);
    } finally {
      await c.close();
    }
  });

  it('lets a login move a version to draft or review, and an access token do all of it', async () => {
    const login = await connect('login');
    try {
      // Reaches the network (the login exchange is not stubbed), so only the guard is asserted: no refusal text.
      const review = await login.call('set_file_version_state', { ...approve, state: 'in_review' });
      expect(review.text).not.toContain('not a security boundary');
    } finally {
      await login.close();
    }
    const token = await connect('token');
    try {
      expect((await token.call('set_file_version_state', approve)).isError).toBe(false);
      expect(
        (await token.call('create_public_link', { itemId: ITEM, confirm: true })).isError,
      ).toBe(false);
      expect(
        (
          await token.call(
            'run_nix_action',
            generic(
              'SetFileVersionState',
              { state: 'revoked' },
              { itemId: ITEM, versionId: VERSION },
            ),
          )
        ).isError,
      ).toBe(false);
      expect(
        (await token.call('run_nix_action', generic('CreatePublicLink', {}, { itemId: ITEM })))
          .isError,
      ).toBe(false);
      expect((await token.call('create_public_link', { itemId: ITEM })).isError).toBe(true);
    } finally {
      await token.close();
    }
  });
});
