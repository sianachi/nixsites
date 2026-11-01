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
}

let state: OfflineState = { bootOffline: false, networkDown: false, lastSyncedAt: null };
const listeners = new Set<() => void>();

export function getOfflineState(): OfflineState {
  return state;
}

export function setOfflineState(patch: Partial<OfflineState>): void {
  const next = { ...state, ...patch };
  if (
    next.bootOffline === state.bootOffline &&
    next.networkDown === state.networkDown &&
    next.lastSyncedAt === state.lastSyncedAt
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
