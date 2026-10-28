import {
  itemSubtreeIds,
  notifyItemChildrenChanged,
  onItemChildrenChanged,
} from '../lib/item-children-changed';
import { isCanceledError, isNixApiError, items as coreItems, type Item } from '@nix/api-client';
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';

import { useApiClient } from '../api/api-client-provider';
import { toViewRequest, type PropertyDefinition, type View } from '../views/core/container-model';
import { useWorkspace } from '../workspaces/workspace-context';

/**
 * The workspace tree: the items, their shape, and the writes the shell performs on them.
 *
 * Talks to Core directly with `fetch` rather than through `@nix/api-client`'s cache layer, because
 * the client's descriptor execution wants a configured `NixClient` and this needs one thing: a
 * bearer token on each request. When the app-wide client is wired, this hook is the only place
 * that changes.
 *
 * **Every state the interface can be in is represented separately**, because the interface renders
 * them separately: loading is not empty, and a failed load is not an empty workspace. Collapsing
 * them is how a person ends up staring at "no items" when the request returned a 500.
 *
 * **Children are fetched per folder, on expansion.** The alternative - one request for the whole
 * workspace - is simpler and wrong at the size this is built for: a workspace with ten thousand
 * items would make opening the application a ten-thousand-row download to render twelve.
 */

export interface TreeItem {
  readonly id: string;
  readonly title: string;
  readonly type: string;
  readonly parentId: string | null;

  /**
   * Whether the item has at least one child that is not deleted.
   *
   * What the expand control is drawn from. Every item can hold children, so without this the tree
   * would either offer a control on every row - most of which would expand to nothing - or guess
   * from the item's type, which is what it used to do and why a note could not hold anything.
   */
  readonly hasChildren: boolean;
  readonly seq: number;
  readonly lifecycleState: string;

  /** Whether the item is protected from deletion. Absent reads as unprotected. */
  readonly noDelete?: boolean;

  /** Whether the item refuses new children. Absent reads as accepting them. */
  readonly noChildren?: boolean;

  /** Whether several people may edit it at once. Absent reads as collaborative. */
  readonly collaboration?: boolean;

  /**
   * The system feature managing the item (a linked calendar), or null. Its deletion protection is
   * lifted in settings, so the tree offers no toggle for it.
   */
  readonly managedBy?: string | null;
}

export type TreeStatus = 'loading' | 'ready' | 'error';

/**
 * What a create came back with.
 *
 * An id or a reason, never neither and never both. `null` alone was ambiguous at the call site -
 * it meant "refused", but the reason had gone into the tree's own error and rendered at the foot
 * of the sidebar, so a caller could report that something failed and not what.
 */
export interface CreateOutcome {
  readonly id: string | null;
  readonly refusal: string | null;
}

/**
 * What a {@link WorkspaceTree.remove} or {@link WorkspaceTree.restore} came back with.
 *
 * `null` means it happened; anything else is why it did not. There is no success payload to carry
 * alongside it the way {@link CreateOutcome} carries an id - the caller already knows which item it
 * asked to remove or restore - so a single field says everything a caller needs to decide whether
 * to trust what it was about to claim happened. Before this existed, both calls were fire-and-
 * forget: the caller set state claiming success in the same breath as the request, with the
 * request's own failure only reaching the tree's foot-of-sidebar error, never the caller that had
 * already told somebody the opposite. `rename` does not follow this pattern yet - it
 * still returns `Promise<void>` - which is a real inconsistency, left alone here as a separate,
 * later change rather than folded into this one.
 */
export interface MutationOutcome {
  readonly refusal: string | null;
}

/**
 * Where a reveal got to.
 *
 * `revealing` while the ancestor walk is in flight; then one of the four things it can have found.
 *
 * Each is a different sentence to a reader, which is the whole reason they are not one word.
 * `missing` says a document may be gone, so it is reserved for a server that actually said 404 -
 * a 500, a dropped connection or an expired session are `failed`, which says something went wrong
 * and offers to try again. Telling somebody their document may have been deleted because a proxy
 * hiccupped is a worse lie than saying nothing.
 */
export type RevealOutcome = 'revealing' | 'found' | 'missing' | 'forbidden' | 'failed';

export interface WorkspaceTree {
  readonly status: TreeStatus;
  readonly error: string | null;

