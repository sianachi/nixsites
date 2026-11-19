import * as Y from 'yjs';
import { z } from 'zod';

const MAX_DELTA = 1024 * 1024;
const MAX_REPLAY = 24 * 1024 * 1024;
const MAX_PAGES = 128;
const sequence = z.string().regex(/^(?:0|[1-9][0-9]{0,18})$/u);

function encoded(bytes: number) {
  return z
    .string()
    .min(1)
    .max(Math.ceil(bytes / 3) * 4);
}

const pageSchema = z.object({
  docId: z.uuid(),
  headSeq: sequence,
  updates: z.array(z.object({ seq: sequence, update: encoded(MAX_DELTA) })),
  checkpoint: z.object({ seq: sequence, update: encoded(MAX_REPLAY) }).optional(),
});
const receiptSchema = z.object({ docId: z.uuid(), seq: sequence });
export const bodyRevisionSchema = z.strictObject({ docId: z.uuid(), headSeq: sequence });
export type BodyRevision = z.infer<typeof bodyRevisionSchema>;

export interface BodySource {
  readonly collabUrl: string;
  readonly itemId: string;
  readonly token: string;
  readonly fetchImpl?: typeof fetch;
}

/** A refusal received from Collab, or an uncertain transport failure after sending the delta. */
export class GuardedBodyError extends Error {
  constructor(
    message: string,
    readonly uncertain: boolean,
    readonly stale = false,
  ) {
    super(message);
  }
}

function endpoint(source: BodySource): URL {
  const origin = new URL(source.collabUrl);
  if (
    !['http:', 'https:'].includes(origin.protocol) ||
    origin.username ||
    origin.password ||
    origin.search ||
    origin.hash
  ) {
    throw new Error('Invalid collaboration origin.');
  }
  const itemId = z.uuid().parse(source.itemId);
  return new URL(`documents/${itemId}/updates`, origin.href.replace(/\/?$/u, '/'));
}

function deadline(signal?: AbortSignal): AbortSignal {
  const timeout = AbortSignal.timeout(30_000);
  return signal === undefined ? timeout : AbortSignal.any([timeout, signal]);
}

function decode(value: string): Uint8Array {
  return Uint8Array.from(atob(value), (char) => char.charCodeAt(0));
}

async function readJson(response: Response, maxBytes: number): Promise<unknown> {
  const reader = response.body?.getReader();
  if (reader === undefined) throw new Error('Collaboration returned an empty response.');
  const chunks: string[] = [];
  const decoder = new TextDecoder('utf-8', { fatal: true });
  let size = 0;
  try {
    for (;;) {
      const chunk = await reader.read();
      if (chunk.done) break;
      size += chunk.value.byteLength;
      if (size > maxBytes) throw new Error('The collaboration response is too large.');
      chunks.push(decoder.decode(chunk.value, { stream: true }));
    }
  } finally {
    void reader.cancel().catch(() => undefined);
    reader.releaseLock();
  }
  chunks.push(decoder.decode());
  const data: unknown = JSON.parse(chunks.join(''));
  return data;
}

