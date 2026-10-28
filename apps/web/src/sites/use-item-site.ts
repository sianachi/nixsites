import {
  isCanceledError,
  items as coreItems,
  sites,
  structure,
  type Site,
  type SiteBuild,
  type SiteLayout,
  type SitePage,
  type UpdateSiteInput,
} from '@nix/api-client';
import { useCallback, useEffect, useState } from 'react';

import { useApiClient } from '@nix/web-platform/api/api-client-provider';
import { isNoSite, refusalMessage } from './site-copy';

/**
 * The site rooted at an item, and what a manager can do with it.
 *
 * **Core decides; this reports.** `canManage` comes from Core on every read. A refused action
 * answers with the refusal's copy rather than throwing, the way the lock actions do.
 *
 * **One poll.** While the latest build is on its way (queued, building, sealed) or a rollback has
 * not yet been served, the site is re-read with a backoff from 250 ms to 2 s. The site carries both
 * its latest and its live build, so a single read answers both questions.
 */

export type ItemSiteState =
  | { readonly phase: 'loading' }
  | { readonly phase: 'none' }
  | { readonly phase: 'error'; readonly message: string }
  | {
      readonly phase: 'ready';
      readonly site: Site;
      /** Null until loaded; the pane shows a partial notice when `buildsError` is set. */
      readonly builds: readonly SiteBuild[] | null;
      readonly buildsError: string | null;
      /** The build a rollback is waiting to see served, or null. */
      readonly rollingBackTo: string | null;
      /** A rollback was watched for its whole window and the build is still not served. */
      readonly rollbackStalled: boolean;
    };

export interface ChildChoice {
  readonly id: string;
  readonly title: string;
  readonly hasChildren: boolean;
}

/** Every action resolves to a refusal message, or null when Core accepted it. */
export interface ItemSiteActions {
  readonly retry: () => void;
  readonly create: (slug: string, layout: SiteLayout) => Promise<string | null>;
  readonly update: (input: UpdateSiteInput) => Promise<string | null>;
  readonly setHostnames: (hostnames: readonly string[]) => Promise<string | null>;
  readonly publish: (acknowledgeDisclosure: boolean) => Promise<string | null>;
  readonly rollback: (buildId: string) => Promise<string | null>;
  readonly unpublish: () => Promise<string | null>;
  readonly remove: () => Promise<string | null>;
  readonly listPages: () => Promise<readonly SitePage[]>;
  readonly setPath: (itemId: string, path: string) => Promise<string | null>;
  readonly listChildren: (parentId: string) => Promise<readonly ChildChoice[]>;
  readonly listProperties: (collectionId: string) => Promise<readonly PropertyChoice[]>;
}

export interface PropertyChoice {
  readonly key: string;
  readonly label: string;
  readonly type: string;
}

const LOADING: ItemSiteState = { phase: 'loading' };
const FIRST_POLL_MS = 250;
const MAX_POLL_MS = 2_000;
/** How long a rollback is watched before the pane stops saying it is under way. */
const ROLLBACK_WATCH_MS = 60_000;
/** The most children one picker level offers; `listChildren` stops there. */
export const CHILD_LIMIT = 500;

function settling(site: Site): boolean {
  const status = site.latestBuild?.status;
  return status === 'queued' || status === 'building' || status === 'sealed';
}

