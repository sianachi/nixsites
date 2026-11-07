import { afterEach, describe, expect, it, vi } from 'vitest';
import { createServer, type Server } from 'node:http';
import { fileURLToPath } from 'node:url';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';

import { createMcpHttpHandler } from './mcp-http.ts';
import type { FetchImpl } from './session.ts';

const API = 'https://core.test';
const localMarkdown = fileURLToPath(
  new URL('../../../docs/agent-guides/backend.md', import.meta.url),
);
const seen: { authorization: string | null; path: string }[] = [];
let revoked = false;
let mintedBearer = 'jwt-for-owner';
let mcpEnabled = true;

/** Calls to Core other than the organisation-switch lookup. */
const toolCalls = () => seen.filter((call) => call.path !== '/api/v1/me');
const meCalls = () => seen.filter((call) => call.path === '/api/v1/me');

const fetchImpl: FetchImpl = (input, init) => {
  const url = new URL(input);
  const headers = new Headers(init?.headers);
  seen.push({ authorization: headers.get('authorization'), path: url.pathname });
  if (revoked) {
    return Promise.resolve(Response.json({ detail: 'Access token revoked' }, { status: 401 }));
  }
  if (url.pathname.endsWith('/public/v1/auth/token')) {
    return Promise.resolve(
      Response.json({ accessToken: mintedBearer, tokenType: 'Bearer', expiresInSeconds: 600 }),
    );
  }
  if (url.pathname === '/api/v1/me') {
    return Promise.resolve(
      Response.json({
        id: '33333333-3333-4333-8333-333333333333',
        tenantId: '44444444-4444-4444-8444-444444444444',
        displayName: 'Owner',
        email: null,
        isTenantAdministrator: false,
        features: {
          sites: false,
          mcpUrl: mcpEnabled ? 'https://core.test/mcp' : null,
          operator: false,
          siteApprover: false,
          publicLinks: true,
          mcpEnabled,
        },
      }),
    );
  }
  if (url.pathname.endsWith('/api/v1/items/11111111-1111-4111-8111-111111111111')) {
    return Promise.resolve(
      Response.json({
        id: '11111111-1111-4111-8111-111111111111',
        workspaceId: '22222222-2222-4222-8222-222222222222',
        parentId: null,
        type: 'note',
        title:
          headers.get('authorization') === 'Bearer jwt-for-other'
            ? 'Other principal note'
            : 'Remote note',
        seq: 1,
        hasChildren: false,
        lifecycleState: 'active',
        properties: {},
        createdAt: '2026-01-01T00:00:00Z',
        updatedAt: '2026-01-01T00:00:00Z',
      }),
    );
  }
  return Promise.resolve(Response.json({ code: 'not_found' }, { status: 404 }));
};

let server: Server | null = null;
const realFetch = globalThis.fetch;
// The Nix client speaks through the global fetch; Core's host is answered by the fake above and
// everything else (this test's own loopback server) goes to the real one.
vi.stubGlobal('fetch', (input: string | URL | Request, init?: RequestInit) => {
  const url = new URL(typeof input === 'string' ? input : input instanceof URL ? input : input.url);
  return url.host === 'core.test' ? fetchImpl(url.toString(), init) : realFetch(input, init);
});

async function listen(): Promise<URL> {
  const handler = createMcpHttpHandler({ apiUrl: API, fetchImpl });
  const created = createServer((request, response) => {
    void handler(request, response);
  });
  server = created;
  await new Promise<void>((resolve) => {
    created.listen(0, '127.0.0.1', resolve);
  });
  const address = created.address();
  if (address === null || typeof address === 'string') throw new Error('no address');
  return new URL(`http://127.0.0.1:${String(address.port)}/mcp`);
}

afterEach(async () => {
  seen.length = 0;
  revoked = false;
  mcpEnabled = true;
  mintedBearer = 'jwt-for-owner';
  vi.unstubAllEnvs();
  const current = server;
  server = null;
  await new Promise<void>((resolve) => {
    if (current === null) resolve();
    else
      current.close(() => {
        resolve();
      });
  });
});

