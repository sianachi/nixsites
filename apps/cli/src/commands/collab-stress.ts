/**
 * `nixctl stress run --scenario collab-edit`: n real Yjs clients on the collaboration socket, each
 * appending unique markers to one note body, timed to the server's persisted barrier.
 *
 * The check is end to end: after every client is done, the body is read back through the normal
 * read path (`readBodyMarkdown`, the update log) and every marker whose barrier was acknowledged must
 * be there exactly once. The wire frames mirror `apps/collab/src/ws/protocol.ts`, copied rather than
 * imported because the CLI does not depend on that service.
 */

import { randomBytes } from 'node:crypto';
import * as decoding from 'lib0/decoding';
import * as encoding from 'lib0/encoding';
import WebSocket from 'ws';
import * as syncProtocol from 'y-protocols/sync';
import * as Y from 'yjs';
import { items } from '@nix/api-client';
import { SCHEMA_VERSION } from '@nix/editor-schema';
import { requireAccessToken, resolveSession, type SessionDeps } from './shared.ts';
import { percentile } from './stress.ts';
import { printResult, type OutputOptions } from '../output.ts';
import type { SessionEndpoints } from '../session.ts';

// Frame constants from apps/collab/src/ws/protocol.ts.
const MESSAGE_SYNC = 0;
const MESSAGE_NOTICE = 2;
const MESSAGE_PERSISTED = 3;
/** The Yjs fragment a note's prose binds to; the same one `body.ts` reads. */
const FRAGMENT = 'default';
const STEP_TIMEOUT_MS = 10_000;
const LOCAL = Symbol('local');

export interface CollabEditOptions {
  readonly docId?: string | undefined;
  readonly create: boolean;
  readonly workspaceId?: string | undefined;
  readonly clients: number;
  readonly edits: number;
  readonly intervalMs: number;
}

export function encodePersisted(barrierId: string): Uint8Array {
  const encoder = encoding.createEncoder();
  encoding.writeVarUint(encoder, MESSAGE_PERSISTED);
  encoding.writeVarString(encoder, barrierId);
  return encoding.toUint8Array(encoder);
}

function isLoopback(url: string): boolean {
  const host = new URL(url).hostname;
  return host === 'localhost' || host === '127.0.0.1' || host === '[::1]';
}

/** Refuses a non-loopback Core or collab host, so a write stress cannot hit production. */
export function guardTarget(endpoints: SessionEndpoints): void {
  if (isLoopback(endpoints.apiUrl) && isLoopback(endpoints.collabUrl)) return;
  throw new Error(
    `collab-edit writes to a live note and runs only against a local stack (got ${endpoints.apiUrl}, ${endpoints.collabUrl}).`,
  );
}

/**
 * Compares the body with the markers whose barrier was acknowledged. `lost` are expected markers
 * absent from the body; `duplicated` are markers present more than once. Foreign text is ignored.
 */
export function checkMarkers(
  body: string,
  tag: string,
  expected: readonly string[],
): { lost: string[]; duplicated: string[] } {
  const seen = new Map<string, number>();
  for (const found of body.match(new RegExp(`${tag}-c\\d+-e\\d+(?![\\w-])`, 'g')) ?? []) {
    seen.set(found, (seen.get(found) ?? 0) + 1);
  }
  return {
    lost: expected.filter((marker) => !seen.has(marker)),
    duplicated: [...seen].filter(([, count]) => count > 1).map(([marker]) => marker),
  };
}

export interface Tally {
  closeCodes: Record<string, number>;
  notices: Record<string, number>;
}

export interface Peer {
  readonly doc: Y.Doc;
  /**
   * Appends a paragraph holding `marker` and resolves when the server echoes the persisted barrier
   * sent right behind it; rejects on timeout or a closed socket.
   */
  edit(marker: string): Promise<void>;
  close(): void;
}

function bump(bag: Record<string, number>, key: string): void {
  bag[key] = (bag[key] ?? 0) + 1;
}

