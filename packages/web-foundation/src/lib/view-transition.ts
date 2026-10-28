/**
 * Runs a navigation inside a view transition, so the page crossfades from what was showing to
 * what replaces it instead of cutting - the browser's own default animation, with no stylesheet of
 * ours involved.
 *
 * **Why the callback waits for a commit signal.** The browser snapshots the old page, runs the
 * callback, and snapshots the new page once the callback's promise settles. The router applies a
 * navigation as a React transition, which `flushSync` cannot hurry, so a callback that returned as
 * soon as it had asked to navigate would photograph the old page twice and crossfade it into
 * itself. Instead the promise settles when the shell reports the new location has committed
 * (`viewCommitted`, from a layout effect keyed on the location), or after `COMMIT_TIMEOUT_MS` for
 * a change that commits no new location - so a transition can end early, never hang the page.
 *
 * Skipped - the update simply runs - where the browser has no view transitions, and where the
 * person has asked for reduced motion.
 */

const COMMIT_TIMEOUT_MS = 250;

let settlePending: (() => void) | null = null;

/** Called by the shell once a new location has committed, ending the transition waiting on it. */
export function viewCommitted(): void {
  const settle = settlePending;
  settlePending = null;
  settle?.();
}

export function withViewTransition(update: () => void): void {
  const transitions = document as Document & {
    startViewTransition?: (callback: () => Promise<void>) => unknown;
  };
  const reduced =
    typeof globalThis.matchMedia === 'function' &&
    globalThis.matchMedia('(prefers-reduced-motion: reduce)').matches;
  if (typeof transitions.startViewTransition !== 'function' || reduced) {
    update();
    return;
  }
  transitions.startViewTransition(
    () =>
      new Promise<void>((resolve) => {
        // A transition still waiting is superseded by this one; let it finish now.
        viewCommitted();
        const timer = setTimeout(settle, COMMIT_TIMEOUT_MS);
        function settle(): void {
          clearTimeout(timer);
          if (settlePending === settle) settlePending = null;
          resolve();
        }
        settlePending = settle;
        update();
      }),
  );
}
