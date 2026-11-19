import { useSyncExternalStore } from 'react';

// Unsent messages survive reopening their workspace or item conversation.
// Drafts live in memory and are cleared on reload or sign-out.
const drafts = new Map<string, string>();
const listeners = new Set<() => void>();

function subscribe(onChange: () => void): () => void {
  listeners.add(onChange);
  return () => {
    listeners.delete(onChange);
  };
}

function writeDraft(key: string, next: string): void {
  if (next === (drafts.get(key) ?? '')) return;
  if (next === '') drafts.delete(key);
  else drafts.set(key, next);
  listeners.forEach((listener) => {
    listener();
  });
}

export function usePetDraft(
  workspaceId: string,
  petId: string,
  rootItemId?: string,
): readonly [string, (next: string | ((current: string) => string)) => void] {
  const key = `${workspaceId}:${petId}${rootItemId ? `:${rootItemId}` : ''}`;
  const draft = useSyncExternalStore(
    subscribe,
    () => drafts.get(key) ?? '',
    () => '',
  );
  return [
    draft,
    (next) => {
      writeDraft(key, typeof next === 'function' ? next(drafts.get(key) ?? '') : next);
    },
  ];
}

/** Unsent messages belong to the outgoing account, including on shared workspaces. */
export function clearPetDrafts(): void {
  drafts.clear();
  listeners.forEach((listener) => {
    listener();
  });
}
