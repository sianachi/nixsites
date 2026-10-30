import {
  ScrollRegion,
  Button,
  Dialog,
  Field,
  Input,
  Table,
  Text,
  cn,
  focusRing,
  type TableColumn,
} from '@nix/ui';
import {
  finance as financeApi,
  type BudgetCell,
  type BudgetLine,
  type Finance,
  type FinanceTransaction,
  type FinanceTransactions,
} from '@nix/api-client';
import { useEffect, useMemo, useRef, useState, type ReactNode, type SyntheticEvent } from 'react';
import {
  ErrorPanel,
  LoadingPanel,
  PartialNotice,
} from '@nix/web-foundation/components/states/status-panels';
import { Money, WriteError } from './finance-shared';
import { TransactionDialog } from './finance-transactions';
import { formatDay, formatMoney, formatMonth, parseAmount } from './money';
import { useFinanceQuery, type FinanceState } from './use-finance';

/**
 * What is behind a line's Actual for one month, and the two ways to change it.
 *
 * The figures at the top are the grid's own, handed in on every render so a change made here is
 * reflected as soon as the grid refetches. Typing a new total and pressing Enter asks Core to
 * record the one transaction that gets the line there, so the workbook habit of typing the
 * month's figure still works; the list beneath is every transaction the figure is made of, each
 * one open to being changed or deleted, with a way to add one more. Adding or editing swaps this
 * dialog for the transaction form rather than stacking a second modal on top.
 */
export function BudgetActualDialog({
  state,
  finance,
  line,
  month,
  cell,
  onClose,
}: {
  readonly state: FinanceState;
  readonly finance: Finance;
  readonly line: BudgetLine;
  readonly month: string;
  readonly cell: BudgetCell;
  readonly onClose: () => void;
}): ReactNode {
  const [mode, setMode] = useState<'summary' | 'add' | { readonly edit: FinanceTransaction }>(
    'summary',
  );
  if (mode === 'add') {
    return (
      <TransactionDialog
        state={state}
        finance={finance}
        transaction={null}
        month={month}
        line={line}
        onClose={() => {
          setMode('summary');
        }}
      />
    );
  }
  if (mode !== 'summary') {
    return (
      <TransactionDialog
        state={state}
        finance={finance}
        transaction={mode.edit}
        onClose={() => {
          setMode('summary');
        }}
      />
    );
  }
  return (
    <ActualSummary
      state={state}
      finance={finance}
      line={line}
      month={month}
      cell={cell}
      onAdd={() => {
        setMode('add');
      }}
      onEdit={(transaction) => {
        setMode({ edit: transaction });
      }}
      onClose={onClose}
    />
  );
}

