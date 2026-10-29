import { Button, Field, Input, Table, Tag, Text, cn, focusRing, type TableColumn } from '@nix/ui';
import {
  finance as financeApi,
  type Finance,
  type FinanceAccount,
  type FinanceAccounts as Accounts,
  type LoanSchedule,
} from '@nix/api-client';
import { useMemo, useState, type ReactNode } from 'react';
import {
  ErrorPanel,
  LoadingPanel,
  PartialNotice,
} from '@nix/web-foundation/components/states/status-panels';
import { AccountDialog, accountTypeLabel } from './finance-setup';
import { Meter, Money, SectionHeading, Tile, WriteError } from './finance-shared';
import { formatMonth, formatPercent, parseAmount } from './money';
import { useFinanceQuery, type FinanceState } from './use-finance';

/** Every account with the figure that matters for its type, and the loan what-if. */
export function FinanceAccounts({
  state,
  finance,
  month,
}: {
  readonly state: FinanceState;
  readonly finance: Finance;
  readonly month: string;
}): ReactNode {
  const currency = finance.settings.currency;
  const [editing, setEditing] = useState<FinanceAccount | null | 'new'>(null);
  const itemId = finance.itemId;
  const endpoint = useMemo(() => financeApi.readAccounts(itemId, month), [itemId, month]);
  const query = useFinanceQuery<Accounts>(endpoint, state.generation);
  const names = new Map(finance.accounts.map((account) => [account.id, account.name]));
  return (
    <div className="@container flex min-w-0 flex-col gap-6">
      <SectionHeading
        id="finance-accounts-title"
        title="Accounts"
        detail={`As at the end of ${formatMonth(month, 'long')}.`}
        actions={
          <Button
            variant="secondary"
            onClick={() => {
              setEditing('new');
            }}
          >
            Add an account
          </Button>
        }
      />
      {query.data === null ? (
        query.status === 'error' ? (
          <ErrorPanel title="The accounts could not be loaded" detail={query.error ?? ''} />
        ) : (
          <LoadingPanel label="accounts" />
        )
      ) : (
        <>
          {query.status === 'error' ? <PartialNotice pending="the latest figures" /> : null}
          {query.data.accounts.length === 0 ? (
            <Text variant="bodySmall" tone="muted">
              No accounts yet. Start with the current account your salary lands in, then each card
              and any loan.
            </Text>
          ) : (
            <ul className="grid min-w-0 gap-3 @3xl:grid-cols-2">
              {query.data.accounts.map((summary) => (
                <li
                  key={summary.account.id}
                  className="@container flex min-w-0 flex-col gap-2 rounded-lg bg-surface-raised p-3"
                >
                  <div className="flex items-start justify-between gap-3">
                    <div className="min-w-0">
                      <Text as="p" variant="body" className="truncate font-medium">
                        {summary.account.name}
                      </Text>
                      <Text variant="caption" tone="muted">
                        {accountTypeLabel(summary.account.type)}
                        {summary.account.archived ? ', archived' : ''}
                        {summary.card !== null && summary.card.settlesFrom !== null
                          ? `, paid from ${names.get(summary.card.settlesFrom) ?? 'another account'}`
                          : ''}
                      </Text>
                    </div>
                    <Button
                      variant="subtle"
                      onClick={() => {
                        setEditing(summary.account);
                      }}
                    >
                      Edit
                    </Button>
                  </div>
                  {summary.card !== null ? (
                    <dl className="grid min-w-0 grid-cols-1 gap-x-3 gap-y-2 @xs:grid-cols-2">
                      <Fact
                        label={`Spent in ${formatMonth(month)}`}
                        value={<Money amount={summary.card.spend} currency={currency} />}
                      />
                      <Fact
                        label="Collected this month"
                        value={<Money amount={summary.card.paymentOut} currency={currency} />}
                      />
                      <Fact
                        label="Owed at month end"
                        value={<Money amount={summary.card.closing} currency={currency} />}
                      />
                      <Fact
                        label="Utilisation"
                        value={
                          summary.card.utilisation === null ? (
                            <Tag tone="muted">Set a limit</Tag>
                          ) : (
                            <span className="flex flex-wrap items-center gap-2">
                              {formatPercent(summary.card.utilisation)}
                              {summary.card.utilisation > 0.3 ? (
                                <Tag tone="accent">Over 30%</Tag>
                              ) : null}
                            </span>
                          )
                        }
                      />
                    </dl>
                  ) : summary.loan !== null ? (
                    <dl className="grid min-w-0 grid-cols-1 gap-x-3 gap-y-2 @xs:grid-cols-2">
                      <Fact
                        label="Still owed"
                        value={
                          <Money amount={summary.loan.balanceAfterMonth} currency={currency} />
                        }
                      />
                      <Fact
                        label="Each month"
                        value={
                          <>
                            <Money
                              amount={summary.loan.payment + summary.loan.overpayment}
                              currency={currency}
                            />
                            {summary.loan.overpayment > 0
                              ? ` incl. ${String(summary.loan.overpayment)} extra`
                              : ''}
                          </>
                        }
                      />
                      <Fact
                        label="Cleared"
                        value={
                          summary.loan.clearedIn === null
                            ? 'Not inside the schedule'
                            : formatMonth(summary.loan.clearedIn)
                        }
                      />
                      <Fact
                        label="Interest in all"
                        value={
                          <Money amount={summary.loan.totalInterest} currency={currency} round />
                        }
                      />
                    </dl>
                  ) : (
                    <dl className="grid min-w-0 grid-cols-1 gap-x-3 gap-y-2 @xs:grid-cols-2">
                      <Fact
                        label="Recorded balance"
                        value={<Money amount={summary.recordedBalance ?? 0} currency={currency} />}
                      />
                      <Fact
                        label="Started at"
                        value={
                          <Money amount={summary.account.openingBalance} currency={currency} />
                        }
                      />
                      {summary.account.target !== null && summary.savingsProgress !== null ? (
                        <div className="flex min-w-0 flex-col gap-1 @xs:col-span-2">
                          <Fact
                            label="Towards target"
                            value={`${formatPercent(summary.savingsProgress)} of ${String(summary.account.target)}`}
                          />
                          <Meter
                            fraction={summary.savingsProgress}
                            label={`${summary.account.name} savings progress`}
                          />
                        </div>
                      ) : null}
                    </dl>
                  )}
                </li>
              ))}
            </ul>
          )}
        </>
      )}
      {finance.accounts
        .filter((account) => account.type === 'loan' && !account.archived)
        .map((loan) => (
          <LoanWhatIf key={loan.id} state={state} finance={finance} loan={loan} />
        ))}
      <AccountDialog
        state={state}
        finance={finance}
        account={editing === 'new' || editing === null ? null : editing}
        open={editing !== null}
        onClose={() => {
          setEditing(null);
        }}
      />
    </div>
  );
}

