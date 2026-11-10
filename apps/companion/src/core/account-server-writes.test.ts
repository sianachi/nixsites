import { describe, expect, it, vi } from 'vitest';

import type { ServerToolInput, ServerToolOutcome, ServerTools } from '../tools/server-tools.ts';
import { eventually, harness, IDS, keyOf, request } from '../testing/testing.ts';
import type { emptyRequest } from '../shared/types.ts';

const WRITE_TOKEN = 'w.r.t';
const APPEND = { itemId: IDS.item, markdown: 'More' };
const CLAIM = IDS.other;

const ok = (text = '{"ok":true}'): ServerToolOutcome => ({
  kind: 'result',
  text,
  success: true,
  lockedContent: false,
  image: '',
});

function fake(
  outcome: ServerToolOutcome | Promise<ServerToolOutcome> = ok(),
  mode: 'reads' | 'all' = 'all',
) {
  const run = vi.fn<
    (input: ServerToolInput, signal: AbortSignal, write?: boolean) => Promise<ServerToolOutcome>
  >(() => Promise.resolve(outcome));
  const tools: ServerTools = { mode, run };
  return { tools, run };
}

async function start(tools: ServerTools | undefined, tool: string, args: unknown) {
  const h = harness({ serverTools: tools });
  const r = request({ workspaceAccess: true });
  await h.account.handle(h.signal, r);
  const key = keyOf(r);
  h.transport.toolCall(1, 'call-1', tool, args);
  const snap = () => h.account.snapshot(key);
  const approve = (overrides: Partial<ReturnType<typeof emptyRequest>> = {}) =>
    h.account.handle(
      h.signal,
      request({
        operation: 'tool_approve',
        toolId: 'call-1',
        requestId: CLAIM,
        turnToken: WRITE_TOKEN,
        approvedOperation: 'append_note',
        ...overrides,
      }),
    );
  return { h, key, snap, approve };
}

const settle = () => new Promise((resolve) => setTimeout(resolve, 20));

