import { timingSafeEqual } from 'node:crypto';
import { accessSync, constants } from 'node:fs';
import {
  createServer,
  type IncomingMessage,
  type RequestListener,
  type Server,
  type ServerResponse,
} from 'node:http';

import type { CompanionConfig } from '../core/config.ts';
import { CoreClient } from '../core/core-client.ts';
import { Manager, type ManagerDeps } from '../providers/manager.ts';
import { createConnectorRouter } from '../sani/connector.ts';
import { googleActions } from '../sani/google.ts';
import { runLinear } from '../sani/linear.ts';
import { microsoftActions } from '../sani/microsoft.ts';
import { opsActions } from '../sani/ops.ts';
import { runRegisteredMcp } from '../sani/registered-mcp.ts';
import { readBody } from '../shared/http.ts';
import { runPetCanvas } from '../tools/pet-canvas.ts';
import { runPetSheet } from '../tools/pet-sheet.ts';
import { createServerTools } from '../tools/server-tools.ts';

export interface CompanionDeps extends ManagerDeps {
  /** Whether Core accepts the service credential; default a GET /healthz against NIX_COMPANION_API_URL. */
  ping?: (() => Promise<boolean>) | undefined;
}

export interface Companion {
  /** Mount this on any http server (or call it per request) to serve the companion routes. */
  readonly listener: RequestListener;
  readonly manager: Manager;
}

function json(
  res: ServerResponse,
  status: number,
  value: unknown,
  headers: Record<string, string> = {},
): void {
  res.writeHead(status, { 'Content-Type': 'application/json', ...headers });
  res.end(`${JSON.stringify(value)}\n`);
}

function sameSecret(presented: string, expected: string): boolean {
  const a = Buffer.from(presented);
  const b = Buffer.from(expected);
  return a.length === b.length && timingSafeEqual(a, b);
}

function writable(dir: string): boolean {
  try {
    accessSync(dir, constants.W_OK);
    return true;
  } catch {
    return false;
  }
}

async function readSaniRequest(req: IncomingMessage, limit: number): Promise<unknown> {
  try {
    const text = await readBody(req, limit);
    if (text !== undefined) {
      const input: unknown = JSON.parse(text);
      return input;
    }
  } catch {
    return undefined;
  }
}

export function createCompanion(config: CompanionConfig, deps: CompanionDeps = {}): Companion {
  const runConnector = createConnectorRouter(
    [...googleActions, ...microsoftActions, ...opsActions],
    deps.fetch,
  );
  const saniRoutes = new Map<
    string,
    { run: (value: unknown) => Promise<unknown>; limit: number; invalid: string }
  >([
    ['/v1/sani/linear', { run: runLinear, limit: 64 << 10, invalid: 'invalid_linear_request' }],
    [
      '/v1/sani/connectors',
      { run: runConnector, limit: 64 << 10, invalid: 'invalid_sani_request' },
    ],
    [
      '/v1/sani/registered-mcp',
      { run: runRegisteredMcp, limit: 64 << 10, invalid: 'invalid_registered_mcp_request' },
    ],
    [
      '/v1/sani/pet-canvas',
      {
        run: (value) => runPetCanvas(value, config.collabUrl),
        limit: 540 << 10,
        invalid: 'invalid_canvas_request',
      },
    ],
    [
      '/v1/sani/pet-sheet',
      {
        run: (value) => runPetSheet(value, config.collabUrl, deps.fetch),
        limit: 64 << 10,
        invalid: 'invalid_sheet_request',
      },
    ],
  ]);
  const core = new CoreClient({
    baseUrl: config.apiUrl,
    secret: config.internalSecret,
    release: config.release,
    fetch: deps.fetch,
  });
  const manager = new Manager(config, {
    executeConversationTool: core.executeConversationTool,
    serverTools: createServerTools(config),
    ...deps,
  });
  const ping = deps.ping ?? ((): Promise<boolean> => core.ping(AbortSignal.timeout(3000)));

  const authenticated = (req: IncomingMessage): boolean => {
    const presented = req.headers['x-nix-internal-secret'];
    return (
      typeof presented === 'string' &&
      presented !== '' &&
      config.internalSecret !== '' &&
      sameSecret(presented, config.internalSecret)
    );
  };

  const listener: RequestListener = (req, res) => {
    const path = (req.url ?? '').split('?')[0];
    void (async () => {
      if (path === '/healthz' || path === '/readyz') {
        if (req.method !== 'GET') {
          json(res, 405, { code: 'method_not_allowed' }, { Allow: 'GET' });
          return;
        }
        if (path === '/healthz') {
          json(res, 200, { status: 'healthy' });
          return;
        }
        const ready = writable(config.dataDir) && (await ping());
        json(res, ready ? 200 : 503, { status: ready ? 'ready' : 'not_ready' });
        return;
      }
      const sani = saniRoutes.get(path ?? '');
      if (path === '/v1/companion' || sani !== undefined) {
        if (sani !== undefined) res.setHeader('Cache-Control', 'no-store');
        if (req.method !== 'POST') {
          json(res, 405, { code: 'method_not_allowed' }, { Allow: 'POST' });
          return;
        }
        if (!authenticated(req)) {
          req.resume();
          json(res, 401, {
            code: 'internal_auth_required',
            detail: 'A trusted service credential is required.',
          });
          return;
        }
        if (sani !== undefined) {
          const reply = await sani.run(await readSaniRequest(req, sani.limit));
          if (reply === undefined) json(res, 400, { code: sani.invalid });
          else json(res, 200, reply);
        } else {
          await manager.serve(req, res);
        }
        return;
      }
      res.writeHead(404).end();
    })().catch(() => {
      if (!res.headersSent) res.writeHead(500);
      res.end();
    });
  };
  return { listener, manager };
}

/** The standalone http server; closing it also stops every provider process. */
export function createCompanionServer(config: CompanionConfig, deps: CompanionDeps = {}): Server {
  const { listener, manager } = createCompanion(config, deps);
  const server = createServer(listener);
  server.on('close', () => {
    manager.close();
  });
  return server;
}
