/**
 * Document history: fetch wrappers for the six collaboration-service routes named in
 * `docs/plans/version-history.md`.
 *
 * **Same service, same seam as the editor's body.** History lives in the collaboration service,
 * not Core, exactly like the note body itself - so this module reaches it the way
 * `../import/note-body-writer.ts` does: a plain `fetch` against `/collab`, a bearer token the
 * caller already holds (from `useAuth().getAccessToken()`), and no dependency on `@nix/api-client`,
 * which speaks to Core alone. `../editor/collab-sync.ts` is the WebSocket half of this same
 * boundary; this is its REST half.
 *
 * **Every response is validated**, in the style of `packages/api-client/src/schemas/*.ts`: a Zod
 * schema stands between whatever bytes came back and the types the rest of the app trusts. A
 * response that parses to the wrong shape is not "probably fine" - it is a refusal, the same as a
 * 4xx, because trusting it would be indistinguishable from a bug the server does not know it has.
 *
 * **Every HTTP problem becomes a `HistoryRefusal`** (`{ code, detail }`), never a throw. The one
 * exception is `fetchStateAt`'s 404: the contract carries a legitimate empty answer through that
 * status (`history_state_unavailable`, meaning the seq is beyond the head or older than the
 * retained base), so that one case comes back as `{ ok: true, value: null }` rather than a
 * refusal - it is not something that went wrong, it is the server telling the truth about what it
 * still has.
 *
 * A thrown exception (a network failure, or an aborted request) is left to throw: callers that
 * care about cancellation, `use-document-history.ts` among them, already have to tell an abort
 * apart from every other failure, and folding it into `HistoryResult` would only make them unwrap
 * it again.
 */

import { z } from 'zod';

const DEFAULT_BASE_URL = '/collab';

/** Everything a call needs to reach one document's history on the collaboration service. */
export interface HistoryRequestConfig {
  readonly itemId: string;
  readonly token: string;
  readonly baseUrl?: string;
  readonly signal?: AbortSignal;
  readonly fetchImpl?: (url: string, init?: RequestInit) => Promise<Response>;
}

export interface HistoryRefusal {
  readonly code: string;
  readonly detail: string;
}

export type HistoryResult<T> =
  | { readonly ok: true; readonly value: T }
  | { readonly ok: false; readonly refusal: HistoryRefusal };

const revisionSchema = z.object({
  seq: z.number().int(),
  fromSeq: z.number().int(),
  actorId: z.string(),
  startedAt: z.iso.datetime({ offset: true }),
  endedAt: z.iso.datetime({ offset: true }),
  updateCount: z.number().int(),
  name: z.string().nullable(),
});

export type Revision = z.infer<typeof revisionSchema>;

const revisionPageSchema = z.object({
  revisions: z.array(revisionSchema),
  hasMore: z.boolean(),
  // Coerced: the sequence is a Postgres bigint, and the driver hands the collab service a
  // string for it, which is what crosses the wire.
  headSeq: z.coerce.number().int(),
});

export type RevisionPage = z.infer<typeof revisionPageSchema>;

const namedVersionSchema = z.object({
  seq: z.number().int(),
  name: z.string(),
  createdBy: z.string(),
  createdAt: z.iso.datetime({ offset: true }),
});

export type NamedVersion = z.infer<typeof namedVersionSchema>;

const namedVersionsResponseSchema = z.object({
  versions: z.array(namedVersionSchema),
});

const documentStateSchema = z.object({
  seq: z.number().int(),
  /** A ProseMirror document in JSON form; the caller (the read-only renderer) owns its shape. */
  document: z.record(z.string(), z.unknown()),
  plaintext: z.string(),
  // Coerced: the sequence is a Postgres bigint, and the driver hands the collab service a
  // string for it, which is what crosses the wire.
  headSeq: z.coerce.number().int(),
});

export type DocumentState = z.infer<typeof documentStateSchema>;

const restoreResponseSchema = z.object({
  // Coerced: the sequence is a Postgres bigint, and the driver hands the collab service a
  // string for it, which is what crosses the wire.
  headSeq: z.coerce.number().int(),
});

const MALFORMED_RESPONSE: HistoryRefusal = {
  code: 'history.malformed_response',
  detail: 'The server returned a response this version of the app does not understand.',
};

/** GET `/documents/:itemId/history?before=&limit=`. */
export async function listRevisions(
  config: HistoryRequestConfig,
  options: { readonly before?: number; readonly limit: number },
): Promise<HistoryResult<RevisionPage>> {
  const params = new URLSearchParams({ limit: String(options.limit) });
  if (options.before !== undefined) {
    params.set('before', String(options.before));
  }
  const response = await send(config, `/documents/${config.itemId}/history?${params.toString()}`, {
    method: 'GET',
  });
  if (!response.ok) {
    return { ok: false, refusal: await refusalFromResponse(response) };
  }
  return parse(response, revisionPageSchema);
}

/**
 * GET `/documents/:itemId/history/:seq`. `value` is `null`, not a refusal, when the server says
 * the state at this seq is no longer reconstructable (`history_state_unavailable`).
 */
