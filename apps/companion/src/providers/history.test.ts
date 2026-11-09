import { mkdirSync, readdirSync, readFileSync, statSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

import { describe, expect, it } from 'vitest';

import { defaultTitle, earlierTranscript, replaceIndex } from '../core/account.ts';
import { completed, harness, IDS, keyOf, request } from '../testing/testing.ts';

const key = keyOf(request());
const op = (h: ReturnType<typeof harness>, operation: string, overrides = {}) =>
  h.account.handle(h.signal, request({ operation, ...overrides }));

async function turn(
  h: ReturnType<typeof harness>,
  n: number,
  text = `question ${String(n)}`,
): Promise<void> {
  await op(h, 'send', {
    requestId: `00000000-0000-4000-8000-${String(n).padStart(12, '0')}`,
    text,
  });
  for (const [m, p] of completed('provider-thread', `answer ${String(n)}`)) h.notify(m, p);
}

describe('history', () => {
  it('archives a reset conversation privately, newest first, and reads, renames and deletes it', async () => {
    const h = harness();
    await turn(h, 1);
    await op(h, 'reset');
    // Entries are stamped to the second, so the first is dated back to keep the order exact.
    const early = join(h.home, `${key}-history`);
    const file = join(early, readdirSync(early)[0] ?? '');
    const archive = JSON.parse(readFileSync(file, 'utf8')) as Record<string, unknown>;
    writeFileSync(file, JSON.stringify({ ...archive, createdAt: '2026-01-01T00:00:00Z' }));
    await turn(h, 2);
    await op(h, 'reset');
    const list = await op(h, 'history');
    expect(list.history.map((e) => e.title)).toEqual(['question 2', 'question 1']);
    const dir = join(h.home, `${key}-history`);
    expect(statSync(dir).mode & 0o777).toBe(0o700);
    const files = readdirSync(dir);
    expect(files.every((f) => /^[0-9a-f-]{36}\.json$/.test(f))).toBe(true);
    expect(statSync(join(dir, files[0] ?? '')).mode & 0o777).toBe(0o600);
    const first = list.history[1];
    const read = await op(h, 'read_history', { historyId: first?.id });
    expect(read.messages.map((m) => m.text)).toEqual(['question 1', 'answer 1']);
    const renamed = await op(h, 'rename', { historyId: first?.id, text: '  Renamed  ' });
    expect(renamed.history.find((e) => e.id === first?.id)?.title).toBe('Renamed');
    const deleted = await op(h, 'delete_history', { historyId: first?.id });
    expect(deleted.history).toHaveLength(1);
  });

  it('writes the archive shape the Go service wrote', async () => {
    const h = harness();
    await turn(h, 1);
    await op(h, 'reset');
    const dir = join(h.home, `${key}-history`);
    const archive = JSON.parse(
      readFileSync(join(dir, readdirSync(dir)[0] ?? ''), 'utf8'),
    ) as Record<string, unknown>;
    expect(Object.keys(archive)).toEqual([
      'id',
      'title',
      'createdAt',
      'messages',
      'tools',
      'lockedRead',
    ]);
    expect(archive.createdAt).toMatch(/^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\dZ$/);
    expect(archive.lockedRead).toBe(false);
  });

  it('refuses a malformed history id', async () => {
    const h = harness();
    await expect(op(h, 'read_history', { historyId: '../x' })).rejects.toThrow(
      'invalid history identity',
    );
    await expect(op(h, 'delete_history', { historyId: 'nope' })).rejects.toThrow(
      'invalid history identity',
    );
  });

  it('refuses a new archive at 32 entries and lists the newest 32', async () => {
    const h = harness();
    const dir = join(h.home, `${key}-history`);
    mkdirSync(dir, { recursive: true });
    for (let i = 0; i < 33; i++) {
      const id = `00000000-0000-4000-8000-${String(i).padStart(12, '0')}`;
      writeFileSync(
        join(dir, `${id}.json`),
        JSON.stringify({
          id,
          title: `t${String(i)}`,
          createdAt: `2026-10-01T00:00:${String(i).padStart(2, '0')}Z`,
          messages: [],
          tools: [],
        }),
      );
    }
    const list = await op(h, 'history');
    expect(list.history).toHaveLength(32);
    expect(list.history[0]?.title).toBe('t32');
    await turn(h, 1);
    await expect(op(h, 'reset')).rejects.toThrow('conversation history is full');
    // Nothing is lost: the live conversation is still there.
    expect(h.account.snapshot(key).messages).toHaveLength(2);
  });

  it('names a conversation after its first user message and lets the owner rename it', async () => {
    expect(
      defaultTitle([
        { id: 'a', role: 'assistant', text: 'x' },
        { id: 'b', role: 'user', text: '  Plan   my\n week  ' },
      ]),
    ).toBe('Plan my week');
    expect(defaultTitle([{ id: 'a', role: 'assistant', text: 'x' }])).toBe('');
    expect(defaultTitle([{ id: 'a', role: 'user', text: 'é'.repeat(200) }])).toBe('é'.repeat(120));
    const h = harness();
    await turn(h, 1, 'Plan my week');
    expect(h.account.snapshot(key).title).toBe('Plan my week');
    await op(h, 'rename', { text: ' Weekly plan ' });
    expect(h.account.snapshot(key).title).toBe('Weekly plan');
    await expect(op(h, 'send', { requestId: IDS.other })).resolves.toBeDefined();
    await expect(op(h, 'rename', { text: 'again' })).rejects.toThrow('stop the running turn first');
  });

  it('swaps an archive in as the live conversation and archives the live one in its place', async () => {
    const h = harness();
    await turn(h, 1);
    await op(h, 'reset');
    await turn(h, 2);
    const archived = (await op(h, 'history')).history[0];
    const resumed = await op(h, 'resume_history', { historyId: archived?.id });
    expect(resumed.messages.map((m) => m.text)).toEqual(['question 1', 'answer 1']);
    expect(resumed.tools).toEqual([]);
    const after = await op(h, 'history');
    expect(after.history).toHaveLength(1);
    expect(after.history[0]?.title).toBe('question 2');
    // The next send starts a fresh provider thread seeded with the visible messages.
    for (const [m, p] of [
      ['turn/completed', { threadId: 'provider-thread', turn: { status: 'completed' } }] as const,
    ])
      h.notify(m, p);
    await turn(h, 3);
    expect(
      h.transport
        .methods()
        .filter((m) => m.startsWith('thread/'))
        .at(-1),
    ).toBe('thread/start');
  });

  it('refuses a resume while thinking and holds an archive that recorded no hold', async () => {
    const h = harness();
    await turn(h, 1);
    await op(h, 'reset');
    const id = (await op(h, 'history')).history[0]?.id ?? '';
    const path = join(h.home, `${key}-history`, `${id}.json`);
    const archive = JSON.parse(readFileSync(path, 'utf8')) as Record<string, unknown>;
    delete archive.lockedRead;
    writeFileSync(path, JSON.stringify(archive));
    await op(h, 'send', { requestId: IDS.other });
    await expect(op(h, 'resume_history', { historyId: id })).rejects.toThrow(
      'stop the running turn first',
    );
    h.notify('turn/completed', { threadId: 'provider-thread', turn: { status: 'completed' } });
    expect((await op(h, 'resume_history', { historyId: id })).lockedRead).toBe(true);
  });

  it('carries the read hold into an archive and back out', async () => {
    const h = harness();
    await turn(h, 1);
    const c = h.account.conversations.get(key);
    if (c === undefined) throw new Error('missing');
    c.lockedRead = true;
    await op(h, 'reset');
    const id = (await op(h, 'history')).history[0]?.id ?? '';
    expect((await op(h, 'resume_history', { historyId: id })).lockedRead).toBe(true);
  });

  it('folds what the retired design conversation left into history', async () => {
    const h = harness();
    const old = `${key}-consult`;
    const oldHistory = join(h.home, `${old}-history`);
    mkdirSync(oldHistory, { recursive: true });
    const entry = '88888888-8888-4888-8888-888888888888';
    writeFileSync(
      join(oldHistory, `${entry}.json`),
      JSON.stringify({
        id: entry,
        title: 'Old thread',
        createdAt: '2026-09-01T00:00:00Z',
        messages: [],
        tools: [],
      }),
    );
    writeFileSync(join(oldHistory, 'notes.txt'), 'kept out');
    writeFileSync(
      join(h.home, `${old}.json`),
      JSON.stringify({
        messages: [
          { id: 'm', role: 'user', text: 'Design a tracker' },
          { id: 'n', role: 'assistant', text: 'Sure' },
        ],
        tools: [],
      }),
    );
    const list = await op(h, 'history');
    expect(list.history.map((e) => e.title).sort()).toEqual(['Design a tracker', 'Old thread']);
    expect(readdirSync(h.home).filter((f) => f.includes('consult'))).toEqual([]);
    // Folding again is a no-op.
    expect((await op(h, 'history')).history).toHaveLength(2);
  });
});

describe('replace from message', () => {
  it('drops the replaced turn, starts a fresh thread and gives it the messages that stay', async () => {
    const h = harness();
    await turn(h, 1);
    await turn(h, 2);
    const last = h.account.snapshot(key).messages.find((m) => m.text === 'question 2');
    await op(h, 'send', {
      requestId: IDS.other,
      text: 'question 2, reworded',
      replaceFromMessageId: last?.id,
    });
    const messages = h.account.snapshot(key).messages;
    expect(messages.map((m) => m.text)).toEqual(['question 1', 'answer 1', 'question 2, reworded']);
    expect(
      h.transport
        .methods()
        .filter((m) => m.startsWith('thread/'))
        .at(-1),
    ).toBe('thread/start');
    const prompt = JSON.parse(
      String((h.transport.last('turn/start').input as { text: string }[])[0]?.text),
    ) as Record<string, unknown>;
    expect(prompt.earlierMessages).toBe('User: question 1\n\nAssistant: answer 1');
  });

  it('refuses a target that is not the last user message, and a running turn', async () => {
    const h = harness();
    await turn(h, 1);
    await turn(h, 2);
    const messages = h.account.snapshot(key).messages;
    const first = messages.find((m) => m.text === 'question 1');
    const assistant = messages.find((m) => m.text === 'answer 2');
    await expect(
      op(h, 'send', { requestId: IDS.other, replaceFromMessageId: first?.id }),
    ).rejects.toThrow('replace target is not a user message');
    await expect(
      op(h, 'send', { requestId: IDS.other, replaceFromMessageId: assistant?.id }),
    ).rejects.toThrow('replace target');
    await expect(
      op(h, 'send', { requestId: IDS.other, replaceFromMessageId: IDS.item }),
    ).rejects.toThrow('replace target');
    const last = messages.find((m) => m.text === 'question 2');
    await op(h, 'send', { requestId: IDS.other, replaceFromMessageId: last?.id });
    await expect(
      op(h, 'send', { requestId: IDS.item, replaceFromMessageId: IDS.other }),
    ).rejects.toThrow('turn already running');
    expect(h.account.snapshot(key).messages).toHaveLength(3);
  });

  it('finds only the last user message', () => {
    const list = [
      { id: 'u1', role: 'user', text: '' },
      { id: 'a1', role: 'assistant', text: '' },
      { id: 'u2', role: 'user', text: '' },
      { id: 'a2', role: 'assistant', text: '' },
    ];
    expect(replaceIndex(list, 'u2')).toBe(2);
    expect(replaceIndex(list, 'u1')).toBe(-1);
    expect(replaceIndex(list, 'a2')).toBe(-1);
    expect(replaceIndex([], 'x')).toBe(-1);
  });

  it('keeps the transcript to 8000 runes, dropping whole oldest messages and leaving out notices', () => {
    const messages = [
      { id: 's', role: 'system', text: 'notice' },
      { id: 'u:commentary:x', role: 'assistant', text: 'reading' },
      { id: 'u:draft:x', role: 'assistant', text: 'typing' },
      { id: 'a', role: 'user', text: 'a'.repeat(6000) },
      { id: 'b', role: 'assistant', text: 'b'.repeat(2000) },
      { id: 'c', role: 'user', text: 'é'.repeat(900) },
    ];
    const transcript = earlierTranscript(messages);
    expect(transcript === `Assistant: ${'b'.repeat(2000)}\n\nUser: ${'é'.repeat(900)}`).toBe(true);
    expect(earlierTranscript(messages.slice(3)).startsWith('User: aaaa')).toBe(false);
    expect(earlierTranscript([{ id: 'a', role: 'user', text: 'x'.repeat(9000) }]) === '').toBe(
      true,
    );
  });

  it('carries shared items into the prompt only when more than one is attached', async () => {
    const h = harness();
    const items = [
      { id: IDS.item, title: 'A' },
      { id: IDS.other, title: 'B' },
    ];
    await op(h, 'send', { items, itemId: IDS.item });
    const prompt = JSON.parse(
      String((h.transport.last('turn/start').input as { text: string }[])[0]?.text),
    ) as Record<string, unknown>;
    expect(prompt.sharedItems).toEqual(items);
  });
});
