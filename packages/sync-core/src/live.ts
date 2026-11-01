import { fromByteArray } from './base64.js';
import * as decoding from 'lib0/decoding';
import * as encoding from 'lib0/encoding';
import * as syncProtocol from 'y-protocols/sync';
import * as Y from 'yjs';
import { z } from 'zod';

import {
  BODY_SYNC_LIMITS,
  type MirrorBody,
  type MirrorStore,
  type PendingBodyUpdate,
} from './mirror.js';

export const LIVE_ORIGIN = Symbol('native-live-collaboration');
const SYNC = 0;
const NOTICE = 2;
const PERSISTED = 3;
const FLUSH_MS = 80;
const BARRIER_MS = 15_000;
const MAX_QUEUED_BYTES = 32 * 1024 * 1024;
const readySchema = z.object({
  type: z.literal('ready'),
  docId: z.uuid(),
  mode: z.enum(['read', 'write']),
  bodyKind: z.string(),
  schemaVersion: z.int().positive(),
});
const noticeSchema = z.object({ code: z.string().max(200), detail: z.string().max(4096) });

export type LiveSyncState = 'connecting' | 'live' | 'pending' | 'readonly' | 'offline' | 'blocked';
export interface LiveSocket {
  binaryType: string;
  readonly readyState: number;
  send(data: string | Uint8Array): void;
  close(code?: number, reason?: string): void;
  onopen: (() => void) | null;
  onmessage: ((event: { data: unknown }) => void) | null;
  onclose: ((event: { code: number }) => void) | null;
  onerror: (() => void) | null;
}
export interface LiveBodySyncOptions {
  workspaceId: string;
  itemId: string;
  doc: Y.Doc;
  store: Pick<
    MirrorStore,
    'readBody' | 'enqueueBodyUpdate' | 'commitLiveBodySync' | 'recordBodyFailure' | 'subscribe'
  >;
  schemaVersion: number;
  baseUrl: string;
  getAccessToken(forceRefresh?: boolean): Promise<string | null>;
  createSocket?: (url: string) => LiveSocket;
  onState(state: LiveSyncState): void;
  onNotice?: (notice: { code: string; detail: string }) => void;
  onAccessLost?: (reason: 'forbidden' | 'document_changed') => void;
}
export interface LiveBodySync {
  enqueue(update: PendingBodyUpdate): Promise<void>;
  flush(): Promise<void>;
  stop(): void;
}

function platformSocket(url: string): LiveSocket {
  const wire = new WebSocket(url);
  wire.binaryType = 'arraybuffer';
  const socket: LiveSocket = {
    binaryType: 'arraybuffer',
    get readyState() {
      return wire.readyState;
    },
    send: (data) => {
      wire.send(data);
    },
    close: (code, reason) => {
      wire.close(code, reason);
    },
    onopen: null,
    onmessage: null,
    onclose: null,
    onerror: null,
  };
  wire.onopen = () => socket.onopen?.();
  wire.onmessage = (event) => socket.onmessage?.({ data: event.data });
  wire.onclose = (event) => socket.onclose?.({ code: event.code });
  wire.onerror = () => socket.onerror?.();
  return socket;
}

function socketUrl(baseUrl: string, itemId: string): string {
  z.uuid().parse(itemId);
  const base = new URL(baseUrl.endsWith('/') ? baseUrl : `${baseUrl}/`);
  if (base.username || base.password || base.search || base.hash)
    throw new Error('The collaboration URL cannot contain credentials or query parameters');
  if (base.protocol === 'https:') base.protocol = 'wss:';
  else if (base.protocol === 'http:') base.protocol = 'ws:';
  if (base.protocol !== 'ws:' && base.protocol !== 'wss:')
    throw new Error('The collaboration URL must use HTTP or WebSocket');
  return new URL(`documents/${itemId}/ws`, base).toString();
}

function frame(type: number, write: (encoder: encoding.Encoder) => void): Uint8Array {
  const encoder = encoding.createEncoder();
  encoding.writeVarUint(encoder, type);
  write(encoder);
  return encoding.toUint8Array(encoder);
}