function ActualSummary({
  state,
  finance,
  line,
  month,
  cell,
  onAdd,
  onEdit,
  onClose,
}: {
  readonly state: FinanceState;
  readonly finance: Finance;
  readonly line: BudgetLine;
  readonly month: string;
  readonly cell: BudgetCell;
  readonly onAdd: () => void;
  readonly onEdit: (transaction: FinanceTransaction) => void;
  readonly onClose: () => void;
}): ReactNode {
  const currency = finance.settings.currency;
  const [reopenedHere, setReopenedHere] = useState(false);
  const [savedNeedsClose, setSavedNeedsClose] = useState(false);
  const [savedTotal, setSavedTotal] = useState<number | null>(null);
  const closed = finance.closedMonths.includes(month) && !reopenedHere;
  const accountName = finance.accounts.find((each) => each.id === line.accountId)?.name ?? '';
  const itemId = finance.itemId;
  const lineId = line.id;
  const endpoint = useMemo(
    () => financeApi.listTransactions(itemId, { month, lineId }),
    [itemId, month, lineId],
  );
  const query = useFinanceQuery<FinanceTransactions>(endpoint, state.generation);
  const [amount, setAmount] = useState(String(cell.actual));
  // Captured once, from the value the field opened with, so a backdrop tap or Escape after the
  // person has actually retyped the total is refused rather than silently discarding it.
  const [initialAmount] = useState(amount);
  const dirty = amount !== initialAmount;
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [deleting, setDeleting] = useState<string | null>(null);
  const [announcement, setAnnouncement] = useState<string | null>(null);
  const amountField = useRef<HTMLInputElement | null>(null);
  const listHeading = useRef<HTMLDivElement | null>(null);
  // The confirm replaces a row's Delete button, so focus is placed on the safe answer when it
  // appears; after a delete the row is gone, so focus goes to the list's heading.
  const keepButton = useRef<HTMLButtonElement | null>(null);
  useEffect(() => {
    if (deleting !== null) keepButton.current?.focus();
  }, [deleting]);

  // What Record would do, said before it is done. The subtraction is a preview of the person's
  // own typing against the figure on screen; the transaction Core records is Core's arithmetic.
  const typed = parseAmount(amount);
  const preview =
    typed === null || typed < 0
      ? null
      : typed === cell.actual
        ? 'Already at this total; nothing to record.'
        : line.flow === 'income'
          ? typed > cell.actual
            ? `Records ${formatMoney(typed - cell.actual, currency)} into ${accountName} as "${cell.transactions === 0 ? line.name : `${line.name} adjustment`}".`
            : `Records ${formatMoney(cell.actual - typed, currency)} out of ${accountName} as "${line.name} adjustment".`
          : typed > cell.actual
            ? `Records ${formatMoney(typed - cell.actual, currency)} spent from ${accountName} as "${cell.transactions === 0 ? line.name : `${line.name} adjustment`}".`
            : `Records ${formatMoney(cell.actual - typed, currency)} back into ${accountName} as "${line.name} adjustment".`;

  const save = async (total: number): Promise<void> => {
    setBusy(true);
    const outcome = savedNeedsClose
      ? null
      : await state.setActual(line.id, month, { amount: total });
    if (typeof outcome === 'string') {
      setBusy(false);
      setError(outcome);
      return;
    }
    if (!savedNeedsClose) {
      setSavedTotal(total);
      setAmount(String(total));
    }
    if (reopenedHere) {
      const refusal = await state.setMonth(month, true);
      if (refusal !== null) {
        setBusy(false);
        setSavedNeedsClose(true);
        setError(`The total was saved, but the month could not be closed: ${refusal}`);
        return;
      }
    }
    setError(null);
    setBusy(false);
    onClose();
  };

  const submit = async (event: SyntheticEvent): Promise<void> => {
    event.preventDefault();
    const total = parseAmount(amount);
    if (total === null || total < 0) {
      setError('The total for the month is an amount of zero or more.');
      return;
    }
    await save(total);
  };

  // The easy button for the common case: the month went exactly to plan, so there is nothing to
  // type. One click records it; it only appears when actual and plan actually differ.
  const matchesPlan = cell.actual === cell.plan;
  const samePlan = async (): Promise<void> => {
    await save(cell.plan);
  };

  const remove = async (transaction: FinanceTransaction): Promise<void> => {
    setBusy(true);
    const refusal = await state.deleteTransaction(transaction.id);
    setBusy(false);
    setDeleting(null);
    setError(refusal);
    if (refusal === null) {
      setAnnouncement(`Deleted ${transaction.description}.`);
      listHeading.current?.focus();
    }
  };

  const columns: readonly TableColumn<FinanceTransaction>[] = [
    { key: 'date', header: 'Date', cell: (row) => formatDay(row.date) },
    { key: 'description', header: 'Description', rowHeader: true, cell: (row) => row.description },
    {
      key: 'amount',
      header: 'Amount',
      align: 'end',
      cell: (row) => <Money amount={row.amount} currency={currency} signed />,
    },
    {
      key: 'actions',
      header: 'Change',
      cell: (row) =>
        deleting === row.id ? (
          <span className="flex flex-wrap items-center gap-2">
            <Text as="span" variant="caption">
              Delete?
            </Text>
            <Button
              ref={keepButton}
              variant="secondary"
              disabled={busy}
              aria-label={`Keep ${row.description}`}
              onClick={() => {
                setDeleting(null);
              }}
            >
              Keep
            </Button>
            <Button
              variant="secondary"
              disabled={busy || savedNeedsClose}
              aria-label={`Yes, delete ${row.description}`}
              onClick={() => {
                void remove(row);
              }}
            >
              Yes, delete
            </Button>
          </span>
        ) : (
          <span className="flex flex-wrap gap-2">
            <Button
              variant="subtle"
              aria-label={`Edit ${row.description}`}
              disabled={busy || savedNeedsClose}
              onClick={() => {
                onEdit(row);
              }}
            >
              Edit
            </Button>
            <Button
              variant="subtle"
              aria-label={`Delete ${row.description}`}
              disabled={busy || closed || savedNeedsClose}
              onClick={() => {
                setDeleting(row.id);
              }}
            >
              Delete
            </Button>
          </span>
        ),
    },
  ];

  return (
    <Dialog
      open
      title={`${line.name} in ${formatMonth(month, 'long')}`}
      onClose={() => {
        if (!busy) onClose();
      }}
      closeLabel={busy ? 'Saving corrected total' : 'Close'}
      initialFocus={amountField}
      presentation="workspace"
      dirty={dirty || reopenedHere}
    >
      <div className="@container flex min-w-0 flex-col gap-4">
        <dl className="grid min-w-0 grid-cols-1 gap-3 rounded-lg bg-surface-raised p-3 @xs:grid-cols-2 @lg:grid-cols-3">
          <div>
            <Text as="dt" variant="caption" tone="muted">
              Plan
            </Text>
            <Text as="dd" variant="h4">
              <Money amount={cell.plan} currency={currency} />
            </Text>
          </div>
          <div>
            <Text as="dt" variant="caption" tone="muted">
              Actual
            </Text>
            <Text as="dd" variant="h4">
              <Money amount={cell.actual} currency={currency} />
            </Text>
          </div>
          <div>
            <Text as="dt" variant="caption" tone="muted">
              {line.flow === 'income' ? 'Against plan' : 'Left'}
            </Text>
            <Text as="dd" variant="h4">
              <Money
                amount={line.flow === 'income' ? cell.variance : -cell.variance}
                currency={currency}
                signed={line.flow === 'income'}
              />
            </Text>
          </div>
        </dl>
        {closed ? (
          <div className="flex flex-col gap-3 rounded-lg bg-surface-raised p-3">
            <Text as="p" variant="bodySmall" tone="muted">
              {formatMonth(month, 'long')} is closed. Correct an individual transaction below, or
              reopen to change the total. Corrections recalculate balances and later forecasts;
              saving a corrected total closes the month again.
            </Text>
            <Button
              variant="secondary"
              disabled={busy}
              onClick={() => {
                void (async () => {
                  setBusy(true);
                  const refusal = await state.setMonth(month, false);
                  setBusy(false);
                  setError(refusal);
                  if (refusal === null) setReopenedHere(true);
                })();
              }}
            >
              Reopen to update total
            </Button>
          </div>
        ) : (
          <form
            className="flex flex-col gap-3"
            onSubmit={(event) => {
              void submit(event);
            }}
          >
            <Field
              label={savedNeedsClose ? 'Saved total' : "Bring this month's total to"}
              hint={
                cell.transactions === 0
                  ? `In ${currency}. Nix records it as one transaction on ${line.name}.`
                  : `In ${currency}. Nix records one adjustment for the difference; the ${String(cell.transactions)} already recorded ${cell.transactions === 1 ? 'stays' : 'stay'} as ${cell.transactions === 1 ? 'it is' : 'they are'}.`
              }
            >
              {(control) => (
                <div className="flex min-w-0 flex-col gap-2 @sm:flex-row">
                  <Input
                    {...control}
                    ref={amountField}
                    disabled={busy || savedNeedsClose}
                    inputMode="decimal"
                    value={amount}
                    onChange={(event) => {
                      setAmount(event.target.value);
                    }}
                  />
                  <Button type="submit" disabled={busy}>
                    {savedNeedsClose ? 'Retry closing month' : 'Record'}
                  </Button>
                </div>
              )}
            </Field>
            {matchesPlan || savedNeedsClose ? null : (
              <Button
                type="button"
                variant="secondary"
                disabled={busy}
                onClick={() => {
                  void samePlan();
                }}
              >
                Same as planned ({formatMoney(cell.plan, currency)})
              </Button>
            )}
            {savedNeedsClose ? (
              <Text variant="bodySmall" role="status">
                Saved <Money amount={savedTotal ?? cell.actual} currency={currency} />. Retry
                closing the month; the total will not be recorded again.
              </Text>
            ) : preview === null ? null : (
              <Text as="p" variant="caption" tone="muted" role="status">
                {preview}
              </Text>
            )}
          </form>
        )}
        {reopenedHere ? (
          <Text variant="caption" tone="muted">
            This month is open until you save the corrected total. Close it from the month controls
            if you leave without saving.
          </Text>
        ) : null}
        <WriteError message={error} />
        {announcement === null ? null : (
          <Text as="p" variant="caption" tone="muted" role="status">
            {announcement}
          </Text>
        )}
        <div className="flex flex-col gap-2">
          <div className="flex min-w-0 flex-wrap items-end justify-between gap-3">
            <div ref={listHeading} tabIndex={-1} className="outline-none">
              <Text as="h3" variant="h4">
                Transactions
              </Text>
            </div>
            {closed ? null : (
              <Button variant="secondary" disabled={busy || savedNeedsClose} onClick={onAdd}>
                Add transaction
              </Button>
            )}
          </div>
          {query.data === null ? (
            query.status === 'error' ? (
              <ErrorPanel title="The transactions could not be loaded" detail={query.error ?? ''} />
            ) : (
              <LoadingPanel label="transactions" />
            )
          ) : (
            <>
              {query.status === 'error' ? (
                <PartialNotice pending="the latest transactions" />
              ) : null}
              {query.data.truncated ? (
                <Text variant="bodySmall" tone="muted" role="status">
                  Showing the newest {String(query.data.transactions.length)} of{' '}
                  {String(query.data.total)}; the total above counts them all.
                </Text>
              ) : null}
              <ScrollRegion
                aria-label={`${line.name} transactions`}
                className={cn('min-w-0 overflow-x-auto', focusRing)}
              >
                <Table<FinanceTransaction>
                  caption={`${line.name} transactions in ${formatMonth(month, 'long')}`}
                  columns={columns}
                  rows={query.data.transactions}
                  rowKey={(row) => row.id}
                  rowContextMenuLabel={(row) => `Actions for ${row.description}`}
                  rowContextMenu={(row) => [
                    {
                      label: 'Edit transaction',
                      disabled: busy || savedNeedsClose,
                      onSelect: () => {
                        onEdit(row);
                      },
                    },
                    {
                      label: 'Delete transaction',
                      destructive: true,
                      disabled: busy || closed || savedNeedsClose,
                      onSelect: () => {
                        setDeleting(row.id);
                      },
                    },
                  ]}
                  emptyMessage={`Nothing recorded on ${line.name} this month.`}
                />
              </ScrollRegion>
            </>
          )}
        </div>
      </div>
    </Dialog>
  );
}
