import { MirrorAccessRevokedError, MirrorHttpError, type MirrorApi } from './mirror.js';

export { MirrorHttpError };

/** No answer came back at all (offline, or the server is down): says nothing about the sync itself. */
export class MirrorUnreachableError extends Error {
  constructor(cause?: unknown) {
    super('The server could not be reached', { cause });
    this.name = 'MirrorUnreachableError';
  }
}

export interface FetchMirrorApiOptions {
  /** Core origin, e.g. `https://host`; `/api/v1/...` is appended. */
  coreUrl: string;
  /** Collab origin that serves `POST /documents/sync`. */
  collabUrl: string;
  getToken: () => Promise<string>;
  /** Waits out a rate limit; tests pass one that does not sleep. */
  wait?: (ms: number) => Promise<void>;
  /**
   * Called on a 401 after the caller had a chance to refresh the token. Return true only when the
   * session is definitively closed (the account is then wiped); false rethrows so a transient
   * expiry never wipes the mirror.
   */
  isSessionClosed?: () => boolean;
  fetch?: typeof fetch;
}

/** Transport-agnostic MirrorApi over fetch: bearer token from `getToken`, no cookies. */
export function createFetchMirrorApi(options: FetchMirrorApiOptions): MirrorApi {
  const doFetch = options.fetch ?? fetch;
  const wait =
    options.wait ?? ((ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms)));
  const trim = (url: string): string => url.replace(/\/+$/, '');
  const core = trim(options.coreUrl);
  const collab = trim(options.collabUrl);

  async function send(
    base: string,
    path: string,
    init: { method: 'GET' | 'POST'; body?: unknown },
    workspace: boolean,
  ): Promise<unknown> {
    const headers: Record<string, string> = {
      authorization: `Bearer ${await options.getToken()}`,
      accept: 'application/json',
    };
    if (init.body !== undefined) headers['content-type'] = 'application/json';
    let response: Response;
    for (let attempt = 0; ; attempt++) {
      response = await doFetch(`${base}${path}`, {
        method: init.method,
        headers,
        credentials: 'omit',
        cache: 'no-store',
        ...(init.body === undefined ? {} : { body: JSON.stringify(init.body) }),
      }).catch((error: unknown) => {
        throw new MirrorUnreachableError(error);
      });
      if (response.status !== 429 || attempt === 2) break;
      // Core's rate limit: wait as told (capped well inside the pass's 60 s lease), then try again.
      const seconds = Number(response.headers.get('retry-after') ?? '');
      await wait(Math.min(Number.isFinite(seconds) && seconds > 0 ? seconds * 1000 : 2000, 15_000));
    }
    if (response.status === 401 && options.isSessionClosed?.() === true)
      throw new MirrorAccessRevokedError('account');
    // Revocation wipes the workspace's copy and its queued edits, so only Core's own refusal (a
    // problem with a `code`) counts: a proxy's, bot check's or mid-deploy 403/404 must not.
    if (
      workspace &&
      (response.status === 403 || response.status === 404) &&
      (await response.json().then(
        (body: unknown) => typeof (body as { code?: unknown } | null)?.code === 'string',
        () => false,
      ))
    )
      throw new MirrorAccessRevokedError('workspace');
    if (!response.ok) throw new MirrorHttpError(response.status, path.split('?')[0] ?? path);
    return response.json();
  }

  const workspacePath = (id: string, tail: string): string =>
    `/api/v1/workspaces/${encodeURIComponent(id)}/sync/${tail}`;

  return {
    snapshot: ({ workspaceId, boundary, cursor, limit }) => {
      const query = new URLSearchParams({ limit: limit.toString() });
      if (boundary !== undefined) query.set('boundary', boundary);
      if (cursor !== undefined) query.set('cursor', cursor);
      return send(
        core,
        `${workspacePath(workspaceId, 'snapshot')}?${query.toString()}`,
        { method: 'GET' },
        true,
      );
    },
    changes: ({ workspaceId, after, limit }) =>
      send(
        core,
        `${workspacePath(workspaceId, 'changes')}?${new URLSearchParams({ after, limit: limit.toString() }).toString()}`,
        { method: 'GET' },
        true,
      ),
    reconcile: ({ workspaceId, itemIds }) =>
      send(
        core,
        workspacePath(workspaceId, 'reconcile'),
        { method: 'POST', body: { itemIds } },
        true,
      ),
    replay: ({ workspaceId, operation }) =>
      send(core, workspacePath(workspaceId, 'replay'), { method: 'POST', body: operation }, false),
    syncBodies: (input) => send(collab, '/documents/sync', { method: 'POST', body: input }, false),
  };
}
