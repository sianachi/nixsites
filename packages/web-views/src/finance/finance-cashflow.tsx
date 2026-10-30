import { ScrollRegion, Table, Tag, Text, cn, focusRing, type TableColumn } from '@nix/ui';
import {
  finance as financeApi,
  type CashFlow,
  type CashFlowMonth,
  type Finance,
} from '@nix/api-client';
import { useMemo, type ReactNode } from 'react';
import {
  ErrorPanel,
  LoadingPanel,
  PartialNotice,
} from '@nix/web-foundation/components/states/status-panels';
import { Money, SectionHeading, Tile, editableTextButton } from './finance-shared';
import { formatMonth } from './money';
import { useFinanceQuery, type FinanceState } from './use-finance';
import { FinanceBalanceTrend } from './finance-balance-trend';

/** Money in the month it moves, from the first month to the end of the horizon. */
export function FinanceCashFlow({
  state,
  finance,
  month,
  onMonth,
}: {
  readonly state: FinanceState;
  readonly finance: Finance;
  readonly month: string;
  readonly onMonth?: ((month: string) => void) | undefined;
}): ReactNode {
  const currency = finance.settings.currency;
  const itemId = finance.itemId;
  const endpoint = useMemo(() => financeApi.readCashFlow(itemId), [itemId]);
  const query = useFinanceQuery<CashFlow>(endpoint, state.generation);
  if (query.data === null) {
    return query.status === 'error' ? (
      <ErrorPanel title="The cash flow could not be loaded" detail={query.error ?? ''} />
    ) : (
      <LoadingPanel label="cash flow" />
    );
  }
  const projection = query.data;
  const selected = projection.months.find((row) => row.month === month);
  const columns: readonly TableColumn<CashFlowMonth>[] = [
    {
      key: 'month',
      header: 'Month',
      rowHeader: true,
      cell: (row) => (
        <span className="flex flex-wrap items-center gap-2">
          {onMonth === undefined ? (
            formatMonth(row.month)
          ) : (
            <button
              type="button"
              className={editableTextButton}
              onClick={() => {
                onMonth(row.month);
              }}
            >
              {formatMonth(row.month)}
            </button>
          )}
          {row.source === 'actual' ? <Tag tone="accent">Closed</Tag> : null}
          {row.month === month ? <Tag tone="muted">Selected</Tag> : null}
        </span>
      ),
    },
    {
      key: 'income',
      header: 'Income',
      align: 'end',
      cell: (row) => <Money amount={row.income} currency={currency} />,
    },
    {
      key: 'paid',
      header: 'Paid this month',
      align: 'end',
      cell: (row) => <Money amount={row.paidThisMonth} currency={currency} />,
    },
    {
      key: 'cardSpend',
      header: 'Card spend',
      align: 'end',
      cell: (row) => <Money amount={row.cardSpend} currency={currency} />,
    },
    {
      key: 'cardOut',
      header: 'Card payment out',
      align: 'end',
      cell: (row) => <Money amount={row.cardPaymentOut} currency={currency} />,
    },
    {
      key: 'cashNet',
      header: 'Cash net',
      align: 'end',
      cell: (row) => <Money amount={row.cashNet} currency={currency} signed />,
    },
    {
      key: 'bank',
      header: 'Closing bank',
      align: 'end',
      cell: (row) => <Money amount={row.closingBank} currency={currency} />,
    },
    {
      key: 'owed',
      header: 'Net card balance',
      align: 'end',
      cell: (row) => <Money amount={row.cardOwed} currency={currency} />,
    },
    {
      key: 'net',
      header: 'Net position',
      align: 'end',
      cell: (row) => <Money amount={row.netPosition} currency={currency} />,
    },
    {
      key: 'target',
      header: 'Emergency target',
      align: 'end',
      cell: (row) => <Money amount={row.emergencyTarget} currency={currency} />,
    },
    { key: 'buffer', header: 'Buffer', cell: (row) => (row.bufferMet ? 'Met' : '') },
  ];
  const last = projection.months[projection.months.length - 1];
  return (
    <div className="@container flex min-w-0 flex-col gap-4">
      <SectionHeading
        id="finance-cashflow-title"
        title="Cash flow"
        detail="Cards are paid in arrears: what leaves in a month is the month before's card spend. Closed months read from their transactions, open ones from the plan."
      />
      {query.status === 'error' ? <PartialNotice pending="the latest figures" /> : null}
      <FinanceBalanceTrend
        months={projection.months}
        month={month}
        currency={currency}
        onMonth={onMonth}
      />
      {selected === undefined ? null : (
        <div className="grid gap-3 @lg:grid-cols-3" aria-label="Selected month balances">
          <Tile
            label={`Cash held at ${formatMonth(month)}`}
            value={<Money amount={selected.closingBank} currency={currency} />}
            caption={
              selected.source === 'plan' ? 'Forecast from the budget' : 'Recorded in a closed month'
            }
          />
          <Tile
            label="Net card balances"
            value={<Money amount={selected.cardOwed} currency={currency} />}
            caption="Positive means owed; negative means card credit"
          />
          <Tile
            label="Cash and card position"
            value={<Money amount={selected.netPosition} currency={currency} />}
            caption="Remaining loans are shown under Accounts."
          />
        </div>
      )}
      <details className="min-w-0 rounded-lg border border-divider p-4">
        <summary className="cursor-pointer text-base font-semibold any-pointer-coarse:min-h-(--control-lg)">
          Detailed monthly ledger and targets
        </summary>
        <div className="mt-4 grid gap-3 @lg:grid-cols-2 @3xl:grid-cols-4">
          <Tile
            label="Opening net position"
            value={<Money amount={projection.openingNetPosition} currency={currency} round />}
            caption={
              <>
                <Money amount={projection.openingBank} currency={currency} round /> in the bank less{' '}
                <Money amount={projection.openingCardOwed} currency={currency} round /> net card
                balance
              </>
            }
          />
          {last === undefined ? null : (
            <Tile
              label={`Net position at ${formatMonth(last.month)}`}
              value={<Money amount={last.netPosition} currency={currency} round />}
              caption={
                <>
                  Bank <Money amount={last.closingBank} currency={currency} round />
                </>
              }
            />
          )}
          <Tile
            label="Emergency target"
            value={
              <Money
                amount={selected?.emergencyTarget ?? projection.emergencyTarget}
                currency={currency}
                round
              />
            }
            caption={`${String(finance.settings.emergencyFundMonths)} months of ${formatMonth(selected?.month ?? projection.emergencyBasisMonth)}'s planned outgoings`}
          />
          <Tile
            label="Buffer reached"
            value={
              projection.bufferMetIn === null
                ? 'Not inside the plan'
                : formatMonth(projection.bufferMetIn)
            }
            caption="The first month the net position covers that month's target."
          />
        </div>
        <ScrollRegion
          aria-label="Monthly cash flow"
          className={cn('min-w-0 overflow-x-auto', focusRing)}
        >
          <Table<CashFlowMonth>
            caption="Cash flow by month"
            columns={columns}
            rows={projection.months}
            rowKey={(row) => row.month}
            emptyMessage="The plan has no months."
          />
        </ScrollRegion>
      </details>
      <Text variant="bodySmall" tone="muted">
        Cash held is the bank balance. The cash and card position adds card credits and deducts
        unpaid cards. Card credits cover future card spending; they are not cash held. Remaining
        loans are listed separately under Accounts.
      </Text>
    </div>
  );
}
