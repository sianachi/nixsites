import {
  isCanceledError,
  isNixApiError,
  items as coreItems,
  structure as coreStructure,
  views as coreViews,
} from '@nix/api-client';
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import type { ZodType } from 'zod';

import { useApiClient } from '../../api/api-client-provider';
import { useWorkspace } from '../../workspaces/workspace-context';
import { onItemChildrenChanged } from '@nix/web-foundation/lib/item-children-changed';
import { useStaleWhileRevalidate } from '@nix/web-foundation/lib/use-stale-while-revalidate';
import { decorateItems, keepComputed } from '../../properties/computed';
import {
  ContainerViewsSchema,
  EffectiveSchemaSchema,
  ItemSchema,
  toViewRequest,
  type ContainerViews,
  type EffectiveSchema,
  type Item,
  type PropertyDefinition,
  type View,
} from './container-model';

/** A schema as an editor holds it: the properties this container declares, and whether it inherits. */
export interface SchemaDraft {
  readonly properties: readonly PropertyDefinition[];
  readonly inherit: boolean;
}

/**
 * Everything a container needs to be looked at: its schema, its views, and its children.
 *
 * One hook rather than three, because a view cannot render until all three have arrived and three
 * hooks would give the screen eight loading states to reason about instead of one.
 *
 * **Every state is represented separately.** Loading is not empty, and a failed load is not an
 * empty item - which is exactly the distinction a view has to draw, since an empty board and a
 * broken board look identical if you let them.
 */

type ContainerStatus = 'loading' | 'ready' | 'partial' | 'error';

export interface ContainerData {
  /**
   * The item whose container this is - what the hook was asked to load - or null at a workspace
   * root. Carried so a view whose data is not the children (the query view runs its own item's
   * stored filters) can name the item without reaching into the URL.
   */
  readonly itemId: string | null;

  readonly status: ContainerStatus;
  readonly error: string | null;

  /**
   * Whether a reload is under way while the previous data is still on screen.
   *
   * `status` only ever becomes `'loading'` for the very first load of this container - after
   * that, a reload keeps the last-known schema, views and children mounted and flips this instead,
   * so a filter panel, an open dialog or a scroll position that a full-panel swap would have thrown
   * away survives the refresh. A region can put this on its own `aria-busy`.
   */
  readonly refreshing: boolean;

  /**
   * Why the most recent background reload failed, or null when the last one that finished succeeded.
   *
   * Only ever set once there is data on screen to keep: a reload that fails before the first
   * successful load still becomes `status: 'error'`, because there is nothing to protect. A reload
   * that fails after the first one keeps the existing children, schema and views exactly as they
   * were and reports the failure here instead of discarding them.
   */
  readonly refreshError: string | null;

  /**
   * Whether Core withheld the children because a lock covers this item and this session has not
   * opened it. Not an error, and not "empty": the children exist and are behind a password, so a
   * view says so rather than drawing nothing. Reload after unlocking to read them.
   */
  readonly locked: boolean;

  readonly schema: EffectiveSchema | null;
  readonly views: ContainerViews | null;
  readonly children: readonly Item[];

  /**
   * Makes a child of this container, optionally with values already set.
   *
   * Returns the reason it was refused, or null when it was made.
   *
   * **Not implemented here.** The item tree already owns creation, and it does two things a second
   * implementation would get wrong: it puts the new item into the store the sidebar reads, and it
   * expands the parent so a child made inside a collapsed item is not invisible. So the screen
   * wires this to `tree.create`, and there is one create path rather than two that drift.
   */
  readonly create: (title: string, properties?: Record<string, unknown>) => Promise<string | null>;

