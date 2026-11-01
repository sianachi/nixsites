import { runSyncPass } from '@nix/sync-core';
import type { MirrorApi } from '@nix/sync-core/mirror';
import type { SqliteMirrorStore } from '@nix/sync-sqlite';

import { WORKSPACES_SETTING } from './mirror-fetch';
import type { NativeMirror } from './native-mirror';

/** One full sync of the signed-in account into the shell's mirror, then its files. */

export interface FileCapability {
  readonly url: string;
  readonly byteLength: number;
  readonly sha256: string;
}

export interface SyncDeps {
  readonly mirror: Pick<NativeMirror, 'fileIndex' | 'setFileIndex' | 'fileDownload' | 'fileDelete'>;
  readonly store: SqliteMirrorStore;
  readonly api: MirrorApi;
  readonly ownerId: string;
  readonly listWorkspaces: () => Promise<
    readonly { id: string; name: string; lifecycleState: string }[]
  >;
  readonly capability: (itemId: string, versionId: string) => Promise<FileCapability>;
  readonly signal?: AbortSignal;
  readonly concurrency?: number;
}

export type SyncOutcome = 'done' | 'revoked';

/** Downloads are native and credential-free, so a capability must be a plain https (or local) URL. */
export function downloadable(url: string): boolean {
  try {
    const parsed = new URL(url);
    return (
      parsed.username === '' &&
      parsed.password === '' &&
      (parsed.protocol === 'https:' ||
        parsed.hostname === 'localhost' ||
        parsed.hostname === '127.0.0.1')
    );
  } catch {
    return false;
  }
}

export async function syncFiles(deps: SyncDeps, workspaceIds: readonly string[]): Promise<void> {
  const wanted = new Map<string, { versionId: string; byteLength: number; sha256: string }>();
  for (const workspaceId of workspaceIds)
    for (const item of await deps.store.listItems(workspaceId))
      if (item.file !== null && !item.locked && item.lifecycleState === 'active')
        wanted.set(item.id, item.file);

  const index: Record<string, string> = {};
  // Files of items that left the mirror, and versions that were replaced, go.
  for (const [itemId, versionId] of Object.entries(await deps.mirror.fileIndex())) {
    if (wanted.get(itemId)?.versionId === versionId) index[itemId] = versionId;
    else await deps.mirror.fileDelete(itemId, versionId);
  }
  await deps.mirror.setFileIndex(index);

  const todo = [...wanted].filter(([itemId, file]) => index[itemId] !== file.versionId);
  const fetchOne = async ([itemId, file]: (typeof todo)[number]): Promise<void> => {
    try {
      const capability = await deps.capability(itemId, file.versionId);
      if (capability.sha256 !== file.sha256 || !downloadable(capability.url)) return;
      const bytes = await deps.mirror.fileDownload(itemId, file.versionId, capability.url);
      if (bytes !== file.byteLength) {
        await deps.mirror.fileDelete(itemId, file.versionId);
        return;
      }
      index[itemId] = file.versionId;
      await deps.mirror.setFileIndex(index);
    } catch {
      // This file is retried on the next pass; one failure never stops the rest.
    }
  };
  let next = 0;
  const worker = async (): Promise<void> => {
    while (next < todo.length && deps.signal?.aborted !== true) {
      const entry = todo[next++];
      if (entry !== undefined) await fetchOne(entry);
    }
  };
  await Promise.all(Array.from({ length: deps.concurrency ?? 2 }, worker));
}

export async function runFullSync(deps: SyncDeps): Promise<SyncOutcome> {
  const all = await deps.listWorkspaces();
  const workspaces = all.filter((workspace) => workspace.lifecycleState === 'active');
  // Drops workspaces the account no longer reaches before any pass tries them.
  await deps.store.replaceWorkspaceList(
    workspaces.map((workspace) => ({ id: workspace.id, name: workspace.name })),
  );
  await deps.store.setSetting(WORKSPACES_SETTING, JSON.stringify(workspaces));
  for (const workspace of workspaces) {
    if (deps.signal?.aborted === true) return 'done';
    // One workspace failing (a lost connection, a bad page) must not hold up the others.
    const result = await runSyncPass({
      workspaceId: workspace.id,
      ownerId: deps.ownerId,
      store: deps.store,
      api: deps.api,
    }).catch(() => null);
    if (result?.status === 'revoked' && result.scope === 'account') return 'revoked';
  }
  await syncFiles(
    deps,
    workspaces.map((workspace) => workspace.id),
  );
  return 'done';
}

/**
 * Runs `run` at start, when the app comes back to the foreground, when the network returns, and
 * every `intervalMs` while visible. A trigger during a run joins it rather than starting another.
 */
export function createSyncScheduler(
  run: () => Promise<void>,
  intervalMs = 5 * 60_000,
): { start: () => () => void; trigger: () => Promise<void> } {
  let running: Promise<void> | null = null;
  const trigger = (): Promise<void> => {
    running ??= run()
      .catch(() => undefined)
      .finally(() => {
        running = null;
      });
    return running;
  };
  return {
    trigger,
    start() {
      const visible = (): void => {
        if (document.visibilityState === 'visible') void trigger();
      };
      const online = (): void => {
        void trigger();
      };
      document.addEventListener('visibilitychange', visible);
      window.addEventListener('online', online);
      const timer = setInterval(visible, intervalMs);
      void trigger();
      return () => {
        document.removeEventListener('visibilitychange', visible);
        window.removeEventListener('online', online);
        clearInterval(timer);
      };
    },
  };
}
