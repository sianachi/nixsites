import { Button, Checkbox, Dialog, Field, Input, Select, Text } from '@nix/ui';
import { type BudgetLine, type Finance, type FinanceTransaction } from '@nix/api-client';
import { useEffect, useRef, useState, type ReactNode, type SyntheticEvent } from 'react';
import { WriteError } from './finance-shared';
import { formatMonth, monthOf, parseAmount, todayIn } from './money';
import { type FinanceState } from './use-finance';

export function linesBySection(
  lines: readonly BudgetLine[],
  retainedId?: string,
): readonly (readonly [string, readonly BudgetLine[]])[] {
  const groups = new Map<string, BudgetLine[]>();
  for (const line of lines) {
    if (line.archived && line.id !== retainedId) continue;
    groups.set(line.section, [...(groups.get(line.section) ?? []), line]);
  }
  return [...groups.entries()];
}

/** A quick-add: description, amount, line, account, day. Spending is typed as a positive figure. */
export function QuickAddDialog({
  state,
  finance,
  month,
  open,
  onClose,
}: {
  readonly state: FinanceState;
  readonly finance: Finance;
  readonly month: string;
  readonly open: boolean;
  readonly onClose: () => void;
}): ReactNode {
  return open ? (
    <TransactionDialog
      state={state}
      finance={finance}
      transaction={null}
      month={month}
      onClose={onClose}
    />
  ) : null;
}

/**
 * Records or edits one transaction. Opened from a budget cell, `line` fills in the line, its
 * account and its direction so the person only types the amount.
 */
