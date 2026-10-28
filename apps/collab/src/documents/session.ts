import { randomUUID } from 'node:crypto';

import { SCHEMA_VERSION } from '@nix/editor-schema';
import * as awarenessProtocol from 'y-protocols/awareness';
import * as syncProtocol from 'y-protocols/sync';
import * as decoding from 'lib0/decoding';
import * as encoding from 'lib0/encoding';
import type { Pool } from 'pg';
import * as Y from 'yjs';

import { appendUpdates, updatesAfter, type ContentDocRow } from '../db/documents.ts';
import { withTenantScope, type ScopedQuery } from '../db/tenant-scope.ts';
import type { CollabMetrics } from '../metrics.ts';
import {
  MESSAGE_AWARENESS,
  MESSAGE_PERSISTED,
  MESSAGE_SYNC,
  CLOSE_CODES,
  encodeNotice,
  encodePersisted,
  readBinaryFrame,
} from '../ws/protocol.ts';
import type { SocketSession } from '../ws/server.ts';
import { noteStrategy, type BodyKindStrategy, type Measurement } from './body-kinds.ts';
import { LIMITS, rejection, type RateWindow, type Rejection } from './limits.ts';
import { CATCH_UP_LIMIT, loadDocument, writeSnapshotNow } from './service.ts';

/** The thresholds a resident document lives by. All of them configuration, none of them lore. */
export interface SessionConfig {
  /** How long pending updates may wait before a flush. The crash-loss window. */
  readonly flushMs: number;

  /** How many pending bytes force a flush before the timer does. */
  readonly flushBytes: number;

  /** Updates between snapshots. */
  readonly snapshotEvery: number;

  /** How long an active document may go without a snapshot, whatever the update count. */
  readonly snapshotIntervalMs: number;

  /**
   * The encoded size from which a document keeps a standing mirror to judge updates against,
   * instead of copying itself for every one. Below it the copy is cheaper than the memory.
   * Defaults to {@link MIRROR_FROM_BYTES}.
   */
  readonly mirrorFromBytes?: number | undefined;
}

/** Where a standing mirror starts paying for itself: about a thousand paragraphs of prose. */
const MIRROR_FROM_BYTES = 64 * 1024;

export interface SessionContext {
  readonly pool: Pool;
  readonly config: SessionConfig;
  readonly metrics?: CollabMetrics | undefined;

  /**
   * Per-principal, per-document backpressure - the same window the HTTP path enforces,
   * ideally the same instance, so moving transports does not double anyone's budget.
   */
  readonly rateWindow?: RateWindow | undefined;

  /** Where refusals worth an operator's attention go. Defaults to silence, not stdout. */
  readonly log?: ((message: string) => void) | undefined;

  /**
   * Fired once per flush, so Core can bump the item's modification stamp. Best-effort by
   * contract: the log append already succeeded, and a stale envelope stamp is a smaller
   * wrong than a failed flush.
   */
  readonly onFlushed?: ((session: DocumentSession) => void) | undefined;

  /**
   * Atomically moves this session's contribution to the process-wide resident-byte account.
   * Growth may be refused before the Yjs document is mutated; shrinkage is always accepted.
   */
  readonly resizeResident?:
    | ((session: DocumentSession, nextEstimatedBytes: number, force?: boolean) => boolean)
    | undefined;

  readonly now?: (() => number) | undefined;
}

type LifecycleState = 'active' | 'draining' | 'unloaded';

/**
 * The origin of updates read back from the log rather than received from a socket: broadcast to
 * every editor, never queued for persistence, because they are already persisted.
 */
const LOG_ORIGIN = Symbol('log');

interface PendingUpdate {
  readonly bytes: Uint8Array;
  readonly principalId: string;
  readonly clientId: string;
}

/**
 * One document, resident: the loaded `Y.Doc`, the sockets editing it, the awareness they
 * share, and the queue of updates not yet flushed to the log.
 *
 * This is the object MVP-1 deliberately did not build. The HTTP path replays snapshot plus
 * tail on every append, which is correct and unaffordable past a handful of editors; here
 * the replay happens once at load, updates apply to live state, and the log sees one
 * batched transaction per flush window instead of one row lock per keystroke burst.
 *
 * **What is in memory ahead of the last flush is the crash-loss window** - bounded by
 * `flushMs` and `flushBytes`, documented, and recovered by clients re-sending on reconnect
 * via sync step 1. Awareness is never persisted at all: presence is a fact about now.
 */
export class DocumentSession {
  readonly itemId: string;
  readonly docRow: ContentDocRow;
  readonly tenantId: string;

  /** The principal the document was loaded as, for log reads no writer is behind. */
  readonly #loadedBy: string;

  /** How this body is validated and materialised - the item's `type`, resolved once at load. */
  readonly strategy: BodyKindStrategy;

  #state: LifecycleState = 'active';
  readonly #doc: Y.Doc;
  readonly #awareness: awarenessProtocol.Awareness;
  readonly #context: SessionContext;

  readonly #sockets = new Set<SocketSession>();
  readonly #clientIdsBySocket = new Map<SocketSession, Set<number>>();
  readonly #writerIdBySocket = new Map<SocketSession, string>();

  #pending: PendingUpdate[] = [];
  #pendingBytes = 0;
  #flushingBytes = 0;
  #flushTimer: NodeJS.Timeout | null = null;
  #flushing: Promise<void> = Promise.resolve();

  #headSeq: bigint;
  #lastSnapshotSeq: bigint;
  #lastSnapshotAt: number;
  #lastWriter: { principalId: string; token: string } | null = null;

  #idleSince: number | null = null;

  /**
   * True while a flush is appending: the resident document then holds updates the log does not
   * have a sequence for yet, so it is not a state any snapshot may describe.
   */
  #appending = false;

  /** How long the next retry waits after a failed append. Zero while appends are succeeding. */
  #retryDelayMs = 0;

  /**
   * A snapshot the cadence did not ask for but the last reader leaving did.
   *
   * Set on the detach that empties the room and cleared by the next flush. It exists because a
   * snapshot is not only an optimisation any more: it is what publishes the document's outgoing
   * links and its searchable text, and both are things a person expects to be true the moment
   * they stop typing rather than whenever the two-hundred-update counter next rolls over.
   */
  #snapshotWhenIdle = false;

  /** Awareness changes are coalesced onto a short tick rather than fanned out per message. */
  readonly #awarenessDirty = new Set<number>();
  #awarenessTimer: NodeJS.Timeout | null = null;

  /** Each socket's presence budget for the current second. */
  readonly #awarenessBudget = new Map<SocketSession, { second: number; count: number }>();

  /** Which rate windows each socket has been refused in; three distinct ones is abuse. */
  readonly #abusedWindows = new Map<SocketSession, Set<number>>();
  readonly #rateResyncs = new Map<SocketSession, ReturnType<typeof setTimeout>>();

  #encodedBase: number;
  #bytesSinceEncode = 0;

  /** Created once the document is big enough for copying it per update to hurt. */
  #mirror: CandidateMirror | null = null;

