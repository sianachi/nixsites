import {
  createContext,
  useContext,
  useLayoutEffect,
  useRef,
  type ReactNode,
  type RefObject,
} from 'react';
import { z } from 'zod';

import { browserSessionStorage } from '../lib/browser-storage';

const positions = new Map<string, number>();

/** Past this many remembered scrollers, the oldest is dropped rather than kept forever. */
const SCROLL_POSITION_LIMIT = 50;

const SCROLL_ENTRY_SCHEMA = z.tuple([z.string(), z.number()]);
const SCROLL_ENTRIES_SCHEMA = z.array(SCROLL_ENTRY_SCHEMA);

function storageKey(workspaceId: string): string {
  return `nix.pane-scroll:${workspaceId}`;
}

/**
 * The workspace this tab is currently addressing, read from the path rather than a store or
 * context - `layout/` only reaches `lib/`, and this module is a leaf itself, so it cannot ask a
 * feature what the workspace is. `/w/:workspaceId/...` is the one routing shape every editor
 * surface that mounts a pane lives under.
 */
function currentWorkspaceId(): string | null {
  if (typeof window === 'undefined') return null;
  return /^\/w\/([^/]+)/.exec(window.location.pathname)?.[1] ?? null;
}

/**
 * Which workspace `positions` currently holds entries for. A scroll position is only ever
 * meaningful within the workspace it was recorded in - restoring it into a different workspace
 * would show a person somebody else's note at the height they happened to leave it, or their own
 * from a workspace they have since left. So a change of workspace clears the map before it is
 * repopulated from that workspace's own storage, rather than merging the two.
 */
let scopedWorkspaceId: string | null = null;

function ensureWorkspaceScope(workspaceId: string | null): void {
  if (workspaceId === scopedWorkspaceId) return;
  scopedWorkspaceId = workspaceId;
  positions.clear();
  if (workspaceId === null) return;

  try {
    const raw = browserSessionStorage()?.getItem(storageKey(workspaceId));
    if (raw === null || raw === undefined) return;

    const parsed = SCROLL_ENTRIES_SCHEMA.safeParse(JSON.parse(raw));
    if (!parsed.success) return; // Corrupt or an older shape - start empty rather than throw.

    for (const [key, value] of parsed.data) positions.set(key, value);
  } catch {
    // Private browsing, a policy that blocks storage, or unparseable JSON. Either way the pane
    // still works with an empty map - only the restore-across-reload convenience is lost.
  }
}

function persistScope(workspaceId: string): void {
  try {
    browserSessionStorage()?.setItem(storageKey(workspaceId), JSON.stringify([...positions]));
  } catch {
    // Best-effort: the in-memory map still serves this tab for the rest of the session.
  }
}

/** How long a burst of scroll events is left to settle before the coalesced write lands. */
const PERSIST_DEBOUNCE_MS = 200;

/**
 * `positions` is updated synchronously on every scroll event, but the `sessionStorage.setItem`
 * behind `persistScope` is not free: it JSON-stringifies up to `SCROLL_POSITION_LIMIT` entries
 * and blocks the main thread, and a fast scroll fires dozens of times a second. Only the write is
 * coalesced here, trailing-edge - each call pushes the pending write `PERSIST_DEBOUNCE_MS` further
 * out, so it only actually lands once scrolling pauses. `flushPersist` exists for the moments a
 * pause is not guaranteed: a tab going away or the pane unmounting.
 */
let persistTimer: ReturnType<typeof setTimeout> | null = null;
let pendingPersistWorkspaceId: string | null = null;

function schedulePersist(workspaceId: string): void {
  pendingPersistWorkspaceId = workspaceId;
  if (persistTimer !== null) clearTimeout(persistTimer);
  persistTimer = setTimeout(() => {
    persistTimer = null;
    const id = pendingPersistWorkspaceId;
    pendingPersistWorkspaceId = null;
    if (id !== null) persistScope(id);
  }, PERSIST_DEBOUNCE_MS);
}

/** Writes a pending coalesced position immediately rather than waiting out the debounce. */
function flushPersist(): void {
  if (persistTimer === null) return;
  clearTimeout(persistTimer);
  persistTimer = null;
  const id = pendingPersistWorkspaceId;
  pendingPersistWorkspaceId = null;
  if (id !== null) persistScope(id);
}

const PaneViewportContext = createContext<RefObject<HTMLDivElement | null> | null>(null);

export interface PaneViewportProps {
  readonly className: string;
  readonly scrollKey?: string;
  readonly children: ReactNode;
}

/** The pane-owned vertical scroller, made discoverable without DOM climbing. */
export function PaneViewport({ className, children, scrollKey }: PaneViewportProps): ReactNode {
  const ref = useRef<HTMLDivElement>(null);
  useLayoutEffect(() => {
    const pane = ref.current;
    if (!pane || !scrollKey) return;
    ensureWorkspaceScope(currentWorkspaceId());
    const target = positions.get(scrollKey) ?? 0;

    // The pane's content - async, most of the time - has not necessarily grown tall enough yet
    // for `target` to be a reachable `scrollTop`: the assignment above gets silently clamped to
    // whatever the empty or partial pane can currently scroll to, which is 0 more often than not.
    // A `ResizeObserver` on the pane itself notices every later growth (a page's blocks arriving,
    // an image finishing layout) and retries the same assignment, so the restore lands once there
    // is finally room for it rather than only on the frame that happened to run first.
    let settled = false;
    const tryRestore = (): void => {
      if (settled) return;
      const reachable = pane.scrollHeight - pane.clientHeight;
      if (reachable >= target) {
        pane.scrollTop = target;
        settled = true;
        observer?.disconnect();
      }
    };

    const observer =
      typeof ResizeObserver === 'undefined'
        ? null
        : new ResizeObserver(() => {
            tryRestore();
          });
    observer?.observe(pane);
    tryRestore();

    const save = (): void => {
      // Any scroll the pane did not just make on this effect's own behalf is somebody looking
      // somewhere else on purpose - the observer above must not then drag them back to `target`
      // once the content grows further.
      settled = true;
      observer?.disconnect();
      positions.delete(scrollKey);
      positions.set(scrollKey, pane.scrollTop);
      if (positions.size > SCROLL_POSITION_LIMIT) {
        const oldest = positions.keys().next().value;
        if (oldest !== undefined) positions.delete(oldest);
      }
      if (scopedWorkspaceId !== null) schedulePersist(scopedWorkspaceId);
    };
    // A tab going to the background - navigated away, closed, or the OS suspending it - may
    // never run another scroll event or an unmount to flush a pending debounced write, so both
    // are treated as "leaving now": flush whatever is pending rather than lose it.
    const flushOnHide = (): void => {
      if (document.visibilityState === 'hidden') flushPersist();
    };
    document.addEventListener('visibilitychange', flushOnHide);
    window.addEventListener('pagehide', flushPersist);
    pane.addEventListener('scroll', save, { passive: true });
    return () => {
      save();
      flushPersist();
      pane.removeEventListener('scroll', save);
      document.removeEventListener('visibilitychange', flushOnHide);
      window.removeEventListener('pagehide', flushPersist);
      observer?.disconnect();
    };
  }, [scrollKey]);
  return (
    <PaneViewportContext.Provider value={ref}>
      <div ref={ref} data-pane-viewport="true" className={className}>
        {children}
      </div>
    </PaneViewportContext.Provider>
  );
}

export function usePaneViewport(): RefObject<HTMLDivElement | null> | null {
  return useContext(PaneViewportContext);
}
