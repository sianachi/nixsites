import { existsSync, readFileSync, statSync, writeFileSync, mkdirSync } from 'node:fs';
import { join } from 'node:path';

import { afterEach, describe, expect, it } from 'vitest';

import {
  MAX_TRACE_BYTES,
  conversationTag,
  logSafeError,
  rawSyntaxKinds,
  resultKind,
  traceRaw,
  turnErrorAttrs,
} from './diagnostics.ts';
import { argumentRefusalCode } from '../tools/flatten.ts';
import { boot, completed, harness, IDS, keyOf, request, type Booted } from '../testing/testing.ts';

const open: Booted[] = [];
afterEach(async () => {
  await Promise.all(open.splice(0).map((b) => b.close()));
});

const key = keyOf(request());
const SECRET_TEXT = 'my-private-sentence-xyzzy';

async function run(h: ReturnType<typeof harness>): Promise<void> {
  await h.account.handle(
    h.signal,
    request({ text: SECRET_TEXT, workspaceAccess: true, instructions: 'private persona text' }),
  );
  h.notify('item/completed', {
    threadId: 'provider-thread',
    item: {
      id: 'c',
      type: 'agentMessage',
      phase: 'commentary',
      text: 'I will read the private note.',
    },
  });
  h.transport.toolCall(1, 'call-1', 'nix_read_note', { itemId: IDS.item });
  await h.account.handle(
    h.signal,
    request({ operation: 'tool_claim', toolId: 'call-1', requestId: IDS.other }),
  );
  await h.account.handle(
    h.signal,
    request({
      operation: 'tool_result',
      toolId: 'call-1',
      requestId: IDS.other,
      toolResult: 'secret note body',
      toolSuccess: true,
    }),
  );
  h.notify('item/completed', {
    threadId: 'provider-thread',
    item: { id: 'f', type: 'agentMessage', phase: 'final_answer', text: 'the private answer' },
  });
  h.notify('turn/completed', { threadId: 'provider-thread', turn: { status: 'completed' } });
}

