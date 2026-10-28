/**
 * A short, passing notice for the person - "Link copied", "3 tabs closed" - published from
 * wherever the action happened and shown by the shell, which owns the one toast stack and the one
 * live region. A channel rather than a context so a control deep in a list, a menu built when it
 * opens, or a module with no React tree can all say something, and so the shell stays the only
 * thing that decides how it is said.
 */
export interface Notice {
  /** Replaces an earlier notice with the same key rather than stacking a second. */
  readonly key: string;
  readonly message: string;
  /** The one thing to do about it, when there is one. */
  readonly action?: { readonly label: string; readonly onAction: () => void };
}

const listeners = new Set<(notice: Notice) => void>();

export function publishNotice(notice: Notice): void {
  for (const listener of listeners) listener(notice);
}

export function onNotice(listener: (notice: Notice) => void): () => void {
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
}