/** Existing Collab sync frames plus same-socket durable barriers, without editor-state autosends. */
export function startLiveBodySync(options: LiveBodySyncOptions): LiveBodySync {
  const { store, workspaceId, itemId, doc } = options;
  const url = socketUrl(options.baseUrl, itemId);
  let socket: LiveSocket | null = null;
  let joined: z.infer<typeof readySchema> | null = null;
  let stopped = false;
  let halted = false;
  let connecting = false;
  let forceRefresh = false;
  let retries = 0;
  let sequence = 0;
  let queuedBytes = 0;
  let writePaused = false;
  let writeDenied = false;
  let noticeGeneration = 0;
  let work = Promise.resolve();
  let flushFlight: Promise<void> | null = null;
  let flushTimer: ReturnType<typeof setTimeout> | undefined;
  let retryTimer: ReturnType<typeof setTimeout> | undefined;
  let handshakeTimer: ReturnType<typeof setTimeout> | undefined;
  let barrier: {
    id: string;
    resolve: () => void;
    reject: (error: Error) => void;
    timer: ReturnType<typeof setTimeout>;
  } | null = null;

  function current(wire: LiveSocket): boolean {
    return !stopped && !halted && socket === wire;
  }
  function running(): boolean {
    return !stopped && !halted;
  }
  function writable(): boolean {
    return !writePaused && joined?.mode === 'write';
  }
  function readyFrame(): z.infer<typeof readySchema> | null {
    return joined;
  }
  function cancelBarrier(): void {
    if (barrier === null) return;
    clearTimeout(barrier.timer);
    barrier.reject(new Error('The update was not confirmed persisted'));
    barrier = null;
  }
  function close(): void {
    clearTimeout(flushTimer);
    clearTimeout(retryTimer);
    clearTimeout(handshakeTimer);
    flushTimer = undefined;
    retryTimer = undefined;
    handshakeTimer = undefined;
    cancelBarrier();
    const previous = socket;
    socket = null;
    joined = null;
    previous?.close(1000, 'The live document channel stopped.');
  }
  async function refuse(reason: 'forbidden' | 'document_changed'): Promise<void> {
    if (halted || stopped) return;
    halted = true;
    writeDenied = true;
    close();
    options.onState('blocked');
    options.onAccessLost?.(reason);
    await store.recordBodyFailure(
      workspaceId,
      reason === 'forbidden'
        ? { itemId, status: 'forbidden' }
        : { itemId, status: 'rejected', code: reason },
    );
  }
  async function admitted(expectedDocId?: string): Promise<MirrorBody | null> {
    const body = await store.readBody(workspaceId, itemId);
    if (body === null || !body.item.canPersistBody || body.item.locked) {
      await refuse('forbidden');
      return null;
    }
    if (
      expectedDocId !== undefined &&
      (body.docId !== expectedDocId || body.item.bodyDocId !== expectedDocId)
    ) {
      await refuse('document_changed');
      return null;
    }
    return body;
  }
  function reconnect(): void {
    if (stopped || halted || retryTimer !== undefined) return;
    if (retries >= 8) {
      halted = true;
      options.onState('blocked');
      options.onNotice?.({
        code: 'live_retry_exhausted',
        detail: 'Reopen this note to retry live collaboration. Pending edits remain stored.',
      });
      return;
    }
    const delay = Math.min(1000 * 2 ** retries, 30_000);
    retries += 1;
    retryTimer = setTimeout(() => {
      retryTimer = undefined;
      void connect();
    }, delay);
  }
  function background(operation: () => Promise<void>): void {
    work = work.then(operation).catch(() => {
      if (!stopped && !halted && !writePaused) {
        options.onState('offline');
        close();
        reconnect();
      }
    });
  }
  function persisted(wire: LiveSocket): Promise<void> {
    if (!current(wire) || barrier !== null)
      return Promise.reject(new Error('The live channel is unavailable'));
    sequence += 1;
    const id = `native-${String(doc.clientID)}-${String(sequence)}`;
    return new Promise<void>((resolve, reject) => {
      const timer = setTimeout(() => {
        barrier = null;
        reject(new Error('The server did not confirm persistence in time'));
      }, BARRIER_MS);
      barrier = { id, resolve, reject, timer };
      try {
        wire.send(
          frame(PERSISTED, (encoder) => {
            encoding.writeVarString(encoder, id);
          }),
        );
      } catch (error) {
        cancelBarrier();
        reject(
          error instanceof Error ? error : new Error('The persistence barrier could not be sent'),
        );
      }
    });
  }
  async function commit(
    wire: LiveSocket,
    update: Uint8Array,
    pending: readonly PendingBodyUpdate[],
  ): Promise<void> {
    const ready = readyFrame();
    if (!current(wire) || ready === null) return;
    const body = await admitted(ready.docId);
    const latest = readyFrame();
    if (body === null || !current(wire) || latest === null) return;
    await store.commitLiveBodySync(workspaceId, {
      itemId,
      status: 'ok',
      docId: latest.docId,
      schemaVersion: latest.schemaVersion,
      canWrite: latest.mode === 'write' && body.item.canWrite,
      update: fromByteArray(update),
      stateVector: fromByteArray(Y.encodeStateVectorFromUpdate(update)),
      acknowledgedClientIds: pending.map((entry) => entry.clientId),
    });
    if (!current(wire)) return;
    Y.applyUpdate(doc, update, LIVE_ORIGIN);
    for (const entry of pending) Y.applyUpdate(doc, entry.update, LIVE_ORIGIN);
    const after = readyFrame();
    options.onState(after?.mode === 'read' ? 'readonly' : writePaused ? 'blocked' : 'live');
  }
  async function flushPending(): Promise<void> {
    const wire = socket;
    const ready = joined;
    if (wire === null || ready?.mode !== 'write' || !writable() || !current(wire)) return;
    const body = await admitted(ready.docId);
    if (body === null || !current(wire) || !body.item.canWrite) return;
    const remaining = body.pending.slice(0, BODY_SYNC_LIMITS.updatesPerDocument);
    while (remaining.length > 0 && current(wire) && writable()) {
      const pending: PendingBodyUpdate[] = [];
      let merged: Uint8Array = new Uint8Array([0, 0]);
      for (const candidate of remaining) {
        const next = Y.mergeUpdates([...pending.map((entry) => entry.update), candidate.update]);
        if (next.byteLength > BODY_SYNC_LIMITS.updateBytes) break;
        pending.push(candidate);
        merged = next;
      }
      if (pending.length === 0) throw new Error('A pending update exceeds the live update limit');
      options.onState('pending');
      wire.send(
        frame(SYNC, (encoder) => {
          syncProtocol.writeUpdate(encoder, merged);
        }),
      );
      await persisted(wire);
      if (!current(wire) || !writable()) return;
      await commit(wire, merged, pending);
      remaining.splice(0, pending.length);
    }
  }
  function flush(): Promise<void> {
    if (flushFlight !== null) return flushFlight;
    clearTimeout(flushTimer);
    flushTimer = undefined;
    flushFlight = work.then(flushPending);
    work = flushFlight.catch(() => {
      if (!stopped && !halted && !writePaused) {
        options.onState('offline');
        close();
        reconnect();
      }
    });
    const flight = flushFlight;
    void flight
      .finally(() => {
        if (flushFlight === flight) flushFlight = null;
      })
      .catch(() => undefined);
    return flight;
  }
  function scheduleFlush(): void {
    if (flushTimer !== undefined || stopped || halted) return;
    flushTimer = setTimeout(() => {
      flushTimer = undefined;
      void flush().catch(() => undefined);
    }, FLUSH_MS);
  }
  async function receive(wire: LiveSocket, bytes: Uint8Array): Promise<void> {
    if (!current(wire) || joined === null) return;
    const decoder = decoding.createDecoder(bytes);
    if (decoding.readVarUint(decoder) !== SYNC) return;
    const kind = decoding.readVarUint(decoder);
    if (kind === syncProtocol.messageYjsSyncStep1) {
      decoding.readVarUint8Array(decoder);
      // Only persisted pending groups may leave this device, never the editor's unchecked state.
      if (!writePaused && joined.mode === 'write') scheduleFlush();
      return;
    }
    if (kind !== syncProtocol.messageYjsSyncStep2 && kind !== syncProtocol.messageYjsUpdate) return;
    const update = decoding.readVarUint8Array(decoder);
    if (update.byteLength > BODY_SYNC_LIMITS.responseUpdateBytes)
      throw new Error('The live body exceeds the receive limit');
    Y.decodeUpdate(update);
    await persisted(wire);
    if (current(wire)) await commit(wire, update, []);
  }
  async function connect(): Promise<void> {
    if (stopped || halted || connecting || socket !== null) return;
    connecting = true;
    options.onState('connecting');
    try {
      await work;
      const body = await admitted();
      if (!running()) return;
      if (body?.docId === null || body === null) {
        options.onState('offline');
        return;
      }
      const token = await options.getAccessToken(forceRefresh);
      if (!running()) return;
      if (token === null) {
        options.onState('offline');
        reconnect();
        return;
      }
      forceRefresh = false;
      const wire = (options.createSocket ?? platformSocket)(url);
      socket = wire;
      noticeGeneration = 0;
      wire.binaryType = 'arraybuffer';
      handshakeTimer = setTimeout(() => {
        if (current(wire) && joined === null) wire.close(1000, 'The handshake timed out.');
      }, 10_000);
      wire.onopen = () => {
        if (current(wire))
          wire.send(JSON.stringify({ type: 'auth', token, schemaVersion: options.schemaVersion }));
      };
      wire.onmessage = ({ data }) => {
        if (!current(wire)) return;
        if (typeof data === 'string') {
          const receivedNoticeGeneration = noticeGeneration;
          background(async () => {
            if (!current(wire) || data.length > 4096) return;
            const ready = readySchema.parse(JSON.parse(data));
            if (ready.docId !== body.docId) {
              await refuse('document_changed');
              return;
            }
            if (ready.schemaVersion > options.schemaVersion)
              throw new Error('The document schema is newer than this app');
            if ((await admitted(ready.docId)) === null || !current(wire)) return;
            clearTimeout(handshakeTimer);
            if (noticeGeneration === receivedNoticeGeneration) {
              writePaused = false;
              writeDenied = ready.mode === 'read';
            }
            joined = { ...ready, mode: writeDenied ? 'read' : ready.mode };
            const state = new Y.Doc();
            try {
              const local = await admitted(ready.docId);
              if (local === null || !current(wire)) return;
              if (local.confirmedUpdate !== null) Y.applyUpdate(state, local.confirmedUpdate);
              for (const pending of local.pending) Y.applyUpdate(state, pending.update);
              wire.send(
                frame(SYNC, (encoder) => {
                  syncProtocol.writeSyncStep1(encoder, state);
                }),
              );
            } finally {
              state.destroy();
            }
            if (writable()) scheduleFlush();
            else options.onState('readonly');
          });
          return;
        }
        const bytes =
          data instanceof Uint8Array
            ? data.slice()
            : data instanceof ArrayBuffer
              ? new Uint8Array(data)
              : null;
        if (bytes === null || bytes.byteLength > BODY_SYNC_LIMITS.responseUpdateBytes + 2048) {
          wire.close(1009, 'Invalid collaboration frame.');
          return;
        }
        try {
          const decoder = decoding.createDecoder(bytes);
          const type = decoding.readVarUint(decoder);
          if (type === PERSISTED) {
            const id = decoding.readVarString(decoder);
            if (barrier !== null && barrier.id === id) {
              clearTimeout(barrier.timer);
              const waiting = barrier;
              barrier = null;
              waiting.resolve();
            }
          } else if (type === NOTICE) {
            noticeGeneration += 1;
            const notice = noticeSchema.parse(JSON.parse(decoding.readVarString(decoder)));
            writePaused = true;
            if (notice.code === 'read_only' && joined !== null)
              joined = { ...joined, mode: 'read' };
            if (notice.code === 'read_only') writeDenied = true;
            cancelBarrier();
            options.onState(notice.code === 'read_only' ? 'readonly' : 'blocked');
            options.onNotice?.(notice);
            background(() =>
              store.recordBodyFailure(workspaceId, {
                itemId,
                status: 'rejected',
                code: notice.code,
              }),
            );
          } else if (type === SYNC) {
            queuedBytes += bytes.byteLength;
            if (queuedBytes > MAX_QUEUED_BYTES) {
              wire.close(1013, 'The reader fell behind.');
              return;
            }
            background(async () => {
              try {
                await receive(wire, bytes);
              } finally {
                queuedBytes -= bytes.byteLength;
              }
            });
          }
        } catch {
          wire.close(1002, 'Invalid collaboration frame.');
        }
      };
      wire.onerror = () => undefined;
      wire.onclose = ({ code }) => {
        if (socket !== wire) return;
        socket = null;
        joined = null;
        clearTimeout(handshakeTimer);
        cancelBarrier();
        if (stopped || halted) return;
        if (code === 4403 || code === 4404 || code === 4405) {
          void refuse('forbidden').catch(() => undefined);
          return;
        }
        if (code === 4409) {
          halted = true;
          writeDenied = true;
          options.onState('blocked');
          options.onNotice?.({
            code: 'schema_version_mismatch',
            detail: 'Update this app to edit the current document.',
          });
          return;
        }
        if (code === 4401) forceRefresh = true;
        options.onState('offline');
        reconnect();
      };
    } catch {
      if (running()) {
        options.onState('offline');
        reconnect();
      }
    } finally {
      connecting = false;
    }
  }
  const unsubscribe = store.subscribe(() => {
    void admitted(joined?.docId)
      .then((body) => {
        if (body === null || stopped || halted) return;
        if (socket === null) void connect();
        else if (body.pending.length > 0) scheduleFlush();
      })
      .catch(() => {
        if (!stopped && !halted) {
          options.onState('blocked');
          close();
        }
      });
  });
  void connect();
  return {
    async enqueue(pending) {
      if (stopped) throw new Error('This live document channel has stopped');
      if (writeDenied) throw new Error('The current session may read this body but cannot edit it');
      await store.enqueueBodyUpdate(workspaceId, itemId, pending);
      options.onState('pending');
      scheduleFlush();
    },
    flush,
    stop() {
      stopped = true;
      unsubscribe();
      close();
    },
  };
}