  /** Every item loaded so far, in no particular order. Use `childrenOf` for display. */
  readonly items: readonly TreeItem[];

  /** The children of a folder, in sibling order, or the roots when given null. */
  readonly childrenOf: (parentId: string | null) => readonly TreeItem[];

  /** Whether a folder's children are on screen. */
  readonly isExpanded: (itemId: string) => boolean;

  /** Whether a folder's children are still being fetched. */
  readonly isLoadingChildren: (itemId: string) => boolean;

  /**
   * Whether Core withheld a folder's children because a lock covers it and this session has not
   * opened it. The folder is folded back, so expanding it again after unlocking reads them afresh.
   */
  readonly isLocked: (itemId: string) => boolean;

  /** The chain from the workspace root down to an item, the item last. */
  readonly breadcrumbs: (itemId: string) => readonly TreeItem[];

  readonly find: (itemId: string) => TreeItem | null;

  /**
   * Loads an item and its ancestors, expanding the chain so it is visible in the tree.
   *
   * What makes a shared link to a nested note work. The tree loads roots and then children on
   * expansion, so an item three folders down is not in it when somebody arrives on a link naming
   * that item - and the screen would otherwise say "select a note from the tree" about the note it
   * was asked for.
   */
  readonly reveal: (itemId: string) => Promise<void>;

  /**
   * What became of a {@link reveal} for one item, or null if none was ever asked for.
   *
   * A screen that opens an item the tree has not loaded has to say something while the walk up
   * its ancestors is in flight, and something different if the walk found nothing. Without this
   * the only honest thing available was "not in this workspace", which is a flat denial that is
   * wrong during the wait and wrong again for an item somebody simply may not see.
   */
  readonly revealOf: (itemId: string) => RevealOutcome | null;

  /** Forgets a settled reveal and walks again. For the one outcome worth another go. */
  readonly retryReveal: (itemId: string) => Promise<void>;

  readonly isCreating: boolean;
  readonly isSaving: boolean;

  readonly toggle: (itemId: string) => Promise<void>;
  readonly expand: (itemId: string) => Promise<void>;
  readonly create: (
    parentId: string | null,
    title: string,
    type?: string,
    properties?: Record<string, unknown>,
  ) => Promise<CreateOutcome>;
  /** Atomically creates a container together with the fields and views assembled by a wizard. */
  readonly createStructured: (setup: {
    readonly parentId: string | null;
    readonly title: string;
    readonly properties: readonly PropertyDefinition[];
    readonly views: readonly View[];
    readonly defaultView: string;
    readonly publishInteractiveFormViewId: string | null;
  }) => Promise<CreateOutcome & { readonly publicUrl?: string | null }>;
  readonly rename: (itemId: string, title: string) => Promise<void>;
  readonly move: (
    itemId: string,
    parentId: string | null,
    afterId: string | null,
  ) => Promise<MutationOutcome>;
  readonly remove: (itemId: string) => Promise<MutationOutcome>;

  /** Sets whether an item can be deleted and whether it accepts new children. */
  readonly setProtection: (
    itemId: string,
    protection: {
      readonly noDelete?: boolean;
      readonly noChildren?: boolean;
      readonly collaboration?: boolean;
    },
  ) => Promise<MutationOutcome>;
  readonly restore: (itemId: string) => Promise<MutationOutcome>;
  readonly reload: () => Promise<void>;
}

function toItem(payload: Item): TreeItem {
  return {
    id: payload.id,
    title: payload.title,
    type: payload.type,
    parentId: payload.parentId,
    hasChildren: payload.hasChildren,
    seq: Number(payload.seq),
    lifecycleState: payload.lifecycleState,
    noDelete: payload.noDelete,
    noChildren: payload.noChildren,
    collaboration: payload.collaboration,
    managedBy: payload.managedBy,
  };
}

function apiFailure(reason: unknown, fallback: string): string {
  return isNixApiError(reason) ? (reason.detail ?? fallback) : fallback;
}

function requestCanCommit(signal: AbortSignal, mounted: boolean): boolean {
  return !signal.aborted && mounted;
}

/** Whether a children read was refused because a lock covers the parent, rather than failing. */
function isLockedListing(reason: unknown): boolean {
  return isNixApiError(reason) && reason.code === 'items.locked';
}

