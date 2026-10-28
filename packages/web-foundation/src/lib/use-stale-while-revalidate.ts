import { useCallback, useRef, useState } from 'react';

/**
 * The bookkeeping a stale-while-revalidate load repeats everywhere it appears: the first load
 * blanks the screen, but every load after that keeps whatever is already on screen mounted and
 * reports the refresh separately - so a filter panel, an open dialog or a scroll position that a
 * full-panel swap would discard survives the refresh.
 *
 * A caller owns everything else: what it fetches, the data it keeps alongside this, and its own
 * status union - only the "first load vs. reload" distinction lives here.
 */
export interface StaleWhileRevalidate<Status extends string> {
  readonly status: Status;
  readonly error: string | null;

  /** Whether a reload is under way while the previous data is still on screen. */
  readonly refreshing: boolean;

  /**
   * Why the most recent background reload failed, or null when the last one that finished
   * succeeded. Only ever set once there is data on screen to keep.
   */
  readonly refreshError: string | null;

  /**
   * Call at the start of every load, including the first. The first call sets `status` to the
   * loading state passed to the hook; every call after that leaves the current data mounted,
   * flips `refreshing` on and clears the previous `refreshError` instead.
   */
  readonly beginLoad: () => void;

  /**
   * Call when a load succeeds. `status` is the ready state to report - a caller whose success can
   * land in more than one place (a container's `ready`/`partial`, finance's `ready`/`unconfigured`)
   * passes whichever applies. `note` is a warning to keep alongside an otherwise successful load;
   * most callers omit it.
   */
  readonly reportLoaded: (status: Status, note?: string | null) => void;

  /**
   * Call when a load fails. `errorStatus` is only used the first time a load fails - once data has
   * loaded once, a failure keeps that data and reports it through `refreshError` instead of
   * replacing `status`.
   * Set `blocking` after a confirmed refusal when the caller has discarded its loaded data.
   */
  readonly reportFailed: (
    message: string,
    errorStatus: Status,
    options?: { readonly blocking?: boolean },
  ) => void;
}

export function useStaleWhileRevalidate<Status extends string>(
  loadingStatus: Status,
): StaleWhileRevalidate<Status> {
  const [status, setStatus] = useState<Status>(loadingStatus);
  const [error, setError] = useState<string | null>(null);
  const [refreshing, setRefreshing] = useState(false);
  const [refreshError, setRefreshError] = useState<string | null>(null);

  // Whether a load has ever finished successfully, so a later reload knows there is something on
  // screen worth protecting. A ref rather than a derived check over `status`, because `status`
  // starts at `loadingStatus` for the very first load too - there is no way to tell "about to load
  // for the first time" from "reloading" by looking at it alone.
  const hasLoadedOnce = useRef(false);

  const beginLoad = useCallback(() => {
    if (hasLoadedOnce.current) {
      setRefreshing(true);
      setRefreshError(null);
    } else {
      setStatus(loadingStatus);
    }
    setError(null);
  }, [loadingStatus]);

  const reportLoaded = useCallback((nextStatus: Status, note: string | null = null) => {
    setStatus(nextStatus);
    setError(note);
    hasLoadedOnce.current = true;
    setRefreshing(false);
    setRefreshError(null);
  }, []);

  const reportFailed = useCallback(
    (message: string, errorStatus: Status, options: { readonly blocking?: boolean } = {}) => {
      if (options.blocking === true) {
        hasLoadedOnce.current = false;
        setError(message);
        setStatus(errorStatus);
        setRefreshing(false);
        setRefreshError(null);
        return;
      }
      // There is already data on screen: keep it, and say the reload failed rather than replacing it
      // with an error panel that discards everything the reader was looking at.
      if (hasLoadedOnce.current) {
        setRefreshing(false);
        setRefreshError(message);
      } else {
        setError(message);
        setStatus(errorStatus);
      }
    },
    [],
  );

  return { status, error, refreshing, refreshError, beginLoad, reportLoaded, reportFailed };
}
