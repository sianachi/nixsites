import * as decoding from 'lib0/decoding';
import * as encoding from 'lib0/encoding';
import * as syncProtocol from 'y-protocols/sync';
import * as Y from 'yjs';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import {
  startCollabSync,
  type CollabSync,
  type ProviderSocket,
  type SyncState,
} from '../../editor/collab-sync';

/**
 * The provider's promises, asserted over a fake socket: the token goes first and never in
 * the URL, a local edit streams when live and survives when not, a remote update is
 * applied without being echoed back, and every close code the server uses lands in a
 * state whose footer copy a person can act on.
 */

const MESSAGE_SYNC = 0;
const MESSAGE_NOTICE = 2;
const MESSAGE_PERSISTENCE_BARRIER = 3;

class FakeSocket implements ProviderSocket {
  binaryType = 'blob';
  readyState = 0;
  readonly sent: (string | Uint8Array)[] = [];
  closedWith: number | null = null;
  onopen: (() => void) | null = null;
  onmessage: ((event: { data: unknown }) => void) | null = null;
  onclose: ((event: { code: number }) => void) | null = null;
  onerror: (() => void) | null = null;

  constructor(readonly url: string) {}

  send(data: string | Uint8Array): void {
    this.sent.push(data);
  }

  close(code?: number): void {
    this.closedWith = code ?? 1000;
    this.readyState = 3;
  }

  open(): void {
    this.readyState = 1;
    this.onopen?.();
  }

  receiveText(payload: unknown): void {
    this.onmessage?.({ data: JSON.stringify(payload) });
  }

  receiveBinary(bytes: Uint8Array): void {
    // Delivered as ArrayBuffer, the shape a browser socket with binaryType arraybuffer
    // produces.
    this.onmessage?.({
      data: bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength),
    });
  }

  drop(code: number): void {
    this.readyState = 3;
    this.onclose?.({ code });
  }

  binaryFramesSent(): Uint8Array[] {
    return this.sent.filter((frame): frame is Uint8Array => typeof frame !== 'string');
  }
}

interface Harness {
  readonly notices: string[];
  readonly doc: Y.Doc;
  readonly states: SyncState[];
  readonly sockets: FakeSocket[];
  readonly sync: CollabSync;
  readonly tokens: string[];
  readonly tokenRefreshes: boolean[];
  latest(): FakeSocket;
}

function harness(): Harness {
  const doc = new Y.Doc();
  const states: SyncState[] = [];
  const sockets: FakeSocket[] = [];
  const tokens: string[] = [];
  const tokenRefreshes: boolean[] = [];
  const notices: string[] = [];

  const sync = startCollabSync({
    itemId: 'item-1',
    doc,
    fragmentName: 'default',
    getAccessToken: (forceRefresh = false) => {
      tokenRefreshes.push(forceRefresh);
      const token = `token-${String(tokens.length)}`;
      tokens.push(token);
      return Promise.resolve(token);
    },
    onNotice: ({ code }) => {
      notices.push(code);
    },
    onState: (state) => {
      states.push(state);
    },
    createSocket: (url) => {
      const socket = new FakeSocket(url);
      sockets.push(socket);
      return socket;
    },
    minRetryMs: 10,
    maxRetryMs: 40,
  });

  return {
    doc,
    states,
    sockets,
    sync,
    tokens,
    tokenRefreshes,
    notices,
    latest: () => {
      const socket = sockets[sockets.length - 1];
      if (socket === undefined) {
        throw new Error('No socket was created.');
      }
      return socket;
    },
  };
}

async function settled(): Promise<void> {
  for (let index = 0; index < 12; index += 1) await Promise.resolve();
}

function ready(socket: FakeSocket, mode: 'write' | 'read' = 'write'): void {
  socket.receiveText({ type: 'ready', docId: 'doc-1', mode, bodyKind: 'note', schemaVersion: 1 });
}

function typeParagraph(doc: Y.Doc, text: string): void {
  const fragment = doc.getXmlFragment('default');
  const paragraph = new Y.XmlElement('paragraph');
  paragraph.insert(0, [new Y.XmlText(text)]);
  fragment.insert(fragment.length, [paragraph]);
}

