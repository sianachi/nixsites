import { toByteArray } from './base64.js';
import * as decoding from 'lib0/decoding';
import * as encoding from 'lib0/encoding';
import * as syncProtocol from 'y-protocols/sync';
import * as Y from 'yjs';
import { afterEach, describe, expect, it, vi } from 'vitest';

import {
  LIVE_ORIGIN,
  startLiveBodySync,
  type LiveBodySync,
  type LiveBodySyncOptions,
  type LiveSocket,
} from './live.js';
import {
  BODY_SYNC_LIMITS,
  type LiveBodySyncSuccess,
  type MirrorBody,
  type PendingBodyUpdate,
} from './mirror.js';

const ITEM = 'c1000000-0000-4000-8000-000000000031';
const DOC = 'c1000000-0000-4000-8000-000000000041';
const WORKSPACE = 'c1000000-0000-4000-8000-000000000011';
const clients: LiveBodySync[] = [];
const docs: Y.Doc[] = [];
afterEach(() => {
  for (const client of clients.splice(0)) client.stop();
  for (const doc of docs.splice(0)) doc.destroy();
  vi.useRealTimers();
});
function document(text = ''): Y.Doc {
  const doc = new Y.Doc();
  docs.push(doc);
  if (text) doc.getText('note').insert(0, text);
  return doc;
}
function frame(type: number, write: (encoder: encoding.Encoder) => void): Uint8Array {
  const encoder = encoding.createEncoder();
  encoding.writeVarUint(encoder, type);
  write(encoder);
  return encoding.toUint8Array(encoder);
}
function updateFrame(update: Uint8Array): Uint8Array {
  return frame(0, (encoder) => {
    syncProtocol.writeUpdate(encoder, update);
  });
}
function barrierIds(wire: Wire): string[] {
  return wire.sent.flatMap((bytes) => {
    if (typeof bytes === 'string') return [];
    const decoder = decoding.createDecoder(bytes);
    return decoding.readVarUint(decoder) === 3 ? [decoding.readVarString(decoder)] : [];
  });
}
function sentUpdates(wire: Wire): Uint8Array[] {
  return wire.sent.flatMap((bytes) => {
    if (typeof bytes === 'string') return [];
    const decoder = decoding.createDecoder(bytes);
    if (decoding.readVarUint(decoder) !== 0) return [];
    const kind = decoding.readVarUint(decoder);
    return kind === syncProtocol.messageYjsUpdate || kind === syncProtocol.messageYjsSyncStep2
      ? [decoding.readVarUint8Array(decoder)]
      : [];
  });
}
class Wire implements LiveSocket {
  binaryType = 'arraybuffer';
  readyState = 0;
  sent: (string | Uint8Array)[] = [];
  onopen: (() => void) | null = null;
  onmessage: ((event: { data: unknown }) => void) | null = null;
  onclose: ((event: { code: number }) => void) | null = null;
  onerror: (() => void) | null = null;
  constructor(readonly events: string[]) {}
  send(data: string | Uint8Array): void {
    this.events.push('send');
    this.sent.push(data);
  }
  close(code = 1000): void {
    this.readyState = 3;
    this.onclose?.({ code });
  }
  open(): void {
    this.readyState = 1;
    this.onopen?.();
  }
  receive(data: unknown): void {
    this.onmessage?.({ data });
  }
  ready(mode: 'read' | 'write' = 'write', docId = DOC): void {
    this.receive(
      JSON.stringify({ type: 'ready', docId, mode, bodyKind: 'note', schemaVersion: 6 }),
    );
  }
  acknowledge(id = barrierIds(this).at(-1)): void {
    if (id === undefined) throw new Error('No persistence barrier was sent');
    this.receive(
      frame(3, (encoder) => {
        encoding.writeVarString(encoder, id);
      }),
    );
  }
}
async function tick(): Promise<void> {
  for (let index = 0; index < 30; index += 1) await Promise.resolve();
}

