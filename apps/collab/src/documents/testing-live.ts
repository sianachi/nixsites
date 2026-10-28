import { SCHEMA_VERSION } from '@nix/editor-schema';
import * as decoding from 'lib0/decoding';
import * as encoding from 'lib0/encoding';
import { Pool } from 'pg';
import { WebSocket } from 'ws';
import * as awarenessProtocol from 'y-protocols/awareness';
import * as syncProtocol from 'y-protocols/sync';
import * as Y from 'yjs';

import type { Authorizer, ItemAuthorization } from '../auth/authorize.ts';
import { connectDocumentLocks, type DocumentLocks } from '../db/advisory-lock.ts';
import { TEST_DATABASE_URL, collabPool, type TestTenant } from '../db/testing.ts';
import { createServer } from '../http/server.ts';
import { MESSAGE_NOTICE, MESSAGE_SYNC } from '../ws/protocol.ts';
import type { SocketSession } from '../ws/server.ts';
import { createSessionAuthenticator } from '../ws/session-auth.ts';
import type { RateWindow } from './limits.ts';
import { createDocumentRegistry, type DocumentHub, type RegistryConfig } from './registry.ts';

/**
 * The live-server harness the socket suites share: a real Fastify server with the real
 * registry against the development Postgres, and a client that speaks just enough of the
 * protocol to assert on it. Not a test file itself - it holds no assertions, only the
 * machinery every socket assertion needs.
 */

/** A second principal of the alpha tenant, for actor-attribution assertions. */
export const SECOND_PRINCIPAL = 'c1000000-0000-4000-8000-000000000023';

/**
 * Tokens double as behaviour selectors so multi-principal, read-only and body-kind tests
 * need no second issuer: 'as-second-principal' acts as another member, 'as-reader' may
 * not write, 'as-canvas-author' opens the item as a canvas body, 'as-sheet-author'
 * opens it as a spreadsheet body, and 'solo-first' / 'solo-second' are the two members on an
 * item whose collaboration is switched off.
 */
export function authorizerFor(tenant: TestTenant): Authorizer {
  return {
    authorize: (token: string): Promise<ItemAuthorization | null> =>
      Promise.resolve({
        tenantId: tenant.tenantId,
        workspaceId: tenant.workspaceId,
        principalId:
          token === 'as-second-principal' || token === 'solo-second'
            ? SECOND_PRINCIPAL
            : tenant.principalId,
        canWrite: token !== 'as-reader',
        collaborative: !token.startsWith('solo-'),
        bodyKind:
          token === 'as-canvas-author'
            ? 'canvas'
            : token === 'as-sheet-author'
              ? 'spreadsheet'
              : 'note',
      }),
  };
}

/** Places one canvas element - the whole-element write the canvas contract expects. */
export function placeElement(doc: Y.Doc, id: string, overrides?: Record<string, unknown>): void {
  doc.getMap('elements').set(id, {
    id,
    type: 'rectangle',
    version: 1,
    versionNonce: 1,
    x: 0,
    y: 0,
    ...overrides,
  });
}

/** Writes one sheet cell - the shape the sheet contract expects. */
export function placeCell(doc: Y.Doc, key: string, raw: string): void {
  doc.getMap('sheet-cells').set(key, { raw });
}

/** Thresholds tightened so lifecycle transitions happen inside a test's patience. */
export const FAST: RegistryConfig = {
  flushMs: 40,
  flushBytes: 512 * 1024,
  snapshotEvery: 5,
  snapshotIntervalMs: 3_600_000,
  idleEvictMs: 150,
  maxDocs: 50,
  maxResidentBytes: 256 * 1024 * 1024,
  sweepMs: 60,
  // Every test document is mirrored, however small, so the suites exercise the path production
  // takes for large documents; the fresh-copy path is covered by judging candidates directly.
  mirrorFromBytes: 0,
};

export interface LiveHarness {
  readonly url: string;
  readonly pool: Pool;
  readonly locks: DocumentLocks;
  readonly registry: DocumentHub;
  readonly flushes: string[];
  close(): Promise<void>;
}

