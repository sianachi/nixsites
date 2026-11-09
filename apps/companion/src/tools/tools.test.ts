import { readFileSync } from 'node:fs';
import { join } from 'node:path';

import { describe, expect, it } from 'vitest';

import { MAX_TOOL_CALLS_PER_TURN } from '../core/account.ts';
import { workspaceTools } from './catalog.ts';
import { workspaceToolsForRequest } from './scope.ts';
import { eventually, FakeTransport, harness, IDS, keyOf, request } from '../testing/testing.ts';
import type { ConversationToolExecutor } from '../shared/types.ts';

const ID = IDS.item;

async function start(overrides = {}, options: Parameters<typeof harness>[0] = {}) {
  const h = harness(options);
  const r = request({ workspaceAccess: true, ...overrides });
  await h.account.handle(h.signal, r);
  return { h, r, key: keyOf(r), tools: () => h.account.snapshot(keyOf(r)).tools };
}

const claim = (
  h: ReturnType<typeof harness>,
  r: ReturnType<typeof request>,
  toolId: string,
  requestId = IDS.other,
) => h.account.handle(h.signal, { ...r, operation: 'tool_claim', toolId, requestId });
const finish = (
  h: ReturnType<typeof harness>,
  r: ReturnType<typeof request>,
  toolId: string,
  extra = {},
) =>
  h.account.handle(h.signal, {
    ...r,
    operation: 'tool_result',
    toolId,
    requestId: IDS.other,
    toolResult: 'done',
    toolSuccess: true,
    ...extra,
  });

describe('tool approval', () => {
  it('records a typed call as a pending receipt with flat arguments', async () => {
    const { h, tools } = await start();
    expect(h.transport.toolCall(1, 'call-1', 'nix_rename_item', { itemId: ID, title: 'New' })).toBe(
      true,
    );
    expect(tools()).toEqual([
      {
        id: 'call-1',
        arguments: `{"operation":"rename_item","itemId":"${ID}","parentId":"","title":"New","markdown":"","query":"","propertiesJson":"","specJson":""}`,
        status: 'pending',
        result: '',
        claimId: '',
      },
    ]);
  });

  it('claims once, then answers the provider with the result and records it', async () => {
    const { h, r, tools } = await start();
    h.transport.toolCall(7, 'call-1', 'nix_trash_item', { itemId: ID });
    await claim(h, r, 'call-1');
    expect(tools()[0]).toMatchObject({ status: 'claimed', claimId: IDS.other });
    await expect(claim(h, r, 'call-1')).rejects.toThrow(
      'tool already claimed; do not execute again',
    );
    await finish(h, r, 'call-1', { toolResult: '  Trashed.  ' });
    expect(h.transport.replies).toEqual([
      { id: 7, result: { success: true, contentItems: [{ type: 'inputText', text: 'Trashed.' }] } },
    ]);
    expect(tools()[0]).toMatchObject({ status: 'completed', result: 'Trashed.' });
    // A repeat of the report is accepted and changes nothing.
    await finish(h, r, 'call-1', { toolResult: 'again' });
    expect(h.transport.replies).toHaveLength(1);
  });

  it('refuses a result from someone who did not claim, and an unknown tool', async () => {
    const { h, r } = await start();
    h.transport.toolCall(1, 'call-1', 'nix_trash_item', { itemId: ID });
    await claim(h, r, 'call-1');
    await expect(
      h.account.handle(h.signal, {
        ...r,
        operation: 'tool_result',
        toolId: 'call-1',
        requestId: IDS.item,
        toolResult: 'x',
        toolSuccess: true,
      }),
    ).rejects.toThrow('tool claim does not match');
    await expect(claim(h, r, 'nope')).rejects.toThrow('unknown tool call');
  });

  it('answers an empty result as not confirmed, and carries a failure and a picture', async () => {
    const { h, r, tools } = await start();
    h.transport.toolCall(1, 'call-1', 'nix_read_note', { itemId: ID });
    await claim(h, r, 'call-1');
    await finish(h, r, 'call-1', {
      toolResult: '  ',
      toolSuccess: false,
      toolImage: 'data:image/jpeg;base64,AAAA',
    });
    expect(tools()[0]).toMatchObject({
      status: 'failed',
      result: 'No result supplied. Do not assume the operation succeeded.',
    });
    expect(h.transport.replies[0]?.result).toMatchObject({
      success: false,
      contentItems: [
        { type: 'inputText' },
        { type: 'inputImage', imageUrl: 'data:image/jpeg;base64,AAAA' },
      ],
    });
  });

  it('leaves no executable approval once a turn completes, and interrupted calls are answered', async () => {
    const { h, tools } = await start();
    h.transport.toolCall(1, 'call-1', 'nix_trash_item', { itemId: ID });
    h.notify('turn/completed', { threadId: 'provider-thread', turn: { status: 'completed' } });
    expect(tools()[0]?.status).toBe('interrupted');
    expect(tools()[0]?.result).toContain('turn ended before this request was confirmed');
    expect(h.transport.replies[0]?.result).toMatchObject({ success: false });
  });

  it('marks an unfinished tool interrupted after a restart so it cannot run twice', async () => {
    const { h, r, key } = await start();
    h.transport.toolCall(1, 'call-1', 'nix_trash_item', { itemId: ID });
    const restarted = harness({ home: h.home });
    restarted.account.load(key);
    expect(restarted.account.snapshot(key).tools[0]).toMatchObject({
      status: 'interrupted',
      result: expect.stringContaining('Worker restarted') as string,
    });
    await expect(claim(restarted, r, 'call-1')).rejects.toThrow('already claimed');
  });
});