export async function fetchStateAt(
  config: HistoryRequestConfig,
  seq: number,
): Promise<HistoryResult<DocumentState | null>> {
  const response = await send(config, `/documents/${config.itemId}/history/${String(seq)}`, {
    method: 'GET',
  });
  if (response.status === 404) {
    const refusal = await refusalFromResponse(response);
    return refusal.code === 'history_state_unavailable'
      ? { ok: true, value: null }
      : { ok: false, refusal };
  }
  if (!response.ok) {
    return { ok: false, refusal: await refusalFromResponse(response) };
  }
  return parse(response, documentStateSchema);
}

/** POST `/documents/:itemId/history/:seq/restore`. Needs write access; attributed to the caller. */
export async function restoreRevision(
  config: HistoryRequestConfig,
  seq: number,
): Promise<HistoryResult<{ readonly headSeq: number }>> {
  const response = await send(
    config,
    `/documents/${config.itemId}/history/${String(seq)}/restore`,
    { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({}) },
  );
  if (!response.ok) {
    return { ok: false, refusal: await refusalFromResponse(response) };
  }
  return parse(response, restoreResponseSchema);
}

/** GET `/documents/:itemId/versions`. */
export async function listNamedVersions(
  config: HistoryRequestConfig,
): Promise<HistoryResult<readonly NamedVersion[]>> {
  const response = await send(config, `/documents/${config.itemId}/versions`, { method: 'GET' });
  if (!response.ok) {
    return { ok: false, refusal: await refusalFromResponse(response) };
  }
  const result = await parse(response, namedVersionsResponseSchema);
  return result.ok ? { ok: true, value: result.value.versions } : result;
}

/** POST `/documents/:itemId/versions`. Needs write access; pins a snapshot at `seq`. */
export async function nameVersion(
  config: HistoryRequestConfig,
  seq: number,
  name: string,
): Promise<HistoryResult<NamedVersion>> {
  const response = await send(config, `/documents/${config.itemId}/versions`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ seq, name }),
  });
  if (!response.ok) {
    return { ok: false, refusal: await refusalFromResponse(response) };
  }
  return parse(response, namedVersionSchema);
}

/** DELETE `/documents/:itemId/versions/:seq`. Needs write access. */
export async function deleteNamedVersion(
  config: HistoryRequestConfig,
  seq: number,
): Promise<HistoryResult<true>> {
  const response = await send(config, `/documents/${config.itemId}/versions/${String(seq)}`, {
    method: 'DELETE',
  });
  if (!response.ok) {
    return { ok: false, refusal: await refusalFromResponse(response) };
  }
  return { ok: true, value: true };
}

/** Every request's shared shape: the base URL, the bearer token, the caller's abort signal. */
async function send(
  config: HistoryRequestConfig,
  path: string,
  init: {
    readonly method: string;
    readonly headers?: Record<string, string>;
    readonly body?: string;
  },
): Promise<Response> {
  const fetchImpl = config.fetchImpl ?? globalThis.fetch;
  const baseUrl = config.baseUrl ?? DEFAULT_BASE_URL;
  // `exactOptionalPropertyTypes` refuses an explicit `undefined` for an optional property, so
  // `body` and `signal` are included only when there is one - never assigned `undefined` in
  // place of being left out.
  return fetchImpl(`${baseUrl}${path}`, {
    method: init.method,
    headers: { ...init.headers, authorization: `Bearer ${config.token}` },
    ...(init.body === undefined ? {} : { body: init.body }),
    ...(config.signal === undefined ? {} : { signal: config.signal }),
  });
}

/** Reads and validates a 2xx body; a 204 has none. A response is read for this exactly once. */
async function parse<T>(response: Response, schema: z.ZodType<T>): Promise<HistoryResult<T>> {
  let body: unknown;
  try {
    body = response.status === 204 ? undefined : await response.json();
  } catch {
    return { ok: false, refusal: MALFORMED_RESPONSE };
  }
  const parsed = schema.safeParse(body);
  if (!parsed.success) {
    return { ok: false, refusal: MALFORMED_RESPONSE };
  }
  return { ok: true, value: parsed.data };
}

/**
 * The collaboration service's own `{ code, detail }` shape (`apps/collab/src/http/server.ts`'s
 * `problem`), read from a response this call has not yet consumed. Falls back to a generic
 * refusal built from the status when the body is missing or not that shape.
 */
async function refusalFromResponse(response: Response): Promise<HistoryRefusal> {
  try {
    const body = (await response.json()) as { code?: unknown; detail?: unknown };
    const code =
      typeof body.code === 'string' && body.code.length > 0
        ? body.code
        : `http_${String(response.status)}`;
    const detail =
      typeof body.detail === 'string' && body.detail.length > 0
        ? body.detail
        : response.statusText || 'The request was refused.';
    return { code, detail };
  } catch {
    return {
      code: `http_${String(response.status)}`,
      detail: response.statusText || 'The request was refused.',
    };
  }
}
