import { mkdirSync } from 'node:fs';
import { join } from 'node:path';
import type { IncomingMessage, ServerResponse } from 'node:http';

import { Account, ReplaceBusyError, ReplaceTargetError, STUCK_TURN_MS } from './account.ts';
import type { CompanionConfig } from './config.ts';
import { conversationKey, logSafeError, stdoutLogger } from './diagnostics.ts';
import { HttpTransport } from './http-transport.ts';
import { sendError, serveInline, writeProviderFailure } from './inline.ts';
import { launchCodex } from './rpc.ts';
import {
  emptyRequest,
  type ConversationToolExecutor,
  type Launch,
  type Logger,
  type Request,
} from './types.ts';
import { UUID } from './util.ts';
import { parseRequest, validRequest } from './validation.ts';

/** How many principals' providers may run at once. */
export const MAX_ACCOUNTS = 4;
const MAX_BODY_BYTES = 1200 << 10;
const REQUEST_TIMEOUT_MS = 25_000;

export interface ManagerDeps {
  logger?: Logger | undefined;
  /** Replaces the default launcher (the Codex child, or the in-process HTTPS transport). */
  launch?: Launch | undefined;
  executeConversationTool?: ConversationToolExecutor | undefined;
  /** Provider origin overrides, for tests. */
  providerBaseUrls?: Partial<Record<'anthropic' | 'openrouter', string>> | undefined;
  fetch?: typeof fetch | undefined;
  /** How often idle accounts are looked for; default the smaller of a minute and half the idle time. */
  reapIntervalMs?: number | undefined;
}

async function readBody(req: IncomingMessage, limit: number): Promise<string | undefined> {
  const chunks: Buffer[] = [];
  let size = 0;
  for await (const chunk of req) {
    const buffer = chunk as Buffer;
    size += buffer.length;
    if (size > limit) return undefined;
    chunks.push(buffer);
  }
  return Buffer.concat(chunks).toString('utf8');
}

export class Manager {
  readonly accounts = new Map<string, Account>();
  private readonly pending = new Map<string, Promise<Account>>();
  private readonly config: CompanionConfig;
  private readonly logger: Logger;
  private readonly launch: Launch;
  private readonly executeConversationTool: ConversationToolExecutor | undefined;
  private readonly timer: NodeJS.Timeout;

  constructor(config: CompanionConfig, deps: ManagerDeps = {}) {
    this.config = config;
    this.logger = deps.logger ?? stdoutLogger();
    this.executeConversationTool = deps.executeConversationTool;
    mkdirSync(config.dataDir, { recursive: true, mode: 0o700 });
    this.launch =
      deps.launch ??
      ((provider, binary, home, apiKey, notify, trace) => {
        if (provider !== '' && provider !== 'chatgpt') {
          return Promise.resolve(
            new HttpTransport({
              kind: provider,
              apiKey,
              home,
              notify,
              baseUrl: deps.providerBaseUrls?.[provider as 'anthropic' | 'openrouter'],
              fetch: deps.fetch,
            }),
          );
        }
        return launchCodex(binary, home, notify, trace);
      });
    const interval = deps.reapIntervalMs ?? Math.min(60_000, (config.idleSeconds * 1000) / 2);
    this.timer = setInterval(() => {
      this.reap();
    }, interval);
    this.timer.unref();
  }

  /** Stops the provider process of every account idle longer than the configured time. */
  reap(): void {
    const idleMs = this.config.idleSeconds * 1000;
    for (const [key, a] of this.accounts) {
      const busy =
        a.opBusy ||
        a.watchers > 0 ||
        a.inlineStreams > 0 ||
        // A turn stuck past the read path's expiry (an approval card nobody answers) must not pin
        // one of the MAX_ACCOUNTS slots forever.
        [...a.conversations.values()].some(
          (c) => c.state === 'thinking' && Date.now() - c.timing.started <= STUCK_TURN_MS,
        );
      if (Date.now() - a.last > idleMs && !busy) {
        a.transport.close();
        this.accounts.delete(key);
      }
    }
  }

  close(): void {
    clearInterval(this.timer);
    for (const [key, a] of this.accounts) {
      a.transport.close();
      this.accounts.delete(key);
    }
  }