describe('nixctl mcp over HTTP', () => {
  it('refuses a request without a personal access token before building any tool server', async () => {
    const url = await listen();
    const response = await fetch(url, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        accept: 'application/json, text/event-stream',
      },
      body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'tools/list' }),
    });
    expect(response.status).toBe(401);
    expect(response.headers.get('www-authenticate')).toContain('Bearer');
    expect(seen).toEqual([]);
    const health = await fetch(new URL('/healthz', url));
    expect(health.status).toBe(200);
  });

  it('serves the tool contract to a bearer and reaches Core as that token alone', async () => {
    const url = await listen();
    const client = new Client({ name: 'remote-test', version: '0.0.0' });
    const transport = new StreamableHTTPClientTransport(url, {
      requestInit: { headers: { authorization: 'Bearer nixpat_remote_owner' } },
    });
    // The SDK's own transport, typed with optional setters this project's strictness refuses.
    await client.connect(transport);
    try {
      const tools = await client.listTools();
      const names = tools.tools.map((tool) => tool.name);
      expect(names).toContain('read_note');
      expect(names).toContain('list_workspaces');
      expect(names).not.toContain('import_document');
      expect(names).not.toContain('upload_file');
      expect(names).not.toContain('replace_file');
      expect(names).not.toContain('download_file');
      expect(names).not.toContain('preview_template_archive_import');
      expect(names).not.toContain('export_template_archive');
      expect(JSON.stringify(tools)).not.toContain('nixpat_');

      const result = await client.callTool({
        name: 'get_item',
        arguments: { itemId: '11111111-1111-4111-8111-111111111111' },
      });
      expect(JSON.stringify(result)).toContain('Remote note');
      // The PAT was exchanged once and Core saw the minted JWT, never the PAT on an API route.
      const exchange = seen.filter((call) => call.path.endsWith('/public/v1/auth/token'));
      expect(exchange).toHaveLength(1);
      const apiCalls = seen.filter((call) => call.path.startsWith('/api/'));
      expect(apiCalls.length).toBeGreaterThan(0);
      expect(apiCalls.every((call) => call.authorization === 'Bearer jwt-for-owner')).toBe(true);
    } finally {
      await client.close();
    }
  });

  it('refuses host filesystem tools even when called directly with a fabricated bearer', async () => {
    vi.stubEnv('XDG_CONFIG_HOME', '/dev/null');
    vi.stubEnv('NIX_SESSION_TOKEN', '');
    const url = await listen();
    const localCalls = [
      {
        name: 'import_document',
        arguments: {
          workspaceId: '22222222-2222-4222-8222-222222222222',
          path: localMarkdown,
          preview: true,
        },
      },
      {
        name: 'upload_file',
        arguments: { workspaceId: '22222222-2222-4222-8222-222222222222', path: localMarkdown },
      },
      {
        name: 'replace_file',
        arguments: {
          workspaceId: '22222222-2222-4222-8222-222222222222',
          itemId: '11111111-1111-4111-8111-111111111111',
          path: localMarkdown,
        },
      },
      {
        name: 'download_file',
        arguments: { itemId: '11111111-1111-4111-8111-111111111111', outputPath: '/dev/null' },
      },
      {
        name: 'preview_template_archive_import',
        arguments: { workspaceId: '22222222-2222-4222-8222-222222222222', path: localMarkdown },
      },
      {
        name: 'export_template_archive',
        arguments: { templateId: '11111111-1111-4111-8111-111111111111', path: '/dev/null' },
      },
    ];
    for (const params of localCalls) {
      const response = await fetch(url, {
        method: 'POST',
        headers: {
          authorization: 'Bearer nixpat_fabricated',
          'content-type': 'application/json',
          accept: 'application/json, text/event-stream',
        },
        body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'tools/call', params }),
      });
      expect(await response.json()).toMatchObject({
        result: {
          isError: true,
          content: [{ text: `MCP error -32602: Tool ${params.name} not found` }],
        },
      });
    }
    expect(toolCalls().filter((call) => call.path.startsWith('/api/'))).toEqual([]);
  });

  it('checks Core again for a repeated read after the personal access token is revoked', async () => {
    const url = await listen();
    const client = new Client({ name: 'revocation-test', version: '0.0.0' });
    const transport = new StreamableHTTPClientTransport(url, {
      requestInit: { headers: { authorization: 'Bearer nixpat_remote_owner' } },
    });
    await client.connect(transport);
    try {
      const input = {
        name: 'get_item',
        arguments: { itemId: '11111111-1111-4111-8111-111111111111' },
      };
      expect(JSON.stringify(await client.callTool(input))).toContain('Remote note');
      revoked = true;
      const result = await client.callTool(input);
      expect(result.isError).toBe(true);
      expect(JSON.stringify(result)).toContain('Access token revoked');
      expect(toolCalls().filter((call) => call.path.startsWith('/api/'))).toHaveLength(2);
    } finally {
      await client.close();
    }
  });

  it('keeps pet calls on the request principal despite a host bearer and a supplied API URL', async () => {
    vi.stubEnv('NIX_SESSION_TOKEN', 'host-credential-must-not-be-used');
    const url = await listen();
    const response = await fetch(url, {
      method: 'POST',
      headers: {
        authorization: 'Bearer nixpat_remote_owner',
        'content-type': 'application/json',
        accept: 'application/json, text/event-stream',
      },
      body: JSON.stringify({
        jsonrpc: '2.0',
        id: 1,
        method: 'tools/call',
        params: {
          name: 'pet_runtime',
          arguments: { operation: 'settings', apiUrl: 'https://attacker.invalid' },
        },
      }),
    });
    expect(await response.json()).toMatchObject({ result: { isError: true } });
    expect(seen).toEqual([
      { authorization: null, path: '/public/v1/auth/token' },
      { authorization: 'Bearer jwt-for-owner', path: '/api/v1/me' },
      { authorization: 'Bearer jwt-for-owner', path: '/api/v1/me/pets/settings' },
    ]);
  });

  it('keeps warm bearer providers separate while every request reaches Core', async () => {
    const url = await listen();
    for (const { token, jwt, title } of [
      { token: 'nixpat_remote_owner', jwt: 'jwt-for-owner', title: 'Remote note' },
      { token: 'nixpat_remote_other', jwt: 'jwt-for-other', title: 'Other principal note' },
      { token: 'nixpat_remote_owner', jwt: 'jwt-for-owner', title: 'Remote note' },
    ]) {
      mintedBearer = jwt;
      const response = await fetch(url, {
        method: 'POST',
        headers: {
          authorization: `Bearer ${token}`,
          'content-type': 'application/json',
          accept: 'application/json, text/event-stream',
        },
        body: JSON.stringify({
          jsonrpc: '2.0',
          id: 1,
          method: 'tools/call',
          params: {
            name: 'get_item',
            arguments: { itemId: '11111111-1111-4111-8111-111111111111' },
          },
        }),
      });
      expect(await response.text()).toContain(title);
    }
    expect(seen.filter((call) => call.path.endsWith('/public/v1/auth/token'))).toHaveLength(2);
    expect(
      toolCalls()
        .filter((call) => call.path.startsWith('/api/'))
        .map((call) => call.authorization),
    ).toEqual(['Bearer jwt-for-owner', 'Bearer jwt-for-other', 'Bearer jwt-for-owner']);
  });

  const toolsList = (url: URL, token = 'nixpat_remote_owner') =>
    fetch(url, {
      method: 'POST',
      headers: {
        authorization: `Bearer ${token}`,
        'content-type': 'application/json',
        accept: 'application/json, text/event-stream',
      },
      body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'tools/list' }),
    });

  it('refuses with 403 when an administrator turned MCP off, and reaches no tool', async () => {
    mcpEnabled = false;
    const url = await listen();
    const response = await toolsList(url);
    expect(response.status).toBe(403);
    expect(await response.json()).toEqual({
      code: 'mcp.disabled',
      error: 'MCP is turned off for this organisation by an administrator.',
    });
    expect(toolCalls().filter((call) => call.path.startsWith('/api/'))).toEqual([]);
  });

  it('asks Core about the switch once per token per 30 seconds and then again', async () => {
    let clock = 1_000_000;
    const handler = createMcpHttpHandler({ apiUrl: API, fetchImpl, now: () => clock });
    const created = createServer((request, response) => {
      void handler(request, response);
    });
    server = created;
    await new Promise<void>((resolve) => {
      created.listen(0, '127.0.0.1', resolve);
    });
    const address = created.address();
    if (address === null || typeof address === 'string') throw new Error('no address');
    const url = new URL(`http://127.0.0.1:${String(address.port)}/mcp`);

    expect((await toolsList(url)).status).toBe(200);
    expect((await toolsList(url)).status).toBe(200);
    expect(meCalls()).toHaveLength(1);
    // A second token has its own answer.
    expect((await toolsList(url, 'nixpat_remote_other')).status).toBe(200);
    expect(meCalls()).toHaveLength(2);

    // Turned off, but the cached "on" holds until it expires.
    mcpEnabled = false;
    clock += 29_000;
    expect((await toolsList(url)).status).toBe(200);
    clock += 2_000;
    expect((await toolsList(url)).status).toBe(403);
    expect(meCalls()).toHaveLength(3);
  });
});
