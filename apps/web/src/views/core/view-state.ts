import {
  createContext,
  useContext,
  useCallback,
  useMemo,
  type Dispatch,
  type SetStateAction,
} from 'react';
import { useSearchParams } from 'react-router';
import { z } from 'zod';

import { usePaneIndex } from '../../panes/pane-context';
import { paneFilterPrefix, paneParam } from '../../panes/pane-params';

/**
 * Which view is on screen, and how it is sorted and filtered - held in the URL.
 *
 * **The URL is this application's primary state container**, and a view is the clearest case for
 * it: "the board, grouped by status, filtered to this quarter, sorted by owner" is exactly the
 * thing somebody pastes into a message. Held in a store instead, every such link would point at
 * the folder's default view and the recipient would have to rebuild what they were sent.
 *
 * **The URL wins over the container's stored view, and that is deliberate.** A container stores
 * which views it offers and how each is configured; the URL says which of them is open and what
 * the person looking at it has done since. When the two disagree the URL is the more specific
 * statement - somebody chose it, just now, possibly in a link they were given - so the stored view
 * is the starting point rather than the authority.
 *
 * Sort and filter replace rather than push, so dragging a column header does not fill the back
 * button with history nobody wanted. Changing view pushes, because Back meaning "the board I was
 * just looking at" is what everybody expects.
 */

const VIEW_PARAM = 'view';
const MODE_PARAM = 'mode';
const SORT_PARAM = 'sort';
const DIRECTION_PARAM = 'dir';
export const SEARCH_PARAM = 'search';

const SortDirectionSchema = z.enum(['ascending', 'descending']);

export type SortDirection = z.infer<typeof SortDirectionSchema>;

export const DEFAULT_SORT_DIRECTION: SortDirection = 'ascending';

/** One property filter: show only items whose property equals one of these values. */
export interface ViewFilter {
  readonly propertyKey: string;
  readonly values: readonly string[];
}

export interface ViewState {
  /** The view the URL names, or null to fall back to the container's first. */
  readonly viewId: string | null;

  /**
   * The calendar grain the URL names, or null to fall back to the view's own.
   *
   * In the address for the same reason the view is: it is a decision about how to look at
   * something, and a link that says "look at this week" should open on that week. The month being
   * *shown* is not - that is a scroll position through time, and freezing every recipient on the
   * sender's month would be a link that ages badly.
   */
  readonly mode: string | null;

  /** The property key to sort by, or null for the view's own configured sort. */
  readonly sortBy: string | null;

  readonly direction: SortDirection;

  /** Every active property filter, in the order the URL happened to carry them. */
  readonly filters: readonly ViewFilter[];
  readonly search: string;
}

export interface ViewStateControl extends ViewState {
  readonly selectView: (viewId: string) => void;
  /** Names a calendar grain in the address. Replaces, because it is not a navigation. */
  readonly setMode: (mode: string) => void;

  readonly setSort: (propertyKey: string, direction: SortDirection) => void;
  readonly clearSort: () => void;
  readonly setFilter: (propertyKey: string, values: readonly string[]) => void;
  readonly clearFilters: () => void;
  readonly setSearch: (search: string) => void;
}

/**
 * Reads a direction out of the URL.
 *
 * Exported so it is testable without a router, and so an unrecognised value is handled in one
 * place rather than at every reader. A malformed direction falls back to ascending and says so:
 * an unparseable URL usually means a link we generated somewhere else has drifted, which is worth
 * knowing about rather than silently correcting.
 */
export function parseDirection(raw: string | null): SortDirection {
  if (raw === null) {
    return DEFAULT_SORT_DIRECTION;
  }

  const parsed = SortDirectionSchema.safeParse(raw);
  if (parsed.success) {
    return parsed.data;
  }

  console.warn(`Ignoring unrecognised "${DIRECTION_PARAM}" search parameter:`, raw);
  return DEFAULT_SORT_DIRECTION;
}

/**
 * Reads every filter out of a query string.
 *
 * Filters are `f.<propertyKey>=<value>&f.<propertyKey>=<other>` rather than one packed parameter,
 * so a person can read a link and see what it filters to, and so adding a value is appending a
 * parameter rather than parsing and rewriting an encoding of our own.
 */
export function parseFilters(params: URLSearchParams, pane = 0): readonly ViewFilter[] {
  const byKey = new Map<string, string[]>();
  const prefix = paneFilterPrefix(pane);

  for (const [name, value] of params) {
    if (!name.startsWith(prefix) || value.length === 0) {
      continue;
    }

    // `f2.status` starts with `f2.` and not with `f.`, and `f.status` starts with `f.` and not
    // with `f2.`, so one prefix test still separates the panes. That is why the second pane's
    // filters are spelled `f2.` rather than `f.2.`.
    const key = name.slice(prefix.length);
    if (key.length === 0) {
      continue;
    }

    const values = byKey.get(key) ?? [];
    values.push(value);
    byKey.set(key, values);
  }

  return [...byKey].map(([propertyKey, values]) => ({ propertyKey, values }));
}