export function useItemSite(
  itemId: string,
  workspaceId: string,
): { readonly state: ItemSiteState; readonly actions: ItemSiteActions } {
  const client = useApiClient();
  const [attempt, setAttempt] = useState(0);
  // Answers are kept with the request they answer, so a new item or a retry reads as loading
  // without an effect having to say so.
  const key = `${itemId}:${String(attempt)}`;
  const [answer, setAnswer] = useState<{ key: string; state: ItemSiteState } | null>(null);
  const state: ItemSiteState = answer?.key === key ? answer.state : LOADING;
  const setState = useCallback(
    (next: ItemSiteState | ((current: ItemSiteState) => ItemSiteState)) => {
      setAnswer((previous) => {
        const current = previous?.key === key ? previous.state : LOADING;
        return { key, state: typeof next === 'function' ? next(current) : next };
      });
    },
    [key],
  );
  const [rollback, setRollback] = useState<{
    buildId: string;
    until: number;
    stalled: boolean;
  } | null>(null);

  const site = state.phase === 'ready' ? state.site : null;

  // The first read, and every retry.
  useEffect(() => {
    const controller = new AbortController();
    client
      .query(sites.getItemSite(itemId), { signal: controller.signal, forceRefresh: true })
      .then((loaded) => {
        setState({
          phase: 'ready',
          site: loaded,
          builds: null,
          buildsError: null,
          rollingBackTo: null,
          rollbackStalled: false,
        });
      })
      .catch((error: unknown) => {
        if (controller.signal.aborted || isCanceledError(error)) return;
        setState(
          isNoSite(error) ? { phase: 'none' } : { phase: 'error', message: refusalMessage(error) },
        );
      });
    return () => {
      controller.abort();
    };
  }, [client, itemId, setState]);

  const siteId = site?.id ?? null;
  const latest = site?.latestBuild ?? null;
  const latestKey = latest === null ? '' : `${latest.id}:${latest.status}`;
  const liveId = site?.liveBuild?.id ?? null;

  // The builds, re-read whenever the latest or live build changes.
  useEffect(() => {
    if (siteId === null) return;
    const controller = new AbortController();
    client
      .query(sites.listSiteBuilds(siteId), { signal: controller.signal, forceRefresh: true })
      .then((list) => {
        setState((current) =>
          current.phase === 'ready'
            ? { ...current, builds: list.builds, buildsError: null }
            : current,
        );
      })
      .catch((error: unknown) => {
        if (controller.signal.aborted || isCanceledError(error)) return;
        setState((current) =>
          current.phase === 'ready' ? { ...current, buildsError: refusalMessage(error) } : current,
        );
      });
    return () => {
      controller.abort();
    };
  }, [client, siteId, latestKey, liveId, setState]);

  const rollbackUnserved =
    rollback !== null && site !== null && site.liveBuild?.id !== rollback.buildId;
  const waitingForRollback = rollbackUnserved && !rollback.stalled;
  const polling = site !== null && (settling(site) || waitingForRollback);

  // The poll. Each pass re-reads the site after a delay that doubles up to the ceiling.
  useEffect(() => {
    if (!polling || siteId === null) return;
    const controller = new AbortController();
    let delay = FIRST_POLL_MS;
    let timer: ReturnType<typeof setTimeout> | undefined;
    const tick = (): void => {
      timer = setTimeout(() => {
        client
          .query(sites.getSite(siteId), { signal: controller.signal, forceRefresh: true })
          .then((fresh) => {
            setState((current) =>
              current.phase === 'ready' ? { ...current, site: fresh } : current,
            );
            setRollback((pending) =>
              pending !== null && fresh.liveBuild?.id === pending.buildId ? null : pending,
            );
            delay = Math.min(delay * 2, MAX_POLL_MS);
            tick();
          })
          .catch((error: unknown) => {
            if (controller.signal.aborted || isCanceledError(error)) return;
            // A failed poll is retried at the ceiling rather than ending the wait.
            delay = MAX_POLL_MS;
            tick();
          });
      }, delay);
    };
    tick();
    return () => {
      controller.abort();
      clearTimeout(timer);
    };
  }, [client, polling, siteId, setState]);

  // A rollback watched long enough stops being "under way" and says so; one that was served is
  // cleared by the poll.
  useEffect(() => {
    if (rollback === null || rollback.stalled) return;
    const timer = setTimeout(
      () => {
        setRollback({ ...rollback, stalled: true });
      },
      Math.max(0, rollback.until - Date.now()),
    );
    return () => {
      clearTimeout(timer);
    };
  }, [rollback]);

  const replaceSite = useCallback(
    (next: Site) => {
      setState((current) =>
        current.phase === 'ready'
          ? { ...current, site: next }
          : {
              phase: 'ready',
              site: next,
              builds: null,
              buildsError: null,
              rollingBackTo: null,
              rollbackStalled: false,
            },
      );
    },
    [setState],
  );

  const attemptAction = useCallback(async (body: () => Promise<void>): Promise<string | null> => {
    try {
      await body();
      return null;
    } catch (error) {
      return refusalMessage(error);
    }
  }, []);

  // Stable identities: the lists that call these re-run their effect when they change.
  const listPages = useCallback(async (): Promise<readonly SitePage[]> => {
    if (siteId === null) return [];
    const list = await client.query(sites.listSitePages(siteId), { forceRefresh: true });
    return list.pages;
  }, [client, siteId]);

  const listChildren = useCallback(
    async (parentId: string): Promise<readonly ChildChoice[]> => {
      const children: ChildChoice[] = [];
      for await (const child of client.paginate(
        // shortcut: at most CHILD_LIMIT children per level are offered, and the picker says so;
        // page the picker if sites grow past it.
        coreItems.listItems(workspaceId, { parentId, pageSize: 100 }),
        { maxPages: CHILD_LIMIT / 100 },
      )) {
        children.push({ id: child.id, title: child.title, hasChildren: child.hasChildren });
      }
      return children;
    },
    [client, workspaceId],
  );

  const listProperties = useCallback(
    async (collectionId: string): Promise<readonly PropertyChoice[]> => {
      const schema = await client.query(structure.effectiveSchema(collectionId));
      return schema.properties.map(({ key, label, type }) => ({ key, label, type }));
    },
    [client],
  );

  const actions: ItemSiteActions = {
    retry: () => {
      setAttempt((value) => value + 1);
    },
    create: (slug, layout) =>
      attemptAction(async () => {
        replaceSite(await client.execute(sites.createSite({ rootItemId: itemId, slug, layout })));
      }),
    update: (input) =>
      attemptAction(async () => {
        if (siteId === null) return;
        replaceSite(await client.execute(sites.updateSite(siteId, input)));
      }),
    setHostnames: (hostnames) =>
      attemptAction(async () => {
        if (siteId === null) return;
        replaceSite(await client.execute(sites.setSiteHostnames(siteId, hostnames)));
      }),
    publish: (acknowledgeDisclosure) =>
      attemptAction(async () => {
        if (site === null) return;
        const build = await client.execute(
          sites.publishSite(site.id, {
            idempotencyKey: `web-site-publish:${crypto.randomUUID()}`,
            acknowledgeDisclosure,
          }),
        );
        replaceSite({ ...site, latestBuild: build });
      }),
    rollback: (buildId) =>
      attemptAction(async () => {
        if (siteId === null) return;
        await client.execute(sites.rollbackSite(siteId, buildId));
        setRollback({ buildId, until: Date.now() + ROLLBACK_WATCH_MS, stalled: false });
      }),
    unpublish: () =>
      attemptAction(async () => {
        if (siteId === null) return;
        replaceSite(await client.execute(sites.unpublishSite(siteId)));
      }),
    remove: () =>
      attemptAction(async () => {
        if (siteId === null) return;
        await client.execute(sites.deleteSite(siteId, itemId));
        setState({ phase: 'none' });
      }),
    listPages,
    setPath: (pageItemId, path) =>
      attemptAction(async () => {
        if (siteId === null) return;
        await client.execute(sites.setSitePagePath(siteId, pageItemId, path));
      }),
    listChildren,
    listProperties,
  };

  return {
    state:
      state.phase === 'ready'
        ? {
            ...state,
            rollingBackTo: waitingForRollback ? rollback.buildId : null,
            rollbackStalled: rollbackUnserved && rollback.stalled,
          }
        : state,
    actions,
  };
}

/**
 * Whether an item is a site's root: true, false, or null while unknown or unreadable. The item menu
 * words its Site entry from it.
 * shortcut: a cache-backed read, so a site made in the pane relabels the menu on the next visit;
 * share the pane's state if the stale label is reported.
 */
export function useItemHasSite(itemId: string, enabled = true): boolean | null {
  const client = useApiClient();
  const [answer, setAnswer] = useState<{ itemId: string; hasSite: boolean } | null>(null);
  useEffect(() => {
    // A deployment without sites answers 503 to every site route; there is nothing to ask.
    if (!enabled) return;
    const controller = new AbortController();
    client
      .query(sites.getItemSite(itemId), { signal: controller.signal })
      .then(() => {
        setAnswer({ itemId, hasSite: true });
      })
      .catch((error: unknown) => {
        if (!controller.signal.aborted && isNoSite(error)) setAnswer({ itemId, hasSite: false });
      });
    return () => {
      controller.abort();
    };
  }, [client, enabled, itemId]);
  return answer?.itemId === itemId ? answer.hasSite : null;
}