function textOf(doc: Y.Doc): string {
  // eslint-disable-next-line @typescript-eslint/no-base-to-string -- Y.XmlFragment defines its own XML toString; the rule cannot see through the generic base class.
  return doc.getXmlFragment('default').toString();
}

let active: CollabSync | null = null;

beforeEach(() => {
  vi.useFakeTimers();
});

afterEach(() => {
  active?.destroy();
  active = null;
  vi.restoreAllMocks();
  vi.useRealTimers();
});

describe('the websocket provider', () => {
  it('authenticates with the first frame, and never puts the token in the URL', async () => {
    const h = harness();
    active = h.sync;
    await settled();
    const socket = h.latest();
    socket.open();

    expect(socket.url).not.toContain('token');
    const first = socket.sent[0];
    expect(typeof first).toBe('string');
    expect(JSON.parse(first as string)).toMatchObject({ type: 'auth', token: 'token-0' });
  });

  it('forces verified token renewal after an unauthenticated socket close', async () => {
    const h = harness();
    active = h.sync;
    await settled();
    expect(h.tokenRefreshes).toEqual([false]);
    h.latest().open();
    h.latest().drop(4401);
    await vi.advanceTimersByTimeAsync(100);

    expect(h.tokenRefreshes).toEqual([false, true]);
    h.latest().open();
    ready(h.latest());
    h.latest().drop(1006);
    await vi.advanceTimersByTimeAsync(100);
    expect(h.tokenRefreshes).toEqual([false, true, false]);
  });

  it('opens sync with step 1 once the server says ready, and reports live', async () => {
    const h = harness();
    active = h.sync;
    await settled();
    const socket = h.latest();
    socket.open();
    ready(socket);

    const frames = socket.binaryFramesSent();
    expect(frames.length).toBeGreaterThan(0);
    const decoder = decoding.createDecoder(frames[0] ?? new Uint8Array());
    expect(decoding.readVarUint(decoder)).toBe(MESSAGE_SYNC);
    expect(decoding.readVarUint(decoder)).toBe(syncProtocol.messageYjsSyncStep1);
    expect(h.states.at(-1)).toBe('live');
  });

  it('streams a local edit while live, within the flush window', async () => {
    const h = harness();
    active = h.sync;
    await settled();
    const socket = h.latest();
    socket.open();
    ready(socket);
    const before = socket.binaryFramesSent().length;

    typeParagraph(h.doc, 'Typed while live.');
    await vi.advanceTimersByTimeAsync(100);

    expect(socket.binaryFramesSent().length).toBeGreaterThan(before);
  });

  it('flushes pending edits and waits for the matching persistence barrier before resolving', async () => {
    const h = harness();
    active = h.sync;
    await settled();
    const socket = h.latest();
    socket.open();
    ready(socket);
    const before = socket.binaryFramesSent().length;

    typeParagraph(h.doc, 'Must be durable before save.');
    let completed = false;
    const pending = h.sync.flushAndWait().then(() => {
      completed = true;
    });

    const frames = socket.binaryFramesSent().slice(before);
    expect(frames).toHaveLength(2);
    const barrier = decoding.createDecoder(frames[1] ?? new Uint8Array());
    expect(decoding.readVarUint(barrier)).toBe(MESSAGE_PERSISTENCE_BARRIER);
    const barrierId = decoding.readVarString(barrier);
    expect(completed).toBe(false);

    const echo = encoding.createEncoder();
    encoding.writeVarUint(echo, MESSAGE_PERSISTENCE_BARRIER);
    encoding.writeVarString(echo, barrierId);
    socket.receiveBinary(encoding.toUint8Array(echo));
    await pending;

    expect(completed).toBe(true);
  });

  it('sends one frame for a burst of updates, not one frame each', async () => {
    // The defect this exists to stop, reported by somebody working alone: a canvas reports a
    // scene change on every pointer move, so dragging one shape produced about sixty updates a
    // second against a ceiling of six hundred a minute. Ten seconds of dragging spent the whole
    // budget and one person was refused as if they were a runaway client.
    const h = harness();
    active = h.sync;
    await settled();
    const socket = h.latest();
    socket.open();
    ready(socket);
    const before = socket.binaryFramesSent().length;

    for (let index = 0; index < 60; index += 1) {
      typeParagraph(h.doc, `Drag frame ${String(index)}.`);
    }
    await vi.advanceTimersByTimeAsync(100);

    expect(socket.binaryFramesSent().length - before).toBe(1);
  });

  it('sends a burst as one update that carries every change in it', async () => {
    // Merging is not sampling. A coalesced flush has to be the same edit as the frames it
    // replaced, or the thing this fixed would become a worse thing: dropped work.
    const h = harness();
    active = h.sync;
    await settled();
    const socket = h.latest();
    socket.open();
    ready(socket);
    const before = socket.binaryFramesSent().length;

    typeParagraph(h.doc, 'First.');
    typeParagraph(h.doc, 'Second.');
    typeParagraph(h.doc, 'Third.');
    await vi.advanceTimersByTimeAsync(100);

    const frames = socket.binaryFramesSent().slice(before);
    expect(frames).toHaveLength(1);

    // Applied to an empty document, the one frame reproduces all three edits.
    const replica = new Y.Doc();
    const first = frames[0];
    if (first === undefined) {
      throw new Error('The burst sent no frame.');
    }
    const decoder = decoding.createDecoder(first);
    decoding.readVarUint(decoder);
    syncProtocol.readSyncMessage(decoder, encoding.createEncoder(), replica, null);

    const text = JSON.stringify(replica.getXmlFragment('default').toJSON());
    expect(text).toContain('First.');
    expect(text).toContain('Second.');
    expect(text).toContain('Third.');
  });

  it('sends whatever is still waiting when the editor closes', async () => {
    // Closing is exactly when somebody expects their last keystroke to have counted, and up to a
    // flush window of it is held here by design.
    const h = harness();
    active = h.sync;
    await settled();
    const socket = h.latest();
    socket.open();
    ready(socket);
    const before = socket.binaryFramesSent().length;

    typeParagraph(h.doc, 'The last thing typed.');
    h.sync.destroy();
    active = null;

    expect(socket.binaryFramesSent().length).toBeGreaterThan(before);
  });

  it('applies a remote update without echoing it back', async () => {
    const h = harness();
    active = h.sync;
    await settled();
    const socket = h.latest();
    socket.open();
    ready(socket);
    const before = socket.binaryFramesSent().length;

    const remote = new Y.Doc();
    typeParagraph(remote, 'From a colleague.');
    const encoder = encoding.createEncoder();
    encoding.writeVarUint(encoder, MESSAGE_SYNC);
    syncProtocol.writeUpdate(encoder, Y.encodeStateAsUpdate(remote));
    socket.receiveBinary(encoding.toUint8Array(encoder));

    expect(textOf(h.doc)).toContain('From a colleague.');
    expect(socket.binaryFramesSent().length).toBe(before);
    remote.destroy();
  });

  it('keeps an edit made while offline and reports pending, not saved', async () => {
    const h = harness();
    active = h.sync;
    await settled();
    const socket = h.latest();
    socket.open();
    ready(socket);
    socket.drop(1006);

    typeParagraph(h.doc, 'Typed in a tunnel.');

    expect(h.states.at(-1)).toBe('pending');
    expect(textOf(h.doc)).toContain('Typed in a tunnel.');
  });

  it('merges the offline edit on reconnect through the sync handshake', async () => {
    const h = harness();
    active = h.sync;
    await settled();
    const first = h.latest();
    first.open();
    ready(first);
    first.drop(1006);

    typeParagraph(h.doc, 'Made offline.');

    // The reconnect happens on the backoff timer, with a fresh token.
    await vi.advanceTimersByTimeAsync(50);
    await settled();
    const second = h.latest();
    expect(second).not.toBe(first);
    second.open();
    ready(second);

    // A server double opens with its own step 1, exactly as the real server does after
    // ready; the client's step 2 reply must carry the offline paragraph.
    const serverDoc = new Y.Doc();
    const step1 = encoding.createEncoder();
    encoding.writeVarUint(step1, MESSAGE_SYNC);
    syncProtocol.writeSyncStep1(step1, serverDoc);
    second.receiveBinary(encoding.toUint8Array(step1));

    for (const frame of second.binaryFramesSent()) {
      const decoder = decoding.createDecoder(frame);
      if (decoding.readVarUint(decoder) !== MESSAGE_SYNC) {
        continue;
      }
      const encoder = encoding.createEncoder();
      encoding.writeVarUint(encoder, MESSAGE_SYNC);
      syncProtocol.readSyncMessage(decoder, encoder, serverDoc, 'server');
    }

    expect(textOf(serverDoc)).toContain('Made offline.');
    expect(h.tokens.length).toBe(2);
    expect(h.states.at(-1)).toBe('live');
    serverDoc.destroy();
  });

  it('reports read-only when the handshake says so', async () => {
    const h = harness();
    active = h.sync;
    await settled();
    const socket = h.latest();
    socket.open();
    ready(socket, 'read');

    expect(h.states.at(-1)).toBe('readonly');
  });

  it('reports read-only on a mid-session downgrade notice', async () => {
    const h = harness();
    active = h.sync;
    await settled();
    const socket = h.latest();
    socket.open();
    ready(socket);

    const encoder = encoding.createEncoder();
    encoding.writeVarUint(encoder, MESSAGE_NOTICE);
    encoding.writeVarString(encoder, JSON.stringify({ code: 'read_only', detail: 'Downgraded.' }));
    socket.receiveBinary(encoding.toUint8Array(encoder));

    expect(h.states.at(-1)).toBe('readonly');
  });

  it('waits read-only while someone else edits, and goes live when handed the document', async () => {
    const h = harness();
    active = h.sync;
    await settled();
    const socket = h.latest();
    socket.open();
    ready(socket, 'read');
    const notice = (code: string): void => {
      const encoder = encoding.createEncoder();
      encoding.writeVarUint(encoder, MESSAGE_NOTICE);
      encoding.writeVarString(encoder, JSON.stringify({ code, detail: '' }));
      socket.receiveBinary(encoding.toUint8Array(encoder));
    };

    notice('editing_elsewhere');
    expect(h.states.at(-1)).toBe('readonly');
    notice('editable');
    expect(h.states.at(-1)).toBe('live');

    const before = socket.binaryFramesSent().length;
    typeParagraph(h.doc, 'Mine to edit now.');
    await vi.advanceTimersByTimeAsync(100);
    expect(socket.binaryFramesSent().length).toBeGreaterThan(before);
  });

  it.each([
    ['document_too_large', 0],
    ['rate_limited', 1],
  ])('after a %s notice answers the server resync %i times', async (code, answers) => {
    const h = harness();
    active = h.sync;
    await settled();
    const socket = h.latest();
    socket.open();
    ready(socket);
    typeParagraph(h.doc, 'Content the server refused.');

    const notice = encoding.createEncoder();
    encoding.writeVarUint(notice, MESSAGE_NOTICE);
    encoding.writeVarString(notice, JSON.stringify({ code, detail: '' }));
    socket.receiveBinary(encoding.toUint8Array(notice));
    const before = socket.binaryFramesSent().length;
    const step1 = encoding.createEncoder();
    encoding.writeVarUint(step1, MESSAGE_SYNC);
    syncProtocol.writeSyncStep1(step1, new Y.Doc());
    socket.receiveBinary(encoding.toUint8Array(step1));

    // A refused document answering every resync with the same content loops with the server.
    const replies = socket
      .binaryFramesSent()
      .slice(before)
      .filter((frame) => frame[0] === MESSAGE_SYNC);
    expect(replies).toHaveLength(answers);
  });

  it('does not send edits after a read-only handshake', async () => {
    const h = harness();
    active = h.sync;
    await settled();
    const socket = h.latest();
    socket.open();
    ready(socket, 'read');
    const before = socket.binaryFramesSent().length;

    typeParagraph(h.doc, 'A reader typing anyway.');

    expect(socket.binaryFramesSent().length).toBe(before);
  });

  it('reports degraded and backs off harder when the server is at capacity', async () => {
    const h = harness();
    active = h.sync;
    await settled();
    const socket = h.latest();
    socket.open();
    ready(socket);

    socket.drop(4413);

    expect(h.states.at(-1)).toBe('degraded');
    // No reconnect inside the ordinary retry window...
    await vi.advanceTimersByTimeAsync(100);
    await settled();
    expect(h.sockets.length).toBe(1);
    // ...but one after the capacity backoff.
    await vi.advanceTimersByTimeAsync(5_000);
    await settled();
    expect(h.sockets.length).toBe(2);
  });

  it('distinguishes access revocation from an ordinary disconnect for source editors', async () => {
    const h = harness();
    active = h.sync;
    await settled();
    const socket = h.latest();
    socket.open();
    ready(socket);
    socket.drop(4403);
    expect(h.states.at(-1)).toBe('readonly');
    expect(h.notices).toEqual(['access_revoked']);
  });

  it('fetches a fresh token for every reconnect attempt', async () => {
    const h = harness();
    active = h.sync;
    await settled();
    h.latest().open();
    ready(h.latest());

    h.latest().drop(4401);
    await vi.advanceTimersByTimeAsync(50);
    await settled();

    expect(h.tokens).toEqual(['token-0', 'token-1']);
  });

  it('reports the schema upgrade required for a connection that retries cannot repair', async () => {
    const h = harness();
    active = h.sync;
    await settled();
    h.latest().open();
    ready(h.latest());
    h.latest().drop(4409);
    expect(h.states.at(-1)).toBe('degraded');
    expect(h.notices).toContain('schema_version_mismatch');
  });

  it.each(['visibilitychange', 'online'])(
    'keeps a responsive connection during %s without restarting synchronization',
    async (eventName) => {
      const h = harness();
      active = h.sync;
      await settled();
      const socket = h.latest();
      socket.open();
      ready(socket);
      vi.spyOn(document, 'visibilityState', 'get').mockReturnValue('visible');
      const target = eventName === 'visibilitychange' ? document : window;
      target.dispatchEvent(new Event(eventName));
      target.dispatchEvent(new Event(eventName));
      const probes = socket.binaryFramesSent().filter((frame) => frame[0] === 3);
      expect(probes).toHaveLength(1);
      const probe = probes[0];
      if (probe === undefined) throw new Error('No connection probe was sent.');
      socket.receiveBinary(probe);
      await settled();
      await vi.advanceTimersByTimeAsync(15_000);

      expect(socket.closedWith).toBeNull();
      expect(h.sockets).toHaveLength(1);
      expect(h.tokens).toEqual(['token-0']);
    },
  );

  it('clears local presence while hidden and restores it when visible', async () => {
    const h = harness();
    active = h.sync;
    await settled();
    h.sync.awareness.setLocalState({ user: { name: 'Me' } });
    const visibility = vi.spyOn(document, 'visibilityState', 'get');
    visibility.mockReturnValue('hidden');
    document.dispatchEvent(new Event('visibilitychange'));
    expect(h.sync.awareness.getLocalState()).toBeNull();
    visibility.mockReturnValue('visible');
    document.dispatchEvent(new Event('visibilitychange'));
    expect(h.sync.awareness.getLocalState()).toEqual({ user: { name: 'Me' } });
  });

  it('reconnects a disconnected note promptly when the app returns to the foreground', async () => {
    const h = harness();
    active = h.sync;
    await settled();
    h.latest().open();
    ready(h.latest());
    h.latest().drop(1006);
    vi.spyOn(document, 'visibilityState', 'get').mockReturnValue('visible');
    document.dispatchEvent(new Event('visibilitychange'));
    await settled();
    expect(h.sockets).toHaveLength(2);
    expect(h.tokens).toEqual(['token-0', 'token-1']);
  });

  it('reconnects a half-open note when the foreground connection probe times out', async () => {
    const h = harness();
    active = h.sync;
    await settled();
    const socket = h.latest();
    socket.open();
    ready(socket);
    vi.spyOn(document, 'visibilityState', 'get').mockReturnValue('visible');
    document.dispatchEvent(new Event('visibilitychange'));

    await vi.advanceTimersByTimeAsync(15_000);
    await settled();

    expect(socket.closedWith).toBe(1000);
    expect(h.sockets).toHaveLength(2);
    expect(h.tokens).toEqual(['token-0', 'token-1']);
  });

  it('stops entirely on destroy: socket closed, no reconnect', async () => {
    const h = harness();
    await settled();
    const socket = h.latest();
    socket.open();
    ready(socket);

    h.sync.destroy();
    await vi.advanceTimersByTimeAsync(1_000);
    await settled();

    expect(socket.closedWith).toBe(1000);
    expect(h.sockets.length).toBe(1);
  });
});