describe('deduplication and limits', () => {
  it('gives identical calls one decision, whatever the key order', async () => {
    const { h, r, tools } = await start();
    h.transport.toolCall(1, 'a', 'nix_set_properties', { itemId: ID, properties: { x: 1, y: 2 } });
    expect(
      h.transport.toolCall(2, 'b', 'nix_set_properties', {
        itemId: ID,
        properties: '{"y":2,"x":1}',
      }),
    ).toBe(true);
    expect(tools()).toHaveLength(1);
    await claim(h, r, 'a');
    await finish(h, r, 'a', { toolResult: 'saved' });
    // Both waiting calls get the one result.
    expect(h.transport.replies.map((x) => x.id)).toEqual([1, 2]);
    // A later identical call replays the stored result.
    h.transport.toolCall(3, 'c', 'nix_set_properties', { itemId: ID, properties: { y: 2, x: 1 } });
    expect(h.transport.replies[2]).toEqual({
      id: 3,
      result: { success: true, contentItems: [{ type: 'inputText', text: 'saved' }] },
    });
    expect(tools()).toHaveLength(1);
  });

  it('does not reuse a provider call id for a different action', async () => {
    const { h, tools } = await start();
    h.transport.toolCall(1, 'a', 'nix_trash_item', { itemId: ID });
    expect(h.transport.toolCall(2, 'a', 'nix_trash_item', { itemId: IDS.other })).toBe(false);
    expect(tools()).toHaveLength(1);
  });

  it('caps the waiters of one pending call at 20', async () => {
    const { h } = await start();
    h.transport.toolCall(1, 'a', 'nix_trash_item', { itemId: ID });
    for (let i = 2; i <= 21; i++)
      expect(h.transport.toolCall(i, `x${String(i)}`, 'nix_trash_item', { itemId: ID })).toBe(true);
    expect(h.transport.toolCall(99, 'late', 'nix_trash_item', { itemId: ID })).toBe(false);
    expect(h.transport.toolCall(5, 'x5', 'nix_trash_item', { itemId: ID })).toBe(true);
  });

  it('needs a fresh result for a read after a write', async () => {
    const { h, r, tools } = await start();
    h.transport.toolCall(1, 'r1', 'nix_read_note', { itemId: ID });
    await claim(h, r, 'r1');
    await finish(h, r, 'r1', { toolResult: 'old text' });
    h.transport.toolCall(2, 'w1', 'nix_append_note', { itemId: ID, markdown: 'more' });
    h.transport.toolCall(3, 'r2', 'nix_read_note', { itemId: ID });
    expect(tools().map((t) => t.id)).toEqual(['r1', 'w1', 'r2']);
    // A read before any write is replayed instead.
    h.transport.toolCall(4, 'r3', 'nix_search', { query: 'q' });
    h.transport.toolCall(5, 'r4', 'nix_search', { query: 'q' });
    expect(tools().map((t) => t.id)).toEqual(['r1', 'w1', 'r2', 'r3']);
  });

  it('answers the 21st distinct call with the budget message and no approval', async () => {
    const { h, tools } = await start();
    for (let i = 0; i < MAX_TOOL_CALLS_PER_TURN; i++)
      h.transport.toolCall(i, `c${String(i)}`, 'nix_search', { query: `q${String(i)}` });
    expect(tools()).toHaveLength(20);
    expect(h.transport.toolCall(100, 'over', 'nix_search', { query: 'another' })).toBe(true);
    expect(tools()).toHaveLength(20);
    expect(JSON.stringify(h.transport.replies.at(-1))).toContain(
      'reached its limit of 20 tool calls',
    );
  });
});