  /**
   * Writes property values onto one child and refreshes it in place.
   *
   * Returns the reason it was refused, or null when it was stored - the same shape every other
   * mutation here returns, and for the same reason: the caller frequently has somewhere better to
   * put the refusal than the view does. A cell that was edited can say so in the cell; a card that
   * was dragged cannot, because nobody awaits a gesture.
   *
   * **Two channels, deliberately.** `writeError` below is the drag channel - a refusal for a caller
   * that fired and forgot. This return value is the awaited-edit channel. A caller uses one or the
   * other and never both: rendering both is two banners for one failure.
   */
  readonly setProperties: (
    itemId: string,
    properties: Record<string, unknown>,
  ) => Promise<string | null>;

  /**
   * Writes property values onto many children as one gesture, and answers for the whole gesture.
   *
   * The spreadsheet view's paste, fill and clear land here: one optimistic pass over the children
   * rather than one per row, requests issued with bounded concurrency rather than all at once, and
   * one reconciling pass at the end that keeps the rows the server took and puts back only the
   * rows it refused. The per-row `setProperties` above cannot do any of that - N calls in one tick
   * share one closure snapshot, so the first refusal used to revert every row in the gesture,
   * including the ones the server had already stored.
   *
   * Refuses a plan larger than {@link MAXIMUM_PLAN_WRITES} outright, with a sentence naming the
   * ceiling: a bigger gesture is a bulk operation the server should own, not a request storm.
   */
  readonly setPropertiesMany: (writes: readonly PlanWrite[]) => Promise<PlanOutcome>;

  /**
   * Replaces the schema this container declares.
   *
   * Returns the reason it was refused, or null when it was stored. A caller needs the reason
   * rather than a boolean: the server names which property is wrong and a form has to put that in
   * front of somebody, which "false" cannot do.
   */
  readonly setSchema: (schema: SchemaDraft) => Promise<string | null>;

  /**
   * Replaces the views this container offers, in switcher order.
   *
   * The default is carried across untouched unless it is passed, so an edit that was not about
   * which view opens does not quietly reset it.
   */
  readonly setViews: (
    views: readonly View[],
    defaultView?: string | null,
  ) => Promise<string | null>;

  /** Atomically appends fields and views assembled by the guided setup studio. */
  readonly appendViewSetup: (
    properties: readonly PropertyDefinition[],
    views: readonly View[],
    makeDefault: boolean,
    publishInteractiveFormViewId?: string | null,
  ) => Promise<string | null>;

  /** Atomically replaces one guided view setup while preserving unrelated views. */
  readonly replaceViewSetup: (
    originalViewId: string,
    properties: readonly PropertyDefinition[],
    views: readonly View[],
    publishInteractiveFormViewId?: string | null,
  ) => Promise<string | null>;

  /**
   * Remembers which view opens, when somebody deliberately switches to it.
   *
   * Never called for a URL that merely arrived carrying `?view=`. See the implementation for why
   * that distinction is the whole of this feature's risk.
   */
  readonly setDefaultView: (viewId: string) => Promise<string | null>;

  /**
   * Hides or shows the item's Document tab, keeping its views and default as they are.
   *
   * Returns Core's own sentence when it refuses - an item with no views has nothing else to open -
   * so the control can say why rather than snap back unexplained.
   */
  readonly setDocumentHidden: (hidden: boolean) => Promise<string | null>;

  /**
   * The last property write that failed, for a view to report without losing the item.
   *
   * The drag channel: a gesture nobody awaits still has to be answered somewhere, and a card that
   * has already snapped back to its old column is not a place to put a sentence. A view whose edits
   * *are* awaited - the list's cells - reads the return value instead and leaves this alone.
   */
  readonly writeError: string | null;

  /**
   * Whether the children shown are only the first pages of a larger container.
   *
   * `load` pages through the children endpoint until it is exhausted or {@link MAXIMUM_CHILDREN}
   * is reached; past that, this is true and a view must say the list is partial. A count asserted
   * over a truncated list - a grid's `aria-rowcount`, a filtered-empty state's total - is a claim
   * about items that were never loaded.
   */
  readonly truncated: boolean;