describe('the shared log', () => {
  it('records every step but never content or identifiers', async () => {
    const h = harness();
    await run(h);
    const events = h.logger.lines.map((l) => l.message.replace('companion ', ''));
    expect(events).toEqual(
      expect.arrayContaining([
        'turn.started',
        'tool.requested',
        'tool.claimed',
        'tool.result',
        'turn completed',
      ]),
    );
    const text = h.logger.text();
    for (const secret of [
      SECRET_TEXT,
      'private persona',
      'private note',
      'secret note body',
      'private answer',
      IDS.item,
      IDS.workspace,
      IDS.pet,
      IDS.tenant,
      IDS.principal,
    ]) {
      expect(text, secret).not.toContain(secret);
    }
    expect(
      h.logger.lines.find((l) => l.message === 'companion tool.requested')?.attrs,
    ).toMatchObject({ conversation: conversationTag(key), tool: 'nix_read_note' });
    expect(h.logger.lines.find((l) => l.message === 'companion tool.result')?.attrs).toMatchObject({
      outcome: 'ok',
      result_chars: 16,
    });
  });

  it('logs one timing line per finished turn, with counts and no content', async () => {
    const h = harness();
    await run(h);
    const line = h.logger.lines.find((l) => l.message === 'companion turn completed');
    expect(line?.attrs).toMatchObject({
      conversation: conversationTag(key),
      model: 'default',
      status: 'completed',
      tool_calls: 1,
    });
    expect(Object.keys(line?.attrs ?? {})).toEqual([
      'conversation',
      'model',
      'effort',
      'status',
      'total_ms',
      'first_text_ms',
      'first_tool_ms',
      'tool_calls',
      'pending_ms',
    ]);
    expect(conversationTag(key)).toMatch(/^[0-9a-f]{8}$/);
    expect(conversationTag('')).toBe('account');
  });

  it('records when reply text first arrived, once, and -1 for a turn that showed none', async () => {
    const timing = (h: ReturnType<typeof harness>): Record<string, unknown> =>
      h.logger.lines.find((l) => l.message === 'companion turn completed')?.attrs ?? {};
    // No text delta before the turn ended (tools only).
    const silent = harness();
    await run(silent);
    expect(timing(silent).first_text_ms).toBe(-1);

    const spoken = harness();
    await spoken.account.handle(spoken.signal, request());
    const delta = (text: string): void => {
      spoken.notify('item/agentMessage/delta', {
        threadId: 'provider-thread',
        itemId: 'm1',
        delta: text,
      });
    };
    delta('');
    expect(spoken.account.conversations.values().next().value?.timing.firstTextAt).toBe(0);
    delta('Hel');
    const first = spoken.account.conversations.values().next().value?.timing.firstTextAt;
    await new Promise((resolve) => setTimeout(resolve, 5));
    delta('lo');
    expect(spoken.account.conversations.values().next().value?.timing.firstTextAt).toBe(first);
    for (const [method, params] of completed()) spoken.notify(method, params);
    expect(timing(spoken).first_text_ms).toBeGreaterThanOrEqual(0);
    expect(JSON.stringify(timing(spoken))).not.toContain('Hel');
  });

  it('logs refused and rejected tool calls with a reason but never the arguments', async () => {
    const h = harness();
    await h.account.handle(h.signal, request({ workspaceAccess: true }));
    h.transport.toolCall(1, 'a', 'nix_read_item', { itemId: IDS.item, invented_key_zz: 'x' });
    h.transport.toolCall(2, 'b', 'nix_read_item', { itemId: 'not-uuid' });
    h.transport.toolCall(3, 'c', 'nix_workspace', {});
    const lines = h.logger.lines.filter((l) => l.message.startsWith('companion tool.'));
    expect(lines.map((l) => l.attrs)).toMatchObject([
      { stage: 'arguments', reason_code: 'unknown_parameter' },
      { stage: 'validation', reason: 'itemId must be a Nix item UUID.' },
      { reason: 'not offered' },
    ]);
    expect(h.logger.text()).not.toContain('invented_key_zz');
  });

  it('names a refusal template by a fixed code', () => {
    expect(argumentRefusalCode('"x" is not a parameter of nix_a; it accepts y.')).toBe(
      'unknown_parameter',
    );
    expect(argumentRefusalCode('nix_a.b must be a string.')).toBe('not_string');
    expect(argumentRefusalCode('nix_a.b must be a JSON object.')).toBe('not_object');
    expect(argumentRefusalCode('nix_a requires a JSON object of arguments.')).toBe(
      'arguments_not_object',
    );
    expect(argumentRefusalCode('nix_a is not a supported tool.')).toBe('unsupported_tool');
    expect(argumentRefusalCode('nix_a.b could not be processed.')).toBe('unprocessable');
    expect(argumentRefusalCode('anything else')).toBe('other');
  });

  it('classifies a result without logging its text', () => {
    expect(resultKind(true, 'x')).toBe('ok');
    expect(resultKind(false, 'Declined by the user. Do not retry this change unless asked.')).toBe(
      'declined',
    );
    expect(resultKind(false, 'Declined: the design has problems. 1. x')).toBe(
      'auto_declined_problems',
    );
    expect(resultKind(false, 'No result supplied. Do not assume the operation succeeded.')).toBe(
      'no_result',
    );
    expect(resultKind(false, 'boom')).toBe('failed');
  });

  it('reads raw-Markdown kinds from a note write result and nothing else', () => {
    const note =
      'Some Markdown stayed as plain text in the note (bold-marker x2, html-tag x1). Rewrite';
    expect(rawSyntaxKinds(`{"rawSyntaxNote":"${note}"}`)).toBe('bold-marker x2, html-tag x1');
    expect(rawSyntaxKinds('stayed as plain text in the note (My Secret Title x1)')).toBe('');
    expect(rawSyntaxKinds('Appended.')).toBe('');
  });

  it('keeps identifiers out of a failed history read', async () => {
    const b = await boot();
    open.push(b);
    const response = await b.call({ operation: 'read_history', historyId: IDS.other });
    expect(response.status).toBe(502);
    const failure = b.logger.lines.find((l) => l.message === 'companion request.failed');
    expect(failure?.attrs).toMatchObject({ operation: 'read_history', error: 'open: ENOENT' });
    expect(b.logger.text()).not.toContain(IDS.other);
    expect(b.logger.text()).not.toContain(b.config.dataDir);
    expect(logSafeError(new Error('x'.repeat(400))).length).toBe(300);
    expect(logSafeError(undefined)).toBe('');
  });

  it('logs a bounded turn error message and nothing for no error', () => {
    expect(turnErrorAttrs({ message: 'Usage limit reached', nixProviderError: '' })).toEqual({
      error: 'Usage limit reached',
    });
    expect(turnErrorAttrs(undefined)).toEqual({});
  });

  it('carries a failed turn and its provider code into the log without the upstream body', async () => {
    const h = harness();
    await h.account.handle(h.signal, request());
    h.notify('turn/completed', {
      threadId: 'provider-thread',
      durationMs: 5,
      turn: {
        status: 'failed',
        durationMs: 1234,
        error: { message: 'Anthropic could not be reached' },
      },
    });
    const failed = h.logger.lines.find((l) => l.message === 'companion turn.failed');
    expect(failed?.attrs).toMatchObject({
      status: 'failed',
      provider_duration_ms: 1234,
      error: 'Anthropic could not be reached',
    });
  });

  it('writes provider failure tokens to the log for a key provider failure', async () => {
    const h = harness({ provider: 'anthropic' });
    h.transport.models = [{ model: 'm', displayName: 'M', isDefault: true }];
    await h.account.handle(h.signal, request({ model: '' }));
    h.notify('turn/completed', {
      threadId: 'provider-thread',
      turn: {
        status: 'failed',
        error: { message: 'x', nixProviderError: 'anthropic.rate_limited.429' },
      },
    });
    expect(h.logger.lines.find((l) => l.message === 'companion turn.failed')?.attrs).toMatchObject({
      provider_error: 'anthropic.rate_limited.429',
      http_status: '429',
      operation: 'send',
    });
    expect(h.account.snapshot(key).reason).toContain('rate limiting this API key');
  });

  it('ignores a provider failure token that does not match the account provider', async () => {
    const h = harness({ provider: 'openrouter' });
    h.transport.models = [{ model: 'm', displayName: 'M', isDefault: true }];
    await h.account.handle(h.signal, request({ model: '' }));
    h.notify('turn/completed', {
      threadId: 'provider-thread',
      turn: {
        status: 'failed',
        error: { message: 'x', nixProviderError: 'anthropic.rate_limited.429' },
      },
    });
    expect(h.account.snapshot(key).reason).toContain('could not finish the response');
  });
});

