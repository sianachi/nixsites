import * as decoding from 'lib0/decoding';
import * as encoding from 'lib0/encoding';

/**
 * The socket's wire protocol, shared by this server and the web client's provider.
 *
 * One handshake frame of JSON text, then binary frames for everything that repeats. The
 * handshake is text because it happens once and carries a credential - browsers cannot set
 * headers on a WebSocket, and a token in the URL's query string would land in every proxy
 * and ingress log between here and the client. Everything after it is lib0-framed binary:
 * a varint message type, then the y-protocols payload the type names.
 */

/** y-protocols sync: step 1 (state vector), step 2 (missing updates), and updates. */
export const MESSAGE_SYNC = 0;

/** y-protocols awareness: presence, cursors, selections. Broadcast, never persisted. */
export const MESSAGE_AWARENESS = 1;

/**
 * A server refusal that does not end the conversation: the same `Rejection` shape the HTTP
 * surface answers with, as JSON. Section 17's rows that say "reject, log, do not
 * disconnect" arrive through this.
 */
export const MESSAGE_NOTICE = 2;

/**
 * A same-socket persistence barrier. The client sends a bounded identifier after its pending Yjs
 * update; the server echoes it only after the resident document has flushed every earlier frame.
 */
export const MESSAGE_PERSISTED = 3;

export function encodePersisted(barrierId: string): Uint8Array {
  const encoder = encoding.createEncoder();
  encoding.writeVarUint(encoder, MESSAGE_PERSISTED);
  encoding.writeVarString(encoder, barrierId);
  return encoding.toUint8Array(encoder);
}

/**
 * Close codes, aligned with the HTTP status the same refusal would have carried.
 *
 * 4000-range codes are the application's to define; 1012 is the standard "service
 * restarting", which is exactly what draining is to a client.
 */
export const CLOSE_CODES = {
  /** No auth frame in time, or a token that expired or did not validate. */
  unauthenticated: 4401,
  /** Authorization was revoked while the socket was open. */
  revoked: 4403,
  /** No such item, or not one the caller may see. The uniform non-answer. */
  notFound: 4404,
  /** The item is visible but its body is locked to this session. Unlock it through Core. */
  bodyLocked: 4405,
  /** The client speaks an older schema version than the document is pinned to. */
  schemaMismatch: 4409,
  /** The server is at capacity and refused to load the document. Honest, not silent. */
  atCapacity: 4413,
  /** Another instance owns this document; this one must not serve it. */
  ownedElsewhere: 4423,
  /** Sustained rate abuse after backpressure notices went unheeded. */
  rateKilled: 4429,
  /** The server is draining: flushing, snapshotting, shutting down. Reconnect. */
  draining: 1012,
  /** Something failed on the server's side while serving the handshake. Reconnect later. */
  unavailable: 1011,
  /** The client fell too far behind the document's traffic. Reconnect, and sync catches up. */
  tooSlow: 1013,
} as const;

/** What the client's first frame must say. */
export interface AuthFrame {
  readonly token: string;
  readonly schemaVersion: number;
}

/** What the server answers the handshake with, as JSON text. */
export interface ReadyFrame {
  readonly type: 'ready';
  readonly docId: string;
  /** What the session may do. A read-only session's sync updates are refused, not applied. */
  readonly mode: 'write' | 'read';
  readonly bodyKind: string;
  readonly schemaVersion: number;
}

/**
 * Parses the handshake frame, or returns null for anything that is not one.
 *
 * Strict on shape and silent on why: the only caller reaction to a bad handshake is to
 * close the socket, and an attacker probing the endpoint learns nothing from uniformity.
 */
export function parseAuthFrame(data: unknown): AuthFrame | null {
  if (typeof data !== 'string') {
    return null;
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(data);
  } catch {
    return null;
  }

  if (typeof parsed !== 'object' || parsed === null) {
    return null;
  }

  const frame = parsed as { type?: unknown; token?: unknown; schemaVersion?: unknown };
  if (
    frame.type !== 'auth' ||
    typeof frame.token !== 'string' ||
    frame.token.length === 0 ||
    typeof frame.schemaVersion !== 'number' ||
    !Number.isInteger(frame.schemaVersion)
  ) {
    return null;
  }

  return { token: frame.token, schemaVersion: frame.schemaVersion };
}

/**
 * Encodes a non-fatal notice: a refusal's code and detail without its HTTP status, or a change
 * of mode such as `editable`.
 */
export function encodeNotice(refusal: {
  readonly code: string;
  readonly detail: string;
}): Uint8Array {
  const encoder = encoding.createEncoder();
  encoding.writeVarUint(encoder, MESSAGE_NOTICE);
  encoding.writeVarString(encoder, JSON.stringify({ code: refusal.code, detail: refusal.detail }));
  return encoding.toUint8Array(encoder);
}

/** A decoded binary frame: which protocol it belongs to, and a decoder positioned at its payload. */
export interface BinaryFrame {
  readonly messageType: number;
  readonly decoder: decoding.Decoder;
}

/** Splits a binary frame into its type and payload, or null when it is not one. */
export function readBinaryFrame(data: Uint8Array): BinaryFrame | null {
  try {
    const decoder = decoding.createDecoder(data);
    return { messageType: decoding.readVarUint(decoder), decoder };
  } catch {
    return null;
  }
}
