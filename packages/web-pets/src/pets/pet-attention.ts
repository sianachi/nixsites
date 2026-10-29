import { useSyncExternalStore } from 'react';

/** Why the pet wants its owner: a tool waiting on a decision, or a reply nobody has seen yet. */
export type PetAttention = 'approval' | 'reply';

/**
 * What the pet is waiting to tell its owner while it has no floating launcher to say it with.
 *
 * The launcher carries a dot, and words in its name, for a turn that needs approval or a reply
 * that arrived unseen. With the chat on its own page everywhere there is no launcher, and a turn
 * waiting on an approval would stop with nothing on screen to say so. The companion publishes the
 * same fact here instead, and the navigation - the way in to the page in that mode - shows it.
 *
 * A module-level value rather than context: the one companion that writes it and the navigation
 * that reads it sit in different branches of the shell, and exactly one companion is ever mounted.
 */
let current: PetAttention | null = null;
const listeners = new Set<() => void>();

export function publishPetAttention(next: PetAttention | null): void {
  if (next === current) return;
  current = next;
  for (const listener of listeners) listener();
}

function subscribe(listener: () => void): () => void {
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
}

function read(): PetAttention | null {
  return current;
}

export function usePetAttention(): PetAttention | null {
  return useSyncExternalStore(subscribe, read, read);
}

/** The words that go with the dot, for a name a screen reader reads and a tooltip shows. */
export function petAttentionText(attention: PetAttention): string {
  return attention === 'approval' ? 'needs approval' : 'new reply';
}
