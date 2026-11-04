import { createHash } from 'node:crypto';
import { appendFileSync, mkdirSync, rmSync, statSync } from 'node:fs';
import { join } from 'node:path';

import type { Level, Logger } from './types.ts';
import { truncateUtf8 } from './util.ts';

/**
 * Two layers, so a misbehaving pet can be debugged without routinely logging what people write.
 * Events always go to the structured log: names, outcomes, counts, durations, fixed refusal
 * reasons and provider error codes, never message text, tool arguments or results, and a
 * conversation only as a short hash of its key. A trace is opt-in (NIX_COMPANION_TRACE): every
 * event plus its content as JSON lines under <account home>/traces/, mode 0600. Never enable it in
 * production: traces hold private workspace content. Deleting a conversation's history removes
 * its trace.
 */

export const MAX_TRACE_BYTES = 32 << 20;
export const MAX_STDERR_BYTES = 8 << 20;
const MAX_TRACE_CONTENT_BYTES = 64 << 10;

export function stdoutLogger(): Logger {
  return {
    log(level, message, attrs) {
      // Debug events (accounts' background notifications, message bodies' sizes) are for the trace only.
      if (level === 'debug') return;
      process.stdout.write(
        `${JSON.stringify({ at: new Date().toISOString(), level, message, ...attrs })}\n`,
      );
    },
  };
}

/** First 4 bytes of sha256(key): the only identifier events carry. */
export function conversationTag(key: string): string {
  return key === '' ? 'account' : createHash('sha256').update(key).digest('hex').slice(0, 8);
}

/** Bounds a payload for a trace line. */
export function traceRaw(value: unknown): unknown {
  const text = JSON.stringify(value) as string | undefined;
  if (text !== undefined && Buffer.byteLength(text) > MAX_TRACE_CONTENT_BYTES) {
    return `(${String(Buffer.byteLength(text))} bytes, truncated) ${truncateUtf8(text, MAX_TRACE_CONTENT_BYTES)}`;
  }
  return value;
}

export class Diagnostics {
  readonly home: string;
  readonly logger: Logger | undefined;
  readonly trace: boolean;
  private readonly full = new Set<string>();

  constructor(home: string, logger: Logger | undefined, trace: boolean) {
    this.home = home;
    this.logger = logger;
    this.trace = trace;
  }

  /** meta is safe for the shared log; content goes only to the opt-in trace. */
  record(
    key: string,
    level: Level,
    event: string,
    meta: Record<string, unknown> = {},
    content?: Record<string, unknown>,
  ): void {
    const tag = conversationTag(key);
    this.logger?.log(level, `companion ${event}`, { conversation: tag, ...meta });
    if (!this.trace) return;
    const line: Record<string, unknown> = {
      time: new Date().toISOString(),
      conversation: tag,
      event,
      level,
      ...meta,
    };
    if (content !== undefined && Object.keys(content).length > 0) line.content = content;
    this.append(tag, line);
  }

  private append(tag: string, line: Record<string, unknown>): void {
    try {
      const dir = join(this.home, 'traces');
      mkdirSync(dir, { recursive: true, mode: 0o700 });
      const path = join(dir, `${tag}.jsonl`);
      let size = 0;
      try {
        size = statSync(path).size;
      } catch {
        // no trace yet
      }
      if (size >= MAX_TRACE_BYTES) {
        if (this.full.has(tag)) return;
        this.full.add(tag);
        line = {
          time: new Date().toISOString(),
          conversation: tag,
          event: 'trace.full',
          note: 'trace size cap reached; later events for this conversation are not traced',
        };
      }
      appendFileSync(path, `${JSON.stringify(line)}\n`, { mode: 0o600 });
    } catch {
      // diagnostics never fail a request
    }
  }

  removeTrace(key: string): void {
    const tag = conversationTag(key);
    rmSync(join(this.home, 'traces', `${tag}.jsonl`), { force: true });
    this.full.delete(tag);
  }
}

/** Reduces an error to text fit for the shared log: a filesystem error's path names ids. */
export function logSafeError(error: unknown): string {
  if (error === undefined || error === null) return '';
  if (error instanceof Error) {
    const code = (error as NodeJS.ErrnoException).code;
    if (code !== undefined && (error as NodeJS.ErrnoException).syscall !== undefined) {
      return `${(error as NodeJS.ErrnoException).syscall ?? ''}: ${code}`;
    }
    return truncateUtf8(error.message, 300);
  }
  return truncateUtf8(typeof error === 'string' ? error : 'unknown error', 300);
}

export const DECLINED_FOR_PROBLEMS = 'Declined: the design has problems.';

/** Classifies a tool result for the shared log without logging its text. */
export function resultKind(success: boolean, result: string): string {
  if (success) return 'ok';
  if (result === 'Declined by the user. Do not retry this change unless asked.') return 'declined';
  if (result.startsWith(DECLINED_FOR_PROBLEMS)) return 'auto_declined_problems';
  if (result === 'No result supplied. Do not assume the operation succeeded.') return 'no_result';
  return 'failed';
}

/** One conversation per pet per workspace (per note or saved chat when scoped). */
export function conversationKey(r: {
  workspaceId: string;
  petId: string;
  conversationItemId: string;
  rootItemId: string;
}): string {
  if (r.workspaceId === '' || r.petId === '') return '';
  let key = `${r.workspaceId}-${r.petId}`;
  if (r.conversationItemId !== '') return `${key}-chat-${r.conversationItemId}`;
  if (r.rootItemId !== '') key += `-note-${r.rootItemId}`;
  return key;
}

export const valueOrDefault = (model: string): string => (model === '' ? 'default' : model);

export interface TurnError {
  message: string;
  nixProviderError: string;
  codexErrorInfo: unknown;
}

/**
 * Only what is safe for the shared log. The structured code is always logged; the free-text
 * message only when the code is a plain name or absent, since an upstream HTTP failure's message
 * can carry the response body.
 */
export function turnErrorAttrs(e: TurnError | undefined): Record<string, unknown> {
  if (e === undefined) return {};
  const attrs: Record<string, unknown> = {};
  const info =
    e.codexErrorInfo === undefined || e.codexErrorInfo === null
      ? ''
      : JSON.stringify(e.codexErrorInfo);
  const hasInfo = info !== '' && info !== 'null';
  if (hasInfo) attrs.code = truncateUtf8(info, 200);
  if (!hasInfo || info.startsWith('"')) attrs.error = truncateUtf8(e.message, 500);
  return attrs;
}
