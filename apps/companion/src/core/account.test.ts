import { readFileSync, statSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

import { describe, expect, it } from 'vitest';

import { Account, TOOL_VERSION, turnPrompt } from './account.ts';
import {
  completed,
  FakeTransport,
  harness,
  IDS,
  keyOf,
  request,
  tempDir,
} from '../testing/testing.ts';

const send = (h: ReturnType<typeof harness>, overrides = {}) =>
  h.account.handle(h.signal, request(overrides));

describe('conversation protocol', () => {
  it('starts one turn per request id, saves privately, and survives a restart', async () => {
    const h = harness();
    const r = request();
    const first = await h.account.handle(h.signal, r);
    expect(first.state).toBe('thinking');
    expect(first.messages).toHaveLength(1);
    await h.account.handle(h.signal, r);
    expect(h.transport.methods()).toEqual(['thread/start', 'turn/start']);
    const start = h.transport.calls[0]?.params ?? {};
    expect(start).toMatchObject({
      sandbox: 'read-only',
      approvalPolicy: 'on-request',
      developerInstructions: r.instructions,
    });
    expect(String(start.baseInstructions)).toContain('You are a Nix workspace companion');
    expect(Array.isArray(start.dynamicTools)).toBe(true);

    for (const [method, params] of completed()) h.notify(method, params);
    const done = await h.account.handle(h.signal, request({ operation: 'read' }));
    expect(done.state).toBe('success');
    expect(done.messages.map((m) => m.text)).toEqual(['Help me write', 'Here is a suggestion.']);
    expect(h.transport.methods()).toHaveLength(2);

    const path = join(h.home, `${keyOf(r)}.json`);
    expect(statSync(path).mode & 0o777).toBe(0o600);
    const other = harness({ home: h.home });
    other.account.load(keyOf(r));
    expect(other.account.snapshot(keyOf(r)).messages).toHaveLength(2);
  });

  it('writes the on-disk shape the Go service wrote', async () => {
    const h = harness();
    await send(h);
    const saved = JSON.parse(
      readFileSync(join(h.home, `${keyOf(request())}.json`), 'utf8'),
    ) as Record<string, unknown>;
    expect(Object.keys(saved)).toEqual([
      'toolVersion',
      'threadId',
      'requestId',
      'messages',
      'tools',
      'title',
    ]);
    expect(saved).toMatchObject({
      toolVersion: TOOL_VERSION,
      threadId: 'provider-thread',
      requestId: IDS.request,
      tools: [],
      title: 'Help me write',
    });
  });

  it('loads a conversation file written by the Go service', () => {
    const home = tempDir();
    const key = keyOf(request());
    writeFileSync(
      join(home, `${key}.json`),
      `${JSON.stringify({
        toolVersion: 11,
        threadId: 't',
        requestId: 'r',
        messages: null,
        tools: [
          { id: 'c', arguments: '{}', status: 'claimed', result: '', claimId: 'x' },
          { id: 'd', arguments: '{}', status: 'completed', result: 'ok', claimId: 'x' },
        ],
        lockedRead: true,
        title: 'Mine',
        futureField: 1,
      })}\n`,
    );
    const h = harness({ home });
    h.account.load(key);
    const snapshot = h.account.snapshot(key);
    expect(snapshot).toMatchObject({
      state: 'idle',
      lockedRead: true,
      title: 'Mine',
      messages: [],
    });
    expect(snapshot.tools.map((t) => t.status)).toEqual(['interrupted', 'completed']);
    expect(snapshot.tools[0]?.result).toContain('Worker restarted');
  });

  it('refuses a corrupt conversation file', () => {
    const home = tempDir();
    const key = keyOf(request());
    writeFileSync(join(home, `${key}.json`), '{nope');
    const h = harness({ home });
    expect(() => {
      h.account.load(key);
    }).toThrow('conversation could not be restored');
  });

  it('seeds the revision from the clock and keeps it monotonic across reload', async () => {
    const h = harness();
    const before = Date.now();
    const first = await send(h);
    expect(first.revision).toBeGreaterThanOrEqual(before);
    const reloaded = harness({ home: h.home });
    reloaded.account.load(keyOf(request()));
    expect(reloaded.account.snapshot(keyOf(request())).revision).toBeGreaterThanOrEqual(
      first.revision,
    );
  });

  it('stores a JSON-shaped final answer as written, and truncates an oversize one at a rune boundary', async () => {
    const h = harness();
    await send(h);
    const shaped = '{"answer":"Created.","actions":[]}';
    h.notify('item/completed', {
      threadId: 'provider-thread',
      item: { type: 'agentMessage', text: shaped, phase: 'final_answer' },
    });
    expect(h.account.snapshot(keyOf(request())).messages[1]?.text).toBe(shaped);
    const h2 = harness();
    await send(h2);
    h2.notify('item/completed', {
      threadId: 'provider-thread',
      item: { type: 'agentMessage', text: 'é'.repeat(20000) },
    });
    h2.notify('turn/completed', { threadId: 'provider-thread', turn: { status: 'completed' } });
    const final = h2.account.snapshot(keyOf(request()));
    expect(final.state).toBe('success');
    expect(Buffer.byteLength(final.messages[1]?.text ?? '')).toBe(32000);
  });

  it('shows commentary once, as written, with an id inside the client contract', async () => {
    const h = harness();
    await send(h);
    const commentary = {
      threadId: 'provider-thread',
      item: {
        id: 'explanation',
        type: 'agentMessage',
        phase: 'commentary',
        text: '{"answer":"I will read the note."}',
      },
    };
    h.notify('item/completed', commentary);
    h.notify('item/completed', commentary);
    const snapshot = h.account.snapshot(keyOf(request()));
    expect(snapshot.messages).toHaveLength(2);
    expect(snapshot.messages[1]?.text).toBe('{"answer":"I will read the note."}');
    expect(snapshot.messages[1]?.id.length).toBeLessThanOrEqual(80);
    expect(snapshot.state).toBe('thinking');
  });

  it('keeps a turn failure through an account status refresh', async () => {
    const h = harness();
    await send(h);
    h.notify('turn/completed', { threadId: 'provider-thread', turn: { status: 'failed' } });
    await h.account.handle(h.signal, request({ operation: 'status' }));
    const snapshot = h.account.snapshot(keyOf(request()));
    expect(snapshot.state).toBe('error');
    expect(snapshot.reason).toContain('could not finish');
  });

  it('turns an interrupted turn into idle and a refused start into an error', async () => {
    const h = harness();
    await send(h);
    h.notify('turn/completed', { threadId: 'provider-thread', turn: { status: 'interrupted' } });
    expect(h.account.snapshot(keyOf(request())).state).toBe('idle');
    const failing = harness();
    failing.transport.script = (method) =>
      method === 'turn/start' ? new Error('provider refused turn/start') : undefined;
    await expect(send(failing)).rejects.toThrow('provider refused');
    expect(failing.account.snapshot(keyOf(request()))).toMatchObject({
      state: 'error',
      reason: expect.stringContaining('could not start') as string,
    });
  });

  it('refuses a second turn while one runs, and an interrupt reaches the provider', async () => {
    const h = harness();
    await send(h);
    await expect(send(h, { requestId: IDS.other })).rejects.toThrow('turn already running');
    await h.account.handle(h.signal, request({ operation: 'interrupt' }));
    expect(h.transport.last('turn/interrupt')).toEqual({
      threadId: 'provider-thread',
      turnId: 'provider-turn',
    });
  });

  it('refuses a reset while thinking, and a reset archives and clears', async () => {
    const h = harness();
    await send(h);
    await expect(send(h, { operation: 'reset' })).rejects.toThrow('stop the running turn first');
    for (const [m, p] of completed()) h.notify(m, p);
    const reset = await send(h, { operation: 'reset' });
    expect(reset.messages).toEqual([]);
    expect(reset.lockedRead).toBe(false);
  });

  it('tells the owner when a tool-version change restarts the provider thread, once per send', async () => {
    const h = harness();
    const key = keyOf(request());
    h.account.load(key);
    const c = h.account.conversations.get(key);
    if (c === undefined) throw new Error('no conversation');
    Object.assign(c, {
      threadId: 'old',
      toolVersion: 7,
      messages: [{ id: 'a', role: 'user', text: 'earlier' }],
      lockedRead: true,
    });
    await send(h);
    expect(h.transport.methods()[0]).toBe('thread/start');
    const snapshot = h.account.snapshot(key);
    expect(snapshot.messages.map((m) => m.role)).toEqual(['user', 'system', 'user']);
    expect(snapshot.messages[1]?.text).toBe(
      'Your pet was updated and starts a fresh conversation.',
    );
    expect(snapshot.lockedRead).toBe(true);
  });

  it('resumes the thread within one tool version and restarts it when read access changes', async () => {
    const h = harness();
    await send(h);
    for (const [m, p] of completed()) h.notify(m, p);
    await send(h, { requestId: IDS.other });
    expect(h.transport.methods().filter((m) => m.startsWith('thread/'))).toEqual([
      'thread/start',
      'thread/resume',
    ]);
    for (const [m, p] of completed()) h.notify(m, p);
    await send(h, { requestId: IDS.item, readOnly: true });
    expect(h.transport.methods().filter((m) => m.startsWith('thread/'))).toEqual([
      'thread/start',
      'thread/resume',
      'thread/start',
    ]);
    expect(
      h.account
        .snapshot(keyOf(request()))
        .messages.some((m) => m.text.startsWith('Chat access changed')),
    ).toBe(true);
  });

  it('keeps the visible conversation when a failed send is retried', async () => {
    const h = harness();
    h.transport.script = (method) =>
      method === 'thread/start' ? new Error('provider refused thread/start') : undefined;
    await expect(send(h)).rejects.toThrow();
    expect(h.account.snapshot(keyOf(request())).messages).toEqual([]);
  });

  it('treats a stale consult mode as the one conversation', () => {
    expect(keyOf(request({ mode: 'consult' }))).toBe(keyOf(request({ mode: '' })));
    expect(keyOf(request({ rootItemId: IDS.item }))).toBe(
      `${IDS.workspace}-${IDS.pet}-note-${IDS.item}`,
    );
    expect(keyOf(request({ conversationItemId: IDS.item }))).toBe(
      `${IDS.workspace}-${IDS.pet}-chat-${IDS.item}`,
    );
  });

  it('limits an account to 128 conversations', () => {
    const h = harness();
    for (let i = 0; i < 128; i++) h.account.load(`k${String(i)}`);
    expect(() => {
      h.account.load('one-more');
    }).toThrow('conversation capacity reached');
  });
});

describe('connection', () => {
  it('walks the device login and disconnect', async () => {
    const h = harness();
    h.account.status = 'disconnected';
    const connecting = await send(h, { operation: 'connect' });
    expect(connecting).toMatchObject({
      status: 'connecting',
      verificationUrl: 'https://auth.openai.com/codex/device',
      userCode: '1234-ABCD',
      canConnect: true,
    });
    await send(h, { operation: 'connect' });
    expect(h.transport.methods().filter((m) => m === 'account/login/start')).toHaveLength(1);
    h.notify('account/login/completed', { success: true });
    expect(h.account.snapshot('')).toMatchObject({
      status: 'connected',
      canConnect: false,
      userCode: '',
    });
    const gone = await send(h, { operation: 'disconnect' });
    expect(gone).toMatchObject({ status: 'disconnected', reason: 'ChatGPT disconnected.' });
    expect(h.transport.methods()).toContain('account/logout');
  });

  it('refuses a device login that is not the OpenAI page', async () => {
    const h = harness();
    h.transport.script = (m) =>
      m === 'account/login/start'
        ? { loginId: 'l', verificationUrl: 'https://evil.example/device', userCode: 'X' }
        : undefined;
    await expect(send(h, { operation: 'connect' })).rejects.toThrow('invalid device login');
  });

  it('reports a failed sign-in', () => {
    const h = harness();
    h.notify('account/login/completed', { success: false });
    expect(h.account.snapshot('')).toMatchObject({
      status: 'error',
      reason: 'Sign-in did not complete. Try connecting again.',
    });
  });

  it('lists models with only the wire fields', async () => {
    const h = harness();
    h.transport.models = [
      {
        model: 'gpt-x',
        displayName: 'GPT X',
        isDefault: true,
        supportedReasoningEfforts: [{ reasoningEffort: 'low' }],
      },
      { model: '', displayName: 'nameless' },
    ];
    const models = await send(h, { operation: 'models' });
    expect(models.models).toEqual([
      { id: 'gpt-x', name: 'GPT X', default: true, supportsTools: true },
    ]);
  });
});

describe('model choice and effort', () => {
  const models = [
    {
      model: 'fast',
      displayName: 'Fast',
      isDefault: true,
      supportedReasoningEfforts: [{ reasoningEffort: 'low' }, { reasoningEffort: 'high' }],
    },
    { model: 'plain', displayName: 'Plain', isDefault: false, supportedReasoningEfforts: [] },
  ];

  it('sends the configured effort only when the effective model advertises it', async () => {
    const efforts: unknown[] = [];
    for (const model of ['', 'fast', 'plain']) {
      const h = harness({ chatEffort: 'low' });
      h.transport.models = models;
      await send(h, { model });
      efforts.push(h.transport.last('turn/start').effort);
    }
    expect(efforts).toEqual(['low', 'low', undefined]);
    const none = harness({ chatEffort: '' });
    none.transport.models = models;
    await send(none);
    expect(none.transport.last('turn/start').effort).toBeUndefined();
  });

  it('never fails the turn when the model list cannot be read for effort', async () => {
    const h = harness({ chatEffort: 'low' });
    h.transport.script = (m) =>
      m === 'model/list' ? new Error('provider refused model/list') : undefined;
    await expect(send(h)).resolves.toMatchObject({ state: 'thinking' });
  });

  it('refuses an unlisted model', async () => {
    const h = harness();
    h.transport.models = models;
    await expect(send(h, { model: 'missing' })).rejects.toThrow('model is unavailable');
  });

  it('refuses workspace access for a model without tools, and chats without it', async () => {
    const h = harness({ provider: 'openrouter' });
    h.transport.models = [
      { model: 'no-tools', displayName: 'No tools', isDefault: true, supportsTools: false },
    ];
    await expect(send(h, { workspaceAccess: true })).rejects.toThrow(
      'model does not support tools',
    );
    expect(h.account.snapshot(keyOf(request())).reason).toContain('cannot use tools');
    const ok = await send(h, { requestId: IDS.other, workspaceAccess: false });
    expect(ok.state).toBe('thinking');
    expect(h.transport.last('thread/start').dynamicTools).toBeUndefined();
  });
});

describe('turn prompt', () => {
  it('carries date, zone and the workspace map only on a turn that starts a thread', () => {
    const map = [{ id: IDS.item, title: 'Tasks', type: 'list' }];
    const r = request({
      today: '2026-10-05',
      timeZone: 'Europe/London',
      workspaceMap: map,
      items: [
        { id: IDS.item, title: 'A' },
        { id: IDS.other, title: 'B' },
      ],
    });
    expect(turnPrompt(r, '', true)).toMatchObject({
      today: '2026-10-05',
      timeZone: 'Europe/London',
      workspaceMap: map,
      sharedItems: r.items,
    });
    expect(turnPrompt(r, '', false).workspaceMap).toBeUndefined();
    expect(
      turnPrompt(request({ items: [{ id: IDS.item, title: 'A' }] }), '', true).sharedItems,
    ).toBeUndefined();
    expect(
      turnPrompt(request({ rootItemId: IDS.item, workspaceMap: map }), '', true).workspaceMap,
    ).toBeUndefined();
    expect(turnPrompt(request(), 'User: hi', true).earlierMessages).toBe('User: hi');
    expect(turnPrompt(request(), 'User: hi', false).earlierMessages).toBeUndefined();
  });

  it('sends the prompt as canonical JSON', async () => {
    const h = harness();
    await send(h, { text: 'a < b', today: '2026-10-05' });
    const text = String((h.transport.last('turn/start').input as { text: string }[])[0]?.text);
    expect(text.startsWith('{"currentItemId":""')).toBe(true);
    expect(text).toContain('a \\u003c b');
  });
});

describe('persistence guards', () => {
  it('never persists a streaming draft, and clears it when the item completes', async () => {
    const h = harness();
    await send(h);
    h.notify('item/agentMessage/delta', {
      threadId: 'provider-thread',
      itemId: 'item-1',
      delta: 'Hel',
    });
    h.notify('item/agentMessage/delta', {
      threadId: 'provider-thread',
      itemId: 'item-1',
      delta: 'lo',
    });
    expect(h.account.snapshot(keyOf(request())).messages[1]?.text).toBe('Hello');
    h.notify('item/completed', {
      threadId: 'provider-thread',
      item: { id: 'x', type: 'agentMessage', phase: 'commentary', text: 'Reading.' },
    });
    h.account.save(keyOf(request()));
    const saved = JSON.parse(readFileSync(join(h.home, `${keyOf(request())}.json`), 'utf8')) as {
      messages: { id: string }[];
    };
    expect(saved.messages.every((m) => !m.id.includes(':draft:'))).toBe(true);
    h.notify('item/completed', {
      threadId: 'provider-thread',
      item: { id: 'item-1', type: 'agentMessage', phase: 'final_answer', text: 'Hello' },
    });
    h.notify('turn/completed', { threadId: 'provider-thread', turn: { status: 'completed' } });
    expect(h.account.snapshot(keyOf(request())).messages.map((m) => m.text)).toEqual([
      'Help me write',
      'Reading.',
      'Hello',
    ]);
  });

  it('caps drafts across the conversation', async () => {
    const h = harness();
    await send(h);
    for (let i = 0; i < 6; i++)
      h.notify('item/agentMessage/delta', {
        threadId: 'provider-thread',
        itemId: `i${String(i)}`,
        delta: 'x'.repeat(30000),
      });
    const drafts = h.account
      .snapshot(keyOf(request()))
      .messages.filter((m) => m.id.includes(':draft:'));
    expect(drafts.reduce((n, m) => n + Buffer.byteLength(m.text), 0)).toBe(64000);
    expect(Math.max(...drafts.map((m) => Buffer.byteLength(m.text)))).toBeLessThanOrEqual(32000);
  });

  it('ignores deltas for a conversation that is not thinking', async () => {
    const h = harness();
    await send(h);
    for (const [m, p] of completed()) h.notify(m, p);
    h.notify('item/agentMessage/delta', {
      threadId: 'provider-thread',
      itemId: 'late',
      delta: 'late',
    });
    expect(h.account.snapshot(keyOf(request())).messages).toHaveLength(2);
  });

  it('trims to 16 messages on each send, so 17 once the answer lands', async () => {
    const h = harness();
    for (let i = 0; i < 12; i++) {
      await send(h, { requestId: `00000000-0000-4000-8000-${String(i).padStart(12, '0')}` });
      for (const [m, p] of completed('provider-thread', `answer ${String(i)}`)) h.notify(m, p);
    }
    const messages = h.account.snapshot(keyOf(request())).messages;
    expect(messages).toHaveLength(17);
    expect(messages[16]?.text).toBe('answer 11');
  });

  it('expires a conversation stuck thinking for 15 minutes on a read', async () => {
    const h = harness();
    await send(h);
    const c = h.account.conversations.get(keyOf(request()));
    if (c === undefined) throw new Error('missing');
    c.timing.started = Date.now() - 16 * 60 * 1000;
    const result = await send(h, { operation: 'read' });
    expect(result).toMatchObject({
      state: 'error',
      reason: 'The response timed out. You can send another message.',
    });
    expect(h.transport.last('turn/interrupt')).toEqual({
      threadId: 'provider-thread',
      turnId: 'provider-turn',
    });
  });
});

describe('saved conversations after a restart', () => {
  it('mark an unfinished response as failed and keep a completed one', () => {
    const home = tempDir();
    const key = `${IDS.workspace}-${IDS.pet}-chat-${IDS.item}`;
    const write = (durableState: string, name = key): void => {
      writeFileSync(
        join(home, `${name}.json`),
        JSON.stringify({
          conversationItemId: IDS.item,
          durableState,
          messages: [{ id: 'a', role: 'user', text: 'q' }],
          tools: [],
          toolVersion: 11,
        }),
      );
    };
    write('thinking');
    const a = harness({ home });
    a.account.load(key);
    expect(a.account.snapshot(key)).toMatchObject({
      state: 'error',
      reason: expect.stringContaining('worker restarted') as string,
    });
    write('success');
    const b = harness({ home });
    b.account.load(key);
    expect(b.account.snapshot(key).state).toBe('success');
    write('');
    const c = harness({ home });
    c.account.load(key);
    expect(c.account.snapshot(key).state).toBe('error');
  });
});

describe('Account type', () => {
  it('is constructed with a transport that may omit the tool seam', () => {
    const account = new Account({
      home: tempDir(),
      provider: 'chatgpt',
      transport: new FakeTransport(),
      chatEffort: '',
      logger: undefined,
      trace: false,
    });
    expect(account.snapshot('')).toMatchObject({
      provider: 'chatgpt',
      status: 'disconnected',
      canConnect: true,
    });
  });
});
