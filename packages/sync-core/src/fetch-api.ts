import { MirrorAccessRevokedError, type MirrorApi } from './mirror.js';

export class MirrorHttpError extends Error {
  constructor(
    readonly status: number,
    readonly path: string,
  ) {
    super(`Sync request failed with HTTP ${status.toString()}: ${path}`);
  }
}

export interface FetchMirrorApiOptions {
  /** Core origin, e.g. `https://host`; `/api/v1/...` is appended. */
  coreUrl: string;
  /** Collab origin that serves `POST /documents/sync`. */
  collabUrl: string;
  getToken: () => Promise<string>;
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
    const response = await doFetch(`${base}${path}`, {
      method: init.method,
      headers,
      credentials: 'omit',
      cache: 'no-store',
      ...(init.body === undefined ? {} : { body: JSON.stringify(init.body) }),
    });
    if (response.status === 401 && options.isSessionClosed?.() === true)
      throw new MirrorAccessRevokedError('account');
    if (workspace && (response.status === 403 || response.status === 404))
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