describe('what never reaches approval', () => {
  it('rejects invalid typed arguments with a reason the model can act on', async () => {
    const { h, tools } = await start();
    expect(h.transport.toolCall(1, 'a', 'nix_read_item', { itemId: 'not-a-uuid' })).toBe(true);
    expect(JSON.stringify(h.transport.replies[0])).toContain(
      'itemId must be a Nix item UUID. No action ran and no approval was requested.',
    );
    expect(h.transport.toolCall(2, 'b', 'nix_read_item', { itemId: ID, extra: 1 })).toBe(true);
    expect(JSON.stringify(h.transport.replies[1])).toContain(
      'is not a parameter of nix_read_item; it accepts itemId.',
    );
    expect(tools()).toEqual([]);
  });

  it('rejects unknown tool names before flattening, and calls without workspace access', async () => {
    const { h, tools } = await start();
    expect(h.transport.toolCall(1, 'a', 'nix_workspace', { operation: 'read_item' })).toBe(false);
    expect(h.transport.toolCall(2, 'b', 'shell', { command: 'ls' })).toBe(false);
    expect(h.transport.toolCall(3, 'c', 'nix_search', { query: 'x' }, 'other-thread')).toBe(false);
    expect(tools()).toEqual([]);
    const off = await start({ workspaceAccess: false });
    expect(off.h.transport.toolCall(1, 'a', 'nix_search', { query: 'x' })).toBe(false);
    expect(off.tools()).toEqual([]);
  });

  it('ignores a tool call on a conversation that is not thinking, and an oversize call', async () => {
    const { h } = await start();
    expect(
      h.transport.handler?.(
        1,
        'item/tool/call',
        { threadId: 'provider-thread', tool: 'nix_search', callId: 'a', arguments: { query: 'x' } },
        40001,
      ),
    ).toBe(false);
    expect(
      h.transport.handler?.(
        1,
        'item/commandExecution/requestApproval',
        { threadId: 'provider-thread' },
        10,
      ),
    ).toBe(false);
    h.notify('turn/completed', { threadId: 'provider-thread', turn: { status: 'completed' } });
    expect(h.transport.toolCall(2, 'b', 'nix_search', { query: 'x' })).toBe(false);
  });

  it('refuses, without throwing, arguments nested too deep to flatten', async () => {
    const { h, tools } = await start();
    const deep: unknown = JSON.parse(`${'['.repeat(5000)}${']'.repeat(5000)}`);
    const args = { itemId: ID, spec: { a: deep } };
    expect(h.transport.toolCall(1, 'a', 'nix_add_view', args, 'provider-thread', 10_100)).toBe(
      false,
    );
    expect(tools()).toEqual([]);
  });

  it('refuses when the transport cannot answer the provider', async () => {
    const transport = new FakeTransport();
    transport.supportsReply = true;
    const { h } = await start({}, { transport });
    Object.defineProperty(h.transport, 'reply', { value: undefined });
    expect(h.transport.toolCall(1, 'a', 'nix_read_item', { itemId: 'nope' })).toBe(false);
  });
});

describe('protected reads', () => {
  it('hold every later write for the whole thread and survive a thread replacement and restart', async () => {
    const { h, r, key, tools } = await start();
    h.transport.toolCall(1, 'a', 'nix_read_note', { itemId: ID });
    await claim(h, r, 'a');
    expect(h.account.snapshot(key).lockedRead).toBe(false);
    await finish(h, r, 'a', { toolLockedContent: true });
    expect(h.account.snapshot(key).lockedRead).toBe(true);
    for (const [m, p] of [
      ['turn/completed', { threadId: 'provider-thread', turn: { status: 'completed' } }] as const,
    ])
      h.notify(m, p);
    await h.account.handle(h.signal, { ...r, requestId: IDS.item, readOnly: true });
    expect(h.account.snapshot(key).lockedRead).toBe(true);
    const restarted = harness({ home: h.home });
    restarted.account.load(key);
    expect(restarted.account.snapshot(key).lockedRead).toBe(true);
    expect(tools()).toEqual([]);
    h.notify('turn/completed', { threadId: 'provider-thread', turn: { status: 'completed' } });
    await h.account.handle(h.signal, { ...r, operation: 'reset' });
    expect(h.account.snapshot(key).lockedRead).toBe(false);
  });

  it('stop nix_remember', async () => {
    const { h, r } = await start();
    h.transport.toolCall(1, 'a', 'nix_read_note', { itemId: ID });
    await claim(h, r, 'a');
    await finish(h, r, 'a', { toolLockedContent: true });
    expect(h.transport.toolCall(2, 'b', 'nix_remember', { fact: 'Likes tea.' })).toBe(true);
    expect(JSON.stringify(h.transport.replies.at(-1))).toContain(
      'read protected content, so nothing from it is remembered',
    );
    const free = await start();
    expect(free.h.transport.toolCall(1, 'a', 'nix_remember', { fact: 'Likes tea.' })).toBe(true);
    expect(free.tools()).toHaveLength(1);
  });
});