export function connect(wsUrl: string, token: string, tally: Tally): Promise<Peer> {
  return new Promise((resolve, reject) => {
    const doc = new Y.Doc();
    const ws = new WebSocket(wsUrl);
    const pending = new Map<string, { ok: () => void; fail: (error: Error) => void }>();
    let synced = false;
    let closing = false;
    const timer = setTimeout(() => {
      reject(new Error('Timed out waiting for the first sync.'));
      ws.terminate();
    }, STEP_TIMEOUT_MS);

    const send = (frame: Uint8Array): void => {
      if (ws.readyState === WebSocket.OPEN) ws.send(frame);
    };

    doc.on('update', (update: Uint8Array, origin: unknown) => {
      if (origin !== LOCAL) return;
      const encoder = encoding.createEncoder();
      encoding.writeVarUint(encoder, MESSAGE_SYNC);
      syncProtocol.writeUpdate(encoder, update);
      send(encoding.toUint8Array(encoder));
    });

    ws.on('open', () => {
      ws.send(JSON.stringify({ type: 'auth', token, schemaVersion: SCHEMA_VERSION }));
    });
    ws.on('error', (error) => {
      if (!synced) reject(error);
    });
    ws.on('close', (code) => {
      clearTimeout(timer);
      if (!closing) bump(tally.closeCodes, String(code));
      if (!synced) reject(new Error(`Closed before sync (${String(code)}).`));
      for (const entry of pending.values()) entry.fail(new Error(`Closed (${String(code)}).`));
      pending.clear();
    });
    ws.on('message', (data: Buffer, isBinary: boolean) => {
      try {
        onMessage(data, isBinary);
      } catch {
        // A frame this client cannot read fails the peer (the close handler fails its edits),
        // not the whole run.
        ws.terminate();
      }
    });

    const onMessage = (data: Buffer, isBinary: boolean): void => {
      if (!isBinary) {
        const frame = JSON.parse(data.toString('utf8')) as { type?: unknown };
        if (frame.type === 'ready') {
          const encoder = encoding.createEncoder();
          encoding.writeVarUint(encoder, MESSAGE_SYNC);
          syncProtocol.writeSyncStep1(encoder, doc);
          send(encoding.toUint8Array(encoder));
        }
        return;
      }
      const decoder = decoding.createDecoder(new Uint8Array(data));
      const type = decoding.readVarUint(decoder);
      if (type === MESSAGE_SYNC) {
        const reply = encoding.createEncoder();
        encoding.writeVarUint(reply, MESSAGE_SYNC);
        const kind = syncProtocol.readSyncMessage(decoder, reply, doc, 'remote');
        if (encoding.length(reply) > 1) send(encoding.toUint8Array(reply));
        if (kind === syncProtocol.messageYjsSyncStep2 && !synced) {
          synced = true;
          clearTimeout(timer);
          resolve({
            doc,
            edit: (id) =>
              new Promise<void>((ok, fail) => {
                if (ws.readyState !== WebSocket.OPEN) {
                  fail(new Error('Closed.'));
                  return;
                }
                // One paragraph per marker: schema-valid, and each marker stays a separate token.
                doc.transact(() => {
                  const paragraph = new Y.XmlElement('paragraph');
                  paragraph.insert(0, [new Y.XmlText(id)]);
                  const fragment = doc.getXmlFragment(FRAGMENT);
                  fragment.insert(fragment.length, [paragraph]);
                }, LOCAL);
                const wait = setTimeout(() => {
                  pending.delete(id);
                  fail(new Error('Timed out waiting for the persisted barrier.'));
                }, STEP_TIMEOUT_MS);
                pending.set(id, {
                  ok: () => {
                    clearTimeout(wait);
                    ok();
                  },
                  fail: (error) => {
                    clearTimeout(wait);
                    fail(error);
                  },
                });
                send(encodePersisted(id));
              }),
            close: () => {
              closing = true;
              ws.close(1000);
            },
          });
        }
      } else if (type === MESSAGE_PERSISTED) {
        const id = decoding.readVarString(decoder);
        pending.get(id)?.ok();
        pending.delete(id);
      } else if (type === MESSAGE_NOTICE) {
        const notice = JSON.parse(decoding.readVarString(decoder)) as { code?: unknown };
        const code = typeof notice.code === 'string' ? notice.code : 'unknown';
        bump(tally.notices, code);
        // A notice refuses the update in flight, and the server drops it; its barrier is still
        // acknowledged, so without this a refused edit would count as confirmed and then as lost.
        for (const entry of pending.values()) entry.fail(new Error(`Refused (${code}).`));
        pending.clear();
      }
    };
  });
}