describe('tool_approve', () => {
  it('claims a pending write, runs it once with the write token and the fence, and answers', async () => {
    const { tools, run } = fake();
    const { h, snap, approve } = await start(tools, 'nix_append_note', APPEND);
    await approve({ fingerprint: 'fp-1' });
    await eventually(() => snap().tools[0]?.status === 'completed');
    expect(run).toHaveBeenCalledOnce();
    expect(run.mock.calls[0]?.[0]).toMatchObject({
      token: WRITE_TOKEN,
      toolId: 'call-1',
      claimId: CLAIM,
      fence: 'fp-1',
    });
    expect(run.mock.calls[0]?.[2]).toBe(true);
    expect(snap().tools[0]).toMatchObject({ claimId: CLAIM, result: '{"ok":true}' });
    expect(h.transport.replies).toHaveLength(1);
    expect(JSON.stringify(snap())).not.toContain(WRITE_TOKEN);
  });

  it('applies a double approval once', async () => {
    const { tools, run } = fake(new Promise<ServerToolOutcome>(() => undefined));
    const { approve } = await start(tools, 'nix_append_note', APPEND);
    await approve();
    await expect(approve({ requestId: IDS.request })).rejects.toThrow('already claimed');
    expect(run).toHaveBeenCalledOnce();
  });

  it('refuses an approval after the turn ended', async () => {
    const { tools, run } = fake();
    const { h, key, approve } = await start(tools, 'nix_append_note', APPEND);
    h.account.cancelTools(key);
    await expect(approve()).rejects.toThrow('already claimed');
    expect(run).not.toHaveBeenCalled();
  });

  it('runs edited arguments, prefixed with the edit note', async () => {
    const { tools, run } = fake();
    const { snap, approve } = await start(tools, 'nix_append_note', APPEND);
    const edited = JSON.stringify({
      ...(JSON.parse(snap().tools[0]?.arguments ?? '{}') as object),
      markdown: 'Edited',
    });
    await approve({ editedArguments: edited, editNote: 'Owner edited the text.' });
    await eventually(() => snap().tools[0]?.status === 'completed');
    expect(run.mock.calls[0]?.[0].args).toBe(edited);
    expect(snap().tools[0]?.result).toBe('Owner edited the text.\n{"ok":true}');
  });

  it('refuses edits that change the operation, or come with automatic', async () => {
    const { tools, run } = fake();
    const { snap, approve } = await start(tools, 'nix_append_note', APPEND);
    const original = JSON.parse(snap().tools[0]?.arguments ?? '{}') as object;
    const other = JSON.stringify({ ...original, operation: 'rename_item', title: 'x' });
    await expect(
      approve({ editedArguments: other, approvedOperation: 'rename_item' }),
    ).rejects.toThrow();
    await expect(
      approve({ editedArguments: JSON.stringify(original), automatic: true }),
    ).rejects.toThrow();
    expect(run).not.toHaveBeenCalled();
    expect(snap().tools[0]?.status).toBe('pending');
  });

  it('refuses an approvedOperation that differs from the call', async () => {
    const { tools, run } = fake();
    const { approve } = await start(tools, 'nix_append_note', APPEND);
    await expect(approve({ approvedOperation: 'move_item' })).rejects.toThrow('does not match');
    expect(run).not.toHaveBeenCalled();
  });

  it('refuses when server writes are off or only reads are on', async () => {
    const reads = fake(ok(), 'reads');
    const a = await start(reads.tools, 'nix_append_note', APPEND);
    await expect(a.approve()).rejects.toThrow('server writes are off');
    expect(a.snap().serverWrites).toBeUndefined();
    const b = await start(undefined, 'nix_append_note', APPEND);
    await expect(b.approve()).rejects.toThrow('server writes are off');
    const c = await start(fake().tools, 'nix_append_note', APPEND);
    await expect(c.approve({ turnToken: '' })).rejects.toThrow('server writes are off');
    expect(reads.run).not.toHaveBeenCalled();
  });

  it('reports serverWrites only in mode all', async () => {
    const { tools } = fake();
    const { snap } = await start(tools, 'nix_append_note', APPEND);
    expect(snap().serverWrites).toBe(true);
  });

  it('never runs an always-ask operation unasked', async () => {
    const { tools, run } = fake();
    const { snap, approve } = await start(tools, 'nix_trash_item', { itemId: IDS.item });
    await approve({ approvedOperation: 'trash_item', automatic: true });
    await settle();
    expect(run).not.toHaveBeenCalled();
    expect(snap().tools[0]?.status).toBe('pending');
  });

  it('never runs a write with an external link unasked', async () => {
    const { tools, run } = fake();
    const { snap, approve } = await start(tools, 'nix_append_note', {
      itemId: IDS.item,
      markdown: '![x](https://evil.example/a.png)',
    });
    await approve({ automatic: true });
    await settle();
    expect(run).not.toHaveBeenCalled();
    expect(snap().tools[0]?.status).toBe('pending');
  });

  it('still runs the same write when the owner approves it by hand', async () => {
    const { tools, run } = fake();
    const { snap, approve } = await start(tools, 'nix_append_note', {
      itemId: IDS.item,
      markdown: 'see https://example.com/a',
    });
    await approve();
    await eventually(() => snap().tools[0]?.status === 'completed');
    expect(run).toHaveBeenCalledOnce();
  });

  it('never auto-applies once the conversation read protected content', async () => {
    const read = fake({ ...ok('secret'), lockedContent: true } as ServerToolOutcome, 'all');
    const { h, snap, approve } = await start(read.tools, 'nix_append_note', APPEND);
    const key = keyOf(request());
    const c = h.account.conversations.get(key);
    if (c !== undefined) c.lockedRead = true;
    await approve({ automatic: true });
    await settle();
    expect(read.run).not.toHaveBeenCalled();
    expect(snap().tools[0]?.status).toBe('pending');
  });

  it('applies an automatic approval of a plain write', async () => {
    const { tools, run } = fake();
    const { snap, approve } = await start(tools, 'nix_append_note', APPEND);
    await approve({ automatic: true });
    await eventually(() => snap().tools[0]?.status === 'completed');
    expect(run).toHaveBeenCalledOnce();
  });

  it('refuses app-only operations', async () => {
    const { tools, run } = fake();
    const { approve } = await start(tools, 'nix_save_as_template', {
      itemId: IDS.item,
      spec: { title: 'T' },
    });
    await expect(approve({ approvedOperation: 'save_as_template' })).rejects.toThrow();
    expect(run).not.toHaveBeenCalled();
  });

  it('maps a refusal to failed, and an unknown error to the uncertain text', async () => {
    const refused = fake({
      kind: 'result',
      text: 'No.',
      success: false,
      lockedContent: false,
      image: '',
    });
    const a = await start(refused.tools, 'nix_append_note', APPEND);
    await a.approve();
    await eventually(() => a.snap().tools[0]?.status === 'failed');
    expect(a.snap().tools[0]?.result).toBe('No.');
    const broken = fake();
    broken.run.mockRejectedValueOnce(new Error('boom'));
    const b = await start(broken.tools, 'nix_append_note', APPEND);
    await b.approve();
    await eventually(() => b.snap().tools[0]?.status === 'failed');
    expect(b.snap().tools[0]?.result).toContain('uncertain');
  });

  it('marks an approved write interrupted after a restart, and never retries it', async () => {
    const { tools, run } = fake(new Promise<ServerToolOutcome>(() => undefined));
    const { h, key, snap, approve } = await start(tools, 'nix_append_note', APPEND);
    await approve();
    expect(snap().tools[0]?.status).toBe('claimed');
    const other = harness({ home: h.home, serverTools: tools });
    other.account.load(key);
    expect(other.account.snapshot(key).tools[0]).toMatchObject({
      status: 'interrupted',
      result: expect.stringContaining('Check Nix') as string,
    });
    expect(run).toHaveBeenCalledOnce();
  });
});