  readonly reload: () => Promise<void>;
}

/** One row's worth of a bulk write: the item, and the property changes going to it together. */
export interface PlanWrite {
  readonly itemId: string;

  /** How the row is named in the outcome's sentences - its title, since an id names nothing. */
  readonly label: string;

  readonly properties: Record<string, unknown>;
}

/** One refused or failed row of a bulk write, named so a sentence can say which row. */
interface PlanRefusal {
  readonly label: string;
  readonly reason: string;
}

/** What a bulk write did, for the one notice a view renders about it. */
export interface PlanOutcome {
  /** Rows the server stored. */
  readonly saved: number;

  /** Rows the server refused or that could not be sent, each put back as it was. */
  readonly refused: readonly PlanRefusal[];
}

/**
 * The most rows one gesture may write.
 *
 * A ceiling rather than a queue: past this, the honest answer is that the gesture is a bulk
 * operation the server should own end to end, and letting it run as a request storm would hold a
 * connection pool for minutes with no way to cancel.
 */
const MAXIMUM_PLAN_WRITES = 1000;

/** How many requests of one plan are in flight at once. */
const PLAN_CONCURRENCY = 6;

/**
 * The most children `load` pages in before reporting the container truncated.
 *
 * Twenty pages at the server's 200-per-page ceiling. Views window their rendering, so the cost of
 * a large container is memory and parse time rather than DOM - but it is not free, and a container
 * past this size needs server-side querying rather than a bigger client buffer.
 */
const MAXIMUM_CHILDREN = 4000;

/** The server's own page ceiling (`CursorPaging.MaximumPageSize`), asked for explicitly. */
const PAGE_SIZE = 200;

/**
 * How a container makes a child.
 *
 * Supplied by the screen rather than built here, because creation belongs to the item tree - see
 * `ContainerData.create`.
 */
export type CreateChild = (
  title: string,
  properties?: Record<string, unknown>,
) => Promise<string | null>;

