import { runSyncPass } from '@nix/sync-core';
import { MirrorHttpError, MirrorUnreachableError } from '@nix/sync-core/fetch-api';
import type { MirrorApi } from '@nix/sync-core/mirror';
import type { SqliteMirrorStore } from '@nix/sync-sqlite';

import { MAX_OFFLINE_FILE_BYTES, PROTECTED_SETTING, WORKSPACES_SETTING } from './mirror-fetch';
import type { NativeMirror } from './native-mirror';
import { closedByPassword } from './workspace-closed';

export { closedByPassword };

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
    readonly {
      id: string;
      name: string;
      lifecycleState: string;
      passwordProtected?: boolean | null;
      unlockedUntil?: string | null;
    }[]
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
  /** Files above the size cap: kept online-only, not a failure. */
  readonly onlineOnlyFiles: number;
  /** A pass got no answer from the network: the failures say nothing about the sync itself. */
  readonly unreachable: boolean;
  /** A pass stopped at a batch limit with changes still queued: another pass should follow now. */
  readonly more: boolean;
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

/**
 * Resolves with how many files could not be stored this time (each is retried on the next pass)
 * and how many are above the size cap and so stay online-only.
 * `unsettled` are workspaces whose pass did not finish this time (no answer, a failure, a rebuild
 * cut short): their files are neither fetched nor removed, since what they should hold is unknown
 * and removing them would mean downloading all of them again.
 */
export async function syncFiles(
  deps: SyncDeps,
  workspaceIds: readonly string[],
  unsettled: readonly string[] = [],
): Promise<{ failed: number; onlineOnly: number }> {
  const wanted = new Map<string, { versionId: string; byteLength: number; sha256: string }>();
  let onlineOnly = 0;
  for (const workspaceId of workspaceIds)
    for (const item of await deps.store.listFileItems(workspaceId))
      if (item.file !== null && !item.locked && item.lifecycleState === 'active') {
        if (item.file.byteLength > MAX_OFFLINE_FILE_BYTES) onlineOnly++;
        else wanted.set(item.id, item.file);
      }
  const kept = new Set<string>();
  for (const workspaceId of unsettled)
    for (const item of await deps.store.listFileItems(workspaceId).catch(() => []))
      kept.add(item.id);

  const index: Record<string, string> = {};
  // Files of items that left the mirror, and versions that were replaced, go.
  for (const [itemId, versionId] of Object.entries(await deps.mirror.fileIndex())) {
    if (wanted.get(itemId)?.versionId === versionId || kept.has(itemId)) index[itemId] = versionId;
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
  return { failed, onlineOnly };
}

export async function runFullSync(deps: SyncDeps): Promise<SyncOutcome> {
  const all = await deps.listWorkspaces();
  const workspaces = all.filter((workspace) => workspace.lifecycleState === 'active');
  // Drops workspaces the account no longer reaches before any pass tries them.
  await deps.store.replaceWorkspaceList(
    workspaces.map((workspace) => ({ id: workspace.id, name: workspace.name })),
  );
  await deps.store.setSetting(WORKSPACES_SETTING, JSON.stringify(workspaces));
  // Kept apart from the list so that, should the list ever be unreadable offline, the device still
  // knows which workspaces to keep closed rather than guessing they are open.
  await deps.store.setSetting(
    PROTECTED_SETTING,
    JSON.stringify(
      workspaces
        .filter((workspace) => workspace.passwordProtected === true)
        .map((workspace) => workspace.id),
    ),
  );
  const failedWorkspaces: string[] = [];
  let unreachable = false;
  let more = false;
  const settled: string[] = [];
  const unsettled: string[] = [];
  for (const workspace of workspaces) {
    if (deps.signal?.aborted === true)
      return { failedWorkspaces, failedFiles: 0, onlineOnlyFiles: 0, unreachable, more: false };
    // Closed, not revoked: no pass, so nothing is wiped. The next pass after an unlock picks it up.
    if (closedByPassword(workspace)) continue;
    // One workspace failing (a lost connection, a bad page) must not hold up the others.
    const result = await runSyncPass({
      workspaceId: workspace.id,
      ownerId: deps.ownerId,
      store: deps.store,
      api: deps.api,
    }).catch((error: unknown) => {
      // No answer came back at all; a TypeError from anywhere else is a fault and is reported.
      if (error instanceof MirrorUnreachableError) unreachable = true;
      // Two cases where nothing is wrong and the pass is simply run again: iOS suspended the page
      // mid-pass and the shell rolled the open transaction back (its 30 s idle limit), or the
      // server still rate limits after waiting (a long queue of offline changes; what was sent
      // is kept).
      else if (
        (error instanceof Error && error.message.includes('Transaction is not open')) ||
        (error instanceof MirrorHttpError && error.status === 429)
      )
        more = true;
      else {
        // The banner names the workspace; the reason (an HTTP status, a bad page) goes to the log.
        console.error(`Sync of workspace ${workspace.id} failed`, error);
        failedWorkspaces.push(workspace.name);
      }
      return null;
    });
    if (result?.status === 'revoked' && result.scope === 'account') return 'revoked';
    // A workspace the server took away is in neither list: its copy is gone, so its files go too.
    if (result === null || result.status === 'busy') unsettled.push(workspace.id);
    else if (result.status !== 'revoked') settled.push(workspace.id);
    if (result !== null && 'more' in result && result.more) more = true;
    if (
      result !== null &&
      (result.status === 'complete' || result.status === 'partial') &&
      result.replayedOperations + result.conflicts > 0
    )
      deps.onReplayed?.();
  }
  // Downloaded copies of a closed workspace's files go until it is unlocked: they are bytes of a
  // workspace this session may not read. Queued edits live in the outbox and are not touched.
  const { failed: failedFiles, onlineOnly: onlineOnlyFiles } = await syncFiles(
    deps,
    settled,
    unsettled,
  );
  return { failedWorkspaces, failedFiles, onlineOnlyFiles, unreachable, more };
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
 * every `intervalMs` while visible. A trigger during a run joins it rather than starting another;
 * `trigger(true)` (something changed that the running pass may already be past) and a run that
 * resolves true (it left queued work) are followed by one more run, at most `maxFollowUps` in a row.
 */
export function createSyncScheduler(
  run: () => Promise<boolean | undefined>,
  intervalMs = 5 * 60_000,
  maxFollowUps = 5,
): { start: () => () => void; trigger: (followUp?: boolean) => Promise<void> } {
  let running: Promise<void> | null = null;
  let requested = 0;
  const trigger = (followUp = false): Promise<void> => {
    if (running !== null) {
      if (followUp) requested++;
      return running;
    }
    running = (async () => {
      for (let runs = 0; runs <= maxFollowUps; runs++) {
        const before = requested;
        const more = await run().catch(() => false);
        if (requested === before && more !== true) return;
      }
    })().finally(() => {
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
