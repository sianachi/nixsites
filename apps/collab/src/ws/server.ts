import type { IncomingMessage, Server as HttpServer } from 'node:http';
import type { Duplex } from 'node:stream';

import { WebSocket, WebSocketServer, type RawData } from 'ws';

import type { CollabMetrics } from '../metrics.ts';
import { CLOSE_CODES, encodeNotice, parseAuthFrame } from './protocol.ts';
import type { SessionAuthenticator, SessionAuthorization } from './session-auth.ts';

/**
 * One authenticated socket, as the document layer sees it.
 *
 * `mode` is mutable on purpose: a revocation re-check can downgrade a writer to a reader
 * mid-session without tearing the socket down, which is the honest middle ground between
 * "a socket outlives its permission" and "every permission change is a disconnect".
 */
export interface SocketSession {
  readonly socket: WebSocket;
  readonly itemId: string;
  readonly authorizationKey: string;
  readonly clientSchemaVersion: number;

  /**
   * The user's own bearer token, held for the session's service-to-service calls - the
   * touched notification forwards it so Core acts as this principal, never as a service.
   */
  readonly token: string;
  authorization: SessionAuthorization;
  mode: 'write' | 'read';
}

/** What a hub says to a handshake: serve it, or close it with a reason. */
export type JoinResult =
  | { readonly ok: true; readonly docId: string; readonly schemaVersion: number }
  | { readonly ok: false; readonly closeCode: number; readonly reason: string };

/**
 * Where authenticated sockets go. The handshake below is transport plumbing; everything
 * document-shaped - loading, sync, awareness, flushing - lives behind this seam, so the
 * lifecycle layer replaces the hub without touching how a connection is established.
 */
export interface SessionHub {
  join(session: SocketSession): Promise<JoinResult>;
  handleMessage(session: SocketSession, data: Uint8Array): void;
  leave(session: SocketSession): void;

  /**
   * Called after the ready frame is on the wire, so anything the hub sends - sync step 1,
   * the awareness roster - arrives after the client knows the session stands.
   */
  ready?(session: SocketSession): void;

  /**
   * Called after a re-check stored a fresh authorization, so the hub can decide who writes now:
   * a switched-off collaboration or a lost write grant hands the pen to someone else.
   */
  reauthorized?(session: SocketSession): void;

  /**
   * Tells a resident document that its log moved underneath it - a REST write or a restore - so
   * it catches up and shows the change to everyone editing it. A no-op when nothing is resident.
   */
  refresh?(itemId: string): Promise<void>;

  /** Drains whatever the hub holds. Called on server close, after the sockets are told. */
  shutdown?(): Promise<void>;
}

export interface WebSocketOptions {
  readonly sessions: SessionAuthenticator;
  readonly hub: SessionHub;

  /** How often a live session's authorization is re-checked. */
  readonly reauthMs: number;

  /** How long the client has to send its auth frame. Defaults to ten seconds. */
  readonly authTimeoutMs?: number | undefined;

  /**
   * The largest frame accepted, before authentication or after. `ws` buffers a whole message
   * before anything here sees it, and its own default is 100 MiB - a ceiling any unauthenticated
   * client could make this process allocate. Defaults to 2 MiB.
   */
  readonly maxPayloadBytes?: number | undefined;

  /** Keepalive ping interval. A socket that misses one is dead, not idle. */
  readonly pingMs?: number | undefined;

  readonly metrics?: CollabMetrics | undefined;

  /** Where failures nobody awaits are reported. Defaults to silence. */
  readonly log?: ((message: string) => void) | undefined;
}

const WS_PATH =
  /^\/documents\/([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})\/ws$/i;
const TEMPLATE_WS_PATH =
  /^\/templates\/([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})\/items\/([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})\/document(?:\/ws)?$/i;
const DRAFT_WS_PATH =
  /^\/templates\/([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})\/drafts\/([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})\/items\/([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})(?:\/ws)?$/i;