describe('note scope', () => {
  it('offers only note-scoped tools, and only reads when read only', () => {
    const names = (overrides: object): string[] =>
      workspaceToolsForRequest(request(overrides)).map((t) => t.name);
    expect(names({})).toHaveLength(workspaceTools().length);
    const editable = names({ rootItemId: ID });
    expect(editable).toContain('nix_append_note');
    expect(editable).not.toContain('nix_read_calendar');
    expect(editable).not.toContain('nix_list_templates');
    expect(editable).not.toContain('nix_remember');
    const readOnly = names({ rootItemId: ID, readOnly: true });
    expect(readOnly).toContain('nix_search_note');
    expect(readOnly).not.toContain('nix_append_note');
  });

  it('refuses a write on a read-only note conversation and an operation outside the scope', async () => {
    const { h, tools } = await start({ rootItemId: ID, readOnly: true });
    expect(h.transport.toolCall(1, 'a', 'nix_append_note', { itemId: ID, markdown: 'x' })).toBe(
      true,
    );
    expect(JSON.stringify(h.transport.replies[0])).toContain(
      'This note conversation is read-only. No change ran.',
    );
    expect(
      h.transport.toolCall(2, 'b', 'nix_read_calendar', { from: '2026-10-01', to: '2026-10-02' }),
    ).toBe(true);
    expect(JSON.stringify(h.transport.replies[1])).toContain(
      'cannot be limited to this note and its children',
    );
    expect(h.transport.toolCall(3, 'c', 'nix_read_note', { itemId: ID })).toBe(true);
    expect(tools().map((t) => t.id)).toEqual(['c']);
  });

  it('adds the scope rules to the base instructions', async () => {
    const { h } = await start({ rootItemId: ID, readOnly: true });
    expect(String(h.transport.last('thread/start').baseInstructions)).toContain(
      'readOnly is on: answer and retrieve only',
    );
  });

  it('keeps note and workspace conversations apart', async () => {
    const h = harness();
    await h.account.handle(h.signal, request());
    for (const [m, p] of [
      ['turn/completed', { threadId: 'provider-thread', turn: { status: 'completed' } }] as const,
    ])
      h.notify(m, p);
    const note = await h.account.handle(
      h.signal,
      request({ rootItemId: ID, requestId: IDS.other }),
    );
    expect(note.messages).toHaveLength(1);
    expect(h.account.conversations.size).toBe(2);
  });
});

