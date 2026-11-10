import { describe, expect, it, vi } from 'vitest';

import type { ServerToolInput, ServerToolOutcome, ServerTools } from '../tools/server-tools.ts';
import { eventually, harness, IDS, keyOf, request } from '../testing/testing.ts';

const TOKEN = 'h.p.s';
const READ = { itemId: IDS.item };

function fake(outcome: ServerToolOutcome | Promise<ServerToolOutcome>) {
  const run = vi.fn<(input: ServerToolInput, signal: AbortSignal) => Promise<ServerToolOutcome>>(
    () => Promise.resolve(outcome),
  );
  const tools: ServerTools = { mode: 'reads', run };
  return { tools, run };
}

const ok = (text = '{"body":"hi"}', lockedContent = false): ServerToolOutcome => ({
  kind: 'result',
  text,
  success: true,
  lockedContent,
  image: '',
});

async function start(
  tools: ServerTools | undefined,
  overrides: Parameters<typeof request>[0] = {},
) {
  const h = harness({ serverTools: tools });
  const r = request({
    workspaceAccess: true,
    readWithoutAsking: true,
    turnToken: TOKEN,
    ...overrides,
  });
  await h.account.handle(h.signal, r);
  return { h, r, key: keyOf(r), snap: () => h.account.snapshot(keyOf(r)) };
}

describe('server-run reads', () => {
  it('claims a read at once, runs it with the token and answers the provider', async () => {
    const { tools, run } = fake(ok());
    const { h, snap } = await start(tools, { rootItemId: IDS.item, readOnly: true });
    h.transport.toolCall(1, 'call-1', 'nix_read_note', READ);
    await eventually(() => snap().tools[0]?.status === 'completed');
    expect(run).toHaveBeenCalledOnce();
    expect(run.mock.calls[0]?.[0]).toMatchObject({
      token: TOKEN,
      workspaceId: IDS.workspace,
      toolId: 'call-1',
      claimId: IDS.request,
      scope: { rootItemId: IDS.item, readOnly: true },
    });
    expect(h.transport.replies).toHaveLength(1);
    expect(snap().tools[0]).toMatchObject({ status: 'completed', result: '{"body":"hi"}' });
    expect(JSON.stringify(snap())).not.toContain(TOKEN);
  });

  it('marks the conversation as having read protected content', async () => {
    const { tools } = fake(ok('secret', true));
    const { h, snap } = await start(tools);
    h.transport.toolCall(1, 'call-1', 'nix_read_note', READ);
    await eventually(() => snap().tools[0]?.status === 'completed');
    expect(snap().lockedRead).toBe(true);
  });

  it('returns the call to the app when the server cannot run it', async () => {
    const { tools, run } = fake({ kind: 'app' });
    const { h, snap } = await start(tools);
    h.transport.toolCall(1, 'call-1', 'nix_read_note', READ);
    await eventually(() => run.mock.calls.length > 0);
    await eventually(() => snap().tools[0]?.status === 'pending');
    expect(snap().tools[0]?.claimId).toBe('');
    expect(h.transport.replies).toHaveLength(0);
  });

  it('records a failed result', async () => {
    const { tools } = fake({
      kind: 'result',
      text: 'nope',
      success: false,
      lockedContent: false,
      image: '',
    });
    const { h, snap } = await start(tools);
    h.transport.toolCall(1, 'call-1', 'nix_read_note', READ);
    await eventually(() => snap().tools[0]?.status === 'failed');
  });

  it.each([
    ['without readWithoutAsking', { readWithoutAsking: false }, 'nix_read_note', READ],
    ['without a turn token', { turnToken: '' }, 'nix_read_note', READ],
    ['for remember', {}, 'nix_remember', { fact: 'likes tea' }],
    ['for a write', {}, 'nix_rename_item', { itemId: IDS.item, title: 'New' }],
  ])('leaves the call pending %s', async (_name, overrides, tool, args) => {
    const { tools, run } = fake(ok());
    const { h, snap } = await start(tools, overrides);
    h.transport.toolCall(1, 'call-1', tool, args);
    expect(snap().tools[0]?.status).toBe('pending');
    await new Promise((resolve) => setTimeout(resolve, 20));
    expect(run).not.toHaveBeenCalled();
  });

  it('behaves as before with the setting off, and never holds the token', async () => {
    const { h, r, snap } = await start(undefined);
    h.transport.toolCall(1, 'call-1', 'nix_read_note', READ);
    expect(snap().tools[0]?.status).toBe('pending');
    expect(h.account.conversations.get(keyOf(r))?.actor.turnToken).toBe('');
  });

  it('stops using the token for the turn once Core refused it', async () => {
    const { tools, run } = fake({ kind: 'app', stopToken: true });
    const { h, key, snap } = await start(tools);
    h.transport.toolCall(1, 'call-1', 'nix_read_note', READ);
    await eventually(() => snap().tools[0]?.status === 'pending');
    expect(h.account.conversations.get(key)?.actor.turnToken).toBe('');
    h.transport.toolCall(2, 'call-2', 'nix_read_note', READ);
    await new Promise((resolve) => setTimeout(resolve, 20));
    expect(run).toHaveBeenCalledOnce();
  });

  it('drops the token when the turn ends', async () => {
    const { tools } = fake(ok());
    const { h, r, key } = await start(tools);
    expect(h.account.conversations.get(key)?.actor.turnToken).toBe(TOKEN);
    h.account.cancelTools(key);
    expect(h.account.conversations.get(key)?.actor.turnToken).toBe('');
    void r;
  });

  it('drops a late result after an interrupt', async () => {
    let finish: (o: ServerToolOutcome) => void = () => undefined;
    const { tools } = fake(new Promise<ServerToolOutcome>((resolve) => (finish = resolve)));
    const { h, key, snap } = await start(tools);
    h.transport.toolCall(1, 'call-1', 'nix_read_note', READ);
    expect(snap().tools[0]?.status).toBe('claimed');
    h.account.cancelTools(key);
    finish(ok());
    await new Promise((resolve) => setTimeout(resolve, 20));
    expect(snap().tools[0]?.status).toBe('interrupted');
  });

  it('marks a server-claimed read interrupted after a restart', async () => {
    const { tools } = fake(new Promise<ServerToolOutcome>(() => undefined));
    const { h, r, key, snap } = await start(tools);
    h.transport.toolCall(1, 'call-1', 'nix_read_note', READ);
    expect(snap().tools[0]?.status).toBe('claimed');
    const other = harness({ home: h.home, serverTools: tools });
    other.account.load(key);
    expect(other.account.snapshot(keyOf(r)).tools[0]?.status).toBe('interrupted');
  });
});