describe('the trace', () => {
  it('is off unless asked for', async () => {
    const h = harness();
    await run(h);
    expect(existsSync(join(h.home, 'traces'))).toBe(false);
  });

  it('keeps full content privately, per conversation', async () => {
    const h = harness({ trace: true });
    await run(h);
    const dir = join(h.home, 'traces');
    expect(statSync(dir).mode & 0o777).toBe(0o700);
    const file = join(dir, `${conversationTag(key)}.jsonl`);
    expect(statSync(file).mode & 0o777).toBe(0o600);
    const lines = readFileSync(file, 'utf8')
      .trim()
      .split('\n')
      .map((l) => JSON.parse(l) as { event: string; content?: Record<string, unknown> });
    const text = JSON.stringify(lines);
    for (const wanted of [
      SECRET_TEXT,
      'private persona text',
      'I will read the private note.',
      'secret note body',
      'the private answer',
      IDS.item,
    ])
      expect(text, wanted).toContain(wanted);
    expect(lines.find((l) => l.event === 'turn.started')?.content).toMatchObject({
      instructions: 'private persona text',
    });
    expect(lines.find((l) => l.event === 'tool.requested')?.content).toHaveProperty('flat');
    expect(lines.map((l) => l.event)).not.toContain('item/agentMessage/delta');
  });

  it('records the raw notifications that belong to no conversation, except rate limits', () => {
    const h = harness({ trace: true });
    h.notify('account/updated', { plan: 'plus' });
    h.notify('account/rateLimits/updated', { used: 5 });
    const file = join(h.home, 'traces', 'account.jsonl');
    const lines = readFileSync(file, 'utf8').trim().split('\n');
    expect(lines).toHaveLength(1);
    expect(lines[0]).toContain('account/updated');
    // Debug events go to the trace file only; the stdout logger drops them.
    expect(h.logger.lines.every((l) => l.level === 'debug')).toBe(true);
  });

  it('is removed with the conversation history it holds', async () => {
    const h = harness({ trace: true });
    await run(h);
    await h.account.handle(h.signal, request({ operation: 'reset' }));
    const file = join(h.home, 'traces', `${conversationTag(key)}.jsonl`);
    expect(existsSync(file)).toBe(true);
    const id = (await h.account.handle(h.signal, request({ operation: 'history' }))).history[0]?.id;
    await h.account.handle(h.signal, request({ operation: 'delete_history', historyId: id ?? '' }));
    expect(existsSync(file)).toBe(false);
  });

  it('stops growing at its size cap with one final note', () => {
    const h = harness({ trace: true });
    const dir = join(h.home, 'traces');
    mkdirSync(dir, { recursive: true });
    const file = join(dir, `${conversationTag(key)}.jsonl`);
    writeFileSync(file, 'x'.repeat(MAX_TRACE_BYTES));
    h.account.diag.record(key, 'info', 'one');
    h.account.diag.record(key, 'info', 'two');
    const size = statSync(file).size;
    expect(size).toBeGreaterThan(MAX_TRACE_BYTES);
    expect(
      readFileSync(file, 'utf8').endsWith(
        'trace size cap reached; later events for this conversation are not traced"}\n',
      ),
    ).toBe(true);
    h.account.diag.record(key, 'info', 'three');
    expect(statSync(file).size).toBe(size);
  });

  it('bounds one raw payload and keeps valid JSON as JSON', () => {
    expect(traceRaw({ a: 1 })).toEqual({ a: 1 });
    const big = traceRaw({ text: 'é'.repeat(70000) }) as string;
    expect(big.startsWith('(')).toBe(true);
    expect(Buffer.byteLength(big)).toBeLessThan(65700);
  });
});