export function TransactionDialog({
  state,
  finance,
  transaction,
  month,
  line = null,
  onClose,
  onSaved,
  beforeSave,
  storedTransaction,
}: {
  readonly state: FinanceState;
  readonly finance: Finance;
  /** The transaction to edit, or null to record one. */
  readonly transaction: FinanceTransaction | null;
  readonly month?: string;
  /** The budget line a new transaction is for, when it is opened from that line. */
  readonly line?: BudgetLine | null;
  readonly onSaved?: (before: FinanceTransaction, after: FinanceTransaction) => void;
  readonly beforeSave?: () => Promise<string | null>;
  readonly storedTransaction?: FinanceTransaction;
  readonly onClose: () => void;
}): ReactNode {
  const currency = finance.settings.currency;
  const today = todayIn(finance.settings.timezone);
  const defaultDay = month === undefined || monthOf(today) === month ? today : `${month}-01`;
  const [description, setDescription] = useState(transaction?.description ?? '');
  const [amount, setAmount] = useState(
    transaction === null ? '' : String(Math.abs(transaction.amount)),
  );
  const [direction, setDirection] = useState<'out' | 'in'>(
    transaction !== null
      ? transaction.amount > 0
        ? 'in'
        : 'out'
      : line?.flow === 'income'
        ? 'in'
        : 'out',
  );
  const [lineId, setLineId] = useState(transaction?.lineId ?? line?.id ?? '');
  const [accountId, setAccountId] = useState(transaction?.accountId ?? line?.accountId ?? '');
  const [date, setDate] = useState(transaction?.date ?? defaultDay);
  // Captured once, from the values the form opened with, so a backdrop tap or Escape after the
  // person has actually changed something is refused rather than silently discarding it.
  const [initial] = useState({ description, amount, direction, lineId, accountId, date });
  const dirty =
    description !== initial.description ||
    amount !== initial.amount ||
    direction !== initial.direction ||
    lineId !== initial.lineId ||
    accountId !== initial.accountId ||
    date !== initial.date;
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [confirmingDelete, setConfirmingDelete] = useState(false);
  const [reopened, setReopened] = useState<readonly string[]>([]);
  const [closeAfter, setCloseAfter] = useState(true);
  const [closePending, setClosePending] = useState(false);
  const closedForEdit = [
    ...new Set([
      monthOf(date),
      ...(transaction === null ? [] : [monthOf(storedTransaction?.date ?? transaction.date)]),
    ]),
  ].filter(
    (candidate) => finance.closedMonths.includes(candidate) && !reopened.includes(candidate),
  );
  const reopen = async (): Promise<void> => {
    setBusy(true);
    for (const candidate of closedForEdit) {
      const refusal = await state.setMonth(candidate, false);
      if (refusal !== null) {
        setError(refusal);
        setBusy(false);
        return;
      }
      setReopened((current) => [...current, candidate]);
    }
    setError(null);
    setBusy(false);
  };
  const finishCorrection = async (): Promise<boolean> => {
    if (!closeAfter) return true;
    for (const candidate of reopened) {
      const refusal = await state.setMonth(candidate, true);
      if (refusal !== null) {
        setClosePending(true);
        setError(
          `The change was saved, but ${formatMonth(candidate)} could not be closed: ${refusal}`,
        );
        return false;
      }
    }
    setClosePending(false);
    return true;
  };
  const amountField = useRef<HTMLInputElement | null>(null);
  // The confirm replaces the Delete button, so focus is placed on the safe answer when it appears
  // and handed back to Delete when the person keeps the transaction.
  const deleteButton = useRef<HTMLButtonElement | null>(null);
  const keepButton = useRef<HTMLButtonElement | null>(null);
  const wasConfirming = useRef(false);
  useEffect(() => {
    if (confirmingDelete) keepButton.current?.focus();
    else if (wasConfirming.current) deleteButton.current?.focus();
    wasConfirming.current = confirmingDelete;
  }, [confirmingDelete]);
  const spendable = finance.accounts.filter(
    (account) =>
      account.type !== 'loan' && (!account.archived || account.id === transaction?.accountId),
  );
  // Choosing a line answers the account and the direction; either can still be changed after.
  const chooseLine = (id: string): void => {
    setLineId(id);
    const line = finance.lines.find((candidate) => candidate.id === id);
    if (line === undefined) return;
    if (transaction === null) {
      setAccountId(line.accountId);
      setDirection(line.flow === 'income' ? 'in' : 'out');
    }
  };

  // `keepOpen` is the "Save and add another" path: the date, account and line usually carry
  // over to the next entry, so only what changes row to row - the amount and description - is
  // cleared, and the dialog stays open for the next one instead of closing.
  const record = async (keepOpen: boolean): Promise<void> => {
    if (closedForEdit.length > 0) {
      setError('Reopen the closed month before saving this correction.');
      return;
    }
    if (closePending) {
      setBusy(true);
      if (await finishCorrection()) onClose();
      setBusy(false);
      return;
    }
    const magnitude = parseAmount(amount);
    if (magnitude === null || magnitude === 0) {
      setError('Enter the amount that moved.');
      return;
    }
    const input = {
      description: description.trim(),
      date,
      amount: direction === 'out' ? -Math.abs(magnitude) : Math.abs(magnitude),
      accountId: accountId === '' ? (spendable[0]?.id ?? '') : accountId,
      lineId: lineId === '' ? null : lineId,
      cleared: transaction?.cleared ?? false,
    };
    setBusy(true);
    if (beforeSave !== undefined) {
      const problem = await beforeSave();
      if (problem !== null) {
        setBusy(false);
        setError(problem);
        return;
      }
    }
    const refusal =
      transaction === null
        ? await state.createTransaction(input)
        : await state.setTransaction(transaction.id, input);
    setError(refusal);
    if (refusal === null) {
      if (transaction !== null) onSaved?.(transaction, { ...transaction, ...input });
      if (!(await finishCorrection())) {
        setBusy(false);
        return;
      }
      if (keepOpen) {
        setDescription('');
        setAmount('');
        amountField.current?.focus();
      } else {
        onClose();
      }
    }
    setBusy(false);
  };

  const submit = async (event: SyntheticEvent): Promise<void> => {
    event.preventDefault();
    await record(false);
  };

  const remove = async (): Promise<void> => {
    if (transaction === null) return;
    setBusy(true);
    const refusal = await state.deleteTransaction(transaction.id);
    setBusy(false);
    setError(refusal);
    if (refusal === null && (await finishCorrection())) onClose();
  };

  return (
    <Dialog
      open
      title={
        transaction === null
          ? 'Add a transaction'
          : beforeSave === undefined
            ? `Edit ${transaction.description}`
            : `Review undo for ${transaction.description}`
      }
      onClose={() => {
        if (!busy) onClose();
      }}
      closeLabel={busy ? 'Saving transaction' : 'Close'}
      initialFocus={amountField}
      dirty={dirty || reopened.length > 0}
      presentation={transaction === null ? 'standard' : 'workspace'}
    >
      <form
        className="@container flex min-w-0 flex-col gap-4"
        aria-busy={busy}
        onSubmit={(event) => {
          void submit(event);
        }}
      >
        {beforeSave === undefined ? null : (
          <Text variant="bodySmall">
            Review the previous values below. Restoring checks that this transaction still matches
            your saved edit.
          </Text>
        )}
        {closedForEdit.length > 0 ? (
          <div className="flex flex-col gap-3 rounded-lg border border-divider bg-surface-raised p-3">
            <Text variant="bodySmall">
              {closedForEdit.map((candidate) => formatMonth(candidate, 'long')).join(' and ')} is
              closed. Reopening allows corrections that recalculate account balances, budget totals
              and later forecasts.
            </Text>
            <Button
              type="button"
              variant="secondary"
              disabled={busy}
              onClick={() => {
                void reopen();
              }}
            >
              Reopen to correct
            </Button>
          </div>
        ) : null}
        {reopened.length > 0 ? (
          <div className="flex flex-col gap-2">
            <Checkbox
              label="Close reopened months after saving"
              checked={closeAfter}
              disabled={busy}
              onChange={(event) => {
                setCloseAfter(event.target.checked);
              }}
            />
            <Text variant="caption" tone="muted">
              These months stay open if you leave without saving:{' '}
              {reopened.map((candidate) => formatMonth(candidate)).join(', ')}.
            </Text>
          </div>
        ) : null}
        <fieldset disabled={busy || closePending} className="flex min-w-0 flex-col gap-4">
          <Field label="Amount" hint={`In ${currency}. Refunds go in as money in.`}>
            {(control) => (
              <div className="grid min-w-0 grid-cols-1 gap-2 @sm:grid-cols-2">
                <Input
                  {...control}
                  ref={amountField}
                  inputMode="decimal"
                  placeholder="12.40"
                  value={amount}
                  onChange={(event) => {
                    setAmount(event.target.value);
                  }}
                />
                <Select
                  aria-label="Direction"
                  value={direction}
                  onChange={(event) => {
                    setDirection(event.target.value === 'in' ? 'in' : 'out');
                  }}
                >
                  <option value="out">Money out</option>
                  <option value="in">Money in</option>
                </Select>
              </div>
            )}
          </Field>
          <Field label="Description" hint="The payee, or what it was for.">
            {(control) => (
              <Input
                {...control}
                value={description}
                onChange={(event) => {
                  setDescription(event.target.value);
                }}
              />
            )}
          </Field>
          <Field
            label="Budget line"
            hint="Leave unassigned to decide later; it still counts as spending."
          >
            {(control) => (
              <Select
                {...control}
                value={lineId}
                onChange={(event) => {
                  chooseLine(event.target.value);
                }}
              >
                <option value="">Unassigned</option>
                {linesBySection(finance.lines, lineId).map(([section, lines]) => (
                  <optgroup key={section} label={section}>
                    {lines.map((line) => (
                      <option key={line.id} value={line.id}>
                        {line.name}
                        {line.archived ? ' (archived)' : ''}
                      </option>
                    ))}
                  </optgroup>
                ))}
              </Select>
            )}
          </Field>
          <Field label="Account">
            {(control) => (
              <Select
                {...control}
                value={accountId === '' ? (spendable[0]?.id ?? '') : accountId}
                onChange={(event) => {
                  setAccountId(event.target.value);
                }}
              >
                {spendable.map((account) => (
                  <option key={account.id} value={account.id}>
                    {account.name}
                    {account.archived ? ' (archived)' : ''}
                  </option>
                ))}
              </Select>
            )}
          </Field>
          <Field label="Date">
            {(control) => (
              <Input
                {...control}
                type="date"
                value={date}
                onChange={(event) => {
                  setDate(event.target.value);
                }}
              />
            )}
          </Field>
        </fieldset>
        <WriteError message={error} />
        <div className="flex flex-wrap items-center justify-end gap-2">
          {transaction === null || beforeSave !== undefined ? null : confirmingDelete ? (
            <span className="mr-auto flex flex-wrap items-center gap-2">
              <Text as="span" variant="bodySmall">
                Delete this transaction?
              </Text>
              <Button
                ref={keepButton}
                type="button"
                variant="secondary"
                disabled={busy}
                onClick={() => {
                  setConfirmingDelete(false);
                }}
              >
                Keep it
              </Button>
              <Button
                type="button"
                variant="secondary"
                disabled={busy}
                onClick={() => {
                  void remove();
                }}
              >
                Yes, delete
              </Button>
            </span>
          ) : (
            <Button
              ref={deleteButton}
              type="button"
              variant="ghost"
              className="mr-auto"
              disabled={busy || closedForEdit.length > 0 || closePending}
              onClick={() => {
                setConfirmingDelete(true);
              }}
            >
              Delete
            </Button>
          )}
          <Button type="button" variant="secondary" disabled={busy} onClick={onClose}>
            Cancel
          </Button>
          {transaction === null ? (
            <Button
              type="button"
              variant="secondary"
              disabled={busy}
              onClick={() => {
                void record(true);
              }}
            >
              Save and add another
            </Button>
          ) : null}
          <Button type="submit" disabled={busy || closedForEdit.length > 0}>
            {busy
              ? 'Saving…'
              : closePending
                ? 'Retry closing month'
                : transaction === null
                  ? 'Record'
                  : beforeSave === undefined
                    ? 'Save changes'
                    : 'Restore previous values'}
          </Button>
        </div>
      </form>
    </Dialog>
  );
}

/** A bank CSV: previewed first, so what a commit would do is seen before it does it. */