/** Reads a retained checkpoint and its consecutive updates. The caller owns the Y.Doc. */
export async function readGuardedBody(
  source: BodySource,
  signal?: AbortSignal,
): Promise<{ doc: Y.Doc; revision: BodyRevision }> {
  const url = endpoint(source);
  const doc = new Y.Doc();
  const request = source.fetchImpl ?? fetch;
  const abort = deadline(signal);
  let size = 0;
  let after = 0n;
  let documentId: string | undefined;
  const apply = (update: string, maximum: number) => {
    const bytes = decode(update);
    size += bytes.byteLength;
    if (bytes.byteLength > maximum || size > MAX_REPLAY)
      throw new Error('This collaboration body is too large to prepare safely.');
    Y.applyUpdate(doc, bytes);
  };
  try {
    for (let pageNumber = 0; pageNumber < MAX_PAGES; pageNumber++) {
      url.searchParams.set('after', after.toString());
      url.searchParams.set('fromCheckpoint', 'true');
      const response = await request(url, {
        headers: { authorization: `Bearer ${source.token}` },
        redirect: 'error',
        signal: abort,
      });
      if (!response.ok) throw new GuardedBodyError('Collaboration refused the body read.', false);
      const page = pageSchema.parse(
        await readJson(response, Math.ceil((MAX_REPLAY - size) / 3) * 4 + 96 * 1024),
      );
      if (documentId !== undefined && documentId !== page.docId)
        throw new GuardedBodyError('The body was replaced while preparing the action.', false);
      documentId = page.docId;
      if (pageNumber === 0 && page.checkpoint !== undefined) {
        apply(page.checkpoint.update, MAX_REPLAY);
        after = BigInt(page.checkpoint.seq);
      }
      for (const update of page.updates) {
        const seq = BigInt(update.seq);
        if (seq !== after + 1n) throw new Error('The collaboration update log is incomplete.');
        apply(update.update, MAX_DELTA);
        after = seq;
      }
      if (after === BigInt(page.headSeq)) {
        return { doc, revision: { docId: documentId, headSeq: page.headSeq } };
      }
      if (after > BigInt(page.headSeq) || page.updates.length === 0)
        throw new Error('The collaboration body changed while preparing the action.');
    }
    throw new Error('The collaboration body needs too many update pages.');
  } catch (error) {
    doc.destroy();
    throw error;
  }
}

/** Encode once before approval or dispatch. A retry must send these exact bytes. */
export function encodeGuardedBodyChange(doc: Y.Doc, change: () => void): string {
  const before = Y.encodeStateVector(doc);
  doc.transact(change);
  const bytes = Y.encodeStateAsUpdate(doc, before);
  if (bytes.byteLength > MAX_DELTA)
    throw new Error('The collaboration change is larger than 1 MiB.');
  const parts: string[] = [];
  for (let from = 0; from < bytes.length; from += 8192)
    parts.push(String.fromCharCode(...bytes.subarray(from, from + 8192)));
  return btoa(parts.join(''));
}

export async function appendGuardedBody(
  source: BodySource,
  revision: BodyRevision,
  update: string,
  actionId: string,
  signal?: AbortSignal,
): Promise<z.infer<typeof receiptSchema>> {
  const url = endpoint(source);
  const checked = bodyRevisionSchema.parse(revision);
  const [prefix, suffix] = actionId.includes(':') ? actionId.split(':', 2) : ['apply', actionId];
  const clientId = `nix-pet-${z
    .string()
    .regex(/^[a-z-]{1,24}$/u)
    .parse(prefix)}-${z.uuid().parse(suffix)}`;
  const body = JSON.stringify({
    update: encoded(MAX_DELTA).parse(update),
    clientId,
    expectedDocId: checked.docId,
    expectedHeadSeq: checked.headSeq,
  });
  try {
    const response = await (source.fetchImpl ?? fetch)(url, {
      method: 'POST',
      redirect: 'error',
      headers: { authorization: `Bearer ${source.token}`, 'content-type': 'application/json' },
      body,
      signal: deadline(signal),
    });
    if (response.status === 409)
      throw new GuardedBodyError(
        'The document changed after preview. Ask for a fresh review.',
        false,
        true,
      );
    if (!response.ok)
      throw new GuardedBodyError('Collaboration refused the body change.', response.status >= 500);
    const receipt = receiptSchema.parse(await readJson(response, 4096));
    if (receipt.docId !== checked.docId || BigInt(receipt.seq) !== BigInt(checked.headSeq) + 1n)
      throw new Error('Collaboration returned an unexpected write receipt.');
    return receipt;
  } catch (error) {
    if (error instanceof GuardedBodyError) throw error;
    throw new GuardedBodyError('The collaboration write could not be verified.', true);
  }
}
