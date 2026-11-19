import { useId, useLayoutEffect, useSyncExternalStore } from 'react';

const dialogs = new Map<string, string>();
const subscribers = new Set<() => void>();
interface DialogOwner {
  readonly owner: string;
  readonly itemId: string;
}
let active: DialogOwner | null = null;

function publish(): void {
  const latest = Array.from(dialogs.entries()).at(-1);
  active = latest === undefined ? null : { owner: latest[0], itemId: latest[1] };
  for (const subscriber of subscribers) subscriber();
}

function subscribe(subscriber: () => void): () => void {
  subscribers.add(subscriber);
  return () => {
    subscribers.delete(subscriber);
  };
}

const getActive = () => active;
const getServerActive = () => null;

export function useActivePetItemDialog(): DialogOwner | null {
  return useSyncExternalStore(subscribe, getActive, getServerActive);
}

export function usePetItemDialogOwner(itemId: string): boolean {
  const owner = useId();
  const current = useActivePetItemDialog();
  useLayoutEffect(() => {
    dialogs.set(owner, itemId);
    publish();
    return () => {
      dialogs.delete(owner);
      publish();
    };
  }, [itemId, owner]);
  return current?.owner === owner;
}