export function useWorkspaceTree(): WorkspaceTree {
  const client = useApiClient();
  const { workspaceId } = useWorkspace();
  const activeRequests = useRef(new Set<AbortController>());
  const activeLoad = useRef<AbortController | null>(null);
  const activeRefresh = useRef<AbortController | null>(null);
  const mounted = useRef(true);
  const deletedSubtrees = useRef(new Map<string, ReadonlySet<string>>());
  const deletedIds = useRef(new Set<string>());
  const readRevision = useRef(0);

  const [status, setStatus] = useState<TreeStatus>('loading');
  const [error, setError] = useState<string | null>(null);
  const [items, setItems] = useState<readonly TreeItem[]>([]);
  const [expanded, setExpanded] = useState<ReadonlySet<string>>(new Set());
  const [loadingChildren, setLoadingChildren] = useState<ReadonlySet<string>>(new Set());
  const [lockedFolders, setLockedFolders] = useState<ReadonlySet<string>>(new Set());
  const markLocked = useCallback((itemId: string, locked: boolean): void => {
    setLockedFolders((current) => {
      if (current.has(itemId) === locked) return current;
      const next = new Set(current);
      if (locked) next.add(itemId);
      else next.delete(itemId);
      return next;
    });
  }, []);

  // A ref rather than state, because `reveal` has to read it to decide whether to run at all - and
  // reading state inside a callback would mean the callback changed identity every time a reveal
  // settled, which is the loop this exists to stop. The counter beside it is what tells React a
  // render is due, since mutating a ref does not.
  const revealsRef = useRef(new Map<string, RevealOutcome>());
  const [, setRevealTick] = useState(0);
  const bumpReveals = useCallback((): void => {
    setRevealTick((tick) => tick + 1);
  }, []);
  const [isCreating, setIsCreating] = useState(false);
  const [isSaving, setIsSaving] = useState(false);

  const fetchChildren = useCallback(
    async (parentId: string | null, signal: AbortSignal): Promise<readonly TreeItem[]> => {
      const revision = readRevision.current;
      const children: TreeItem[] = [];
      for await (const item of client.paginate(
        coreItems.listItems(workspaceId, {
          ...(parentId === null ? {} : { parentId }),
          pageSize: 200,
        }),
        { signal },
      )) {
        children.push(toItem(item));
      }
      if (revision === readRevision.current) return children;
      return parentId !== null && deletedIds.current.has(parentId)
        ? []
        : children.filter((item) => !deletedIds.current.has(item.id));
    },
    [client, workspaceId],
  );

  /**
   * Replaces one parent's children wholesale.
   *
   * Merging would leave an item that was deleted elsewhere on screen forever, because a merge has
   * no way to learn that something is gone - only that it was not mentioned.
   */
  const absorb = useCallback(
    (parentId: string | null, children: readonly TreeItem[], revision: number): void => {
      if (revision !== readRevision.current) return;
      setItems((current) => {
        if (parentId !== null && !current.some((item) => item.id === parentId)) return current;
        const nextIds = new Set(children.map((item) => item.id));
        const removed = itemSubtreeIds(
          current,
          current
            .filter((item) => item.parentId === parentId && !nextIds.has(item.id))
            .map((item) => item.id),
        );
        return [
          ...current.filter((item) => item.parentId !== parentId && !removed.has(item.id)),
          ...children,
        ];
      });
    },
    [],
  );

  const load = useCallback(async (): Promise<void> => {
    const revision = readRevision.current;
    activeLoad.current?.abort();
    const controller = new AbortController();
    activeLoad.current = controller;
    activeRequests.current.add(controller);
    setStatus('loading');
    setError(null);

    try {
      const roots = await fetchChildren(null, controller.signal);
      if (controller.signal.aborted || !mounted.current || revision !== readRevision.current)
        return;

      setItems(roots);
      setExpanded(new Set());
      setStatus('ready');
    } catch (reason) {
      if (
        controller.signal.aborted ||
        isCanceledError(reason) ||
        !mounted.current ||
        revision !== readRevision.current
      )
        return;
      setError(apiFailure(reason, 'Core could not be reached.'));
      setStatus('error');
    } finally {
      activeRequests.current.delete(controller);
      if (activeLoad.current === controller) activeLoad.current = null;
    }
  }, [fetchChildren]);

  const refresh = useCallback(async (): Promise<void> => {
    activeRefresh.current?.abort();
    activeLoad.current?.abort();
    const controller = new AbortController();
    activeRefresh.current = controller;
    activeRequests.current.add(controller);
    const revision = ++readRevision.current;
    setLoadingChildren(new Set());
    revealsRef.current.clear();
    bumpReveals();
    const parents: (string | null)[] = [null, ...expanded];
    const loaded = new Map<string | null, readonly TreeItem[]>();
    try {
      // Read only branches already on screen, with at most four requests in flight.
      await Promise.all(
        Array.from({ length: Math.min(4, parents.length) }, async () => {
          while (parents.length > 0 && requestCanCommit(controller.signal, mounted.current)) {
            const parentId = parents.shift();
            if (parentId === undefined) return;
            try {
              const children = await fetchChildren(parentId, controller.signal);
              if (
                !requestCanCommit(controller.signal, mounted.current) ||
                revision !== readRevision.current
              )
                return;
              loaded.set(parentId, children);
              if (parentId !== null) markLocked(parentId, false);
            } catch (reason) {
              if (
                !requestCanCommit(controller.signal, mounted.current) ||
                isCanceledError(reason) ||
                revision !== readRevision.current
              )
                return;
              if (
                parentId !== null &&
                (isLockedListing(reason) ||
                  (isNixApiError(reason) && (reason.status === 403 || reason.status === 404)))
              ) {
                loaded.set(parentId, []);
                absorb(parentId, [], revision);
                markLocked(parentId, isLockedListing(reason));
              } else throw reason;
            }
          }
        }),
      );
      if (controller.signal.aborted || !mounted.current || revision !== readRevision.current)
        return;
      // Apply the whole read together so a moved expanded branch cannot lose its children.
      setItems((current) => {
        const next = [
          ...current.filter((item) => !loaded.has(item.parentId)),
          ...[...loaded.values()].flat(),
        ];
        const children = new Map<string | null, TreeItem[]>();
        for (const item of next) {
          const siblings = children.get(item.parentId) ?? [];
          siblings.push(item);
          children.set(item.parentId, siblings);
        }
        const visible = new Set<string>();
        const pending: (string | null)[] = [null];
        for (const parentId of pending)
          for (const item of children.get(parentId) ?? []) {
            if (visible.has(item.id)) continue;
            visible.add(item.id);
            pending.push(item.id);
          }
        return next.filter((item) => visible.has(item.id));
      });
      setError(null);
      setStatus('ready');
    } catch (reason) {
      if (!controller.signal.aborted && mounted.current && revision === readRevision.current) {
        if (isNixApiError(reason) && (reason.status === 403 || reason.status === 404)) {
          setItems([]);
          setExpanded(new Set());
          setStatus('error');
        }
        setError(apiFailure(reason, 'The workspace could not be refreshed.'));
      }
      controller.abort();
    } finally {
      activeRequests.current.delete(controller);
      if (activeRefresh.current === controller) activeRefresh.current = null;
    }
  }, [absorb, bumpReveals, expanded, fetchChildren, markLocked]);

  useEffect(() => {
    mounted.current = true;
    const pendingRequests = activeRequests.current;
    // queueMicrotask so the first setState lands after the effect returns rather than during it,
    // which is what stops the initial render cascading.
    queueMicrotask(() => {
      if (mounted.current) void load();
    });
    return () => {
      mounted.current = false;
      for (const controller of pendingRequests) controller.abort();
      pendingRequests.clear();
    };
  }, [load]);

  const expand = useCallback(
    async (itemId: string): Promise<void> => {
      const revision = readRevision.current;
      const controller = new AbortController();
      activeRequests.current.add(controller);
      setExpanded((current) => new Set(current).add(itemId));
      setLoadingChildren((current) => new Set(current).add(itemId));

      try {
        const children = await fetchChildren(itemId, controller.signal);
        if (!controller.signal.aborted && mounted.current && revision === readRevision.current) {
          absorb(itemId, children, revision);
          markLocked(itemId, false);
        }
      } catch (reason) {
        if (
          !controller.signal.aborted &&
          !isCanceledError(reason) &&
          mounted.current &&
          revision === readRevision.current
        ) {
          if (isLockedListing(reason)) {
            markLocked(itemId, true);
            // Not a failure: the item is locked and its contents stay hidden until it is opened
            // from its own page. Recorded, so the row says "locked" rather than "empty", and folded
            // back here, so expanding it again after unlocking reads the children afresh.
            setExpanded((current) => {
              const next = new Set(current);
              next.delete(itemId);
              return next;
            });
          } else {
            setError(apiFailure(reason, 'Core could not be reached.'));
          }
        }
      } finally {
        activeRequests.current.delete(controller);
        if (
          requestCanCommit(controller.signal, mounted.current) &&
          revision === readRevision.current
        ) {
          setLoadingChildren((current) => {
            const next = new Set(current);
            next.delete(itemId);
            return next;
          });
        }
      }
    },
    [absorb, fetchChildren, markLocked],
  );

  useEffect(
    () =>
      onItemChildrenChanged((detail) => {
        if (detail.workspaceId !== workspaceId) return;
        if (detail.removedItemIds.length > 0) {
          readRevision.current += 1;
          const root = detail.removedItemIds[0];
          if (root !== undefined && !deletedSubtrees.current.has(root))
            deletedSubtrees.current.set(root, new Set(detail.removedItemIds));
          for (const id of detail.removedItemIds) deletedIds.current.add(id);
          for (const id of detail.removedItemIds) revealsRef.current.set(id, 'missing');
          bumpReveals();
          setItems((current) => {
            const removed = itemSubtreeIds(current, detail.removedItemIds);
            return current.filter((item) => !removed.has(item.id));
          });
          return;
        }
        if (detail.restoredItemIds.length > 0) {
          readRevision.current += 1;
          for (const root of detail.restoredItemIds) {
            for (const id of deletedSubtrees.current.get(root) ?? [root])
              revealsRef.current.delete(id);
            deletedSubtrees.current.delete(root);
          }
          deletedIds.current = new Set(
            [...deletedSubtrees.current.values()].flatMap((ids) => [...ids]),
          );
          bumpReveals();
        }
        if (detail.parentId === null) void refresh();
        else void expand(detail.parentId);
      }),
    [bumpReveals, expand, refresh, workspaceId],
  );

  const toggle = useCallback(
    async (itemId: string): Promise<void> => {
      if (expanded.has(itemId)) {
        setExpanded((current) => {
          const next = new Set(current);
          next.delete(itemId);
          return next;
        });
        return;
      }

      await expand(itemId);
    },
    [expand, expanded],
  );

  const reveal = useCallback(
    async (itemId: string): Promise<void> => {
      const revision = readRevision.current;
      // Once per identifier, ever. Without this, an item that cannot be revealed - deleted, or
      // not this caller's to see - is retried by every render that asks, because `find` keeps
      // answering null and nothing remembers having tried. That is a thirty-two request walk per
      // render, and it arrives exactly when somebody opens a stale link.
      // Once per identifier - except after a failure, which is worth another go. Without the
      // first half, an item that cannot be revealed is retried by every render, because `find`
      // keeps answering null and nothing remembers having tried; without the second, one dropped
      // request would leave that item unreachable for the rest of the session.
      const already = revealsRef.current.get(itemId);
      if (already !== undefined && already !== 'failed') {
        return;
      }
      revealsRef.current.set(itemId, 'revealing');
      bumpReveals();

      const found: TreeItem[] = [];
      const expand = new Set<string>();
      const controller = new AbortController();
      activeRequests.current.add(controller);

      const settle = (outcome: RevealOutcome): void => {
        if (controller.signal.aborted || !mounted.current || revision !== readRevision.current)
          return;
        revealsRef.current.set(itemId, outcome);
        bumpReveals();
      };

      try {
        await walk();
      } catch (reason) {
        // A dropped connection, a token refresh that failed, anything that rejected rather than
        // answered. Left unhandled this would keep the entry on `revealing` for the rest of the
        // session, and the screen reading from it would say "Finding this item…" forever with no
        // control on it - a dead end reached by a different road than the one this replaced.
        if (!controller.signal.aborted && !isCanceledError(reason) && mounted.current) {
          settle('failed');
        }
      } finally {
        activeRequests.current.delete(controller);
      }

      return;

      // Walk up from the item, fetching each ancestor. Bounded rather than trusting the chain to
      // terminate: the database forbids cycles, and a client that looped anyway would hang the tab.
      async function walk(): Promise<void> {
        let cursor: string | null = itemId;
        let guard = 32;
        let refusal: RevealOutcome | null = null;

        while (cursor !== null && guard > 0) {
          let loaded: TreeItem;
          try {
            loaded = toItem(
              await client.query(coreItems.itemById(cursor), { signal: controller.signal }),
            );
          } catch (reason) {
            if (isNixApiError(reason)) {
              refusal =
                reason.status === 403 ? 'forbidden' : reason.status === 404 ? 'missing' : 'failed';
              break;
            }
            throw reason;
          }
          if (controller.signal.aborted || !mounted.current || revision !== readRevision.current)
            return;
          found.push(loaded);

          if (loaded.parentId !== null) {
            expand.add(loaded.parentId);
          }

          cursor = loaded.parentId;
          guard -= 1;
        }

        if (found.length === 0) {
          settle(refusal ?? 'missing');
          return;
        }

        if (controller.signal.aborted || !mounted.current || revision !== readRevision.current)
          return;

        setItems((current) => {
          const known = new Set(current.map((entry) => entry.id));
          return [...current, ...found.filter((entry) => !known.has(entry.id))];
        });

        setExpanded((current) => new Set([...current, ...expand]));

        // The ancestors are now present but their other children are not, so a revealed note would
        // appear as its parent's only child. Fetching each level puts its siblings back.
        for (const parentId of expand) {
          let siblings: readonly TreeItem[];
          try {
            siblings = await fetchChildren(parentId, controller.signal);
          } catch (reason) {
            if (
              !requestCanCommit(controller.signal, mounted.current) ||
              revision !== readRevision.current
            )
              return;
            // A locked ancestor withholds its other children. The path to the revealed item is
            // already known, so it is shown on its own rather than the reveal failing.
            if (isLockedListing(reason)) {
              markLocked(parentId, true);
              continue;
            }
            throw reason;
          }
          if (
            !requestCanCommit(controller.signal, mounted.current) ||
            revision !== readRevision.current
          )
            return;
          absorb(parentId, siblings, revision);
        }

        settle('found');
      }
    },
    [absorb, bumpReveals, client, fetchChildren, markLocked],
  );

  const retryReveal = useCallback(
    async (itemId: string): Promise<void> => {
      revealsRef.current.delete(itemId);
      bumpReveals();
      await reveal(itemId);
    },
    [bumpReveals, reveal],
  );

  const create = useCallback(
    async (
      parentId: string | null,
      title: string,
      type = 'note',
      properties?: Record<string, unknown>,
    ): Promise<CreateOutcome> => {
      const controller = new AbortController();
      activeRequests.current.add(controller);
      setIsCreating(true);
      try {
        const created = toItem(
          await client.execute(
            coreItems.createItem(workspaceId, { type, title, parentId, properties }),
            { signal: controller.signal },
          ),
        );
        if (controller.signal.aborted || !mounted.current) {
          return { id: null, refusal: 'The item creation was cancelled.' };
        }
        setItems((current) => [...current, created]);

        // A child created inside a collapsed folder would otherwise be invisible, which reads as
        // the creation having failed.
        if (parentId !== null) {
          setExpanded((current) => new Set(current).add(parentId));
        }

        return { id: created.id, refusal: null };
      } catch (reason) {
        return { id: null, refusal: apiFailure(reason, 'The item could not be created.') };
      } finally {
        activeRequests.current.delete(controller);
        if (mounted.current) setIsCreating(false);
      }
    },
    [client, workspaceId],
  );

  const createStructured = useCallback(
    async (setup: {
      readonly parentId: string | null;
      readonly title: string;
      readonly properties: readonly PropertyDefinition[];
      readonly views: readonly View[];
      readonly defaultView: string;
      readonly publishInteractiveFormViewId: string | null;
    }): Promise<CreateOutcome & { readonly publicUrl?: string | null }> => {
      const controller = new AbortController();
      activeRequests.current.add(controller);
      setIsCreating(true);
      try {
        const result = await client.execute(
          coreItems.createStructuredItem(workspaceId, {
            type: 'note',
            title: setup.title,
            parentId: setup.parentId,
            schema: {
              inherit: true,
              properties: setup.properties.map((property) => ({
                ...property,
                options: property.options.length === 0 ? null : property.options,
                choiceSource: property.choiceSource ?? null,
              })),
            },
            views: { views: setup.views.map(toViewRequest), default: setup.defaultView },
            publishInteractiveFormViewId: setup.publishInteractiveFormViewId,
          }),
          { signal: controller.signal },
        );
        if (controller.signal.aborted || !mounted.current) {
          return { id: null, refusal: 'This setup creation was cancelled.' };
        }
        const created = toItem(result.item);
        setItems((current) => [...current, created]);
        const createdParent = setup.parentId;
        if (createdParent !== null) {
          setExpanded((current) => new Set(current).add(createdParent));
        }
        return { id: created.id, refusal: null, publicUrl: result.publicForm?.url ?? null };
      } catch (reason) {
        return {
          id: null,
          refusal: apiFailure(
            reason,
            'This setup could not be sent. Check the connection and try again.',
          ),
        };
      } finally {
        activeRequests.current.delete(controller);
        if (mounted.current) setIsCreating(false);
      }
    },
    [client, workspaceId],
  );

  const rename = useCallback(
    async (itemId: string, title: string): Promise<void> => {
      const controller = new AbortController();
      activeRequests.current.add(controller);
      setIsSaving(true);
      try {
        const updated = toItem(
          await client.execute(coreItems.renameItem(workspaceId, itemId, title), {
            signal: controller.signal,
          }),
        );
        if (requestCanCommit(controller.signal, mounted.current)) {
          setItems((current) => current.map((item) => (item.id === itemId ? updated : item)));
        }
      } catch (reason) {
        if (!controller.signal.aborted && !isCanceledError(reason) && mounted.current) {
          setError(apiFailure(reason, 'The title could not be saved.'));
        }
      } finally {
        activeRequests.current.delete(controller);
        if (mounted.current) setIsSaving(false);
      }
    },
    [client, workspaceId],
  );

  const move = useCallback(
    async (
      itemId: string,
      parentId: string | null,
      afterId: string | null,
    ): Promise<MutationOutcome> => {
      const controller = new AbortController();
      activeRequests.current.add(controller);
      setIsSaving(true);
      let confirmed = false;
      try {
        const moved = toItem(
          await client.execute(coreItems.moveItem(workspaceId, itemId, { parentId, afterId }), {
            signal: controller.signal,
          }),
        );
        confirmed = true;
        if (controller.signal.aborted || !mounted.current) return { refusal: null };
        setItems((current) => current.map((item) => (item.id === itemId ? moved : item)));

        // Container views read their own children, so both lists they may be showing are told;
        // an unloaded source falls back to a workspace-wide refresh.
        const from = items.find((item) => item.id === itemId);
        notifyItemChildrenChanged(workspaceId, parentId);
        notifyItemChildrenChanged(workspaceId, from === undefined ? null : from.parentId);

        // The destination's order changed for every sibling, not just the moved item, so its
        // children are re-read rather than patched.
        const revision = readRevision.current;
        const siblings = await fetchChildren(parentId, controller.signal);
        if (requestCanCommit(controller.signal, mounted.current)) {
          absorb(parentId, siblings, revision);
        }
        return { refusal: null };
      } catch (reason) {
        if (confirmed) {
          if (mounted.current)
            setError('The item moved, but the destination could not be refreshed.');
          return { refusal: null };
        }
        const refusal =
          isNixApiError(reason) && reason.code === 'items.move_would_create_cycle'
            ? 'An item cannot be moved inside itself.'
            : isLockedListing(reason)
              ? 'Unlock the locked item first. Nothing can be moved into or out of it while it is locked.'
              : apiFailure(
                  reason,
                  'The move could not be confirmed. Check the workspace before retrying.',
                );
        if (!controller.signal.aborted && !isCanceledError(reason) && mounted.current) {
          setError(refusal);
        }
        return { refusal };
      } finally {
        activeRequests.current.delete(controller);
        if (mounted.current) setIsSaving(false);
      }
    },
    [absorb, client, fetchChildren, items, workspaceId],
  );

  const remove = useCallback(
    async (itemId: string): Promise<MutationOutcome> => {
      const controller = new AbortController();
      activeRequests.current.add(controller);
      setIsSaving(true);
      try {
        await client.execute(coreItems.deleteItem(workspaceId, itemId), {
          signal: controller.signal,
        });
        if (!controller.signal.aborted && mounted.current) {
          const removed = itemSubtreeIds(items, [itemId]);
          deletedSubtrees.current.set(itemId, removed);
          notifyItemChildrenChanged(
            workspaceId,
            items.find((item) => item.id === itemId)?.parentId ?? null,
            { removedItemIds: [...removed] },
          );
        }
        return { refusal: null };
      } catch (reason) {
        const refusal = apiFailure(reason, 'The item could not be deleted.');
        if (!controller.signal.aborted && !isCanceledError(reason) && mounted.current)
          setError(refusal);
        return { refusal };
      } finally {
        activeRequests.current.delete(controller);
        if (mounted.current) setIsSaving(false);
      }
    },
    [client, items, workspaceId],
  );

  const setProtection = useCallback(
    async (
      itemId: string,
      protection: {
        readonly noDelete?: boolean;
        readonly noChildren?: boolean;
        readonly collaboration?: boolean;
      },
    ): Promise<MutationOutcome> => {
      const controller = new AbortController();
      activeRequests.current.add(controller);
      setIsSaving(true);
      try {
        const updated = toItem(
          await client.execute(coreItems.setItemProtection(workspaceId, itemId, protection), {
            signal: controller.signal,
          }),
        );
        if (!controller.signal.aborted && mounted.current) {
          setItems((current) => current.map((item) => (item.id === itemId ? updated : item)));
        }
        return { refusal: null };
      } catch (reason) {
        const refusal = apiFailure(reason, 'The protection could not be changed.');
        if (!controller.signal.aborted && !isCanceledError(reason) && mounted.current)
          setError(refusal);
        return { refusal };
      } finally {
        activeRequests.current.delete(controller);
        if (mounted.current) setIsSaving(false);
      }
    },
    [client, workspaceId],
  );

  const restore = useCallback(
    async (itemId: string): Promise<MutationOutcome> => {
      const controller = new AbortController();
      activeRequests.current.add(controller);
      setIsSaving(true);
      try {
        const restored = toItem(
          await client.execute(coreItems.restoreItem(workspaceId, itemId), {
            signal: controller.signal,
          }),
        );
        if (!controller.signal.aborted && mounted.current) {
          setItems((current) => [...current.filter((item) => item.id !== itemId), restored]);
          notifyItemChildrenChanged(workspaceId, restored.parentId, { restoredItemIds: [itemId] });
        }
        return { refusal: null };
      } catch (reason) {
        const refusal = apiFailure(reason, 'The item could not be restored.');
        if (!controller.signal.aborted && !isCanceledError(reason) && mounted.current)
          setError(refusal);
        return { refusal };
      } finally {
        activeRequests.current.delete(controller);
        if (mounted.current) setIsSaving(false);
      }
    },
    [client, workspaceId],
  );

  const byParent = useMemo(() => {
    const index = new Map<string | null, TreeItem[]>();
    for (const item of items) {
      const siblings = index.get(item.parentId) ?? [];
      siblings.push(item);
      index.set(item.parentId, siblings);
    }

    for (const siblings of index.values()) {
      siblings.sort((left, right) => left.seq - right.seq);
    }

    return index;
  }, [items]);

  const byId = useMemo(() => new Map(items.map((item) => [item.id, item])), [items]);

  const childrenOf = useCallback(
    (parentId: string | null): readonly TreeItem[] => byParent.get(parentId) ?? [],
    [byParent],
  );

  const breadcrumbs = useCallback(
    (itemId: string): readonly TreeItem[] => {
      const chain: TreeItem[] = [];
      let cursor = byId.get(itemId) ?? null;

      // Bounded by the number of loaded items rather than trusting the chain to terminate: the
      // database forbids cycles, and a client that looped anyway would hang the tab.
      let guard = byId.size + 1;
      while (cursor !== null && guard > 0) {
        chain.unshift(cursor);
        cursor = cursor.parentId === null ? null : (byId.get(cursor.parentId) ?? null);
        guard -= 1;
      }

      return chain;
    },
    [byId],
  );

  return {
    status,
    error,
    items,
    childrenOf,
    revealOf: (itemId) => revealsRef.current.get(itemId) ?? null,
    retryReveal,
    isExpanded: (itemId) => expanded.has(itemId),
    isLoadingChildren: (itemId) => loadingChildren.has(itemId),
    isLocked: (itemId) => lockedFolders.has(itemId),
    breadcrumbs,
    reveal,
    find: (itemId) => byId.get(itemId) ?? null,
    isCreating,
    isSaving,
    toggle,
    expand,
    create,
    createStructured,
    rename,
    move,
    remove,
    setProtection,
    restore,
    reload: load,
  };
}
