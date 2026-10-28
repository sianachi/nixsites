import {
  finance,
  isCanceledError,
  isNixApiError,
  type BudgetActual,
  type BudgetActualInput,
  type BudgetLineInput,
  type Finance,
  type FinanceAccountInput,
  type FinanceImport,
  type FinanceImportInput,
  type FinanceSettingsInput,
  type FinanceTransactionInput,
  type CommandEndpoint,
  type PostScheduled,
  type QueryEndpoint,
} from '@nix/api-client';
import { useCallback, useEffect, useRef, useState } from 'react';
import { useApiClient } from '../../api/api-client-provider';
import { useStaleWhileRevalidate } from '@nix/web-foundation/lib/use-stale-while-revalidate';

export type FinanceLoadState = 'loading' | 'ready' | 'unconfigured' | 'error';

/** A write's outcome: null when it went through, otherwise words the person can act on. */
export type WriteOutcome = string | null;

export interface FinanceState {
  readonly status: FinanceLoadState;
  readonly finance: Finance | null;
  readonly error: string | null;
  /** Bumps on every committing write, so every reader under the root refetches together. */
  readonly generation: number;
  /**
   * Whether a reload is under way while the previous finances are still on screen.
   *
   * `status` only becomes `'loading'` for the very first load - a later generation bump (a write
   * elsewhere under the root) keeps the current data mounted instead of swapping the whole section
   * for a loading panel, which used to reset the chosen section, open dialogs and the account
   * filter on every write.
   */
  readonly refreshing: boolean;
  /**
   * Why the most recent background reload failed, or null when the last one that finished
   * succeeded. Only ever set once there are finances on screen to protect.
   */
  readonly refreshError: string | null;
  readonly reload: () => void;
  readonly setSettings: (input: FinanceSettingsInput) => Promise<WriteOutcome>;
  readonly createAccount: (input: FinanceAccountInput) => Promise<WriteOutcome>;
  readonly setAccount: (accountId: string, input: FinanceAccountInput) => Promise<WriteOutcome>;
  readonly createLine: (input: BudgetLineInput) => Promise<WriteOutcome>;
  readonly setLine: (lineId: string, input: BudgetLineInput) => Promise<WriteOutcome>;
  readonly createTransaction: (input: FinanceTransactionInput) => Promise<WriteOutcome>;
  readonly setTransaction: (
    transactionId: string,
    input: FinanceTransactionInput,
  ) => Promise<WriteOutcome>;
  /** Deletes a transaction in an open month; the ordinary soft delete, so it can be restored. */
  readonly deleteTransaction: (transactionId: string) => Promise<WriteOutcome>;
  /**
   * Brings a line's actual for a month to an amount. Core records the one transaction that gets
   * it there, so the figure is never typed over and every transaction behind it stays.
   */
  readonly setActual: (
    lineId: string,
    month: string,
    input: BudgetActualInput,
  ) => Promise<BudgetActual | string>;
  readonly setMonth: (month: string, closed: boolean) => Promise<WriteOutcome>;
  readonly postScheduled: (month: string) => Promise<PostScheduled | string>;
  readonly importStatement: (input: FinanceImportInput) => Promise<FinanceImport | string>;
}

/** Why a request was refused, in words a reader can act on. */
export function financeRefusal(reason: unknown, fallback: string): string {
  if (isNixApiError(reason)) {
    if (reason.code === 'items.not_found') return 'This item could not be found.';
    if (reason.code === 'finance.not_configured') {
      return 'This item is not set up for finances yet.';
    }
    if (reason.code === 'finance.month_closed') {
      return reason.detail ?? 'That month is closed. Reopen it first.';
    }
    if (reason.code === 'finance.line_not_found') {
      return 'That budget line no longer exists. Reload and try again.';
    }
    if (reason.code === 'finance.transaction_not_found') {
      return 'That transaction no longer exists. Reload and try again.';
    }
    if (reason.code === 'finance.limit') {
      return reason.detail ?? 'This finance root has more records than this version can total.';
    }
    if (reason.status === 404) {
      return 'This version of the application asked for a finance feature the server does not offer.';
    }
    return reason.detail ?? reason.message;
  }
  return reason instanceof Error ? reason.message : fallback;
}

/**
 * The finance root: its settings, accounts and lines, plus every write under it.
 *
 * One generation counter serves every reader. A single transaction changes the grid, the cash
 * flow, the accounts and the dashboard at once, so after any write all of them refetch rather
 * than each guessing whether it was affected.
 */