export async function startLiveServer(
  tenant: TestTenant,
  overrides?: Partial<RegistryConfig>,
  options?: { rateWindow?: RateWindow },
): Promise<LiveHarness> {
  const pool = collabPool();
  const locks = await connectDocumentLocks({
    databaseUrl: TEST_DATABASE_URL,
    onSessionLost: () => undefined,
  });
  const flushes: string[] = [];

  const registry = createDocumentRegistry({
    pool,
    locks,
    config: { ...FAST, ...overrides },
    rateWindow: options?.rateWindow,
    onFlushed: (session) => {
      flushes.push(session.itemId);
    },
  });

  const app = createServer({
    pool,
    sessions: createSessionAuthenticator({
      tokens: { validate: (token) => Promise.resolve({ subject: token, expiresAt: null }) },
      authorizer: authorizerFor(tenant),
      cacheTtlMs: 1,
    }),
    core: {
      getItem: () => Promise.resolve(null),
      listChildren: () => Promise.resolve(null),
      getSchema: () => Promise.resolve(null),
      getViews: () => Promise.resolve(null),
    },
    internalSecret: 'live-harness-secret',
    reauthMs: 60_000,
    hub: registry,
    rateWindow: options?.rateWindow,
  });

  await app.listen({ port: 0, host: '127.0.0.1' });
  const address = app.server.address();
  if (address === null || typeof address === 'string') {
    throw new Error('The test server did not bind a port.');
  }

  let closed = false;
  return {
    url: `ws://127.0.0.1:${String(address.port)}`,
    pool,
    locks,
    registry,
    flushes,
    close: async () => {
      if (closed) {
        return;
      }
      closed = true;
      await app.close();
      await locks.close();
      await pool.end();
    },
  };
}

/**
 * A minimal client provider: auth frame, sync protocol, local edits sent as updates - the
 * shape the web client's provider takes, reduced to what assertions need. It also records
 * every notice the server sends, because most of the validation suite is about those.
 */
export interface TestClient {
  readonly doc: Y.Doc;
  readonly socket: WebSocket;
  readonly ready: Promise<{ docId: string; mode: string }>;
  readonly notices: { code: string; detail: string }[];
  readonly awareness: awarenessProtocol.Awareness;
  readonly syncFramesReceived: () => number;
  sendRaw(bytes: Uint8Array): void;
  close(): void;
}

export function connectTestClient(
  url: string,
  itemId: string,
  token: string,
  schemaVersion: number = SCHEMA_VERSION,
): TestClient {
  const doc = new Y.Doc();
  const socket = new WebSocket(`${url}/documents/${itemId}/ws`);
  const REMOTE = socket;
  const notices: { code: string; detail: string }[] = [];
  const awareness = new awarenessProtocol.Awareness(doc);
  let syncFrames = 0;

  const ready = new Promise<{ docId: string; mode: string }>((resolve, reject) => {
    socket.on('close', (code) => {
      reject(new Error(`closed before ready: ${String(code)}`));
    });
    socket.on('message', (data, isBinary) => {
      if (!isBinary) {
        resolve(
          JSON.parse(Buffer.from(data as Buffer).toString('utf8')) as {
            docId: string;
            mode: string;
          },
        );
      }
    });
  });
  // A test that only asserts on the socket's close event (the read-only and
  // schema-rejection cases below) never awaits `ready` itself. The `await ready` below
  // is what observes its rejection; this second handler is belt-and-braces for any future
  // caller that reads `ready` some other way without awaiting it inline.
  ready.catch(() => undefined);

  socket.on('open', () => {
    socket.send(JSON.stringify({ type: 'auth', token, schemaVersion }));
  });

  // Both sides open with sync step 1, exactly as y-websocket does: the server's step 1
  // pulls the client's edits, and this one pulls the server's. Awaiting `ready` inline
  // and returning on its rejection keeps a "closed before ready" local to this function
  // instead of escaping as an unhandled rejection on a derived promise (a bare
  // `void ready.then(onFulfilled)` has no `onRejected`, so it used to leak); a genuine
  // throw from the encode/send below still propagates, same as before.
  void (async () => {
    try {
      await ready;
    } catch {
      return;
    }
    const encoder = encoding.createEncoder();
    encoding.writeVarUint(encoder, MESSAGE_SYNC);
    syncProtocol.writeSyncStep1(encoder, doc);
    socket.send(encoding.toUint8Array(encoder));
  })();

  socket.on('message', (data, isBinary) => {
    if (!isBinary) {
      return;
    }
    const decoder = decoding.createDecoder(new Uint8Array(data as Buffer));
    const messageType = decoding.readVarUint(decoder);

    if (messageType === MESSAGE_NOTICE) {
      notices.push(JSON.parse(decoding.readVarString(decoder)) as { code: string; detail: string });
      return;
    }

    if (messageType === 1) {
      awarenessProtocol.applyAwarenessUpdate(
        awareness,
        decoding.readVarUint8Array(decoder),
        REMOTE,
      );
      return;
    }

    if (messageType !== MESSAGE_SYNC) {
      return;
    }
    syncFrames += 1;
    const encoder = encoding.createEncoder();
    encoding.writeVarUint(encoder, MESSAGE_SYNC);
    syncProtocol.readSyncMessage(decoder, encoder, doc, REMOTE);
    if (encoding.length(encoder) > 1 && socket.readyState === WebSocket.OPEN) {
      socket.send(encoding.toUint8Array(encoder));
    }
  });

  doc.on('update', (update: Uint8Array, origin: unknown) => {
    if (origin !== REMOTE && socket.readyState === WebSocket.OPEN) {
      const encoder = encoding.createEncoder();
      encoding.writeVarUint(encoder, MESSAGE_SYNC);
      syncProtocol.writeUpdate(encoder, update);
      socket.send(encoding.toUint8Array(encoder));
    }
  });

  awareness.on(
    'update',
    (change: { added: number[]; updated: number[]; removed: number[] }, origin: unknown) => {
      if (origin === REMOTE || socket.readyState !== WebSocket.OPEN) {
        return;
      }
      const changed = [...change.added, ...change.updated, ...change.removed];
      const encoder = encoding.createEncoder();
      encoding.writeVarUint(encoder, 1);
      encoding.writeVarUint8Array(
        encoder,
        awarenessProtocol.encodeAwarenessUpdate(awareness, changed),
      );
      socket.send(encoding.toUint8Array(encoder));
    },
  );

  return {
    doc,
    socket,
    ready,
    notices,
    awareness,
    syncFramesReceived: () => syncFrames,
    sendRaw: (bytes) => {
      socket.send(bytes);
    },
    close: () => {
      socket.terminate();
      awareness.destroy();
      doc.destroy();
    },
  };
}