/**
 * Attaches the WebSocket endpoint to an HTTP server: `GET /documents/:itemId/ws`, upgraded.
 *
 * **The handshake authorizes before anything else happens.** The first frame must be the
 * auth frame; until it arrives and Core says yes, no document is loaded, no state is sent,
 * and nothing the client transmits is interpreted. Every refusal is a close code from
 * `CLOSE_CODES`, chosen so the client can tell "get a new token" from "you cannot have
 * this" from "try again later" - and nothing more.
 */
export function attachWebSocketServer(
  httpServer: HttpServer,
  options: WebSocketOptions,
): WebSocketServer {
  const wss = new WebSocketServer({
    noServer: true,
    maxPayload: options.maxPayloadBytes ?? 2 * 1024 * 1024,
  });
  const authTimeoutMs = options.authTimeoutMs ?? 10_000;
  const pingMs = options.pingMs ?? 30_000;

  httpServer.on('upgrade', (request: IncomingMessage, socket: Duplex, head: Buffer) => {
    const path = new URL(request.url ?? '/', 'http://placeholder').pathname;
    const match = WS_PATH.exec(path);
    const templateMatch = TEMPLATE_WS_PATH.exec(path);
    const draftMatch = DRAFT_WS_PATH.exec(path);
    if (match === null && templateMatch === null && draftMatch === null) {
      // Refused before the upgrade completes: a path that is not the endpoint gets HTTP's
      // answer, not a WebSocket close code on a connection that should never have opened.
      socket.write('HTTP/1.1 404 Not Found\r\nconnection: close\r\n\r\n');
      socket.destroy();
      return;
    }

    const authorizationKey =
      match !== null
        ? (match[1] ?? '').toLowerCase()
        : draftMatch !== null
          ? `draft:${draftMatch[1] ?? ''}:${draftMatch[2] ?? ''}:${draftMatch[3] ?? ''}`.toLowerCase()
          : `template:${templateMatch?.[1] ?? ''}:${templateMatch?.[2] ?? ''}`.toLowerCase();
    wss.handleUpgrade(request, socket, head, (ws) => {
      handleConnection(ws, authorizationKey, options, authTimeoutMs, pingMs);
    });
  });

  return wss;
}