function Fact({ label, value }: { readonly label: string; readonly value: ReactNode }): ReactNode {
  return (
    <div className="flex min-w-0 flex-col">
      <Text as="dt" variant="caption" tone="muted">
        {label}
      </Text>
      <Text as="dd" variant="bodySmall">
        {value}
      </Text>
    </div>
  );
}

/** The loan's schedule as configured, beside the schedule with the overpayment typed here. */
function LoanWhatIf({
  state,
  finance,
  loan,
}: {
  readonly state: FinanceState;
  readonly finance: Finance;
  readonly loan: FinanceAccount;
}): ReactNode {
  const currency = finance.settings.currency;
  const [typed, setTyped] = useState(String(loan.overpayment ?? 0));
  const [applied, setApplied] = useState<number | undefined>(undefined);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [showSchedule, setShowSchedule] = useState(false);
  const itemId = finance.itemId;
  const loanId = loan.id;
  const endpoint = useMemo(
    () => financeApi.readLoan(itemId, loanId, applied),
    [itemId, loanId, applied],
  );
  const query = useFinanceQuery<LoanSchedule>(endpoint, state.generation);
  const tryIt = (): void => {
    const parsed = parseAmount(typed);
    if (parsed === null || parsed < 0) {
      setError('An overpayment is an amount of zero or more.');
      return;
    }
    setError(null);
    setApplied(parsed);
  };
  const commit = async (): Promise<void> => {
    if (applied === undefined) return;
    setBusy(true);
    const refusal = await state.setAccount(loan.id, {
      name: loan.name,
      type: loan.type,
      limit: loan.limit,
      openingBalance: loan.openingBalance,
      settlesFrom: loan.settlesFrom,
      apr: loan.apr,
      payment: loan.payment,
      overpayment: applied,
      target: loan.target,
      archived: loan.archived,
    });
    setBusy(false);
    setError(refusal);
    if (refusal === null) setApplied(undefined);
  };
  const schedule = query.data;
  const columns: readonly TableColumn<LoanSchedule['months'][number]>[] = [
    { key: 'month', header: 'Month', rowHeader: true, cell: (row) => formatMonth(row.month) },
    {
      key: 'opening',
      header: 'Opening',
      align: 'end',
      cell: (row) => <Money amount={row.opening} currency={currency} />,
    },
    {
      key: 'interest',
      header: 'Interest',
      align: 'end',
      cell: (row) => <Money amount={row.interest} currency={currency} />,
    },
    {
      key: 'payment',
      header: 'Payment',
      align: 'end',
      cell: (row) => <Money amount={row.payment} currency={currency} />,
    },
    {
      key: 'principal',
      header: 'Principal',
      align: 'end',
      cell: (row) => <Money amount={row.principal} currency={currency} />,
    },
    {
      key: 'closing',
      header: 'Closing',
      align: 'end',
      cell: (row) => <Money amount={row.closing} currency={currency} />,
    },
  ];
  return (
    <section
      className="@container flex min-w-0 flex-col gap-3"
      aria-labelledby={`finance-loan-${loan.id}`}
    >
      <Text as="h4" variant="h5" id={`finance-loan-${loan.id}`}>
        {loan.name}: what an overpayment buys
      </Text>
      <div className="flex min-w-0 flex-col gap-3 @lg:flex-row @lg:items-end">
        <Field
          label="Overpay each month"
          hint="Try a figure; apply it when it is right."
          className="min-w-0 flex-1"
        >
          {(control) => (
            <Input
              {...control}
              inputMode="decimal"
              value={typed}
              onChange={(event) => {
                setTyped(event.target.value);
              }}
            />
          )}
        </Field>
        <div className="flex flex-wrap gap-2 pb-2">
          <Button variant="secondary" onClick={tryIt}>
            Try it
          </Button>
          <Button
            disabled={busy || applied === undefined || applied === (loan.overpayment ?? 0)}
            onClick={() => {
              void commit();
            }}
          >
            Apply to the loan
          </Button>
        </div>
      </div>
      <WriteError message={error} />
      {schedule === null ? (
        query.status === 'error' ? (
          <Text as="p" variant="bodySmall" role="alert">
            {query.error}
          </Text>
        ) : (
          <LoadingPanel label="the schedule" />
        )
      ) : (
        <>
          <div className="grid min-w-0 gap-3 @lg:grid-cols-3">
            <Tile
              label="Cleared"
              value={
                schedule.alternative.clearedIn === null
                  ? 'Not cleared'
                  : formatMonth(schedule.alternative.clearedIn)
              }
              caption={
                schedule.monthsSaved === 0
                  ? `${String(schedule.baseline.monthsToClear)} months as configured`
                  : `${String(schedule.monthsSaved)} months sooner than ${schedule.baseline.clearedIn === null ? 'never' : formatMonth(schedule.baseline.clearedIn)}`
              }
            />
            <Tile
              label="Interest in all"
              value={
                <Money amount={schedule.alternative.totalInterest} currency={currency} round />
              }
              caption={
                schedule.interestSaved === 0 ? (
                  'as configured'
                ) : (
                  <>
                    saves <Money amount={schedule.interestSaved} currency={currency} round />{' '}
                    against{' '}
                    <Money amount={schedule.baseline.totalInterest} currency={currency} round />
                  </>
                )
              }
            />
            <Tile
              label="Each month"
              value={
                <Money
                  amount={schedule.alternative.payment + schedule.alternative.overpayment}
                  currency={currency}
                />
              }
              caption={`${String(schedule.alternative.payment)} standard plus ${String(schedule.alternative.overpayment)} extra at ${formatPercent(schedule.alternative.apr)}`}
            />
          </div>
          <Button
            variant="subtle"
            aria-expanded={showSchedule}
            onClick={() => {
              setShowSchedule((value) => !value);
            }}
          >
            {showSchedule ? 'Hide the repayment schedule' : 'Show the repayment schedule'}
          </Button>
          {showSchedule ? (
            <div
              role="region"
              aria-label={`Repayment schedule for ${loan.name}`}
              // eslint-disable-next-line jsx-a11y/no-noninteractive-tabindex -- Justification: keyboard users need to reach horizontally clipped repayment columns.
              tabIndex={0}
              className={cn('min-w-0 overflow-x-auto', focusRing)}
            >
              <Table<LoanSchedule['months'][number]>
                caption={`Repayment schedule for ${loan.name}`}
                columns={columns}
                rows={schedule.months}
                rowKey={(row) => String(row.number)}
                emptyMessage="The loan has nothing left to pay."
              />
            </div>
          ) : null}
        </>
      )}
    </section>
  );
}