  /** One account per provider: conversation files share the principal's home, the process is the provider's own. */
  async account(signal: AbortSignal, r: Request): Promise<Account> {
    const provider = r.provider === '' ? 'chatgpt' : r.provider;
    let key = `${r.tenantId}-${r.principalId}`;
    if (provider !== 'chatgpt') key += `-${provider}`;
    for (;;) {
      const starting = this.pending.get(key);
      if (starting === undefined) break;
      await starting.catch(() => undefined);
    }
    const existing = this.accounts.get(key);
    if (existing !== undefined) {
      if (existing.provider !== 'chatgpt') existing.transport.setApiKey?.(r.apiKey);
      if (existing.transport.alive?.() === false) {
        this.accounts.delete(key);
      } else {
        existing.last = Date.now();
        return existing;
      }
    }
    if (this.accounts.size + this.pending.size >= MAX_ACCOUNTS)
      throw new Error('companion capacity reached');
    const starting = this.start(signal, r, provider);
    this.pending.set(key, starting);
    try {
      const account = await starting;
      this.accounts.set(key, account);
      return account;
    } finally {
      this.pending.delete(key);
    }
  }

  private async start(signal: AbortSignal, r: Request, provider: string): Promise<Account> {
    const home = join(this.config.dataDir, `${r.tenantId}-${r.principalId}`);
    const ref: { account?: Account } = {};
    const transport = await this.launch(
      provider,
      this.config.binary,
      home,
      r.apiKey,
      (method, params) => ref.account?.notify(method, params),
      this.config.trace,
    );
    const account = new Account({
      home,
      provider,
      transport,
      chatEffort: this.config.chatEffort,
      logger: this.logger,
      trace: this.config.trace,
      executeConversationTool: this.executeConversationTool,
    });
    ref.account = account;
    try {
      await account.handle(signal, { ...emptyRequest(), operation: 'status' });
    } catch (error) {
      transport.close();
      throw error;
    }
    return account;
  }

  /** POST /v1/companion, behind the caller's secret check. */
  async serve(req: IncomingMessage, res: ServerResponse): Promise<void> {
    res.setHeader('Content-Type', 'application/json');
    res.setHeader('Cache-Control', 'no-store');
    const client = new AbortController();
    res.on('close', () => {
      client.abort();
    });
    const body = await readBody(req, MAX_BODY_BYTES).catch(() => undefined);
    const request = body === undefined ? null : parseRequest(body);
    if (request === null || (request.operation !== 'inline' && !validRequest(request))) {
      sendError(res, 400, 'Invalid companion request');
      return;
    }
    if (request.operation === 'inline') {
      if (!UUID.test(request.tenantId) || !UUID.test(request.principalId)) {
        sendError(res, 400, 'Invalid companion request');
        return;
      }
      return serveInline(
        async (signal) => {
          try {
            return await this.account(signal, request);
          } catch (error) {
            this.logger.log('error', 'companion runtime unavailable', {
              operation: request.operation,
              error: logSafeError(error),
            });
            return undefined;
          }
        },
        res,
        request,
        client.signal,
      );
    }
    const signal = AbortSignal.any([client.signal, AbortSignal.timeout(REQUEST_TIMEOUT_MS)]);
    let account: Account;
    try {
      account = await this.account(signal, request);
    } catch (error) {
      // The provider process could not start or answer its first status call (a missing binary, a
      // crashed runtime, the account cap): without this line the only symptom is a 503.
      this.logger.log('error', 'companion runtime unavailable', {
        operation: request.operation,
        error: logSafeError(error),
      });
      sendError(res, 503, 'Companion runtime unavailable');
      return;
    }
    const key = conversationKey(request);
    let watching = false;
    let locked = false;
    try {
      // A watch or a plain read never claims the operation lock: they must never see "busy" while
      // a send or tool operation holds it. The watch cap bounds the database connections Core
      // pins behind every long-poll, per principal.
      if (request.operation === 'watch') {
        if (!account.tryAcquireWatcher()) {
          account.diag.record(key, 'warn', 'watch.refused', { reason: 'too many open watches' });
          sendError(res, 429, 'Too many open watches');
          return;
        }
        watching = true;
      }
      if (request.operation !== 'read' && request.operation !== 'watch') {
        if (account.opBusy) {
          account.diag.record(key, 'warn', 'request.busy', { operation: request.operation });
          sendError(res, 409, 'Companion is busy');
          return;
        }
        account.opBusy = true;
        locked = true;
      }
      account.last = Date.now();
      let response;
      try {
        response = await account.handle(signal, request);
      } catch (error) {
        account.diag.record(key, 'warn', 'request.failed', {
          operation: request.operation,
          error: logSafeError(error),
        });
        if (error instanceof ReplaceTargetError) {
          sendError(res, 400, 'Invalid companion request');
          return;
        }
        if (error instanceof ReplaceBusyError) {
          sendError(res, 409, 'Companion is busy');
          return;
        }
        writeProviderFailure(res, error);
        return;
      }
      res.end(`${JSON.stringify(response)}\n`);
    } finally {
      if (watching) account.releaseWatcher();
      if (locked) account.opBusy = false;
    }
  }
}
