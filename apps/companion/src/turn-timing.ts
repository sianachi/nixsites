import { createHash } from 'node:crypto';

import type { Logger, ProviderUsage } from './types.ts';

/**
 * One turn's in-memory timing bookkeeping for the turn-completed log line and for the 15-minute
 * "thinking" expiry check: never persisted, never sent to the client, reset by start() at the
 * beginning of every send().
 */
export class TurnTiming {
  /** When the current turn began (ms); 0 if no turn has ever run. */
  started = 0;
  model = '';
  effort = '';
  firstToolAt = 0;
  toolCount = 0;
  pendingMs = 0;
  usage: ProviderUsage | undefined;

  start(model: string, effort: string): void {
    this.started = Date.now();
    this.model = model;
    this.effort = effort;
    this.firstToolAt = 0;
    this.toolCount = 0;
    this.pendingMs = 0;
    this.usage = undefined;
  }

  toolRecorded(): void {
    if (this.firstToolAt === 0) this.firstToolAt = Date.now();
    this.toolCount++;
  }

  toolClaimed(since: number): void {
    if (since !== 0) this.pendingMs += Date.now() - since;
  }

  /** One timing line for a finished turn: no message text, no id beyond a short hash of key. */
  log(logger: Logger | undefined, key: string, status: string): void {
    if (logger === undefined || this.started === 0) return;
    const attrs: Record<string, unknown> = {
      conversation: createHash('sha256').update(key).digest('hex').slice(0, 8),
      model: this.model === '' ? 'default' : this.model,
      effort: this.effort,
      status,
      total_ms: Date.now() - this.started,
      first_tool_ms: this.firstToolAt === 0 ? -1 : this.firstToolAt - this.started,
      tool_calls: this.toolCount,
      pending_ms: this.pendingMs,
    };
    if (this.usage !== undefined) {
      attrs.input_tokens = this.usage.input_tokens;
      attrs.cache_read_tokens = this.usage.cache_read_input_tokens;
      attrs.cache_write_tokens = this.usage.cache_creation_input_tokens;
      attrs.output_tokens = this.usage.output_tokens;
    }
    logger.log('info', 'companion turn completed', attrs);
  }
}
