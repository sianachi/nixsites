import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { Account, type AccountOptions } from '../core/account.ts';
import { conversationKey } from '../shared/diagnostics.ts';
import {
  emptyRequest,
  type Level,
  type Logger,
  type Notify,
  type Request,
  type RequestHandler,
  type Transport,
} from '../shared/types.ts';

export const IDS = {
  tenant: '11111111-1111-4111-8111-111111111111',
  principal: '22222222-2222-4222-8222-222222222222',
  workspace: '33333333-3333-4333-8333-333333333333',
  pet: '44444444-4444-4444-8444-444444444444',
  request: '55555555-5555-4555-8555-555555555555',
  item: '66666666-6666-4666-8666-666666666666',
  other: '77777777-7777-4777-8777-777777777777',
};

export function request(overrides: Partial<Request> = {}): Request {
  return {
    ...emptyRequest(),
    tenantId: IDS.tenant,
    principalId: IDS.principal,
    workspaceId: IDS.workspace,
    petId: IDS.pet,
    requestId: IDS.request,
    operation: 'send',
    text: 'Help me write',
    instructions: 'Be calm and concise',
    ...overrides,
  };
}

export const keyOf = (r: Request): string => conversationKey(r);

export function tempDir(): string {
  return mkdtempSync(join(tmpdir(), 'companion-'));
}

export interface LogLine {
  level: Level;
  message: string;
  attrs: Record<string, unknown>;
}

export class MemoryLogger implements Logger {
  readonly lines: LogLine[] = [];
  log(level: Level, message: string, attrs: Record<string, unknown> = {}): void {
    this.lines.push({ level, message, attrs });
  }
  text(): string {
    return JSON.stringify(this.lines);
  }
}

export interface Call {
  method: string;
  params: Record<string, unknown>;
}

/** The scripted Codex peer the Go tests call fakeTransport. */
export class FakeTransport implements Transport {
  readonly calls: Call[] = [];
  handler: RequestHandler | undefined;
  readonly replies: { id: unknown; result: unknown }[] = [];
  /** Per-method override; return undefined to fall through to the default answer. */
  script: (method: string, params: Record<string, unknown>) => unknown = () => undefined;
  models: unknown[] = [];
  supportsReply = true;

  call(method: string, params: unknown): Promise<unknown> {
    const p = params as Record<string, unknown>;
    this.calls.push({ method, params: p });
    const scripted = this.script(method, p);
    if (scripted instanceof Error) return Promise.reject(scripted);
    if (scripted !== undefined) return Promise.resolve(scripted);
    switch (method) {
      case 'account/login/start':
        return Promise.resolve({
          loginId: 'login',
          verificationUrl: 'https://auth.openai.com/codex/device',
          userCode: '1234-ABCD',
        });
      case 'account/read':
        return Promise.resolve({ account: { type: 'chatgpt' } });
      case 'thread/start':
      case 'thread/resume':
        return Promise.resolve({ thread: { id: 'provider-thread' } });
      case 'turn/start':
        return Promise.resolve({ turn: { id: 'provider-turn' } });
      case 'model/list':
        return Promise.resolve({ data: this.models });
      default:
        return Promise.resolve({});
    }
  }
  close(): void {
    // nothing to stop
  }
  setRequestHandler(handler: RequestHandler): void {
    this.handler = handler;
  }
  reply(id: unknown, result: unknown): void {
    if (!this.supportsReply) throw new Error('no reply');
    this.replies.push({ id, result });
  }
  methods(): string[] {
    return this.calls.map((c) => c.method);
  }
  last(method: string): Record<string, unknown> {
    const found = [...this.calls].reverse().find((c) => c.method === method);
    if (found === undefined) throw new Error(`no ${method} call`);
    return found.params;
  }
  /** Sends the account a tool call as the provider would. */
  toolCall(
    id: number,
    callId: string,
    tool: string,
    args: unknown,
    threadId = 'provider-thread',
    byteLength?: number,
  ): boolean {
    const params = { threadId, tool, callId, arguments: args };
    // The wire length is what the real reader measured on the raw line; a caller passes it when
    // the arguments are too deep for JSON.stringify on older Node versions.
    return (
      this.handler?.(id, 'item/tool/call', params, byteLength ?? JSON.stringify(params).length) ??
      false
    );
  }
}

export interface Harness {
  account: Account;
  transport: FakeTransport;
  logger: MemoryLogger;
  home: string;
  signal: AbortSignal;
  /** Feeds the account a provider notification. */
  notify: Notify;
}

export function harness(
  options: Partial<AccountOptions> & { transport?: FakeTransport } = {},
): Harness {
  const home = options.home ?? tempDir();
  const transport = options.transport ?? new FakeTransport();
  const logger = new MemoryLogger();
  const account = new Account({
    home,
    provider: 'chatgpt',
    chatEffort: '',
    logger,
    trace: false,
    transport,
    ...options,
  });
  account.status = 'connected';
  return {
    account,
    transport,
    logger,
    home,
    signal: new AbortController().signal,
    notify: (m, p) => {
      account.notify(m, p);
    },
  };
}

export const completed = (
  threadId = 'provider-thread',
  text = 'Here is a suggestion.',
): [string, unknown][] => [
  ['item/completed', { threadId, item: { type: 'agentMessage', text, phase: 'final_answer' } }],
  ['turn/completed', { threadId, turn: { status: 'completed' } }],
];