export function useContainer(containerId: string | null, createChild?: CreateChild): ContainerData {
  const client = useApiClient();
  const { workspaceId } = useWorkspace();

  const { status, error, refreshing, refreshError, beginLoad, reportLoaded, reportFailed } =
    useStaleWhileRevalidate<ContainerStatus>('loading');
  const [writeError, setWriteError] = useState<string | null>(null);
  const [schema, storeSchema] = useState<EffectiveSchema | null>(null);
  const [views, storeViews] = useState<ContainerViews | null>(null);
  const [children, setChildren] = useState<readonly Item[]>([]);
  const [locked, setLocked] = useState(false);
  const [truncated, setTruncated] = useState(false);
  const defaultViewWrite = useRef(0);
  const activeLoad = useRef<AbortController | null>(null);
  const activeRequests = useRef(new Set<AbortController>());

  const load = useCallback(async (): Promise<void> => {
    activeLoad.current?.abort();
    const controller = new AbortController();
    activeLoad.current = controller;
    let refusalReason: unknown;
    const currentRead = (): boolean =>
      !controller.signal.aborted && activeLoad.current === controller;
    const discardRefused = (reason: unknown): void => {
      if (
        !currentRead() ||
        !isNixApiError(reason) ||
        (reason.status !== 403 && reason.status !== 404 && reason.status !== 423)
      )
        return;
      refusalReason = reason;
      setChildren([]);
      storeSchema(null);
      storeViews(null);
      setTruncated(false);
      setLocked(false);
      reportFailed(reason.detail ?? 'This item could not be read.', 'error', { blocking: true });
    };

    beginLoad();

    try {
      const loaded: Item[] = [];
      let partial = false;
      let withheld = false;
      const childRead = (async (): Promise<void> => {
        try {
          for await (const item of client.paginate(
            coreItems.listItems(workspaceId, {
              ...(containerId === null ? {} : { parentId: containerId }),
              pageSize: PAGE_SIZE,
            }),
            { signal: controller.signal },
          )) {
            loaded.push(ItemSchema.parse(item));
            if (loaded.length >= MAXIMUM_CHILDREN) {
              partial = true;
              break;
            }
          }
        } catch (reason) {
          // A lock withholds the children, not the item: its schema and views still load, so the
          // screen can draw its switcher and say the contents are locked.
          if (isNixApiError(reason) && reason.code === 'items.locked') {
            withheld = true;
            if (currentRead()) {
              setChildren([]);
              setLocked(true);
            }
            return;
          }
          discardRefused(reason);
          throw reason;
        }
      })();
      const boundaryWarnings: string[] = [];
      const readParsed = <T>(
        request: Promise<unknown>,
        schema: ZodType<T>,
        what: string,
        warning: string,
      ): Promise<T | null> =>
        request
          .then((value) => {
            const parsed = schema.safeParse(value);
            if (parsed.success) return parsed.data;
            console.warn(`The container ${what} did not match the contract:`, parsed.error.message);
            boundaryWarnings.push(warning);
            return null;
          })
          .catch((reason: unknown) => {
            if (isNixApiError(reason) && reason.code === 'http.404') return null;
            discardRefused(reason);
            throw reason;
          });
      const schemaRead =
        containerId === null
          ? Promise.resolve(null)
          : readParsed(
              client.query(coreStructure.effectiveSchema(containerId), {
                signal: controller.signal,
                forceRefresh: true,
              }),
              EffectiveSchemaSchema,
              'schema',
              'The item schema could not be read, so some fields are unavailable.',
            );
      const viewsRead =
        containerId === null
          ? Promise.resolve(null)
          : readParsed(
              client.query(coreViews.containerViewConfigurations(containerId), {
                signal: controller.signal,
                forceRefresh: true,
              }),
              ContainerViewsSchema,
              'views',
              'The item views could not be read, so some views are unavailable.',
            );

      const [childOutcome, schemaOutcome, viewsOutcome] = await Promise.allSettled([
        childRead,
        schemaRead,
        viewsRead,
      ]);
      if (childOutcome.status === 'rejected') throw childOutcome.reason;
      if (schemaOutcome.status === 'rejected') throw schemaOutcome.reason;
      if (viewsOutcome.status === 'rejected') throw viewsOutcome.reason;
      const nextSchema = schemaOutcome.value;
      const nextViews = viewsOutcome.value;
      if (controller.signal.aborted || activeLoad.current !== controller) return;
      setChildren(loaded);
      setLocked(withheld);
      setTruncated(partial);
      storeSchema(nextSchema);
      storeViews(nextViews);
      reportLoaded(
        boundaryWarnings.length === 0 ? 'ready' : 'partial',
        boundaryWarnings[0] ?? null,
      );
    } catch (reason) {
      if (controller.signal.aborted || activeLoad.current !== controller || isCanceledError(reason))
        return;
      const failure = refusalReason ?? reason;
      const message = isNixApiError(failure)
        ? (failure.detail ?? 'This item\u2019s contents could not be loaded.')
        : 'Core could not be reached.';
      const refused =
        isNixApiError(failure) &&
        (failure.status === 403 || failure.status === 404 || failure.status === 423);
      if (refused) {
        setChildren([]);
        storeSchema(null);
        storeViews(null);
        setTruncated(false);
        setLocked(false);
      }
      reportFailed(message, 'error', { blocking: refused });
    } finally {
      if (activeLoad.current === controller) activeLoad.current = null;
    }
  }, [client, containerId, workspaceId, beginLoad, reportLoaded, reportFailed]);

  useEffect(() => {
    let disposed = false;
    const pendingRequests = activeRequests.current;
    queueMicrotask(() => {
      if (!disposed) void load();
    });
    return () => {
      disposed = true;
      activeLoad.current?.abort();
      for (const controller of pendingRequests) controller.abort();
      pendingRequests.clear();
    };
  }, [load]);

  useEffect(
    () =>
      onItemChildrenChanged((detail) => {
        if (detail.workspaceId !== workspaceId) return;
        if (detail.removedItemIds.length > 0) {
          const removed = new Set(detail.removedItemIds);
          // Drop confirmed deletions before refreshing; a slow or failed refresh must not keep
          // a deleted card on screen. load() also cancels any read started before the deletion.
          setChildren((current) =>
            containerId !== null && removed.has(containerId)
              ? []
              : current.filter((item) => !removed.has(item.id)),
          );
          void load();
          return;
        }
        if (
          detail.restoredItemIds.length > 0 ||
          detail.parentId === null ||
          detail.parentId === containerId
        )
          void load();
      }),
    [load, workspaceId, containerId],
  );

  const setProperties = useCallback(
    async (itemId: string, properties: Record<string, unknown>): Promise<string | null> => {
      setWriteError(null);

      // Optimistic: the card moves under the pointer and the request follows. A drag that waited
      // for a round trip before moving would feel broken, and the reconcile below puts it back if
      // the server disagrees.
      //
      // The one item is captured, not the whole array: concurrent writes fired in one tick share
      // this closure, and reverting the array a write happened to see would wipe the optimistic
      // values of every other write in flight - including rows the server had already stored.
      const before = children.find((item) => item.id === itemId);
      setChildren((current) =>
        current.map((item) =>
          item.id === itemId
            ? { ...item, properties: { ...item.properties, ...properties } }
            : item,
        ),
      );

      const putBack = (): void => {
        // Put it back exactly where it was and say why. Leaving the card in its new column after
        // the server refused would be a lie that survives until the next reload.
        if (before !== undefined) {
          setChildren((current) => current.map((item) => (item.id === itemId ? before : item)));
        }
      };

      const controller = new AbortController();
      activeRequests.current.add(controller);
      try {
        const updated = ItemSchema.parse(
          await client.execute(coreStructure.setItemProperties(itemId, properties), {
            signal: controller.signal,
          }),
        );
        if (controller.signal.aborted) return 'That change was cancelled.';
        setChildren((current) =>
          current.map((item) => (item.id === itemId ? keepComputed(item, updated) : item)),
        );
        return null;
      } catch (reason) {
        // The request never reached the server - offline, DNS, a dropped connection. Without this
        // the promise rejected, nothing rolled back, and the cell kept showing a value the server
        // never took, with no sentence anywhere saying so.
        putBack();
        const failure = isNixApiError(reason)
          ? (reason.detail ?? 'That change could not be saved.')
          : 'That change could not be sent. Check the connection and try again.';
        setWriteError(failure);
        return failure;
      } finally {
        activeRequests.current.delete(controller);
      }
    },
    [children, client],
  );

  const setPropertiesMany = useCallback(
    async (writes: readonly PlanWrite[]): Promise<PlanOutcome> => {
      if (writes.length === 0) {
        return { saved: 0, refused: [] };
      }

      if (writes.length > MAXIMUM_PLAN_WRITES) {
        return {
          saved: 0,
          refused: [
            {
              label: 'The whole gesture',
              reason: `this would change ${String(writes.length)} rows at once, and the most one gesture takes is ${String(MAXIMUM_PLAN_WRITES)}.`,
            },
          ],
        };
      }

      // One optimistic pass for the whole plan, not one per row: N chained map passes are N
      // renders and N walks, and the plan is one gesture that should paint once.
      const beforeById = new Map(children.map((item) => [item.id, item]));
      const bags = new Map(writes.map((write) => [write.itemId, write.properties]));
      setChildren((current) =>
        current.map((item) => {
          const bag = bags.get(item.id);
          return bag === undefined ? item : { ...item, properties: { ...item.properties, ...bag } };
        }),
      );

      // Bounded concurrency rather than a request storm: a 1,000-row paste at full parallelism is
      // 1,000 sockets fighting the browser's own per-host cap, and there is no cancelling it.
      const results = new Array<{ write: PlanWrite; refusal: string | null; stored: Item | null }>(
        writes.length,
      );
      let next = 0;

      async function worker(): Promise<void> {
        for (;;) {
          const index = next;
          next += 1;
          const write = writes[index];
          if (write === undefined) {
            return;
          }

          try {
            const controller = new AbortController();
            activeRequests.current.add(controller);
            const updated = ItemSchema.safeParse(
              await client.execute(
                coreStructure.setItemProperties(write.itemId, write.properties),
                { signal: controller.signal },
              ),
            );
            activeRequests.current.delete(controller);
            results[index] = {
              write,
              refusal: null,
              stored: updated.success ? updated.data : null,
            };
          } catch (reason) {
            results[index] = {
              write,
              refusal: isNixApiError(reason)
                ? (reason.detail ?? 'That change could not be saved.')
                : 'that change could not be sent. Check the connection and try again.',
              stored: null,
            };
          }
        }
      }

      await Promise.all(
        Array.from({ length: Math.min(PLAN_CONCURRENCY, writes.length) }, () => worker()),
      );

      // One reconciling pass: rows the server stored take its answer, rows it refused go back
      // exactly as they were, rows it never mentioned keep their optimistic value. This is what
      // the per-row path cannot do - its rollback knows one row and one snapshot.
      const storedById = new Map<string, Item>();
      const revertIds = new Set<string>();
      const refused: PlanRefusal[] = [];

      for (const result of results) {
        if (result.refusal !== null) {
          refused.push({ label: result.write.label, reason: result.refusal });
          revertIds.add(result.write.itemId);
        } else if (result.stored !== null) {
          storedById.set(result.stored.id, result.stored);
        }
      }

      setChildren((current) =>
        current.map((item) => {
          const stored = storedById.get(item.id);
          if (stored !== undefined) {
            return stored;
          }
          if (revertIds.has(item.id)) {
            return beforeById.get(item.id) ?? item;
          }
          return item;
        }),
      );

      return { saved: writes.length - refused.length, refused };
    },
    [children, client],
  );

  /**
   * Sends one structure write, then reloads unless asked not to. Resolves to null on success or to
   * the sentence to show: Core's own detail when it refused, `offline` when nothing got through.
   */
  const submit = useCallback(
    async (
      send: (signal: AbortSignal) => Promise<unknown>,
      failure: string,
      offline = failure,
      reload = true,
    ): Promise<string | null> => {
      const controller = new AbortController();
      activeRequests.current.add(controller);
      try {
        await send(controller.signal);
        if (reload && !controller.signal.aborted) await load();
        return null;
      } catch (reason) {
        return isNixApiError(reason) ? (reason.detail ?? failure) : offline;
      } finally {
        activeRequests.current.delete(controller);
      }
    },
    [load],
  );

  const setSchema = useCallback(
    async (draft: SchemaDraft): Promise<string | null> => {
      if (containerId === null) {
        return 'A workspace root cannot declare a schema.';
      }

      return submit(
        (signal) =>
          client.execute(
            coreStructure.setItemSchema(containerId, {
              inherit: draft.inherit,
              properties: draft.properties.map((property) => ({
                key: property.key,
                label: property.label,
                type: property.type,

                // Only the select types carry options, and the server refuses a schema where anything
                // else does. Sending an empty array for the rest would be refused on a technicality
                // nobody typed.
                options: [...property.options],
                required: property.required,

                // Only a formula carries one, and the server refuses a schema where anything else does -
                // the same technicality the options line above avoids, for the same reason.
                expression: property.type === 'formula' ? (property.expression ?? null) : null,

                // The same rule for the rollup's pair. A count of the children carries no source, and
                // sending one would be refused for naming a property the fold ignores.
                aggregate: property.type === 'rollup' ? (property.aggregate ?? null) : null,
                source: property.type === 'rollup' ? (property.source ?? null) : null,
                choiceSource: property.choiceSource ?? null,
              })),
            }),
            { signal },
          ),
        'That could not be saved.',
      );
    },
    [client, containerId, submit],
  );

  const setViews = useCallback(
    async (next: readonly View[], defaultView?: string | null): Promise<string | null> => {
      if (containerId === null) {
        return 'A workspace root cannot offer views.';
      }

      // The default is sent as it stands unless the caller says otherwise. Omitting it on an edit
      // that was not about the default would reset it to the document, so somebody renaming a view
      // would find the item opening somewhere else afterwards.
      return submit(
        (signal) => {
          const body = ContainerViewsSchema.parse({
            views: next,
            unrenderable: [],
            default: defaultView === undefined ? (views?.default ?? null) : defaultView,
          });
          return client.execute(
            coreViews.setContainerViews(containerId, { views: body.views, default: body.default }),
            { signal },
          );
        },
        'That could not be saved.',
        'That could not be saved.',
        false,
      );
    },
    [client, containerId, submit, views],
  );

  const appendViewSetup = useCallback(
    async (
      properties: readonly PropertyDefinition[],
      addedViews: readonly View[],
      makeDefault: boolean,
      publishInteractiveFormViewId: string | null = null,
    ): Promise<string | null> => {
      if (containerId === null) return 'A workspace root cannot offer views.';
      return submit(
        (signal) =>
          client.execute(
            coreViews.appendViewSetup(containerId, {
              properties: properties.map((property) => ({
                ...property,
                options: property.options.length === 0 ? null : property.options,
                choiceSource: property.choiceSource ?? null,
              })),
              views: addedViews.map(toViewRequest),
              makeDefault,
              publishInteractiveFormViewId,
            }),
            { signal },
          ),
        'This view setup could not be saved.',
        'This view setup could not be sent. Check the connection and try again.',
      );
    },
    [client, containerId, submit],
  );

  const replaceViewSetup = useCallback(
    async (
      originalViewId: string,
      properties: readonly PropertyDefinition[],
      replacementViews: readonly View[],
      publishInteractiveFormViewId: string | null = null,
    ): Promise<string | null> => {
      if (containerId === null) return 'A workspace root cannot offer views.';
      return submit(
        (signal) =>
          client.execute(
            coreViews.replaceViewSetup(containerId, originalViewId, {
              schema: {
                inherit: schema?.inherit ?? true,
                properties: properties.map((property) => ({
                  ...property,
                  options: property.options.length === 0 ? null : property.options,
                  choiceSource: property.choiceSource ?? null,
                })),
              },
              originalPropertyKeys: schema?.declared.map((property) => property.key) ?? [],
              views: replacementViews.map(toViewRequest),
              publishInteractiveFormViewId,
            }),
            { signal },
          ),
        'This view setup could not be saved.',
        'This view setup could not be sent. Check the connection and try again.',
      );
    },
    [client, containerId, submit, schema?.declared, schema?.inherit],
  );

  /**
   * Stores which view the item opens as.
   *
   * **Called from the item's "Open as" choice and from nowhere else.** Following a link that
   * carries `?view=`, or glancing at another tab, must not write anything: the default is what the
   * item opens as for everybody in the workspace, and it changes only when somebody says so. That
   * rule is kept by where this is called rather than by a check inside it - there is no effect
   * watching the URL, so there is nothing to get wrong.
   */
  const setDefaultView = useCallback(
    async (viewId: string): Promise<string | null> => {
      if (containerId === null || views === null) {
        return null;
      }

      if (views.default === viewId) {
        return null;
      }

      const previous = views;
      const write = defaultViewWrite.current + 1;
      defaultViewWrite.current = write;

      // Switching views must not reload every child just to remember one identifier. Large
      // containers take several pages to load, and coupling this preference write to `load()`
      // made each switch discard the data already on screen and start that walk again. Optimistic
      // local state also makes a second quick switch compare against the choice the person just
      // made rather than a stale server response.
      storeViews({ ...views, default: viewId });

      const controller = new AbortController();
      activeRequests.current.add(controller);
      try {
        const body = ContainerViewsSchema.parse({ ...views, default: viewId });
        const response = await client.execute(
          coreViews.setContainerViews(containerId, { views: body.views, default: viewId }),
          { signal: controller.signal },
        );
        const parsed = ContainerViewsSchema.safeParse(response);
        if (!parsed.success) {
          console.warn('The saved views did not match the contract:', parsed.error.message);
          return 'The view was saved, but Core returned an unreadable response.';
        }
        if (defaultViewWrite.current === write) {
          storeViews(parsed.data);
        }
        return null;
      } catch (reason) {
        if (defaultViewWrite.current === write) {
          storeViews(previous);
        }
        return isNixApiError(reason)
          ? (reason.detail ?? 'That view could not be remembered.')
          : 'That view could not be remembered. Check the connection and try again.';
      } finally {
        activeRequests.current.delete(controller);
      }
    },
    [client, containerId, views],
  );

  const setDocumentHidden = useCallback(
    async (hidden: boolean): Promise<string | null> => {
      if (containerId === null || views === null) {
        return 'A workspace root cannot offer views.';
      }

      return submit(
        (signal) => {
          const body = ContainerViewsSchema.parse(views);
          // The one write that sends the flag. The others leave it out, which Core reads as "keep what
          // is stored", so a rename or a reorder cannot bring the tab back by accident. The default
          // goes as it stands: asked to hide a document that was the default, Core moves the default
          // to the first view itself.
          return client.execute(
            coreViews.setContainerViews(containerId, {
              views: body.views,
              default: body.default,
              hideDocument: hidden,
            }),
            { signal },
          );
        },
        'That could not be saved.',
        'That could not be saved. Check the connection and try again.',
      );
    },
    [client, containerId, submit, views],
  );

  const create = useCallback(
    async (title: string, properties?: Record<string, unknown>): Promise<string | null> => {
      if (createChild === undefined) {
        return 'This container cannot hold items.';
      }

      const refusal = await createChild(title, properties);

      // Reloaded here rather than by the caller, because this hook owns the children a view is
      // drawing and the tree's own store is a different list. Skipped on a refusal: nothing
      // changed, and a reload would only make the screen flicker to say so.
      if (refusal === null) {
        await load();
      }

      return refusal;
    },
    [createChild, load],
  );

  /**
   * The children as every view reads them: what the server sent, plus the properties this build
   * computes rather than stores.
   *
   * Derived on the way out rather than merged into state, so the optimistic write paths above keep
   * operating on exactly what the server sent and a computed value can never be mistaken for one
   * to send back. `decorateItems` returns the same array when the schema declares no formulas, so
   * a container without any pays nothing at all.
   *
   * Memoised for identity, not for arithmetic: `children` is the dependency of every view's own
   * memoised sort, filter and virtual window, and a fresh array each render would re-run all of
   * them on every keystroke elsewhere on the screen.
   */
  const computedChildren = useMemo(
    () => decorateItems(children, schema?.properties),
    [children, schema?.properties],
  );

  return {
    itemId: containerId,
    status,
    error,
    refreshing,
    refreshError,
    locked,
    create,
    schema,
    views,
    children: computedChildren,
    setProperties,
    setPropertiesMany,
    setSchema,
    setDefaultView,
    setDocumentHidden,
    setViews,
    appendViewSetup,
    replaceViewSetup,
    writeError,
    truncated,
    reload: load,
  };
}
