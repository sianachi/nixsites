import { Button, Text } from '@nix/ui';
import {
  finance as financeApi,
  type Finance,
  type FinanceTransaction,
  type FinanceTransactions as Transactions,
} from '@nix/api-client';
import { useEffect, useMemo, useRef, useState, type ReactNode } from 'react';
import { useOptionalApiClient } from '@nix/web-platform/api/api-client-provider';
import {
  ErrorPanel,
  LoadingPanel,
  PartialNotice,
} from '@nix/web-foundation/components/states/status-panels';
import { Money, SectionHeading, WriteError } from './finance-shared';
import { shiftMonth } from './money';
import { useFinanceQuery, type FinanceState } from './use-finance';
import { TransactionTable } from './transaction-table';
import { ImportDialog } from './finance-import-dialog';
import { QuickAddDialog, TransactionDialog } from './transaction-dialog';
import {
  TransactionFilterForm,
  type AppliedFilters,
  type HistoryRange,
} from './transaction-filter-form';
import { TransactionBulkBar } from './transaction-bulk-bar';
import { AssignPreviewDialog } from './assign-preview-dialog';
import { SessionChanges, sameEditableTransaction, type SessionChange } from './session-changes';

// Importers reach these through this module.
export { QuickAddDialog, TransactionDialog };