export function useFinance(itemId: string | null): FinanceState {
  const client = useApiClient();
  const writes = useRef<AbortController | null>(null);
  useEffect(() => {
    const controller = new AbortController();
    writes.current = controller;
    return () => {
      controller.abort();
    };
  }, [client]);
  const [generation, setGeneration] = useState(0);
  const { status, error, refreshing, refreshError, beginLoad, reportLoaded, reportFailed } =
    useStaleWhileRevalidate<FinanceLoadState>('loading');
  const [data, setData] = useState<Finance | null>(null);
  const reload = useCallback(() => {
    setGeneration((value) => value + 1);
  }, []);

  useEffect(() => {
    if (itemId === null) {
      queueMicrotask(() => {
        reportFailed('A finance view needs an item to live on.', 'error');
      });
      return;
    }
    const controller = new AbortController();
    queueMicrotask(() => {
      if (controller.signal.aborted) return;
      beginLoad();
    });
    void client
      .query(finance.readFinance(itemId), { signal: controller.signal, forceRefresh: true })
      .then((value) => {
        if (controller.signal.aborted) return;
        setData(value);
        reportLoaded('ready');
      })
      .catch((reason: unknown) => {
        if (controller.signal.aborted || isCanceledError(reason)) return;
        if (isNixApiError(reason) && reason.code === 'finance.not_configured') {
          setData(null);
          reportLoaded('unconfigured');
          return;
        }
        const message = financeRefusal(reason, 'The finances could not be loaded.');
        reportFailed(message, 'error');
      });
    return () => {
      controller.abort();
    };
  }, [client, generation, itemId, beginLoad, reportLoaded, reportFailed]);

  const write = useCallback(
    async <T>(
      endpoint: (id: string) => CommandEndpoint<T>,
      fallback: string,
      // A preview - the CSV import's `commit: false` pass - changes nothing under the root, so it
      // must not bump the generation: doing so used to make every reader refetch for a request
      // that stored nothing, and reset every section's local state along the way.
      bumpGeneration = true,
    ): Promise<T | string> => {
      if (itemId === null) return 'A finance view needs an item to live on.';
      try {
        const value = await client.execute(endpoint(itemId), { signal: writes.current?.signal });
        if (bumpGeneration) setGeneration((count) => count + 1);
        return value;
      } catch (reason) {
        return financeRefusal(reason, fallback);
      }
    },
    [client, itemId],
  );

  const outcome = async (promise: Promise<unknown>): Promise<WriteOutcome> => {
    const value = await promise;
    return typeof value === 'string' ? value : null;
  };

  return {
    status,
    finance: data,
    error,
    refreshing,
    refreshError,
    generation,
    reload,
    setSettings: (input) =>
      outcome(write((id) => finance.setSettings(id, input), 'The settings could not be saved.')),
    createAccount: (input) =>
      outcome(write((id) => finance.createAccount(id, input), 'The account could not be added.')),
    setAccount: (accountId, input) =>
      outcome(
        write((id) => finance.setAccount(id, accountId, input), 'The account could not be saved.'),
      ),
    createLine: (input) =>
      outcome(write((id) => finance.createLine(id, input), 'The budget line could not be added.')),
    setLine: (lineId, input) =>
      outcome(
        write((id) => finance.setLine(id, lineId, input), 'The budget line could not be saved.'),
      ),
    createTransaction: (input) =>
      outcome(
        write(
          (id) => finance.createTransaction(id, input),
          'The transaction could not be recorded.',
        ),
      ),
    setTransaction: (transactionId, input) =>
      outcome(
        write(
          (id) => finance.setTransaction(id, transactionId, input),
          'The transaction could not be saved.',
        ),
      ),
    deleteTransaction: (transactionId) =>
      outcome(
        write(
          (id) => finance.deleteTransaction(id, transactionId),
          'The transaction could not be deleted.',
        ),
      ),
    setActual: (lineId, month, input) =>
      write<BudgetActual>(
        (id) => finance.setActual(id, lineId, month, input),
        'The amount could not be recorded.',
      ),
    setMonth: (month, closed) =>
      outcome(
        write((id) => finance.setMonth(id, month, closed), 'The month could not be changed.'),
      ),
    postScheduled: (month) =>
      write<PostScheduled>((id) => finance.postScheduled(id, month), 'Nothing could be posted.'),
    importStatement: (input) =>
      write<FinanceImport>(
        (id) => finance.importStatement(id, input),
        'The statement could not be imported.',
        // Only a commit changes anything under the root; a preview reads what a commit would do
        // without doing it, and must not make every other reader refetch.
        input.commit,
      ),
  };
}

export type FinanceQueryStatus = 'loading' | 'ready' | 'error';

export interface FinanceQueryState<T> {
  readonly status: FinanceQueryStatus;
  readonly data: T | null;
  readonly error: string | null;
}

/**
 * One derived read under the root, refetched whenever the generation moves.
 *
 * The endpoint is the dependency: a caller memoises it on the arguments that change what is
 * read, so a re-render with the same month does not refetch and a new month does. Stale data is
 * kept on screen while the next read is in flight, so a month change does not blank the grid.
 */
export function useFinanceQuery<T>(
  endpoint: QueryEndpoint<T> | null,
  generation: number,
): FinanceQueryState<T> {
  const client = useApiClient();
  const [state, setState] = useState<FinanceQueryState<T>>({
    status: 'loading',
    data: null,
    error: null,
  });
  useEffect(() => {
    if (endpoint === null) return;
    const controller = new AbortController();
    queueMicrotask(() => {
      if (controller.signal.aborted) return;
      setState((previous) => ({ status: 'loading', data: previous.data, error: null }));
    });
    void client
      .query(endpoint, { signal: controller.signal, forceRefresh: true })
      .then((data) => {
        if (controller.signal.aborted) return;
        setState({ status: 'ready', data, error: null });
      })
      .catch((reason: unknown) => {
        if (controller.signal.aborted || isCanceledError(reason)) return;
        setState((previous) => ({
          status: 'error',
          data: previous.data,
          error: financeRefusal(reason, 'The figures could not be loaded.'),
        }));
      });
    return () => {
      controller.abort();
    };
  }, [client, endpoint, generation]);
  return state;
}