/** Waits until check() is true, polling the event loop. */
export async function eventually(check: () => boolean, ms = 3000): Promise<void> {
  const until = Date.now() + ms;
  while (!check()) {
    if (Date.now() > until) throw new Error('condition not met in time');
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
}

// ---- a local HTTP server for provider and Core fakes ----

import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http';
import type { AddressInfo } from 'node:net';

export interface Seen {
  method: string;
  url: string;
  headers: IncomingMessage['headers'];
  body: string;
}

export interface FakeServer {
  url: string;
  seen: Seen[];
  close(): Promise<void>;
}

export type FakeHandler = (seen: Seen, res: ServerResponse) => void;

export async function startServer(handler: FakeHandler): Promise<FakeServer> {
  const seen: Seen[] = [];
  const server: Server = createServer((req, res) => {
    const chunks: Buffer[] = [];
    req.on('data', (c: Buffer) => chunks.push(c));
    req.on('end', () => {
      const entry = {
        method: req.method ?? '',
        url: req.url ?? '',
        headers: req.headers,
        body: Buffer.concat(chunks).toString('utf8'),
      };
      seen.push(entry);
      handler(entry, res);
    });
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  return {
    url: `http://127.0.0.1:${String((server.address() as AddressInfo).port)}`,
    seen,
    close: () =>
      new Promise<void>((resolve) => {
        server.closeAllConnections();
        server.close(() => {
          resolve();
        });
      }),
  };
}

/** Writes server-sent events: each item is one `data:` line. */
export function sse(res: ServerResponse, items: (object | string)[], keepOpen = false): true {
  res.writeHead(200, { 'Content-Type': 'text/event-stream' });
  for (const item of items)
    res.write(`data: ${typeof item === 'string' ? item : JSON.stringify(item)}\n\n`);
  if (!keepOpen) res.end();
  return true;
}

export function jsonResponse(
  res: ServerResponse,
  status: number,
  body: unknown,
  headers: Record<string, string> = {},
): true {
  res.writeHead(status, { 'Content-Type': 'application/json', ...headers });
  res.end(JSON.stringify(body));
  return true;
}

// ---- the whole service on a local port ----

import { chmodSync, writeFileSync } from 'node:fs';
import { createCompanion, type CompanionDeps } from '../server/server.ts';
import type { CompanionConfig } from '../core/config.ts';
import type { Launch } from '../shared/types.ts';

export const SECRET = 'test-internal-secret';

export interface Booted {
  url: string;
  config: CompanionConfig;
  logger: MemoryLogger;
  manager: ReturnType<typeof createCompanion>['manager'];
  fake: FakeTransport;
  /** The notify function the manager handed the launcher. */
  notifications: Notify[];
  post(body: unknown, headers?: Record<string, string>): Promise<Response>;
  call(overrides: Partial<Request>, signal?: AbortSignal): Promise<Response>;
  close(): Promise<void>;
}

export async function boot(
  options: {
    real?: boolean;
    launch?: Launch | undefined;
    config?: Partial<CompanionConfig>;
    deps?: CompanionDeps;
    fake?: FakeTransport;
  } = {},
): Promise<Booted> {
  const logger = new MemoryLogger();
  const fake = options.fake ?? new FakeTransport();
  const notifications: Notify[] = [];
  const config: CompanionConfig = {
    dataDir: tempDir(),
    binary: 'codex',
    chatEffort: '',
    trace: false,
    idleSeconds: 300,
    internalSecret: SECRET,
    apiUrl: 'http://127.0.0.1:1',
    serverTools: 'off',
    collabUrl: '',
    address: { host: '127.0.0.1', port: 0 },
    release: { version: '', commit: '' },
    ...options.config,
  };
  const launch: Launch | undefined = options.real
    ? undefined
    : (options.launch ??
      ((_provider, _binary, _home, _key, notify) => {
        notifications.push(notify);
        return Promise.resolve(fake);
      }));
  const { listener, manager } = createCompanion(config, {
    logger,
    ping: () => Promise.resolve(true),
    ...options.deps,
    launch,
  });
  const server = createServer(listener);
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const url = `http://127.0.0.1:${String((server.address() as AddressInfo).port)}`;
  const post = (
    body: unknown,
    headers: Record<string, string> = { 'X-Nix-Internal-Secret': SECRET },
  ): Promise<Response> =>
    fetch(`${url}/v1/companion`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', ...headers },
      body: typeof body === 'string' ? body : JSON.stringify(body),
    });
  return {
    url,
    config,
    logger,
    manager,
    fake,
    notifications,
    post,
    call: (overrides, signal) =>
      fetch(`${url}/v1/companion`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'X-Nix-Internal-Secret': SECRET },
        body: JSON.stringify(request(overrides)),
        ...(signal === undefined ? {} : { signal }),
      }),
    close: () =>
      new Promise<void>((resolve) => {
        manager.close();
        server.closeAllConnections();
        server.close(() => {
          resolve();
        });
      }),
  };
}

/** A shell wrapper that runs the scripted Codex peer, so the real launcher can spawn it. */
export function fakeCodexBinary(): string {
  const dir = tempDir();
  const path = join(dir, 'codex');
  const script = fileURLToPath(new URL('./fake-codex.ts', import.meta.url));
  writeFileSync(
    path,
    `#!/bin/sh\nexec "${process.execPath}" --experimental-strip-types --no-warnings "${script}" "$@"\n`,
  );
  chmodSync(path, 0o755);
  return path;
}

import { fileURLToPath } from 'node:url';