function setup(overrides: Partial<Pick<LiveBodySyncOptions, 'getAccessToken'>> = {}) {
  vi.useFakeTimers();
  const remote = document('base');
  const doc = document();
  Y.applyUpdate(doc, Y.encodeStateAsUpdate(remote));
  let body: MirrorBody | null = {
    item: {
      id: ITEM,
      workspaceId: WORKSPACE,
      parentId: null,
      computedProperties: null,
      type: 'note',
      title: 'Note',
      seq: '1',
      revision: '1',
      lifecycleState: 'active',
      properties: {},
      schema: null,
      views: null,
      recurrence: null,
      noDelete: false,
      noChildren: false,
      managedBy: null,
      createdAt: '2026-10-13T12:00:00Z',
      updatedAt: null,
      canWrite: true,
      locked: false,
      canPersistBody: true,
      metadataExpiresAt: null,
      bodyDocId: DOC,
      bodyHeadSeq: '7',
      file: null,
    },
    docId: DOC,
    schemaVersion: 6,
    headSeq: '7',
    confirmedUpdate: Y.encodeStateAsUpdate(remote),
    pending: [],
  };
  const events: string[] = [];
  const commits: LiveBodySyncSuccess[] = [];
  const listeners = new Set<() => void>();
  const wires: Wire[] = [];
  const urls: string[] = [];
  const states: string[] = [];
  const losses: string[] = [];
  const failures: unknown[] = [];
  let readGate: Promise<void> | null = null;
  const store: LiveBodySyncOptions['store'] = {
    readBody: () => (readGate === null ? Promise.resolve(body) : readGate.then(() => body)),
    enqueueBodyUpdate: (_workspaceId, _itemId, pending) => {
      if (body === null) return Promise.reject(new Error('Body missing'));
      body.pending.push(pending);
      events.push(`persist:${pending.clientId}`);
      for (const listener of listeners) listener();
      return Promise.resolve();
    },
    commitLiveBodySync: (_workspaceId, response) => {
      if (body === null || !body.item.canPersistBody || body.docId !== response.docId)
        return Promise.reject(new Error('Body withheld'));
      const confirmed = document();
      if (body.confirmedUpdate) Y.applyUpdate(confirmed, body.confirmedUpdate);
      const acknowledged = new Set(response.acknowledgedClientIds);
      for (const pending of body.pending)
        if (acknowledged.has(pending.clientId)) Y.applyUpdate(confirmed, pending.update);
      Y.applyUpdate(confirmed, toByteArray(response.update));
      body.confirmedUpdate = Y.encodeStateAsUpdate(confirmed);
      body.pending = body.pending.filter((pending) => !acknowledged.has(pending.clientId));
      body.item.canWrite = response.canWrite;
      commits.push(response);
      events.push('commit');
      for (const listener of listeners) listener();
      return Promise.resolve();
    },
    recordBodyFailure: (_workspaceId, failure) => {
      failures.push(failure);
      if (failure.status === 'forbidden') body = null;
      for (const listener of listeners) listener();
      return Promise.resolve();
    },
    subscribe: (listener) => {
      listeners.add(listener);
      return () => {
        listeners.delete(listener);
      };
    },
  };
  const client = startLiveBodySync({
    workspaceId: WORKSPACE,
    itemId: ITEM,
    doc,
    store,
    schemaVersion: 6,
    baseUrl: 'https://nix.example/collab/',
    getAccessToken: overrides.getAccessToken ?? (() => Promise.resolve('private-native-token')),
    createSocket: (url) => {
      urls.push(url);
      const wire = new Wire(events);
      wires.push(wire);
      return wire;
    },
    onState: (state) => {
      states.push(state);
    },
    onAccessLost: (reason) => {
      losses.push(reason);
    },
  });
  clients.push(client);
  return {
    client,
    doc,
    remote,
    events,
    commits,
    states,
    losses,
    failures,
    urls,
    wires,
    get body() {
      return body;
    },
    pauseReads() {
      let release: () => void = () => undefined;
      readGate = new Promise<void>((resolve) => {
        release = resolve;
      });
      return () => {
        readGate = null;
        release();
      };
    },
    async connected(mode: 'read' | 'write' = 'write') {
      await tick();
      const wire = wires.at(-1);
      if (wire === undefined) throw new Error('No socket');
      wire.open();
      wire.ready(mode);
      await tick();
      return wire;
    },
    loseAdmission() {
      if (body !== null) body.item.canPersistBody = false;
      for (const listener of listeners) listener();
    },
  };
}
function edit(doc: Y.Doc, text: string): PendingBodyUpdate {
  const before = Y.encodeStateVector(doc);
  doc.getText('note').insert(doc.getText('note').length, text);
  return { clientId: text.slice(0, 200), update: Y.encodeStateAsUpdate(doc, before) };
}