const sleep = (ms: number): Promise<void> => new Promise((done) => setTimeout(done, ms));

export async function collabEdit(
  profileName: string | undefined,
  options: CollabEditOptions,
  output: OutputOptions,
  deps: SessionDeps = {},
): Promise<void> {
  for (const [flag, value] of [
    ['--clients', options.clients],
    ['--edits', options.edits],
  ] as const) {
    if (!Number.isInteger(value) || value < 1) {
      throw new Error(`${flag} must be a positive integer, got '${String(value)}'.`);
    }
  }
  if (!Number.isFinite(options.intervalMs) || options.intervalMs < 0) {
    throw new Error('--interval-ms must be zero or more.');
  }
  if (options.create === (options.docId !== undefined)) {
    throw new Error('collab-edit needs exactly one of --item <itemId> or --create.');
  }
  if (options.create && options.workspaceId === undefined) {
    throw new Error('--create needs --workspace <id>.');
  }

  const session = await resolveSession(profileName, deps);
  guardTarget(session.endpoints);

  const docId =
    options.docId ??
    (
      await session.client.execute(
        items.createItem(options.workspaceId ?? '', { type: 'note', title: 'Collab stress' }),
      )
    ).id;
  const token = await requireAccessToken(session);
  const wsUrl = `${session.endpoints.collabUrl.replace(/^http/u, 'ws')}/documents/${docId}/ws`;
  const tag = `nx${randomBytes(3).toString('hex')}`;
  const tally: Tally = { closeCodes: {}, notices: {} };
  const started = performance.now();

  const connected = await Promise.allSettled(
    Array.from({ length: options.clients }, () => connect(wsUrl, token, tally)),
  );
  const peers = connected.flatMap((result) =>
    result.status === 'fulfilled' ? [result.value] : [],
  );
  const connectErrors = connected.length - peers.length;

  const confirmed: string[] = [];
  const latencies: number[] = [];
  let failedEdits = 0;
  await Promise.all(
    peers.map(async (peer, client) => {
      for (let edit = 0; edit < options.edits; edit += 1) {
        const marker = `${tag}-c${String(client)}-e${String(edit)}`;
        const begin = performance.now();
        try {
          await peer.edit(marker);
          latencies.push(performance.now() - begin);
          confirmed.push(marker);
        } catch {
          // Later edits build on the failed one, which the server may not hold, so they would
          // be parked unpersisted and then read as lost. Stop this peer and count the rest failed.
          failedEdits += options.edits - edit;
          break;
        }
        await sleep(options.intervalMs);
      }
    }),
  );
  for (const peer of peers) peer.close();
  const wallMs = performance.now() - started;

  const { readBodyMarkdown } = await import('../body.ts');
  const body = await readBodyMarkdown({
    collabUrl: session.endpoints.collabUrl,
    itemId: docId,
    token,
    ...(deps.fetchImpl === undefined ? {} : { fetchImpl: deps.fetchImpl }),
  });
  const { lost, duplicated } = checkMarkers(body.markdown, tag, confirmed);
  const sorted = latencies.sort((left, right) => left - right);
  const ok =
    lost.length === 0 && duplicated.length === 0 && failedEdits === 0 && connectErrors === 0;

  printResult(
    {
      scenario: 'collab-edit',
      docId,
      clients: options.clients,
      edits: options.edits,
      confirmedEdits: confirmed.length,
      failedEdits,
      connectErrors,
      lost: { count: lost.length, first: lost.slice(0, 5) },
      duplicated: { count: duplicated.length, first: duplicated.slice(0, 5) },
      persistedMs: {
        p50: Math.round(percentile(sorted, 50)),
        p95: Math.round(percentile(sorted, 95)),
        max: Math.round(percentile(sorted, 100)),
      },
      closeCodes: tally.closeCodes,
      notices: tally.notices,
      wallMs: Math.round(wallMs),
      ok,
    },
    output,
  );
  if (!ok) process.exitCode = 1;
}