describe('saved cross-workspace conversations', () => {
  const chat = {
    conversationItemId: ID,
    readOnly: true,
    workspaceAccess: true,
    sourceWorkspaceIds: [IDS.workspace],
    earlierMessages: [{ id: 'm1', role: 'user', text: 'Earlier question' }],
  };

  it('offer read tools only, each requiring a source workspaceId', () => {
    const tools = workspaceToolsForRequest(request(chat));
    expect(tools.map((t) => t.name).sort()).toEqual([
      'nix_list_items',
      'nix_read_item',
      'nix_read_note',
      'nix_read_structure',
      'nix_read_view',
      'nix_search',
      'nix_search_note',
    ]);
    for (const tool of tools) {
      expect(tool.inputSchema.required).toContain('workspaceId');
      expect(Object.keys(tool.inputSchema.properties as object)).toContain('workspaceId');
    }
    // The shared catalog is untouched.
    expect(Object.keys(workspaceTools()[0]?.inputSchema.properties as object)).not.toContain(
      'workspaceId',
    );
  });

  it('always starts a fresh thread from the Core transcript and never takes a model change', async () => {
    const { h, r, key } = await start(chat);
    expect(h.transport.methods()[0]).toBe('thread/start');
    expect(String(h.transport.last('thread/start').baseInstructions)).toContain(
      'saved, read-only cross-workspace analysis conversation',
    );
    const prompt = JSON.parse(
      String((h.transport.last('turn/start').input as { text: string }[])[0]?.text),
    ) as Record<string, unknown>;
    expect(prompt).toMatchObject({
      conversationItemId: ID,
      readOnly: true,
      sourceWorkspaceIds: [IDS.workspace],
      earlierMessages: chat.earlierMessages,
    });
    for (const [m, p] of [
      ['turn/completed', { threadId: 'provider-thread', turn: { status: 'completed' } }] as const,
    ])
      h.notify(m, p);
    await h.account.handle(h.signal, { ...r, requestId: IDS.other, text: 'Again' });
    expect(h.transport.methods().filter((m) => m.startsWith('thread/'))).toEqual([
      'thread/start',
      'thread/start',
    ]);
    expect(h.account.snapshot(key).messages.map((m) => m.text)).toEqual([
      'Earlier question',
      'Again',
    ]);
  });

  it('refuse mutations and workspaces outside the sources before anything runs', async () => {
    const { h } = await start(chat);
    expect(
      h.transport.toolCall(1, 'a', 'nix_append_note', {
        itemId: ID,
        markdown: 'x',
        workspaceId: IDS.workspace,
      }),
    ).toBe(true);
    expect(JSON.stringify(h.transport.replies[0])).toContain(
      'Saved conversations allow read-only analysis',
    );
    expect(h.transport.toolCall(2, 'b', 'nix_search', { query: 'x', workspaceId: IDS.other })).toBe(
      true,
    );
    expect(JSON.stringify(h.transport.replies[1])).toContain('outside the selected sources');
    expect(h.transport.toolCall(3, 'c', 'nix_search', { query: 'x' })).toBe(true);
    expect(JSON.stringify(h.transport.replies[2])).toContain(
      'workspaceId must be a selected source UUID',
    );
  });

  it('execute a read in Core, deduplicate it, and keep the hold when Core says it was protected', async () => {
    const executed: { conversationId: string; requestId: string; args: string }[] = [];
    const executeConversationTool: ConversationToolExecutor = (
      _signal,
      conversationId,
      tenantId,
      principalId,
      requestId,
      args,
    ) => {
      executed.push({ conversationId, requestId, args });
      expect([tenantId, principalId]).toEqual([IDS.tenant, IDS.principal]);
      return Promise.resolve({ text: 'Source text', success: true, lockedContent: true });
    };
    const { h, key } = await start(chat, { executeConversationTool });
    h.transport.toolCall(1, 'a', 'nix_search', { query: 'plan', workspaceId: IDS.workspace });
    await eventually(() => h.transport.replies.length === 1);
    h.transport.toolCall(2, 'b', 'nix_search', { query: 'plan', workspaceId: IDS.workspace });
    expect(executed).toHaveLength(1);
    expect(executed[0]?.conversationId).toBe(ID);
    expect(executed[0]?.requestId).toBe(IDS.request);
    expect(JSON.parse(executed[0]?.args ?? '')).toMatchObject({
      operation: 'search',
      query: 'plan',
      workspaceId: IDS.workspace,
    });
    expect(h.transport.replies.map((x) => x.id)).toEqual([1, 2]);
    expect(h.account.snapshot(key)).toMatchObject({
      lockedRead: true,
      tools: [{ status: 'completed', result: 'Source text', claimId: IDS.request }],
    });
  });

  it('report an unreadable source as an incomplete analysis', async () => {
    const executeConversationTool: ConversationToolExecutor = () =>
      Promise.reject(new Error('core down'));
    const { h, tools } = await start(chat, { executeConversationTool });
    h.transport.toolCall(1, 'a', 'nix_search', { query: 'plan', workspaceId: IDS.workspace });
    await eventually(() => h.transport.replies.length === 1);
    expect(tools()[0]).toMatchObject({
      status: 'failed',
      result: 'The source could not be read. Treat this analysis as incomplete.',
    });
  });

  it('allow only send, read, watch and interrupt, and persist a durable state', async () => {
    const { h, key } = await start(chat);
    const saved = JSON.parse(readFileSync(join(h.home, `${key}.json`), 'utf8')) as Record<
      string,
      unknown
    >;
    expect(saved).toMatchObject({
      conversationItemId: ID,
      durableState: 'thinking',
      readOnly: true,
      sourceWorkspaceIds: [IDS.workspace],
    });
  });
});