/** Frames a raw Yjs update the way a writer's edit goes over the wire. */
export function updateFrame(update: Uint8Array): Uint8Array {
  const encoder = encoding.createEncoder();
  encoding.writeVarUint(encoder, MESSAGE_SYNC);
  syncProtocol.writeUpdate(encoder, update);
  return encoding.toUint8Array(encoder);
}

/** Writes one paragraph of prose - a shape the schema accepts - into the shared fragment. */
export function typeParagraph(doc: Y.Doc, text: string): void {
  const fragment = doc.getXmlFragment('default');
  const paragraph = new Y.XmlElement('paragraph');
  paragraph.insert(0, [new Y.XmlText(text)]);
  fragment.insert(fragment.length, [paragraph]);
}

export function textOf(doc: Y.Doc): string {
  // eslint-disable-next-line @typescript-eslint/no-base-to-string -- Y.XmlFragment defines its own XML toString; the rule cannot see through the generic base class.
  return doc.getXmlFragment('default').toString();
}

export async function until(
  check: () => boolean | Promise<boolean>,
  what: string,
  timeoutMs = 4_000,
): Promise<void> {
  const startedAt = Date.now();
  for (;;) {
    if (await check()) {
      return;
    }
    if (Date.now() - startedAt > timeoutMs) {
      throw new Error(`Timed out waiting for ${what}.`);
    }
    await new Promise((resolve) => setTimeout(resolve, 25));
  }
}

/** A socket session with a recording socket, for exercising session logic without a wire. */
export interface FakeSocketSession extends SocketSession {
  readonly sent: Uint8Array[];
  readonly closedWith: { code: number; reason: string }[];
  readonly terminated: { value: boolean };
}

export function fakeSocketSession(
  tenant: TestTenant,
  overrides?: { principalId?: string; mode?: 'write' | 'read'; bodyKind?: string },
): FakeSocketSession {
  const sent: Uint8Array[] = [];
  const closedWith: { code: number; reason: string }[] = [];
  const terminated = { value: false };

  const socket = {
    send: (data: Uint8Array) => {
      sent.push(data);
    },
    close: (code: number, reason: string) => {
      closedWith.push({ code, reason });
    },
    terminate: () => {
      terminated.value = true;
    },
    readyState: WebSocket.OPEN,
    bufferedAmount: 0,
  } as unknown as WebSocket;

  return {
    socket,
    sent,
    closedWith,
    terminated,
    itemId: tenant.itemId,
    authorizationKey: tenant.itemId,
    clientSchemaVersion: SCHEMA_VERSION,
    token: 'a-token',
    authorization: {
      tenantId: tenant.tenantId,
      workspaceId: tenant.workspaceId,
      principalId: overrides?.principalId ?? tenant.principalId,
      canWrite: overrides?.mode !== 'read',
      bodyKind: overrides?.bodyKind ?? 'note',
      subject: 'someone',
      tokenExpiresAt: null,
    },
    mode: overrides?.mode ?? 'write',
  };
}

/** The superuser pool for verification: the collab role's own reads are tenant-scoped. */
export function adminPool(): Pool {
  return new Pool({
    connectionString:
      process.env.NIX_COLLAB_TEST_ADMIN_DATABASE_URL ??
      'postgresql://postgres:nix-dev-superuser@localhost:5433/nix',
    max: 2,
  });
}

export async function countUpdates(verify: Pool, tenant: TestTenant): Promise<number> {
  const { rows } = await verify.query<{ count: string }>(
    `SELECT count(*)::text AS count
     FROM content_update u JOIN content_doc d USING (doc_id)
     WHERE d.tenant_id = $1 AND d.item_id = $2`,
    [tenant.tenantId, tenant.itemId],
  );
  return Number(rows[0]?.count ?? '0');
}
