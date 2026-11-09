import { Button, Field, Input, Select } from '@nix/ui';
import type { Finance, FinanceTransaction } from '@nix/api-client';
import { useRef, useState, type ReactNode, type SyntheticEvent } from 'react';
import { WriteError } from './finance-shared';
import { formatMonth, monthOf, parseAmount, todayIn } from './money';
import { LineOptions } from './transaction-dialog';
import type { FinanceState } from './use-finance';

/**
 * Records transactions one after another without a dialog: the account and day carry over, and
 * focus goes back to Amount after each one. Typing a description that matches an earlier
 * categorised row suggests its category until the person picks one themselves.
 */
export function QuickAddForm({
  state,
  finance,
  month,
  suggest,
  onAdded,
}: {
  readonly state: FinanceState;
  readonly finance: Finance;
  readonly month: string;
  /** The line id an earlier row with this description used, or '' when there is none. */
  readonly suggest: (description: string) => string;
  readonly onAdded: (created: FinanceTransaction) => void;
}): ReactNode {
  const today = todayIn(finance.settings.timezone);
  const spendable = finance.accounts.filter(
    (account) => account.type !== 'loan' && !account.archived,
  );
  const [amount, setAmount] = useState('');
  const [direction, setDirection] = useState<'out' | 'in'>('out');
  const [description, setDescription] = useState('');
  const [lineId, setLineId] = useState('');
  const [touched, setTouched] = useState(false);
  const [accountId, setAccountId] = useState(spendable[0]?.id ?? '');
  const [date, setDate] = useState(monthOf(today) === month ? today : `${month}-01`);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const amountField = useRef<HTMLInputElement | null>(null);

  const chooseLine = (id: string): void => {
    setLineId(id);
    setTouched(true);
    const line = finance.lines.find((candidate) => candidate.id === id);
    if (line === undefined) return;
    setAccountId(line.accountId);
    setDirection(line.flow === 'income' ? 'in' : 'out');
  };
  const suggested = !touched && lineId !== '';

  const submit = async (event: SyntheticEvent): Promise<void> => {
    event.preventDefault();
    if (busy) return;
    const magnitude = parseAmount(amount);
    if (magnitude === null || magnitude === 0) {
      setError('Enter the amount that moved.');
      amountField.current?.focus();
      return;
    }
    if (finance.closedMonths.includes(monthOf(date))) {
      setError(
        `${formatMonth(monthOf(date), 'long')} is closed. Pick another date, or reopen it first.`,
      );
      return;
    }
    setBusy(true);
    const created = await state.addTransaction({
      description: description.trim(),
      date,
      amount: direction === 'out' ? -Math.abs(magnitude) : Math.abs(magnitude),
      accountId,
      lineId: lineId === '' ? null : lineId,
      cleared: false,
    });
    setBusy(false);
    if (typeof created === 'string') {
      setError(created);
      return;
    }
    setError(null);
    setAmount('');
    setDescription('');
    setLineId('');
    setTouched(false);
    setDirection('out');
    onAdded(created);
    amountField.current?.focus();
  };

  return (
    <form
      aria-label="Add a transaction"
      aria-busy={busy}
      className="@container grid min-w-0 grid-cols-2 gap-3 rounded-lg border border-divider p-3 @3xl:grid-cols-[minmax(9rem,11rem)_2fr_1.5fr_1.2fr_9rem_auto] @3xl:items-end"
      onSubmit={(event) => {
        void submit(event);
      }}
    >
      <Field label="Amount" className="col-span-2 @3xl:col-span-1">
        {(control) => (
          <div className="flex min-w-0 gap-2">
            <Input
              {...control}
              ref={amountField}
              inputMode="decimal"
              autoComplete="off"
              placeholder="12.40"
              value={amount}
              onChange={(event) => {
                setAmount(event.target.value);
              }}
            />
            <div role="group" aria-label="Direction" className="flex flex-none gap-1">
              {(['out', 'in'] as const).map((value) => (
                <Button
                  key={value}
                  variant={direction === value ? 'primary' : 'secondary'}
                  aria-pressed={direction === value}
                  aria-label={value === 'out' ? 'Money out' : 'Money in'}
                  onClick={() => {
                    setDirection(value);
                  }}
                >
                  {value === 'out' ? 'Out' : 'In'}
                </Button>
              ))}
            </div>
          </div>
        )}
      </Field>
      <Field label="Description" className="col-span-2 @3xl:col-span-1">
        {(control) => (
          <Input
            {...control}
            autoComplete="off"
            placeholder="Payee or note"
            value={description}
            onChange={(event) => {
              setDescription(event.target.value);
              if (!touched) setLineId(suggest(event.target.value));
            }}
          />
        )}
      </Field>
      <Field
        label="Category"
        className="col-span-2 @3xl:col-span-1"
        {...(suggested ? { hint: 'Suggested from an earlier transaction' } : {})}
      >
        {(control) => (
          <Select
            {...control}
            value={lineId}
            onChange={(event) => {
              chooseLine(event.target.value);
            }}
          >
            <option value="">Decide later</option>
            <LineOptions lines={finance.lines} retainedId={lineId} />
          </Select>
        )}
      </Field>
      <Field label="Account">
        {(control) => (
          <Select
            {...control}
            value={accountId}
            onChange={(event) => {
              setAccountId(event.target.value);
            }}
          >
            {spendable.map((account) => (
              <option key={account.id} value={account.id}>
                {account.name}
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
      <Button type="submit" className="col-span-2 @3xl:col-span-1" disabled={busy}>
        {busy ? 'Adding…' : 'Add'}
      </Button>
      <div className="col-span-2 @3xl:col-span-full">
        <WriteError message={error} />
      </div>
    </form>
  );
}
