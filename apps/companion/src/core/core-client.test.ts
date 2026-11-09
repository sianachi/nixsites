import { afterEach, describe, expect, it } from 'vitest';

import { CoreClient } from './core-client.ts';
import { IDS, jsonResponse, startServer, type FakeServer } from '../testing/testing.ts';

let server: FakeServer | undefined;
afterEach(async () => {
  await server?.close();
  server = undefined;
});

const client = (url: string, release = { version: '1.2.3', commit: 'abc' }): CoreClient =>
  new CoreClient({ baseUrl: url, secret: 's3cret', release });
const signal = (): AbortSignal => new AbortController().signal;
const call = (c: CoreClient, args = '{"operation":"search","query":"x","workspaceId":"w"}') =>
  c.executeConversationTool(signal(), IDS.item, IDS.tenant, IDS.principal, IDS.request, args);

describe('Core client', () => {
  it('posts the tool call with the secret and release headers, and reads the result', async () => {
    server = await startServer((_seen, res) => {
      jsonResponse(res, 200, { success: true, result: 'found', lockedContent: true });
    });
    expect(await call(client(server.url))).toEqual({
      text: 'found',
      success: true,
      lockedContent: true,
    });
    const seen = server.seen[0];
    expect(seen?.method).toBe('POST');
    expect(seen?.url).toBe(`/internal/conversations/${IDS.item}/tools`);
    expect(seen?.headers).toMatchObject({
      'x-nix-internal-secret': 's3cret',
      'x-nix-service': 'companion',
      'x-nix-release-version': '1.2.3',
      'x-nix-release-commit': 'abc',
      accept: 'application/json',
    });
    expect(JSON.parse(seen?.body ?? '')).toEqual({
      tenantId: IDS.tenant,
      principalId: IDS.principal,
      requestId: IDS.request,
      arguments: { operation: 'search', query: 'x', workspaceId: 'w' },
    });
  });

  it('sends no release headers when none are configured', async () => {
    server = await startServer((_seen, res) => {
      jsonResponse(res, 200, { success: false, result: '' });
    });
    await call(client(server.url, { version: '', commit: '' }));
    expect(server.seen[0]?.headers['x-nix-service']).toBeUndefined();
  });

  it('refuses malformed identifiers and arguments before any request', async () => {
    server = await startServer((_seen, res) => {
      jsonResponse(res, 200, {});
    });
    const c = client(server.url);
    await expect(
      c.executeConversationTool(signal(), 'x', IDS.tenant, IDS.principal, IDS.request, '{}'),
    ).rejects.toThrow('invalid conversation tool request');
    await expect(call(c, 'not json')).rejects.toThrow('invalid conversation tool request');
    await expect(call(c, JSON.stringify({ a: 'x'.repeat(40001) }))).rejects.toThrow(
      'invalid conversation tool request',
    );
    expect(server.seen).toEqual([]);
  });

  it('refuses an error status, a non-JSON body, an unknown field and an oversize result', async () => {
    for (const respond of [
      (res: Parameters<Parameters<typeof startServer>[0]>[1]) => {
        jsonResponse(res, 403, {});
      },
      (res: Parameters<Parameters<typeof startServer>[0]>[1]) => {
        res.writeHead(200, { 'Content-Type': 'text/html' });
        res.end('<p>');
      },
      (res: Parameters<Parameters<typeof startServer>[0]>[1]) => {
        jsonResponse(res, 200, { success: true, result: 'x', extra: 1 });
      },
      (res: Parameters<Parameters<typeof startServer>[0]>[1]) => {
        jsonResponse(res, 200, { success: true, result: 'x'.repeat(128001) });
      },
      (res: Parameters<Parameters<typeof startServer>[0]>[1]) => {
        res.writeHead(302, { Location: 'http://127.0.0.1:1/' });
        res.end();
      },
    ]) {
      server = await startServer((_seen, res) => {
        respond(res);
      });
      await expect(call(client(server.url))).rejects.toThrow();
      await server.close();
    }
    server = undefined;
  });

  it('pings Core and reports whether it accepts the credential', async () => {
    server = await startServer((seen, res) => {
      jsonResponse(res, seen.headers['x-nix-internal-secret'] === 's3cret' ? 200 : 401, []);
    });
    expect(await client(server.url).ping(signal())).toBe(true);
    expect(server.seen[0]?.method).toBe('POST');
    expect(server.seen[0]?.url).toBe('/internal/worker-dispatch/jobs/lease');
    expect(JSON.parse(server.seen[0]?.body ?? '')).toEqual({
      owner: 'companion',
      kind: 'readiness.probe',
      limit: 1,
    });
    const wrong = new CoreClient({
      baseUrl: server.url,
      secret: 'nope',
      release: { version: '', commit: '' },
    });
    expect(await wrong.ping(signal())).toBe(false);
    expect(await client('http://127.0.0.1:1').ping(signal())).toBe(false);
  });
});