/**
 * Strips every parameter that belongs to the item being left.
 *
 * A view id, a sort and a filter set all name properties of one item's configuration. Carried onto
 * a different item they are at best meaningless - that item has no view by that id, so it falls
 * back to its body - and at worst wrong, because two items can easily both have a view called
 * `by-status` and the second would open on a board nobody asked for, sorted by a property it may
 * not have.
 *
 * Exported so item navigation can call it. It lives here rather than there because this module owns
 * the parameter names, and a second list of them somewhere else is a list that goes stale.
 *
 * **Scoped to one pane.** Deleting the unprefixed names unconditionally - which is what this did
 * before there were panes, and what a naive port would have kept doing - means navigating in the
 * second pane silently discards the first pane's view, sort and filters. That is the single most
 * likely defect in this whole area, so it has a test of its own.
 */
export function clearViewState(params: URLSearchParams, pane = 0): void {
  params.delete(paneParam(VIEW_PARAM, pane));
  params.delete(paneParam(MODE_PARAM, pane));
  params.delete(paneParam(SORT_PARAM, pane));
  params.delete(paneParam(DIRECTION_PARAM, pane));
  params.delete(paneParam(SEARCH_PARAM, pane));

  const prefix = paneFilterPrefix(pane);
  for (const name of [...params.keys()]) {
    if (name.startsWith(prefix)) {
      params.delete(name);
    }
  }
}

/** Reads the whole view state out of a query string. Exported for testing without a router. */
export function parseViewState(params: URLSearchParams, pane = 0): ViewState {
  const viewId = params.get(paneParam(VIEW_PARAM, pane));
  const sortBy = params.get(paneParam(SORT_PARAM, pane));

  const mode = params.get(paneParam(MODE_PARAM, pane));

  return {
    viewId: viewId !== null && viewId.length > 0 ? viewId : null,
    mode: mode !== null && mode.length > 0 ? mode : null,
    sortBy: sortBy !== null && sortBy.length > 0 ? sortBy : null,
    direction: parseDirection(params.get(paneParam(DIRECTION_PARAM, pane))),
    filters: parseFilters(params, pane),
    search: params.get(paneParam(SEARCH_PARAM, pane)) ?? '',
  };
}

/**
 * The view state of the pane this is called in.
 *
 * The pane comes from context rather than an argument, so a board, a calendar and a list read and
 * write their own pane's parameters without any of them knowing panes exist. Outside a provider
 * that is pane one, which is every caller today.
 */
export const LocalViewStateContext = createContext<{
  params: URLSearchParams;
  setParams: Dispatch<SetStateAction<URLSearchParams>>;
} | null>(null);

export function useViewState(): ViewStateControl {
  const pane = usePaneIndex();
  const [routeParams, setSearchParams] = useSearchParams();
  const local = useContext(LocalViewStateContext);
  const searchParams = local?.params ?? routeParams;
  // The parsed filter array is an input to the full-container filter/sort and virtualization
  // pipeline. Stable identity prevents interaction-only renders from repeating that work and
  // replacing the virtualizer's key sequence when the address has not changed.
  const state = useMemo(() => parseViewState(searchParams, pane), [pane, searchParams]);

  const write = useCallback(
    (mutate: (next: URLSearchParams) => void, push: boolean): void => {
      const next = new URLSearchParams(searchParams);
      mutate(next);
      if (local !== null) local.setParams(next);
      else setSearchParams(next, { replace: !push });
    },
    [local, searchParams, setSearchParams],
  );

  const selectView = useCallback(
    (viewId: string): void => {
      write((next) => {
        // The sort and the filters belonged to the view being left. Carrying them across would
        // apply a board's grouping filter to a calendar, which is not what anybody meant by
        // switching view.
        clearViewState(next, pane);
        next.set(paneParam(VIEW_PARAM, pane), viewId);
      }, true);
    },
    [pane, write],
  );

  const setMode = useCallback(
    (mode: string): void => {
      write((next) => {
        next.set(paneParam(MODE_PARAM, pane), mode);
      }, false);
    },
    [pane, write],
  );

  const setSort = useCallback(
    (propertyKey: string, direction: SortDirection): void => {
      write((next) => {
        next.set(paneParam(SORT_PARAM, pane), propertyKey);
        next.set(paneParam(DIRECTION_PARAM, pane), direction);
      }, false);
    },
    [pane, write],
  );

  const clearSort = useCallback((): void => {
    write((next) => {
      next.delete(paneParam(SORT_PARAM, pane));
      next.delete(paneParam(DIRECTION_PARAM, pane));
    }, false);
  }, [pane, write]);

  const setFilter = useCallback(
    (propertyKey: string, values: readonly string[]): void => {
      write((next) => {
        const name = `${paneFilterPrefix(pane)}${propertyKey}`;
        next.delete(name);
        for (const value of values) {
          next.append(name, value);
        }
      }, false);
    },
    [pane, write],
  );

  const clearFilters = useCallback((): void => {
    write((next) => {
      const prefix = paneFilterPrefix(pane);
      for (const name of [...next.keys()]) {
        if (name.startsWith(prefix)) {
          next.delete(name);
        }
      }
    }, false);
  }, [pane, write]);

  const setSearch = useCallback(
    (search: string): void => {
      write((next) => {
        const name = paneParam(SEARCH_PARAM, pane);
        if (search.length === 0) next.delete(name);
        else next.set(name, search);
      }, false);
    },
    [pane, write],
  );

  return { ...state, selectView, setMode, setSort, clearSort, setFilter, clearFilters, setSearch };
}