  private constructor(
    itemId: string,
    docRow: ContentDocRow,
    scope: { tenantId: string; principalId: string },
    doc: Y.Doc,
    context: SessionContext,
    strategy: BodyKindStrategy,
  ) {
    this.itemId = itemId;
    this.docRow = docRow;
    this.tenantId = scope.tenantId;
    this.#loadedBy = scope.principalId;
    this.strategy = strategy;
    this.#doc = doc;
    this.#context = context;
    this.#headSeq = BigInt(docRow.head_seq);
    this.#lastSnapshotSeq = this.#headSeq;
    this.#lastSnapshotAt = this.now();
    this.#encodedBase = Y.encodeStateAsUpdate(doc).byteLength;
    this.#awareness = new awarenessProtocol.Awareness(doc);
    // The server itself has no cursor; holding a local state would advertise a phantom
    // participant to every client.
    this.#awareness.setLocalState(null);

    this.#doc.on('update', (update: Uint8Array, origin: unknown) => {
      this.#onDocUpdate(update, origin);
    });

    this.#awareness.on(
      'update',
      (change: { added: number[]; updated: number[]; removed: number[] }, origin: unknown) => {
        this.#onAwarenessUpdate(change, origin);
      },
    );
  }

  /** Loads the document once - snapshot plus tail - and holds it. */
  static async load(
    itemId: string,
    docRow: ContentDocRow,
    scope: { tenantId: string; principalId: string },
    context: SessionContext,
    strategy: BodyKindStrategy = noteStrategy,
  ): Promise<DocumentSession> {
    const doc = await withTenantScope(context.pool, scope, (sql) =>
      loadDocument(sql, scope.tenantId, docRow),
    );

    return new DocumentSession(itemId, docRow, scope, doc, context, strategy);
  }

  get state(): LifecycleState {
    return this.#state;
  }

  get socketCount(): number {
    return this.#sockets.size;
  }

  /** When the last socket left, or null while any is attached. The eviction clock. */
  get idleSince(): number | null {
    return this.#idleSince;
  }

  /**
   * Roughly how many bytes this document holds resident: the encoded state at the last
   * snapshot plus every update applied since, with pending or currently flushing log bytes
   * counted separately because both copies remain resident. An estimate on purpose - counting
   * real heap would cost more than the number is worth - and always an overestimate, which is the
   * safe direction for a capacity decision.
   */
  get estimatedBytes(): number {
    return (
      this.#encodedBase +
      this.#bytesSinceEncode +
      this.#mirrorBytes() +
      this.#pendingBytes +
      this.#flushingBytes
    );
  }

  /** The mirror is a second copy of the document, and is counted as one. */
  #mirrorBytes(): number {
    return this.#mirror === null ? 0 : this.#encodedBase + this.#bytesSinceEncode;
  }

  #scratch(): CandidateMirror | undefined {
    if (this.#mirror === null) {
      const from = this.#context.config.mirrorFromBytes ?? MIRROR_FROM_BYTES;
      if (this.#encodedBase + this.#bytesSinceEncode < from) {
        return undefined;
      }
      // Reserved before it is built: a mirror is a second copy of the document, and building it
      // first would let it exist uncounted - or be refused only after it had been paid for. Near
      // capacity, judging against a throwaway copy is the slower answer that fits.
      if (
        this.#context.resizeResident?.(
          this,
          this.estimatedBytes + this.#encodedBase + this.#bytesSinceEncode,
        ) === false
      ) {
        return undefined;
      }
      this.#mirror = new CandidateMirror(this.#doc);
    }
    return this.#mirror;
  }

  /**
   * Who last wrote, and with which credential - what the touched notification acts as.
   * Null until somebody writes; a flush with no writer notifies nobody.
   */
  get lastWriter(): { principalId: string; token: string } | null {
    return this.#lastWriter;
  }

  /** Attaches a socket. Arriving during a drain cancels it - reconnect wins. */
  attach(socket: SocketSession): void {
    this.#state = 'active';
    this.#idleSince = null;
    this.#sockets.add(socket);
    this.#clientIdsBySocket.set(socket, new Set());
    this.#writerIdBySocket.set(socket, `ws:${randomUUID()}`);
  }

  /**
   * Starts sync with a socket that has been told it is ready: sends sync step 1, and the
   * current awareness roster so a joiner sees who is present before anyone next moves.
   */
  beginSync(socket: SocketSession): void {
    const encoder = encoding.createEncoder();
    encoding.writeVarUint(encoder, MESSAGE_SYNC);
    syncProtocol.writeSyncStep1(encoder, this.#doc);
    this.#send(socket, encoding.toUint8Array(encoder));

    const states = this.#awareness.getStates();
    if (states.size > 0) {
      const awarenessEncoder = encoding.createEncoder();
      encoding.writeVarUint(awarenessEncoder, MESSAGE_AWARENESS);
      encoding.writeVarUint8Array(
        awarenessEncoder,
        awarenessProtocol.encodeAwarenessUpdate(this.#awareness, [...states.keys()]),
      );
      this.#send(socket, encoding.toUint8Array(awarenessEncoder));
    }
  }

  /** Routes one binary frame from an attached socket. */
  handleMessage(socket: SocketSession, data: Uint8Array): void {
    const frame = readBinaryFrame(data);
    if (frame === null) {
      return;
    }

    switch (frame.messageType) {
      case MESSAGE_SYNC:
        this.#handleSync(socket, frame.decoder);
        return;
      case MESSAGE_AWARENESS:
        try {
          const update = decoding.readVarUint8Array(frame.decoder);
          // Presence is relayed to every socket here, so its size and its rate are everyone's
          // cost. Over either, the message is dropped: the next one carries the full state anyway.
          if (
            update.byteLength > LIMITS.awarenessBytes ||
            !this.#spendAwareness(socket) ||
            !this.#mayClaimPresence(socket, update)
          ) {
            return;
          }
          awarenessProtocol.applyAwarenessUpdate(this.#awareness, update, socket);
        } catch {
          // A malformed awareness payload costs its sender their cursor, nothing more.
        }
        return;
      case MESSAGE_PERSISTED:
        // A failed flush is logged by `flush` and leaves the barrier unanswered, which is the
        // honest reply: the client keeps its edits and asks again.
        this.#persistBarrier(socket, frame.decoder).catch(() => undefined);
        return;
      default:
        return;
    }
  }

  async #persistBarrier(socket: SocketSession, decoder: decoding.Decoder): Promise<void> {
    let barrierId: string;
    try {
      barrierId = decoding.readVarString(decoder);
    } catch {
      return;
    }
    if (barrierId.length === 0 || barrierId.length > 100) return;
    await this.flush();
    if (this.#sockets.has(socket) && socket.socket.readyState === 1) {
      this.#send(socket, encodePersisted(barrierId));
    }
  }

  #handleSync(socket: SocketSession, decoder: decoding.Decoder): void {
    let messageType: number;
    try {
      messageType = decoding.readVarUint(decoder);
    } catch {
      this.#refuse(socket, rejection('update_unreadable', 'The frame is not a sync message.'));
      return;
    }

    if (messageType === syncProtocol.messageYjsSyncStep1) {
      // A read: the client announces its state vector and receives what it is missing.
      // Readers and writers alike may ask.
      const encoder = encoding.createEncoder();
      encoding.writeVarUint(encoder, MESSAGE_SYNC);
      try {
        syncProtocol.readSyncStep1(decoder, encoder, this.#doc);
      } catch {
        this.#refuse(socket, rejection('update_unreadable', 'The state vector does not decode.'));
        return;
      }
      this.#send(socket, encoding.toUint8Array(encoder));
      return;
    }

    if (
      messageType !== syncProtocol.messageYjsSyncStep2 &&
      messageType !== syncProtocol.messageYjsUpdate
    ) {
      return;
    }

    // Everything below carries writes, and every §17 row is checked before the resident
    // document is touched - a refused update leaves no trace to roll back.
    if (socket.mode !== 'write') {
      this.#refuse(socket, rejection('read_only', 'You may read this document but not change it.'));
      return;
    }

    let update: Uint8Array;
    try {
      update = decoding.readVarUint8Array(decoder);
    } catch {
      if (!this.#overRateLimit(socket))
        this.#refuse(socket, rejection('update_unreadable', 'The payload is not a Yjs update.'));
      return;
    }

    // An empty sync-step reply is a handshake, not an edit. Validating it against
    // a new, uninitialized note would refuse it and request the same reply forever.
    if (update.byteLength === 2 && update[0] === 0 && update[1] === 0) return;
    if (this.#overRateLimit(socket)) return;

    if (update.byteLength > LIMITS.updateBytes) {
      this.#context.log?.(
        `Refused an oversized update (${String(update.byteLength)} bytes) from principal ` +
          `${socket.authorization.principalId} on item ${this.itemId}.`,
      );
      this.#refuse(
        socket,
        rejection(
          'update_too_large',
          `An update may be at most ${String(LIMITS.updateBytes)} bytes; this one is ` +
            `${String(update.byteLength)}.`,
        ),
      );
      return;
    }

    const scratch = this.#scratch();
    const verdict = judgeCandidate(this.#doc, update, {
      strategy: this.strategy,
      pin: this.docRow.schema_version,
      scratch,
      diagnose: (reason) => {
        this.#context.log?.(
          `A ${this.strategy.kind} update from principal ` +
            `${socket.authorization.principalId} on item ${this.itemId} in tenant ` +
            `${this.tenantId} would not parse: ${reason}`,
        );
      },
    });
    if (!verdict.ok) {
      // The detail carries the two numbers that explain a pin refusal - what the merged
      // document needed and what the pin is - and without them nobody reading this log during a
      // deploy window can tell that the answer is "run the document migration".
      this.#context.log?.(
        `Refused an update (${verdict.refusal.code}) from principal ` +
          `${socket.authorization.principalId} on item ${this.itemId} in tenant ` +
          `${this.tenantId}: ${verdict.refusal.detail}`,
      );
      this.#refuse(socket, verdict.refusal);
      if (verdict.resync) {
        // The client's local state now diverges from the document the server will keep
        // serving. A fresh sync step 1 forces it to reconcile against reality instead of
        // silently editing a document nobody else has.
        this.beginSync(socket);
      }
      return;
    }

    // An accepted update lives twice until it is flushed: once in Yjs's resident history and
    // once in the pending persistence queue. This is the same deliberately conservative estimate
    // exposed by `estimatedBytes`, projected before mutating the document.
    const copies = this.#mirror === null ? 2 : 3;
    const projectedBytes = this.estimatedBytes + verdict.persistedUpdateBytes * copies;
    if (this.#context.resizeResident?.(this, projectedBytes) === false) {
      this.#context.log?.(
        `Refused an update from principal ${socket.authorization.principalId} on item ` +
          `${this.itemId}: applying it would exceed this server's resident-memory capacity.`,
      );
      // The server has not applied the update, while the client still holds it locally. Closing
      // with the capacity code makes reconnect-and-resend the recovery path; keeping the socket
      // open would leave the two documents diverged with no honest acknowledgement available.
      this.detach(socket);
      socket.socket.close(
        CLOSE_CODES.atCapacity,
        'This server is at its resident-memory capacity. Retry shortly.',
      );
      return;
    }

    try {
      if (verdict.repair) {
        this.#applyWithRepair(socket, update);
      } else {
        Y.applyUpdate(this.#doc, update, socket);
        // The mirror took this same update to judge it, so the two are equal again. A repair, a
        // refusal or anything else that returns before here leaves it out of step, and it is
        // rebuilt on the next candidate.
        scratch?.settle();
      }
    } catch (cause) {
      // A judged Yjs update is deterministic, so this is a bug path. Restore the byte account
      // before surfacing it; otherwise one bad frame permanently consumes process capacity.
      this.#context.resizeResident?.(this, this.estimatedBytes);
      throw cause;
    }
  }

  /**
   * Applies an update that would have left the document under its structural floor, and puts the
   * floor back with it.
   *
   * **One transaction, and the origin is the socket, and both facts are load-bearing.** One
   * transaction, because Yjs emits a single update for it: the document is never observable
   * between the emptying and the mend, so nothing can flush, broadcast or snapshot the state that
   * would not parse. The socket as origin, because `#onDocUpdate` only queues an update for the
   * log when its origin is an attached socket - a server-invented origin would broadcast the mend
   * and never persist it, and the document would come back empty on the next load, which is the
   * bug this exists to close wearing a longer fuse.
   *
   * Attributing the mend to the principal whose update caused it is also the honest record: their
   * edit is what took the document to the floor, and the log should say so rather than invent a
   * second author.
   */
  #applyWithRepair(socket: SocketSession, update: Uint8Array): void {
    const before = Y.encodeStateVector(this.#doc);

    this.#doc.transact(() => {
      Y.applyUpdate(this.#doc, update, socket);
      this.strategy.repair?.(this.#doc);
    }, socket);

    // The broadcast in `#onDocUpdate` skips the origin, on the sound assumption that a client
    // already has what it just sent. That assumption is exactly false here: the mend is the one
    // part of this transaction the sender does not have, and without it the sender goes on
    // editing a document with no block in it and every later update is refused again. So the
    // delta since the state vector taken above goes back to it specifically - the mend, plus its
    // own update, which merges idempotently and costs nothing to re-receive.
    const encoder = encoding.createEncoder();
    encoding.writeVarUint(encoder, MESSAGE_SYNC);
    syncProtocol.writeUpdate(encoder, Y.encodeStateAsUpdate(this.#doc, before));
    this.#send(socket, encoding.toUint8Array(encoder));

    this.#context.log?.(
      `Repaired an emptied ${this.strategy.kind} document from principal ` +
        `${socket.authorization.principalId} on item ${this.itemId} in tenant ` +
        `${this.tenantId}: the merge left it under the schema's structural floor, so the floor ` +
        'was restored and the update accepted rather than refused.',
    );
  }

  /**
   * Sends to one socket, unless it has fallen too far behind to be worth sending to.
   *
   * `ws` queues whatever the network has not taken yet, without limit. A tab on a dead link, or a
   * client that stopped reading, would accumulate every broadcast for as long as its socket stays
   * open. Past the bound it is closed instead; reconnecting syncs it from the document, so what it
   * missed is not lost.
   */
  #send(socket: SocketSession, data: Uint8Array): void {
    if (socket.socket.bufferedAmount > LIMITS.socketBufferedBytes) {
      this.cutOff(socket);
      return;
    }
    socket.socket.send(data);
  }

  /** Each attached socket with what it has queued and not yet sent. For the process-wide bound. */
  backlogs(): { socket: SocketSession; bytes: number }[] {
    return [...this.#sockets].map((socket) => ({ socket, bytes: socket.socket.bufferedAmount }));
  }

  /**
   * Disconnects a socket that has fallen behind. Reconnecting syncs it from the document, so what
   * it had not yet received is not lost.
   */
  cutOff(socket: SocketSession): void {
    if (!this.#sockets.has(socket)) {
      return;
    }
    this.#context.log?.(
      `Closing a socket that fell behind (${String(socket.socket.bufferedAmount)} bytes ` +
        `unsent): principal ${socket.authorization.principalId} on item ${this.itemId}.`,
    );
    this.detach(socket);
    socket.socket.close(CLOSE_CODES.tooSlow, 'Too far behind. Reconnect to catch up.');
    // Terminated as well: a close frame queues behind everything the reader is not reading, and
    // the backlog this exists to free would be held until ws's own close timeout.
    socket.socket.terminate();
  }

  /**
   * Whether every presence identity in `update` is this socket's to set: one it already holds, or a
   * new one within its allowance. An identity another socket holds is refused, so no client can
   * move or erase somebody else's cursor.
   */
  #mayClaimPresence(socket: SocketSession, update: Uint8Array): boolean {
    const owned = this.#clientIdsBySocket.get(socket);
    if (owned === undefined) {
      return false;
    }
    try {
      const decoder = decoding.createDecoder(update);
      const entries = decoding.readVarUint(decoder);
      let claimed = owned.size;
      for (let index = 0; index < entries; index += 1) {
        const clientId = decoding.readVarUint(decoder);
        decoding.readVarUint(decoder);
        decoding.readVarString(decoder);
        if (owned.has(clientId)) {
          continue;
        }
        for (const [other, ids] of this.#clientIdsBySocket) {
          if (other !== socket && ids.has(clientId)) {
            return false;
          }
        }
        claimed += 1;
        if (claimed > LIMITS.awarenessClientsPerSocket) {
          return false;
        }
      }
      return true;
    } catch {
      return false;
    }
  }

  #spendAwareness(socket: SocketSession): boolean {
    const second = Math.floor(this.now() / 1000);
    const budget = this.#awarenessBudget.get(socket);
    if (budget?.second !== second) {
      this.#awarenessBudget.set(socket, { second, count: 1 });
      return true;
    }
    budget.count += 1;
    return budget.count <= LIMITS.awarenessPerSecond;
  }

  #refuse(socket: SocketSession, refusal: Rejection): void {
    this.#send(socket, encodeNotice(refusal));
  }

  /**
   * The backpressure ladder: over the window, each write is refused with a notice; a
   * principal who keeps pushing through three separate windows of refusals has a broken
   * client, not a busy one, and the socket closes.
   */
  #overRateLimit(socket: SocketSession): boolean {
    const rateWindow = this.#context.rateWindow;
    if (rateWindow === undefined) {
      return false;
    }

    if (!rateWindow.exceeded(socket.authorization.principalId, this.docRow.doc_id)) {
      return false;
    }

    // Distinct windows, pruned rather than cleared: a busy-loop client still gets some
    // messages through at each window's start, and forgiving the abuse for that would
    // mean never closing on exactly the client this exists for.
    const currentWindow = Math.floor(this.now() / LIMITS.windowMs);
    const windows = this.#abusedWindows.get(socket) ?? new Set<number>();
    this.#abusedWindows.set(socket, windows);
    windows.add(currentWindow);
    for (const window of windows) {
      if (window <= currentWindow - 3) {
        windows.delete(window);
      }
    }

    if (windows.size >= 3) {
      this.#context.log?.(
        `Closing a socket for sustained rate abuse: principal ` +
          `${socket.authorization.principalId} on item ${this.itemId}.`,
      );
      socket.socket.close(CLOSE_CODES.rateKilled, 'Sustained rate abuse.');
      return true;
    }

    this.#refuse(
      socket,
      rejection(
        'rate_limited',
        `At most ${String(LIMITS.updatesPerWindow)} updates per document per minute.`,
      ),
    );

    // The refused update is dropped, so this client now holds an edit the server does not and
    // nothing would ever re-send it - the socket stays open, and Yjs only re-reconciles on a
    // fresh sync. A sync step 1 is what makes the client notice and send it again, which turns
    // silent loss into a delay. Without it a person over the limit watches their work stay on
    // screen and finds it gone on reload.
    // One resync per socket, sent when the window resets: an immediate one is answered with the
    // same over-limit edit, refused again, and resynced again at network speed.
    if (!this.#rateResyncs.has(socket)) {
      const wait = rateWindow.msUntilReset(socket.authorization.principalId, this.docRow.doc_id);
      this.#rateResyncs.set(
        socket,
        setTimeout(() => {
          this.#rateResyncs.delete(socket);
          if (this.#sockets.has(socket)) this.beginSync(socket);
        }, wait),
      );
    }
    return true;
  }

  #onDocUpdate(update: Uint8Array, origin: unknown): void {
    this.#bytesSinceEncode += update.byteLength;

    const encoder = encoding.createEncoder();
    encoding.writeVarUint(encoder, MESSAGE_SYNC);
    syncProtocol.writeUpdate(encoder, update);
    const message = encoding.toUint8Array(encoder);

    for (const socket of this.#sockets) {
      if (socket !== origin) {
        this.#send(socket, message);
      }
    }

    if (!this.#isAttachedSocket(origin)) {
      return;
    }

    this.#pending.push({
      bytes: update,
      principalId: origin.authorization.principalId,
      clientId: this.#writerIdBySocket.get(origin) ?? 'ws:unknown',
    });
    this.#pendingBytes += update.byteLength;
    this.#lastWriter = { principalId: origin.authorization.principalId, token: origin.token };

    if (this.#retryDelayMs > 0) {
      // The log is refusing appends. Typing must not turn the backoff into a flush per keystroke.
      this.scheduleFlush(this.#retryDelayMs);
    } else if (this.#pendingBytes >= this.#context.config.flushBytes) {
      this.scheduleFlush(0);
    } else {
      this.scheduleFlush(this.#context.config.flushMs);
    }
  }

  #isAttachedSocket(origin: unknown): origin is SocketSession {
    return this.#sockets.has(origin as SocketSession);
  }

  #onAwarenessUpdate(
    change: { added: number[]; updated: number[]; removed: number[] },
    origin: unknown,
  ): void {
    const changed = [...change.added, ...change.updated, ...change.removed];

    if (this.#isAttachedSocket(origin)) {
      const owned = this.#clientIdsBySocket.get(origin);
      if (owned !== undefined) {
        for (const id of change.added) {
          owned.add(id);
        }
        for (const id of change.removed) {
          owned.delete(id);
        }
      }
    }

    for (const id of changed) {
      this.#awarenessDirty.add(id);
    }

    // Coalesced: with a hundred editors, per-message fan-out is editors-squared traffic,
    // and a cursor that moves fifty times in fifty milliseconds is one move to a reader.
    this.#awarenessTimer ??= setTimeout(() => {
      this.#awarenessTimer = null;
      this.#broadcastAwareness();
    }, 50);
  }

  #broadcastAwareness(): void {
    if (this.#awarenessDirty.size === 0 || this.#sockets.size === 0) {
      this.#awarenessDirty.clear();
      return;
    }

    const encoder = encoding.createEncoder();
    encoding.writeVarUint(encoder, MESSAGE_AWARENESS);
    encoding.writeVarUint8Array(
      encoder,
      awarenessProtocol.encodeAwarenessUpdate(this.#awareness, [...this.#awarenessDirty]),
    );
    const message = encoding.toUint8Array(encoder);
    this.#awarenessDirty.clear();

    for (const socket of this.#sockets) {
      this.#send(socket, message);
    }
  }

  /** Schedules a flush no later than `inMs` from now, keeping any earlier deadline. */
  scheduleFlush(inMs: number): void {
    if (this.#pending.length === 0) {
      return;
    }
    if (inMs <= 0) {
      if (this.#flushTimer !== null) {
        clearTimeout(this.#flushTimer);
        this.#flushTimer = null;
      }
      this.#flushInBackground();
      return;
    }
    this.#flushTimer ??= setTimeout(() => {
      this.#flushTimer = null;
      this.#flushInBackground();
    }, inMs);
  }

  /**
   * Flushes the pending queue to the log, one transaction per same-principal run.
   *
   * The queue is split into maximal runs of one principal because `actor_id` is a per-row
   * fact and the tenant scope names one principal per transaction - and order must hold,
   * so runs flush sequentially, never in parallel. At a 500 ms window a queue is almost
   * always a single run, so the batching survives the honesty.
   */
  async flush(): Promise<void> {
    await this.#exclusive(async () => {
      try {
        const queue = this.#pending;
        if (queue.length === 0) {
          // An empty queue does not mean nothing is owed. The last reader leaving asks for a
          // snapshot whatever the cadence says, and by then the queue is almost always already
          // empty - the 500 ms timer will have drained it seconds before the tab closed. Returning
          // here unconditionally, as this did, is what would leave a document's links and its
          // searchable text unpublished until the session was evicted five minutes later.
          await this.#maybeSnapshot();
          return;
        }
        this.#pending = [];
        const queueBytes = this.#pendingBytes;
        this.#pendingBytes = 0;
        this.#flushingBytes += queueBytes;
        this.#context.resizeResident?.(this, this.estimatedBytes);
        if (this.#flushTimer !== null) {
          clearTimeout(this.#flushTimer);
          this.#flushTimer = null;
        }

        const started = this.now();

        let appendedCount = 0;
        this.#appending = true;
        try {
          for (const run of principalRuns(queue)) {
            const { lastSeq } = await withTenantScope(
              this.#context.pool,
              { tenantId: this.tenantId, principalId: run.principalId },
              async (sql) => {
                const appended = await appendUpdates(sql, {
                  tenantId: this.tenantId,
                  docId: this.docRow.doc_id,
                  updates: run.updates,
                  actorId: run.principalId,
                });
                // Sequences between the head this session knew and the first one just allocated
                // were written by somebody else. They must be in memory before the head moves past
                // them: a snapshot labelled with the new head and built without them would make
                // every later load skip them.
                await this.#applyLogged(sql, this.#headSeq, appended.firstSeq - 1n);
                return appended;
              },
            );
            this.#headSeq = lastSeq;
            appendedCount += run.updates.length;
            this.#context.metrics?.updatesAppendedTotal.inc(run.updates.length);
          }
        } catch (cause) {
          this.#requeue(queue.slice(appendedCount));
          throw cause;
        } finally {
          this.#appending = false;
        }
        this.#retryDelayMs = 0;

        await this.#maybeSnapshot();

        this.#context.metrics?.flushSeconds.observe((this.now() - started) / 1000);
        this.#context.onFlushed?.(this);
      } finally {
        // The local queue remains strongly referenced throughout the database append. It leaves
        // the process-wide byte account only here, not when it moves out of `#pending` above.
        if (this.#flushingBytes > 0) {
          this.#flushingBytes = 0;
          this.#context.resizeResident?.(this, this.estimatedBytes);
        }
      }
    });
  }

  /**
   * Puts updates whose append failed back at the front of the queue, in order, and schedules the
   * retry.
   *
   * They are already in the resident document and already broadcast, so dropping them - which is
   * what leaving them out of the queue did - kept them on every screen and out of the log: a crash
   * before the next snapshot lost them, and the log stopped describing the document. Runs appended
   * before the failure are committed and are not requeued.
   */
  #requeue(updates: readonly PendingUpdate[]): void {
    if (updates.length === 0 || this.#state === 'unloaded') {
      return;
    }
    this.#pending = [...updates, ...this.#pending];
    for (const update of updates) {
      this.#pendingBytes += update.bytes.byteLength;
    }
    this.#context.metrics?.flushFailuresTotal.inc();
    // Backing off: a database that refused this append is unlikely to accept the same one a
    // flush window later, and a tight loop of failing transactions makes its recovery harder.
    this.#retryDelayMs = Math.min(
      MAX_RETRY_DELAY_MS,
      Math.max(this.#context.config.flushMs, this.#retryDelayMs * 2),
    );
    this.scheduleFlush(this.#retryDelayMs);
  }

  /**
   * A flush nobody waits for: a timer's, or the last reader leaving. Its failure is reported here
   * and recovered by the retry `#requeue` scheduled, never left to reject unhandled - which would
   * end the process, and every other document resident in it.
   */
  #flushInBackground(): void {
    this.flush().catch((cause: unknown) => {
      this.#context.log?.(
        `Could not flush item ${this.itemId} in tenant ${this.tenantId}; retrying in ` +
          `${String(this.#retryDelayMs)} ms: ${describe(cause)}`,
      );
    });
  }

  /**
   * Brings the resident document up to the log's head: applies, and broadcasts, every update
   * another writer appended since this session last touched the log.
   *
   * Called after a REST write or a restore lands for a document that is open here, so the people
   * editing it see the change now rather than after reloading. Serialised with flushes, which
   * read and advance the same head.
   */
  async catchUp(): Promise<void> {
    if (this.#state === 'unloaded') {
      return;
    }
    await this.#exclusive(async () => {
      if (this.#state === 'unloaded') {
        return;
      }
      await withTenantScope(
        this.#context.pool,
        { tenantId: this.tenantId, principalId: this.#loadedBy },
        (sql) => this.#applyLogged(sql, this.#headSeq, null),
      );
    });
  }

  /**
   * Applies the logged updates after `afterSeq`, up to and including `throughSeq` (or the end of
   * the log when null), and moves the head to the last one applied.
   *
   * They are persisted already, so they are applied under {@link LOG_ORIGIN}: every socket
   * receives them and the pending queue does not. Yjs merges idempotently, so an update the
   * resident state already holds - one the load replayed past its recorded head - costs nothing.
   */
  async #applyLogged(sql: ScopedQuery, afterSeq: bigint, throughSeq: bigint | null): Promise<void> {
    let from = afterSeq;
    for (;;) {
      if (throughSeq !== null && from >= throughSeq) {
        break;
      }
      const page = await updatesAfter(sql, this.tenantId, this.docRow.doc_id, from, CATCH_UP_LIMIT);
      const wanted =
        throughSeq === null ? page : page.filter((row) => BigInt(row.seq) <= throughSeq);
      if (wanted.length > 0) {
        this.#doc.transact(() => {
          for (const row of wanted) {
            Y.applyUpdate(this.#doc, new Uint8Array(row.update_bytes), LOG_ORIGIN);
          }
        }, LOG_ORIGIN);
      }
      const last = wanted[wanted.length - 1];
      if (last !== undefined) {
        from = BigInt(last.seq);
        if (from > this.#headSeq) {
          this.#headSeq = from;
        }
      }
      if (wanted.length < CATCH_UP_LIMIT) {
        break;
      }
    }
    // Already durable, so never refused: the account has to describe what is resident.
    this.#context.resizeResident?.(this, this.estimatedBytes, true);
  }

  /** Runs log I/O one piece at a time: flushes and catch-ups read and advance the same head. */
  async #exclusive(work: () => Promise<void>): Promise<void> {
    const previous = this.#flushing;
    let release: () => void = () => undefined;
    this.#flushing = new Promise((resolve) => {
      release = resolve;
    });
    await previous;
    try {
      await work();
    } finally {
      release();
    }
  }

  async #maybeSnapshot(): Promise<void> {
    const due =
      this.#snapshotWhenIdle ||
      this.#headSeq - this.#lastSnapshotSeq >= BigInt(this.#context.config.snapshotEvery) ||
      (this.#headSeq > this.#lastSnapshotSeq &&
        this.now() - this.#lastSnapshotAt >= this.#context.config.snapshotIntervalMs);

    if (!due) {
      return;
    }

    // Cleared only once the write has actually been attempted. `#snapshotNow` does real I/O, and
    // clearing first meant a transient database error lost the request outright - on an idle
    // document `headSeq` never moves again, so "eventually" would have meant "at eviction".
    // Declining because the log has not moved is different, and is answered: that is a request
    // with nothing to do.
    let deferred = false;
    try {
      deferred = (await this.#snapshotNow()) === 'deferred';
    } finally {
      // A deferred request stays asked for: the pending updates that deferred it schedule the
      // flush that comes back here.
      if (!deferred) {
        this.#snapshotWhenIdle = false;
      }
    }
  }

  /**
   * Writes a snapshot of the log up to the current head, or answers `'deferred'` when the resident
   * document is ahead of the log and so cannot be one.
   *
   * **The state is frozen before the first await.** A snapshot labelled `seq` claims to be the log
   * up to `seq`. The resident document holds more than that whenever an update is queued or being
   * appended, and it keeps changing while the write below waits for a connection. Encoding it then
   * would store edits the log may never receive - content no replay of the log can produce, which
   * breaks the rule that snapshots are rebuildable from it.
   */
  async #snapshotNow(): Promise<'written' | 'skipped' | 'deferred'> {
    const principal = this.#lastWriter?.principalId ?? null;
    if (principal === null || this.#headSeq <= this.#lastSnapshotSeq) {
      return 'skipped';
    }
    if (this.#pending.length > 0 || this.#appending) {
      return 'deferred';
    }

    const seq = this.#headSeq;
    const frozen = new Y.Doc();
    Y.applyUpdate(frozen, Y.encodeStateAsUpdate(this.#doc));
    let written: boolean;
    try {
      written = await withTenantScope(
        this.#context.pool,
        { tenantId: this.tenantId, principalId: principal },
        (sql) =>
          writeSnapshotNow(sql, {
            tenantId: this.tenantId,
            docId: this.docRow.doc_id,
            itemId: this.docRow.item_id,
            seq,
            state: frozen,
            strategy: this.strategy,
          }),
      );
    } finally {
      frozen.destroy();
    }

    if (written) {
      this.#lastSnapshotSeq = seq;
      this.#lastSnapshotAt = this.now();
      this.#encodedBase = Y.encodeStateAsUpdate(this.#doc).byteLength;
      this.#bytesSinceEncode = 0;
      this.#context.resizeResident?.(this, this.estimatedBytes);
    }
    return written ? 'written' : 'skipped';
  }

  /** Detaches a socket; the last one out flushes immediately and starts the idle clock. */
  detach(socket: SocketSession): void {
    if (!this.#sockets.delete(socket)) {
      return;
    }

    const owned = this.#clientIdsBySocket.get(socket);
    this.#clientIdsBySocket.delete(socket);
    this.#writerIdBySocket.delete(socket);
    this.#abusedWindows.delete(socket);
    clearTimeout(this.#rateResyncs.get(socket));
    this.#rateResyncs.delete(socket);
    this.#awarenessBudget.delete(socket);
    if (owned !== undefined && owned.size > 0) {
      awarenessProtocol.removeAwarenessStates(this.#awareness, [...owned], null);
    }

    if (this.#sockets.size === 0) {
      this.#idleSince = this.now();
      // Only socket updates are judged against the mirror. A document nobody is editing would
      // otherwise hold twice its memory until eviction; the next editor rebuilds it on first use.
      if (this.#mirror !== null) {
        this.#mirror.destroy();
        this.#mirror = null;
        this.#context.resizeResident?.(this, this.estimatedBytes);
      }
      // A snapshot is what publishes a document's link edges and its searchable text, so the
      // moment the last person stops editing is exactly when they are owed. Without this the
      // cadence decides - every two hundred updates or every five minutes - and somebody who
      // writes a link and closes the tab watches the backlinks panel stay empty for both.
      this.#snapshotWhenIdle = true;

      // `flush` directly, not `scheduleFlush(0)`, and the difference is the whole fix.
      // `scheduleFlush` returns immediately when the pending queue is empty - which is right for
      // what it was written for, and wrong here: by the time the last tab closes the 500 ms timer
      // has almost always already drained the queue, so the snapshot this asks for was never
      // reached. Flush on disconnect is one of the three §17 triggers, and it still is; it now
      // also carries the snapshot request, and `flush` handles an empty queue itself.
      this.#flushInBackground();
    }
  }

  /**
   * Drains: final flush, snapshot, and - if nobody reconnected while that ran - unload.
   *
   * Returns true when the session reached `unloaded` and may be discarded. False means a
   * reconnect cancelled the drain and the session is active again, which is the state
   * diagram's `draining --> active` edge.
   */
  async drain(): Promise<boolean> {
    this.#state = 'draining';

    try {
      await this.flush();
      await this.#snapshotNow();
    } catch (cause) {
      // Not unloaded, and not left draining either: the sweep passes over a draining document, so
      // one failed attempt would otherwise pin it in memory for good. Active and idle, the next
      // sweep tries again, and the requeued updates retry on their own clock meanwhile.
      this.#state = 'active';
      throw cause;
    }

    if (this.#sockets.size > 0) {
      this.#state = 'active';
      return false;
    }

    this.#state = 'unloaded';
    if (this.#awarenessTimer !== null) {
      clearTimeout(this.#awarenessTimer);
      this.#awarenessTimer = null;
    }
    if (this.#flushTimer !== null) {
      clearTimeout(this.#flushTimer);
      this.#flushTimer = null;
    }
    this.#awareness.destroy();
    this.#mirror?.destroy();
    this.#mirror = null;
    this.#doc.destroy();
    return true;
  }

  /**
   * Forgets an envelope Core has already deleted. Nothing may be flushed: the database
   * cascade is authoritative, and replaying pending draft updates would only create noise
   * against a body that no longer exists.
   */
  invalidate(): void {
    this.#state = 'unloaded';
    this.#pending = [];
    this.#pendingBytes = 0;
    this.#flushingBytes = 0;
    if (this.#awarenessTimer !== null) {
      clearTimeout(this.#awarenessTimer);
      this.#awarenessTimer = null;
    }
    if (this.#flushTimer !== null) {
      clearTimeout(this.#flushTimer);
      this.#flushTimer = null;
    }
    this.#awareness.destroy();
    this.#mirror?.destroy();
    this.#mirror = null;
    this.#doc.destroy();
  }

  /** Closes every attached socket with a code, for shutdown and lost ownership. */
  closeSockets(code: number, reason: string): void {
    for (const socket of [...this.#sockets]) {
      socket.socket.close(code, reason);
    }
  }

  private now(): number {
    return this.#context.now?.() ?? Date.now();
  }
}

/**
 * What a candidate update is judged against.
 *
 * An options object rather than a tail of defaulted positionals: `ceilings` defaults to the
 * strategy's own, so reaching `pin` past it meant passing the default explicitly at the one
 * call site that needed to - which is the shape that guarantees the next parameter gets
 * appended too.
 */
export interface CandidateJudgement {
  readonly strategy?: BodyKindStrategy;
  readonly ceilings?: { nodes: number; bytes: number };

  /**
   * Where the merged document is built for the main measurement. Defaults to a fresh copy of the
   * resident, thrown away afterwards; a session passes its {@link CandidateMirror} so a large
   * document is not copied for every keystroke. The rarer paths - repair, diagnosis, the ceiling's
   * growth check - always use fresh copies.
   */
  readonly scratch?: CandidateScratch | undefined;

  /** The document's stored `schema_version`. Defaults to what this build speaks. */
  readonly pin?: number;

  /**
   * Told why, when the merged document will not parse.
   *
   * Separate from the refusal the client receives, which stays deliberately vague. This is for
   * the operator log, and without it `document_does_not_parse` names a symptom and nothing else -
   * which is exactly the position somebody is in when a document silently will not save.
   */
  readonly diagnose?: (reason: string) => void;
}

/**
 * What became of a candidate update: apply it, or refuse it - and maybe force a resync.
 *
 * `repair` on the accepting side is the one case where applying the update verbatim is not
 * enough: the merged document fell through its kind's structural floor, and the caller must put
 * the floor back in the same breath as it applies the update. It is reported rather than done
 * here because this function is deliberately free of side effects on the resident document -
 * everything it learns, it learns from throwaway forks.
 */
export type CandidateVerdict =
  | {
      readonly ok: true;
      readonly repair: boolean;
      readonly persistedUpdateBytes: number;
    }
  | { readonly ok: false; readonly refusal: Rejection; readonly resync: boolean };

/**
 * Judges a candidate update against a throwaway fork of the resident document, so a
 * refusal leaves the resident state untouched - the same validate-by-applying stance the
 * HTTP path takes, minus the per-request reload it had to pay for it.
 *
 * The ceiling rule is §17's: a document over its node or byte ceiling refuses growth and
 * allows shrinkage, because the one edit that must always go through on an oversized
 * document is the delete that fixes it. A Yjs update can insert and delete at once, so
 * "growth" is measured on the outcome: over the ceiling *and* bigger than before.
 *
 * The pin rule has no such asymmetry: an update that would take the document past its
 * stored `schema_version` is refused outright, because every client that speaks the pinned
 * version has been promised this document opens, and there is no shrinking edit that a
 * newer node makes necessary.
 */
export function judgeCandidate(
  resident: Y.Doc,
  update: Uint8Array,
  judgement: CandidateJudgement = {},
): CandidateVerdict {
  const strategy = judgement.strategy ?? noteStrategy;
  const ceilings = judgement.ceilings ?? strategy.ceilings;
  const pin = judgement.pin ?? SCHEMA_VERSION;

  const scratch = judgement.scratch ?? freshScratch(resident);
  let fork: Y.Doc;
  try {
    fork = scratch.fork(update);
  } catch (cause) {
    return {
      ok: false,
      refusal: rejection(
        'update_unreadable',
        cause instanceof Error ? cause.message : 'The payload is not a Yjs update.',
      ),
      resync: false,
    };
  }

  let persistedUpdateBytes = update.byteLength;
  let after = strategy.measure(fork);
  scratch.release(fork);

  // The floor, before the refusal. A merged document that holds nothing is the one unparseable
  // outcome a client can reach without having written anything wrong - the Yjs undo manager
  // unwinds below the schema's `block+` minimum, which ProseMirror editing itself cannot do - and
  // refusing it strands the client in a state it cannot edit its way out of. So the floor is put
  // back and the update accepted, rather than the person's edit being dropped.
  //
  // A fresh fork, because measuring consumed the one above for the same reason the diagnosis
  // below rebuilds its own: reading a fragment as prose drops what the schema does not know from
  // the Yjs document itself, so a measured fork can no longer be asked anything. Every fork here
  // is thrown away; the resident is not touched by anything in this function, which is what lets
  // the caller treat a refusal as having left no trace.
  //
  // **Gated on the resident having parsed.** Without that, "the merged document has no blocks"
  // also describes an update belonging to an entirely different body kind - a canvas keeps its
  // scene in a Y.Map and leaves the prose fragment empty - and the backstop would answer a
  // client talking to the wrong document by silently writing it an empty paragraph and accepting
  // the update. Requiring the resident to be a document of this kind already is what makes this
  // "a valid document fell through its floor" rather than "anything that does not parse".
  let repair = false;
  if (after === null && strategy.repair !== undefined && parsesAlone(resident, strategy)) {
    try {
      const mended = forkWith(resident, update);
      try {
        if (strategy.repair(mended)) {
          // Re-measured, never assumed: a repair is honoured only if it actually produced a
          // document this build could open again. Anything else - a fault the floor was not the
          // cause of, a repaired document now over its schema pin - falls through to the refusal
          // with the diagnosis intact, which is the outcome that tells an operator the truth.
          const mendedPersistedUpdateBytes = Y.encodeStateAsUpdate(
            mended,
            Y.encodeStateVector(resident),
          ).byteLength;
          const mendedMeasurement = strategy.measure(mended);
          if (mendedMeasurement !== null) {
            after = mendedMeasurement;
            repair = true;
            persistedUpdateBytes = mendedPersistedUpdateBytes;
          }
        }
      } finally {
        mended.destroy();
      }
    } catch {
      // A failed repair attempt is not a second failure mode to report; it simply means the
      // update stays refused, which is what it already was.
    }
  }

  if (after === null) {
    // A second fork, built from the same two inputs, because measuring consumed the first: reading
    // a fragment as prose drops the nodes the schema does not know, so the fork can no longer say
    // what was in it. The resident is untouched - only the fork was measured - so rebuilding is
    // exact, and it costs nothing on the path where an update is accepted.
    if (judgement.diagnose !== undefined && strategy.explain !== undefined) {
      const pristine = new Y.Doc();
      try {
        Y.applyUpdate(pristine, Y.encodeStateAsUpdate(resident));
        Y.applyUpdate(pristine, update);
        const reason = strategy.explain(pristine);

        // And what the update carried *on its own*, which the merged reading cannot show. A client
        // sending a well-formed document into an empty one and a client sending nothing at all
        // both produce an empty merge, and they are opposite problems: the first means the server
        // is losing something, the second means the client never had it.
        const alone = new Y.Doc();
        let carried = 'unreadable';
        try {
          Y.applyUpdate(alone, update);
          carried = strategy.explain(alone) === null ? 'a document that parses' : 'nothing usable';
        } catch {
          carried = 'an update that does not decode';
        } finally {
          alone.destroy();
        }

        if (reason !== null) {
          judgement.diagnose(`${reason}; the update by itself carried ${carried}`);
        }
      } catch {
        // The diagnosis is a courtesy; failing to produce one must not change the verdict.
      } finally {
        pristine.destroy();
      }
    }
    return {
      ok: false,
      refusal: rejection(
        'document_does_not_parse',
        'Applying this update would produce a document the schema rejects.',
      ),
      resync: true,
    };
  }

  if (after.schemaVersion > pin) {
    return {
      ok: false,
      refusal: rejection(
        'document_above_schema_pin',
        `This update would need schema version ${String(after.schemaVersion)} to open, and ` +
          `the document is pinned to ${String(pin)}. Refusing to write a document older ` +
          'clients have been told they can read. Run the document schema migration first.',
      ),
      // No resync. The client's local state is not wrong - this build would happily keep it -
      // so forcing it to reconcile against the server would discard a legitimate edit and
      // teach the person nothing. The refusal notice is the honest answer.
      resync: false,
    };
  }

  if (after.nodes > ceilings.nodes || after.bytes > ceilings.bytes) {
    const before = measureCopy(resident, strategy);
    const grew = before === null || after.nodes > before.nodes || after.bytes > before.bytes;

    if (grew) {
      return {
        ok: false,
        refusal:
          after.nodes > ceilings.nodes
            ? rejection(
                'document_too_many_nodes',
                `A document may hold at most ${String(ceilings.nodes)} nodes; this one ` +
                  `would hold ${String(after.nodes)}.`,
              )
            : rejection(
                'document_too_large',
                `A document may be at most ${String(ceilings.bytes)} bytes; this one ` +
                  `would be ${String(after.bytes)}.`,
              ),
        resync: true,
      };
    }
  }

  return { ok: true, repair, persistedUpdateBytes };
}

/**
 * Whether the resident document, as it stands and before any candidate update, is one this
 * strategy can already read.
 *
 * Through a copy rather than by measuring the resident, because measuring is not read-only:
 * reading a fragment as prose drops the nodes the schema does not know from the Yjs document
 * itself. Asking the resident directly would mutate live state to answer a question about it,
 * and on exactly the documents where the answer matters most.
 */
function parsesAlone(resident: Y.Doc, strategy: BodyKindStrategy): boolean {
  return measureCopy(resident, strategy) !== null;
}

/** The resident's measurement, taken on a copy for the reason {@link parsesAlone} gives. */
function measureCopy(resident: Y.Doc, strategy: BodyKindStrategy): Measurement | null {
  const copy = new Y.Doc();
  try {
    Y.applyUpdate(copy, Y.encodeStateAsUpdate(resident));
    return strategy.measure(copy);
  } catch {
    return null;
  } finally {
    copy.destroy();
  }
}

/**
 * A throwaway copy of the resident document with the candidate update applied.
 *
 * Throws when the update does not decode, which is the caller's `update_unreadable`. Every caller
 * destroys what it gets back: these are short-lived and the resident document must never be
 * reachable from one.
 */
function forkWith(resident: Y.Doc, update: Uint8Array): Y.Doc {
  const fork = new Y.Doc();
  try {
    Y.applyUpdate(fork, Y.encodeStateAsUpdate(resident));
    Y.applyUpdate(fork, update);
  } catch (cause) {
    fork.destroy();
    throw cause;
  }
  return fork;
}

/** The longest a failing flush waits before trying again. */
const MAX_RETRY_DELAY_MS = 30_000;

function describe(cause: unknown): string {
  return cause instanceof Error ? cause.message : String(cause);
}

/** Builds the resident-plus-candidate document that a judgement measures. */
export interface CandidateScratch {
  /** The resident with `update` applied. Throws when the update does not decode. */
  fork(update: Uint8Array): Y.Doc;

  /** Done measuring what {@link fork} returned. */
  release(fork: Y.Doc): void;
}

function freshScratch(resident: Y.Doc): CandidateScratch {
  return {
    fork: (update) => forkWith(resident, update),
    release: (fork) => {
      fork.destroy();
    },
  };
}

/** The origin of everything the mirror applies itself, so it can tell when a measure wrote. */
const MIRROR_ORIGIN = Symbol('mirror');

/**
 * A standing copy of the resident document, kept equal to it, for judging candidates against.
 *
 * Judging needs the resident *plus* the candidate, and Yjs has no undo, so the plain way is to copy
 * the resident for every update - which on a large document is most of the cost of a keystroke.
 * The mirror is that copy, made once: a candidate is applied to it and measured there, and when the
 * resident accepts the same update the two are equal again without copying anything.
 *
 * **It is either known equal to the resident, or rebuilt.** {@link fork} takes it out of step; only
 * {@link settle}, called once the resident has applied exactly that candidate, puts it back. While
 * in step it follows every other resident update - log catch-up, a repair - by applying them too.
 * A measurement that wrote to it (prose conversion drops nodes the schema does not know) also
 * leaves it out of step. Out of step, the next fork rebuilds it from the resident, which is the
 * cost the mirror exists to avoid, paid only on refusals and repairs.
 */
export class CandidateMirror implements CandidateScratch {
  readonly #resident: Y.Doc;
  #doc: Y.Doc | null = null;
  #inStep = false;
  #written = false;
  readonly #follow = (update: Uint8Array): void => {
    if (this.#doc !== null && this.#inStep) {
      Y.applyUpdate(this.#doc, update, MIRROR_ORIGIN);
    }
  };

  constructor(resident: Y.Doc) {
    this.#resident = resident;
    resident.on('update', this.#follow);
  }

  fork(update: Uint8Array): Y.Doc {
    const doc = this.#doc !== null && this.#inStep ? this.#doc : this.#rebuild();
    this.#inStep = false;
    this.#written = false;
    Y.applyUpdate(doc, update, MIRROR_ORIGIN);
    return doc;
  }

  release(): void {
    // Kept, not destroyed: whether it can be reused is for `settle` to say.
  }

  /** The resident has applied exactly the candidate last forked; the two are equal again. */
  settle(): void {
    this.#inStep = this.#doc !== null && !this.#written;
  }

  destroy(): void {
    this.#resident.off('update', this.#follow);
    this.#doc?.destroy();
    this.#doc = null;
    this.#inStep = false;
  }

  #rebuild(): Y.Doc {
    this.#doc?.destroy();
    const doc = new Y.Doc();
    Y.applyUpdate(doc, Y.encodeStateAsUpdate(this.#resident), MIRROR_ORIGIN);
    doc.on('update', (_update: Uint8Array, origin: unknown) => {
      if (origin !== MIRROR_ORIGIN) {
        this.#written = true;
        this.#inStep = false;
      }
    });
    this.#doc = doc;
    return doc;
  }
}

interface PrincipalRun {
  readonly principalId: string;
  readonly updates: { bytes: Uint8Array; clientId: string }[];
}

/** Splits a queue into maximal contiguous runs of one principal, order preserved. */
function principalRuns(queue: readonly PendingUpdate[]): PrincipalRun[] {
  const runs: PrincipalRun[] = [];
  for (const update of queue) {
    const entry = { bytes: update.bytes, clientId: update.clientId };
    const current = runs[runs.length - 1];
    if (current !== undefined) {
      if (current.principalId === update.principalId) {
        current.updates.push(entry);
        continue;
      }
    }
    runs.push({ principalId: update.principalId, updates: [entry] });
  }
  return runs;
}
