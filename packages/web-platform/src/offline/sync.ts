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
  /** Called when a pass replayed queued changes or found conflicts, so screens can refetch. */
  readonly onReplayed?: () => void;
}

/** What a full sync could not do, for the person to hear about. */
export interface SyncReport {
  /** Names of workspaces whose pass failed. */
  readonly failedWorkspaces: readonly string[];
  readonly failedFiles: number;
  /** A pass got no answer from the network: the failures say nothing about the sync itself. */
  readonly unreachable: boolean;
}

export type SyncOutcome = 'revoked' | SyncReport;

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

/** Resolves with how many files could not be stored this time; each is retried on the next pass. */
export async function syncFiles(deps: SyncDeps, workspaceIds: readonly string[]): Promise<number> {
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
  let failed = 0;
  const fetchOne = async ([itemId, file]: (typeof todo)[number]): Promise<void> => {
    try {
      const capability = await deps.capability(itemId, file.versionId);
      // A version that changed since the mirror saw it is the next pass's to fetch.
      if (capability.sha256 !== file.sha256) return;
      if (!downloadable(capability.url)) {
        failed++;
        return;
      }
      const stored = await deps.mirror.fileDownload(itemId, file.versionId, capability.url);
      if (stored === null) return;
      // The bytes on disk must be the bytes Core named, not just as many of them.
      if (
        stored.bytes !== file.byteLength ||
        stored.sha256.toLowerCase() !== file.sha256.toLowerCase()
      ) {
        await deps.mirror.fileDelete(itemId, file.versionId);
        failed++;
        return;
      }
      index[itemId] = file.versionId;
      await deps.mirror.setFileIndex(index);
    } catch {
      // This file is retried on the next pass; one failure never stops the rest.
      failed++;
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
  return failed;
}

export async function runFullSync(deps: SyncDeps): Promise<SyncOutcome> {
  const all = await deps.listWorkspaces();
  const workspaces = all.filter((workspace) => workspace.lifecycleState === 'active');
  // Drops workspaces the account no longer reaches before any pass tries them.
  await deps.store.replaceWorkspaceList(
    workspaces.map((workspace) => ({ id: workspace.id, name: workspace.name })),
  );
  await deps.store.setSetting(WORKSPACES_SETTING, JSON.stringify(workspaces));
  const failedWorkspaces: string[] = [];
  let unreachable = false;
  for (const workspace of workspaces) {
    if (deps.signal?.aborted === true) return { failedWorkspaces, failedFiles: 0, unreachable };
    // One workspace failing (a lost connection, a bad page) must not hold up the others.
    const result = await runSyncPass({
      workspaceId: workspace.id,
      ownerId: deps.ownerId,
      store: deps.store,
      api: deps.api,
    }).catch((error: unknown) => {
      // fetch rejects with a TypeError when no answer came back at all.
      if (error instanceof TypeError) unreachable = true;
      else failedWorkspaces.push(workspace.name);
      return null;
    });
    if (result?.status === 'revoked' && result.scope === 'account') return 'revoked';
    if (
      result !== null &&
      (result.status === 'complete' || result.status === 'partial') &&
      result.replayedOperations + result.conflicts > 0
    )
      deps.onReplayed?.();
  }
  const failedFiles = await syncFiles(
    deps,
    workspaces.map((workspace) => workspace.id),
  );
  return { failedWorkspaces, failedFiles, unreachable };
}

/** One line for the person, or null when the report has nothing to say. */
export function describeSyncProblem(report: SyncReport): string | null {
  const parts: string[] = [];
  if (report.failedWorkspaces.length > 0)
    parts.push(`${report.failedWorkspaces.join(', ')} could not be synced`);
  if (report.failedFiles > 0)
    parts.push(
      report.failedFiles === 1
        ? '1 file could not be downloaded'
        : `${String(report.failedFiles)} files could not be downloaded`,
    );
  return parts.length === 0 ? null : `${parts.join('; ')}.`;
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
