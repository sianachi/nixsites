import { useSyncExternalStore } from 'react';

/**
 * What the iOS shell knows about its connection, outside React so the API client's fetch and the
 * auth provider can read it without a render. Inert in the browser and the PWA: nothing sets it.
 */
export interface OfflineState {
  /** The app opened (or fell back) on the synced copy because Core could not be reached. */
  readonly bootOffline: boolean;
  /** The last request to Core got no answer. Cleared by the next one that does. */
  readonly networkDown: boolean;
  readonly lastSyncedAt: number | null;
  /** Bumped when something on this device needs a sync pass now (an unlock). */
  readonly resyncRequestedAt: number | null;
  /** What the last sync that reached the server could not do; null when it did everything. */
  readonly syncProblem: string | null;
  /** Files above the size cap that the copy leaves online-only. */
  readonly onlineOnlyFiles: number;
}

let state: OfflineState = {
  bootOffline: false,
  networkDown: false,
  lastSyncedAt: null,
  resyncRequestedAt: null,
  syncProblem: null,
  onlineOnlyFiles: 0,
};
const listeners = new Set<() => void>();

export function getOfflineState(): OfflineState {
  return state;
}

export function setOfflineState(patch: Partial<OfflineState>): void {
  const next = { ...state, ...patch };
  if (
    next.bootOffline === state.bootOffline &&
    next.networkDown === state.networkDown &&
    next.lastSyncedAt === state.lastSyncedAt &&
    next.resyncRequestedAt === state.resyncRequestedAt &&
    next.syncProblem === state.syncProblem &&
    next.onlineOnlyFiles === state.onlineOnlyFiles
  )
    return;
  state = next;
  for (const listener of [...listeners]) listener();
}

export function subscribeOfflineState(listener: () => void): () => void {
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
}

export function useOfflineState(): OfflineState {
  return useSyncExternalStore(subscribeOfflineState, getOfflineState, getOfflineState);
}

/** Whether requests must be answered from the synced copy without trying the network. */
export const isBootOffline = (): boolean => state.bootOffline;

/**
 * `run` once, shortly after a burst of calls. The store tells its subscribers of every change, and
 * a file sync changes it once per file: each screen that re-reads on a change does so once.
 */
export function coalesced(run: () => void, ms = 250): () => void {
  let timer: ReturnType<typeof setTimeout> | undefined;
  return () => {
    clearTimeout(timer);
    timer = setTimeout(run, ms);
  };
}