describe('native live collaboration', () => {
  it('authenticates in the first frame without putting the token in the URL', async () => {
    const test = setup();
    const wire = await test.connected();
    expect(test.urls).toEqual([`wss://nix.example/collab/documents/${ITEM}/ws`]);
    expect(wire.sent[0]).toBe(
      JSON.stringify({ type: 'auth', token: 'private-native-token', schemaVersion: 6 }),
    );
    expect(wire.sent.slice(1).every((message) => message instanceof Uint8Array)).toBe(true);
  });

  it('persists local updates before sending and clears only the pending IDs captured by its barrier', async () => {
    const test = setup();
    const wire = await test.connected();
    await test.client.enqueue(edit(test.doc, ' A'));
    await vi.advanceTimersByTimeAsync(80);
    const firstBarrier = barrierIds(wire)[0];
    expect(firstBarrier).toBeDefined();
    expect(test.events.indexOf('persist: A')).toBeLessThan(test.events.lastIndexOf('send'));
    await test.client.enqueue(edit(test.doc, ' B'));
    expect(test.commits).toEqual([]);
    wire.acknowledge(firstBarrier);
    await tick();
    expect(test.body?.pending.map((entry) => entry.clientId)).toEqual([' B']);
    expect(test.commits[0]?.acknowledgedClientIds).toEqual([' A']);
    await vi.advanceTimersByTimeAsync(80);
    wire.acknowledge();
    await tick();
    expect(test.body?.pending).toEqual([]);
    const persisted = document();
    if (test.body?.confirmedUpdate) Y.applyUpdate(persisted, test.body.confirmedUpdate);
    expect(persisted.getText('note').toJSON()).toBe('base A B');
  });

  it('freezes incoming bytes per barrier and commits before applying them to the editor', async () => {
    const test = setup();
    const wire = await test.connected();
    const origins: unknown[] = [];
    test.doc.on('update', (_update: Uint8Array, origin: unknown) => {
      origins.push(origin);
      expect(test.events.at(-1)).toBe('commit');
    });
    wire.receive(updateFrame(edit(test.remote, ' A').update));
    await tick();
    const firstBarrier = barrierIds(wire)[0];
    wire.receive(updateFrame(edit(test.remote, ' B').update));
    await tick();
    expect(test.doc.getText('note').toJSON()).toBe('base');
    wire.acknowledge(firstBarrier);
    await tick();
    expect(test.doc.getText('note').toJSON()).toBe('base A');
    expect(test.commits).toHaveLength(1);
    wire.acknowledge();
    await tick();
    expect(test.doc.getText('note').toJSON()).toBe('base A B');
    expect(origins).toEqual([LIVE_ORIGIN, LIVE_ORIGIN]);
  });

  it('does not reply to sync step 1 with unchecked local bytes or read-only writes', async () => {
    const test = setup();
    test.doc.getText('note').insert(0, 'Unqueued ');
    const wire = await test.connected('read');
    wire.receive(
      frame(0, (encoder) => {
        syncProtocol.writeSyncStep1(encoder, test.remote);
      }),
    );
    await vi.advanceTimersByTimeAsync(80);
    expect(sentUpdates(wire)).toEqual([]);
    wire.receive(updateFrame(edit(test.remote, ' remote').update));
    await tick();
    wire.acknowledge();
    await tick();
    expect(test.commits[0]?.canWrite).toBe(false);
    expect(test.states.at(-1)).toBe('readonly');
  });

  it('refuses new local edits when the socket says read-only despite stale writable metadata', async () => {
    const test = setup();
    await test.connected('read');
    expect(test.body?.item.canWrite).toBe(true);
    await expect(test.client.enqueue(edit(test.doc, ' denied'))).rejects.toThrow('cannot edit');
    expect(test.body?.pending).toEqual([]);
  });

  it('retains a newer read-only notice while the ready handler waits for local storage', async () => {
    const test = setup();
    await tick();
    const wire = test.wires[0];
    if (wire === undefined) throw new Error('No socket');
    wire.open();
    const release = test.pauseReads();
    wire.ready('write');
    await tick();
    wire.receive(
      frame(2, (encoder) => {
        encoding.writeVarString(
          encoder,
          JSON.stringify({ code: 'read_only', detail: 'Read only' }),
        );
      }),
    );
    release();
    await tick();
    await expect(test.client.enqueue(edit(test.doc, ' denied'))).rejects.toThrow('cannot edit');
    await vi.advanceTimersByTimeAsync(80);
    expect(test.body?.pending).toEqual([]);
    expect(sentUpdates(wire)).toEqual([]);
    expect(test.states.at(-1)).toBe('readonly');
  });

  it('stores edits while token acquisition waits and does not open a socket after stop', async () => {
    let release: (token: string | null) => void = () => undefined;
    const token = new Promise<string | null>((resolve) => {
      release = resolve;
    });
    const test = setup({ getAccessToken: () => token });
    await tick();
    await test.client.enqueue(edit(test.doc, ' offline'));
    expect(test.body?.pending).toHaveLength(1);
    test.client.stop();
    release('fresh-token');
    await tick();
    expect(test.wires).toEqual([]);
  });

  it('keeps refused pending edits and ignores a later acknowledgement without a resync loop', async () => {
    const test = setup();
    const wire = await test.connected();
    await test.client.enqueue(edit(test.doc, ' rejected'));
    await vi.advanceTimersByTimeAsync(80);
    const id = barrierIds(wire)[0];
    wire.receive(
      frame(2, (encoder) => {
        encoding.writeVarString(
          encoder,
          JSON.stringify({ code: 'read_only', detail: 'Read only' }),
        );
      }),
    );
    wire.acknowledge(id);
    await tick();
    wire.receive(
      frame(0, (encoder) => {
        syncProtocol.writeSyncStep1(encoder, test.remote);
      }),
    );
    await vi.advanceTimersByTimeAsync(1000);
    expect(test.commits).toEqual([]);
    expect(test.body?.pending).toHaveLength(1);
    expect(sentUpdates(wire)).toHaveLength(1);
    expect(test.wires).toHaveLength(1);
  });

  it('halts on document replacement before any binary document frame leaves', async () => {
    const test = setup();
    await tick();
    const wire = test.wires[0];
    if (wire === undefined) throw new Error('No socket');
    wire.open();
    wire.ready('write', ITEM);
    await tick();
    expect(wire.sent).toHaveLength(1);
    expect(test.losses).toEqual(['document_changed']);
    expect(test.commits).toEqual([]);
  });

  it('stops and purges withheld bodies before a waiting remote update reaches the editor', async () => {
    const test = setup();
    const wire = await test.connected();
    wire.receive(updateFrame(edit(test.remote, ' secret').update));
    await tick();
    const id = barrierIds(wire)[0];
    test.loseAdmission();
    await tick();
    wire.acknowledge(id);
    await tick();
    expect(test.body).toBeNull();
    expect(test.doc.getText('note').toJSON()).toBe('base');
    expect(test.commits).toEqual([]);
    expect(test.losses).toEqual(['forbidden']);
  });

  it('retains unacknowledged edits on timeout and rejects stale socket echoes after reconnect', async () => {
    const test = setup();
    const wire = await test.connected();
    await test.client.enqueue(edit(test.doc, ' pending'));
    await vi.advanceTimersByTimeAsync(80);
    const id = barrierIds(wire)[0];
    await vi.advanceTimersByTimeAsync(15_000);
    expect(test.body?.pending).toHaveLength(1);
    wire.acknowledge(id);
    await tick();
    expect(test.commits).toEqual([]);
    await vi.advanceTimersByTimeAsync(1000);
    expect(test.wires).toHaveLength(2);
  });

  it('splits persisted queues into update frames under the server byte ceiling', async () => {
    const test = setup();
    const wire = await test.connected();
    const source = document();
    await test.client.enqueue(edit(source, 'x'.repeat(700_000)));
    await test.client.enqueue(edit(source, 'y'.repeat(700_000)));
    await vi.advanceTimersByTimeAsync(80);
    expect(sentUpdates(wire)).toHaveLength(1);
    wire.acknowledge();
    await tick();
    expect(sentUpdates(wire)).toHaveLength(2);
    expect(
      sentUpdates(wire).every((update) => update.byteLength <= BODY_SYNC_LIMITS.updateBytes),
    ).toBe(true);
    wire.acknowledge();
    await tick();
    expect(test.body?.pending).toEqual([]);
  });

  it('caps automatic retries even when each failed connection reaches ready', async () => {
    const test = setup();
    for (let attempt = 0; attempt < 9; attempt += 1) {
      const wire = await test.connected();
      wire.close(1006);
      if (attempt < 8) await vi.advanceTimersByTimeAsync(Math.min(1000 * 2 ** attempt, 30_000));
    }
    await vi.advanceTimersByTimeAsync(60_000);
    expect(test.wires).toHaveLength(9);
    expect(test.states.at(-1)).toBe('blocked');
  });
});
