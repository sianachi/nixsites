import { timingSafeEqual } from 'node:crypto';
import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http';

import type { BrowserService } from './browser.ts';
import { BrowserFault, commandSchema } from './contracts.ts';

async function readRequest(request: IncomingMessage): Promise<unknown> {
  const chunks: Buffer[] = [];
  let size = 0;
  for await (const chunk of request) {
    if (!Buffer.isBuffer(chunk)) throw new BrowserFault('invalid_request');
    size += chunk.length;
    if (size > 512 << 10) throw new BrowserFault('invalid_request');
    chunks.push(chunk);
  }
  const input: unknown = JSON.parse(Buffer.concat(chunks).toString());
  return input;
}

function json(response: ServerResponse, status: number, body: unknown): void {
  response.writeHead(status, { 'Cache-Control': 'no-store', 'Content-Type': 'application/json' });
  response.end(JSON.stringify(body));
}

export function createBrowserServer({
  secret,
  browser,
}: {
  readonly secret: string;
  readonly browser: BrowserService;
}): Server {
  if (!secret) throw new Error('NIX_BROWSER_INTERNAL_SECRET is required.');
  const expected = Buffer.from(secret);
  const server = createServer((req, res) => {
    void (async () => {
      if (req.url === '/healthz' && req.method === 'GET') {
        json(res, 200, { status: 'healthy' });
        return;
      }
      if (req.url === '/readyz' && req.method === 'GET') {
        const ready = await browser.ready();
        json(res, ready ? 200 : 503, { status: ready ? 'ready' : 'unavailable' });
        return;
      }
      if (req.url !== '/v1/browser') {
        json(res, 404, { code: 'not_found' });
        return;
      }
      if (req.method !== 'POST') {
        res.setHeader('Allow', 'POST');
        json(res, 405, { code: 'method_not_allowed' });
        return;
      }
      const supplied = Buffer.from(
        typeof req.headers['x-nix-internal-secret'] === 'string'
          ? req.headers['x-nix-internal-secret']
          : '',
      );
      if (supplied.length !== expected.length || !timingSafeEqual(supplied, expected)) {
        req.resume();
        json(res, 401, { code: 'internal_auth_required' });
        return;
      }
      let input: unknown;
      try {
        input = await readRequest(req);
      } catch {
        json(res, 400, { code: 'invalid_request' });
        return;
      }
      const command = commandSchema.safeParse(input);
      if (!command.success) {
        json(res, 400, { code: 'invalid_request' });
        return;
      }
      const peer = new AbortController();
      res.once('close', () => {
        if (!res.writableEnded) peer.abort();
      });
      try {
        json(res, 200, await browser.run(command.data, peer.signal));
      } catch (error) {
        const known = error instanceof BrowserFault;
        const status =
          known && error.dispatched ? 502 : known && error.code === 'browser_busy' ? 429 : 422;
        json(res, status, {
          code: known ? error.code : 'browser_unavailable',
          dispatched: known && error.dispatched,
        });
      }
    })().catch(() => {
      if (!res.headersSent) json(res, 500, { code: 'browser_unavailable' });
      else res.end();
    });
  });
  server.on('close', () => {
    void browser.close().catch(() => undefined);
  });
  return server;
}