function handleConnection(
  socket: WebSocket,
  authorizationKey: string,
  options: WebSocketOptions,
  authTimeoutMs: number,
  pingMs: number,
): void {
  const { sessions, hub, metrics } = options;

  let session: SocketSession | null = null;
  let token: string | null = null;
  let alive = true;

  // The handshake spans awaits, and the client can act during them: send its auth frame again, or
  // go away. `establishing` keeps a second frame from starting a second join; `closed` tells the
  // awaits that resume afterwards that there is no longer anybody to serve.
  let establishing = false;
  let closed = false;
  // A function, not the bare flag: the checks below sit after awaits, and the compiler would
  // otherwise carry the first check's narrowing across them as if nothing could have closed.
  const isClosed = (): boolean => closed;

  metrics?.openSockets.inc();

  // The clock starts at accept: a socket that connects and says nothing is holding a file
  // descriptor hostage, and after this it is not.
  const authTimer = setTimeout(() => {
    close(CLOSE_CODES.unauthenticated, 'No auth frame arrived in time.');
  }, authTimeoutMs);

  const pinger = setInterval(() => {
    if (!alive) {
      socket.terminate();
      return;
    }
    alive = false;
    socket.ping();
  }, pingMs);

  // Re-checked on a wall-clock timer, not on traffic: an idle socket held by a
  // deprovisioned principal is exactly the leak the re-check exists to close.
  const reauthTimer = setInterval(() => {
    // **This fails closed.** An unreachable Core, a timeout or a Core-side error is answered
    // `unavailable`, and the socket closes - with the code that says "reconnect", not "revoked" -
    // rather than outliving a permission nobody could confirm.
    // What reaches this catch is a fault in the re-check itself; it is logged, and the socket is
    // judged again on the next tick. Keeping a socket open through an unconfirmed re-check would
    // be a policy change that needs an ADR, with a staleness bound, not an edit here.
    recheck().catch((cause: unknown) => {
      options.log?.(`The authorization re-check failed: ${describe(cause)}`);
    });
  }, options.reauthMs);

  socket.on('pong', () => {
    alive = true;
  });

  socket.on('message', (data: RawData, isBinary: boolean) => {
    if (session === null) {
      if (establishing) {
        // Nothing is interpreted before the session stands. Sync after `ready` reconciles
        // anything a client sent early, and a repeated auth frame has nothing left to say.
        return;
      }
      establishing = true;
      establish(data, isBinary)
        .catch((cause: unknown) => {
          options.log?.(`A handshake failed on the server's side: ${describe(cause)}`);
          // Authorization or the document load failed on this side - Core unreachable, the
          // database refusing. The client is owed a close it reconnects from, not a socket that
          // never answers, and the process is owed not being ended by an unhandled rejection.
          if (!isClosed()) {
            close(
              CLOSE_CODES.unavailable,
              'The server could not open this document. Retry shortly.',
            );
          }
        })
        .finally(() => {
          establishing = false;
        });
      return;
    }

    if (!isBinary) {
      // After the handshake the protocol is binary; a stray text frame is a client bug,
      // ignored rather than fatal so a logging line gone astray cannot end a session.
      return;
    }

    hub.handleMessage(session, toUint8Array(data));
  });

  socket.on('close', () => {
    closed = true;
    clearTimeout(authTimer);
    clearInterval(pinger);
    clearInterval(reauthTimer);
    metrics?.openSockets.dec();
    if (session !== null) {
      const parting = session;
      session = null;
      hub.leave(parting);
    }
  });

  socket.on('error', () => {
    // 'close' follows and does the cleanup; an unhandled 'error' event would kill the
    // process, which is the only reason this handler exists.
  });

  async function establish(data: RawData, isBinary: boolean): Promise<void> {
    const frame = parseAuthFrame(isBinary ? null : rawDataToString(data));
    if (frame === null) {
      close(CLOSE_CODES.unauthenticated, 'The first frame must be the auth frame.');
      return;
    }

    const result = await sessions.authenticate(frame.token, authorizationKey);
    if (isClosed()) {
      return;
    }
    if (!result.ok) {
      if (result.reason === 'unauthenticated') {
        close(CLOSE_CODES.unauthenticated, 'The token could not be validated.');
      } else if (result.reason === 'locked') {
        close(CLOSE_CODES.bodyLocked, 'This document is locked. Unlock it first.');
      } else if (result.reason === 'unavailable') {
        close(CLOSE_CODES.unavailable, 'Access could not be confirmed. Retry shortly.');
      } else {
        close(CLOSE_CODES.notFound, 'No such document.');
      }
      return;
    }

    const authorization = result.value;
    const candidate: SocketSession = {
      socket,
      itemId: authorization.resolvedItemId ?? authorizationKey,
      authorizationKey,
      clientSchemaVersion: frame.schemaVersion,
      token: frame.token,
      authorization,
      mode: authorization.canWrite ? 'write' : 'read',
    };

    // Authorization and room loading are separate awaits. Recheck the synchronous operation
    // generation between them so a Save fence cannot be crossed by a result delivered just before
    // the block; once join starts, the registry generation cancels a concurrent seal.
    if (!sessions.isCurrent(authorizationKey, authorization)) {
      close(CLOSE_CODES.notFound, 'No such document.');
      return;
    }

    const joined = await hub.join(candidate);
    if (isClosed()) {
      // The close handler already ran, with no session to leave. The join attached one anyway,
      // and only this can release it.
      if (joined.ok) {
        hub.leave(candidate);
      }
      return;
    }
    if (!joined.ok) {
      close(joined.closeCode, joined.reason);
      return;
    }

    clearTimeout(authTimer);
    token = frame.token;
    session = candidate;
    metrics?.connectionsTotal.inc({ outcome: 'accepted' });

    socket.send(
      JSON.stringify({
        type: 'ready',
        docId: joined.docId,
        mode: candidate.mode,
        bodyKind: authorization.bodyKind,
        schemaVersion: joined.schemaVersion,
      }),
    );

    hub.ready?.(candidate);
  }

  async function recheck(): Promise<void> {
    const current = session;
    if (current === null || token === null) {
      return;
    }

    // The token's own lifetime is a hard bound. The client is told to reconnect - with the
    // fresh token it has long since acquired - rather than being allowed to ride a session
    // whose credential no longer exists.
    const expiry = current.authorization.tokenExpiresAt;
    if (expiry !== null && expiry <= Date.now()) {
      close(CLOSE_CODES.unauthenticated, 'The session token has expired. Reconnect.');
      return;
    }

    const rechecked = await sessions.authenticate(token, current.authorizationKey);
    if (socket.readyState !== WebSocket.OPEN) {
      // The socket closed while the re-check was in flight; there is nothing left to
      // downgrade or revoke.
      return;
    }

    if (!rechecked.ok) {
      if (rechecked.reason === 'unauthenticated') {
        close(CLOSE_CODES.unauthenticated, 'The token could not be validated. Reconnect.');
      } else if (rechecked.reason === 'locked') {
        close(CLOSE_CODES.bodyLocked, 'This document was locked. Unlock it to keep editing.');
      } else if (rechecked.reason === 'unavailable') {
        // Still closed - nothing outlives a permission that could not be confirmed - but not as
        // revoked. A client told "revoked" seals its cached body; one
        // told the server is unavailable keeps them and reconnects.
        close(CLOSE_CODES.unavailable, 'Access could not be confirmed. Reconnect shortly.');
      } else {
        close(CLOSE_CODES.revoked, 'This session is no longer authorized.');
      }
      return;
    }

    const fresh = rechecked.value;
    if (fresh.resolvedItemId !== undefined && fresh.resolvedItemId !== current.itemId) {
      close(
        CLOSE_CODES.revoked,
        'This template revision changed. Reconnect to the current revision.',
      );
      return;
    }
    if (fresh.workspaceId !== current.authorization.workspaceId) {
      close(
        CLOSE_CODES.revoked,
        'This item moved to another workspace. Reconnect to confirm access.',
      );
      return;
    }
    current.authorization = fresh;

    if (!fresh.canWrite && current.mode === 'write') {
      current.mode = 'read';
      socket.send(
        encodeNotice({
          code: 'read_only',
          detail: 'Your access changed to read-only. Edits are no longer accepted.',
        }),
      );
    }
    if (hub.reauthorized !== undefined) {
      hub.reauthorized(current);
    } else if (fresh.canWrite && current.mode === 'read') {
      current.mode = 'write';
    }
  }

  function close(code: number, reason: string): void {
    metrics?.refusalsTotal.inc({ code: String(code) });
    if (session === null) {
      metrics?.connectionsTotal.inc({ outcome: 'refused' });
    }
    socket.close(code, reason);
  }
}

function describe(cause: unknown): string {
  return cause instanceof Error ? cause.message : String(cause);
}

function rawDataToString(data: RawData): string | null {
  try {
    if (typeof data === 'string') {
      return data;
    }
    if (Array.isArray(data)) {
      return Buffer.concat(data).toString('utf8');
    }
    return Buffer.from(data as ArrayBuffer).toString('utf8');
  } catch {
    return null;
  }
}

function toUint8Array(data: RawData): Uint8Array {
  if (Array.isArray(data)) {
    return new Uint8Array(Buffer.concat(data));
  }
  if (data instanceof ArrayBuffer) {
    return new Uint8Array(data);
  }
  return new Uint8Array(data);
}