/** The month's transactions, newest first, with a way to record, change and import them. */
export function FinanceTransactions({
  state,
  finance,
  month,
  initialLineId = '',
  initialAccountId = '',
  initialUnassigned = false,
}: {
  readonly state: FinanceState;
  readonly finance: Finance;
  readonly month: string;
  readonly initialLineId?: string | undefined;
  readonly initialAccountId?: string | undefined;
  readonly initialUnassigned?: boolean | undefined;
}): ReactNode {
  const currency = finance.settings.currency;
  const client = useOptionalApiClient();
  const reads = useRef<AbortController | null>(null);
  useEffect(() => {
    const controller = new AbortController();
    reads.current = controller;
    return () => {
      controller.abort();
    };
  }, [client]);
  const [changes, setChanges] = useState<readonly SessionChange[]>([]);
  const [restoring, setRestoring] = useState<SessionChange | null>(null);
  const [undoError, setUndoError] = useState<string | null>(null);
  const [accountId, setAccountId] = useState(initialAccountId);
  const [lineFilter, setLineFilter] = useState(initialLineId);
  const [range, setRange] = useState<HistoryRange>('month');
  const [filters, setFilters] = useState<AppliedFilters>({
    search: '',
    source: '',
    from: '',
    to: '',
    minAmount: '',
    maxAmount: '',
  });
  const [offset, setOffset] = useState(0);
  const [previewAssignment, setPreviewAssignment] = useState(false);
  const [announcement, setAnnouncement] = useState<string | null>(null);
  const [unassigned, setUnassigned] = useState(initialUnassigned);
  const [editing, setEditing] = useState<FinanceTransaction | null>(null);
  const [importing, setImporting] = useState(false);
  const [adding, setAdding] = useState(false);
  const [selected, setSelected] = useState<ReadonlySet<string>>(new Set());
  const [assignLineId, setAssignLineId] = useState('');
  const [assigning, setAssigning] = useState(false);
  const [assignError, setAssignError] = useState<string | null>(null);
  const itemId = finance.itemId;
  // The selection is a bulk-editing tool for the rows on screen; a different filter or month
  // means different rows, so a stale selection would silently reassign transactions the person
  // never looked at. Adjusted during render rather than in an effect - the recommended way to
  // reset state on a prop change - so a background reload of the same filter, which changes
  // none of these three, leaves the selection alone and lets it survive the writes it makes.
  const filterKey = `${accountId}|${lineFilter}|${String(unassigned)}|${month}|${range}|${JSON.stringify(filters)}|${String(offset)}`;
  const [previousMonth, setPreviousMonth] = useState(month);
  if (previousMonth !== month) {
    setPreviousMonth(month);
    setOffset(0);
  }
  const [selectionFilterKey, setSelectionFilterKey] = useState(filterKey);
  if (selectionFilterKey !== filterKey) {
    setSelectionFilterKey(filterKey);
    setSelected(new Set());
    setAssignLineId('');
    setAssignError(null);
  }
  const endpoint = useMemo(
    () =>
      financeApi.listTransactions(itemId, {
        ...(range === 'month' ? { month } : {}),
        ...(range === 'custom' ? { from: filters.from, to: filters.to } : {}),
        ...(filters.search === '' ? {} : { search: filters.search }),
        ...(filters.source === ''
          ? {}
          : { source: filters.source as FinanceTransaction['source'] }),
        ...(filters.minAmount === ''
          ? {}
          : { minAmount: Number(filters.minAmount.replaceAll(',', '')) }),
        ...(filters.maxAmount === ''
          ? {}
          : { maxAmount: Number(filters.maxAmount.replaceAll(',', '')) }),
        ...(lineFilter === '' ? {} : { lineId: lineFilter }),
        offset,
        limit: 50,
        ...(accountId === '' ? {} : { accountId }),
        ...(unassigned ? { unassigned: true } : {}),
      }),
    [itemId, month, accountId, lineFilter, unassigned, range, filters, offset],
  );
  const query = useFinanceQuery<Transactions>(endpoint, state.generation);
  const lines = useMemo(
    () => new Map(finance.lines.map((line) => [line.id, line])),
    [finance.lines],
  );
  const accounts = useMemo(
    () => new Map(finance.accounts.map((account) => [account.id, account])),
    [finance.accounts],
  );
  const visibleIds = useMemo(
    () => (query.data === null ? [] : query.data.transactions.map((row) => row.id)),
    [query.data],
  );
  const allVisibleSelected = visibleIds.length > 0 && visibleIds.every((id) => selected.has(id));
  const someVisibleSelected = visibleIds.some((id) => selected.has(id));
  const toggleRow = (id: string, checked: boolean): void => {
    setSelected((current) => {
      const next = new Set(current);
      if (checked) next.add(id);
      else next.delete(id);
      return next;
    });
  };
  const toggleAllVisible = (checked: boolean): void => {
    setSelected((current) => {
      const next = new Set(current);
      for (const id of visibleIds) {
        if (checked) next.add(id);
        else next.delete(id);
      }
      return next;
    });
  };
  // Applied one transaction at a time through the same write the edit dialog uses, so a
  // partial failure fails one row rather than the whole batch. Rows that fail stay selected -
  // and reselected, since a retry after fixing whatever was refused should start from them.
  const applyAssignment = async (): Promise<void> => {
    if (assignLineId === '' || query.data === null) return;
    const targets = query.data.transactions.filter((row) => selected.has(row.id));
    if (targets.length === 0) return;
    setPreviewAssignment(false);
    setAssigning(true);
    setAssignError(null);
    const failed = new Set<string>();
    // Counts, not just the last reason: several rows can be refused for different reasons in the
    // same batch, and reporting only whichever one happened to run last would misdescribe the
    // rest. Insertion order in this Map is the order each distinct reason was first seen.
    const reasonCounts = new Map<string, number>();
    for (const row of targets) {
      const refusal = await state.setTransaction(row.id, {
        description: row.description,
        date: row.date,
        amount: row.amount,
        accountId: row.accountId,
        lineId: assignLineId,
        cleared: row.cleared,
      });
      if (refusal === null)
        setChanges((current) =>
          [{ before: row, after: { ...row, lineId: assignLineId } }, ...current].slice(0, 25),
        );
      if (refusal !== null) {
        failed.add(row.id);
        reasonCounts.set(refusal, (reasonCounts.get(refusal) ?? 0) + 1);
      }
    }
    setAssigning(false);
    setSelected(failed);
    if (failed.size === 0) {
      setAnnouncement(
        `Updated the category for ${String(targets.length)} transactions. Totals are refreshing.`,
      );
      setAssignLineId('');
    } else {
      const succeeded = targets.length - failed.size;
      const reasons = [...reasonCounts.entries()]
        .map(([reason, count]) => `${reason} (${String(count)})`)
        .join(', ');
      setAssignError(
        `Assigned ${String(succeeded)} of ${String(targets.length)}; ${String(failed.size)} ` +
          `${failed.size === 1 ? 'was' : 'were'} refused: ${reasons}`,
      );
    }
  };
  return (
    <div className="@container flex min-w-0 flex-col gap-4">
      <SectionHeading
        id="finance-transactions-title"
        title="Transaction history"
        detail="Select a transaction to edit it. Money out is negative."
        actions={
          <>
            <Button
              onClick={() => {
                setAdding(true);
              }}
            >
              Add transaction
            </Button>
            <Button
              variant="secondary"
              onClick={() => {
                setImporting(true);
              }}
            >
              Import a statement
            </Button>
          </>
        }
      />
      <TransactionFilterForm
        finance={finance}
        month={month}
        monthEnd={monthEnd(month)}
        range={range}
        accountId={accountId}
        lineFilter={lineFilter}
        unassigned={unassigned}
        filters={filters}
        onRange={(value, from, to) => {
          setRange(value);
          setOffset(0);
          if (value === 'custom') setFilters((current) => ({ ...current, from, to }));
        }}
        onAccount={(id) => {
          setAccountId(id);
          setOffset(0);
        }}
        onCategory={(value) => {
          setUnassigned(value === 'unassigned');
          setLineFilter(value === 'unassigned' ? '' : value);
          setOffset(0);
        }}
        onApply={(next) => {
          setOffset(0);
          setFilters(next);
        }}
        onClear={(from, to) => {
          setAccountId('');
          setLineFilter('');
          setUnassigned(false);
          setOffset(0);
          setFilters({ search: '', source: '', from, to, minAmount: '', maxAmount: '' });
        }}
      />
      {query.data === null ? (
        query.status === 'error' ? (
          <ErrorPanel title="The transactions could not be loaded" detail={query.error ?? ''} />
        ) : (
          <LoadingPanel label="transactions" />
        )
      ) : (
        <>
          {query.status === 'error' ? <PartialNotice pending="the latest transactions" /> : null}
          {query.data.offset === undefined ? (
            <Text variant="bodySmall" tone="muted" role="status">
              Update the server to use the new history filters and paging. The records below may not
              match all selected filters.
            </Text>
          ) : null}
          {query.data.truncated && query.data.nextOffset === undefined ? (
            <Text variant="bodySmall" tone="muted" role="status">
              This server returned a partial history. Narrow the dates or account to see more
              records.
            </Text>
          ) : null}
          {query.status === 'loading' ? (
            <Text variant="bodySmall" tone="muted" role="status">
              Updating results. Previous results remain below.
            </Text>
          ) : null}
          <div className="flex flex-wrap items-center justify-between gap-4 border-b border-divider pb-3">
            <Text variant="bodySmall">{String(query.data.total)} matching transactions</Text>
            <dl className="flex flex-wrap gap-6">
              {(['inflow', 'outflow', 'net'] as const).map((key) => (
                <div key={key}>
                  <Text as="dt" variant="caption" tone="muted">
                    {key === 'inflow'
                      ? 'Money in'
                      : key === 'outflow'
                        ? 'Money out'
                        : 'Net movement'}
                  </Text>
                  <Text as="dd" variant="body" className="font-medium">
                    {query.data?.[key] === undefined ? (
                      'Unavailable from this server'
                    ) : (
                      <Money amount={query.data[key]} currency={currency} signed={key === 'net'} />
                    )}
                  </Text>
                </div>
              ))}
            </dl>
          </div>
          {query.data.transactions.length === 0 ? null : (
            <TransactionBulkBar
              lines={finance.lines}
              visibleCount={visibleIds.length}
              selectedCount={selected.size}
              allVisibleSelected={allVisibleSelected}
              someVisibleSelected={someVisibleSelected}
              ready={query.status === 'ready'}
              assigning={assigning}
              assignLineId={assignLineId}
              onToggleAll={toggleAllVisible}
              onAssignLine={setAssignLineId}
              onPreview={() => {
                setPreviewAssignment(true);
              }}
              onClear={() => {
                setSelected(new Set());
                setAssignError(null);
              }}
            />
          )}
          <WriteError message={assignError} />
          <TransactionTable
            rows={query.data.transactions}
            lines={lines}
            accounts={accounts}
            currency={currency}
            selected={selected}
            disabled={query.status !== 'ready' || assigning}
            onToggle={toggleRow}
            onEdit={setEditing}
          />
          <div className="flex flex-wrap items-center justify-between gap-3">
            <Text variant="bodySmall" tone="muted">
              Showing {query.data.total === 0 ? '0' : String((query.data.offset ?? 0) + 1)}–
              {String((query.data.offset ?? 0) + query.data.transactions.length)} of{' '}
              {String(query.data.total)}
            </Text>
            <div className="flex flex-wrap gap-2">
              <Button
                variant="secondary"
                disabled={offset === 0 || query.status !== 'ready'}
                onClick={() => {
                  setOffset(Math.max(0, offset - 50));
                }}
              >
                Previous 50
              </Button>
              <Button
                variant="secondary"
                disabled={query.data.nextOffset == null || query.status !== 'ready'}
                onClick={() => {
                  setOffset(query.data?.nextOffset ?? offset);
                }}
              >
                Next 50
              </Button>
            </div>
          </div>
        </>
      )}
      {changes.length === 0 ? null : (
        <SessionChanges
          changes={changes}
          lines={lines}
          currency={currency}
          onReview={(change) => {
            setUndoError(null);
            setRestoring(change);
          }}
        />
      )}
      <WriteError message={undoError} />
      {restoring === null ? null : (
        <TransactionDialog
          state={state}
          finance={finance}
          transaction={restoring.before}
          storedTransaction={restoring.after}
          onClose={() => {
            setRestoring(null);
          }}
          beforeSave={async () => {
            if (client === null) return 'Reconnect to the server before restoring this edit.';
            try {
              const latest = await client.query(
                financeApi.listTransactions(finance.itemId, { transactionId: restoring.after.id }),
                { forceRefresh: true, signal: reads.current?.signal },
              );
              const row = latest.transactions.find(
                (candidate) => candidate.id === restoring.after.id,
              );
              return row === undefined || !sameEditableTransaction(row, restoring.after)
                ? 'This transaction has changed since that edit. Open its current record and review the changes before correcting it.'
                : null;
            } catch {
              return 'The current transaction could not be checked. Try again before restoring.';
            }
          }}
          onSaved={() => {
            setChanges((current) => current.filter((candidate) => candidate !== restoring));
            setAnnouncement('Restored the previous values. Totals are refreshing.');
          }}
        />
      )}
      {announcement === null ? null : (
        <Text variant="bodySmall" role="status">
          {announcement}
        </Text>
      )}
      {previewAssignment ? (
        <AssignPreviewDialog
          finance={finance}
          lines={lines}
          rows={query.data?.transactions}
          selected={selected}
          assignLineId={assignLineId}
          onApply={() => {
            void applyAssignment();
          }}
          onClose={() => {
            setPreviewAssignment(false);
          }}
        />
      ) : null}
      <QuickAddDialog
        state={state}
        finance={finance}
        month={month}
        open={adding}
        onClose={() => {
          setAdding(false);
        }}
      />
      {editing === null ? null : (
        <TransactionDialog
          state={state}
          finance={finance}
          transaction={editing}
          onSaved={(before, after) => {
            setChanges((current) => [{ before, after }, ...current].slice(0, 25));
            setAnnouncement('Saved transaction changes. Totals are refreshing.');
          }}
          onClose={() => {
            setEditing(null);
          }}
        />
      )}
      <ImportDialog
        state={state}
        finance={finance}
        open={importing}
        onClose={() => {
          setImporting(false);
        }}
      />
    </div>
  );
}

function monthEnd(month: string): string {
  const next = new Date(`${shiftMonth(month, 1)}-01T00:00:00Z`);
  next.setUTCDate(0);
  return next.toISOString().slice(0, 10);
}
