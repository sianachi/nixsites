import { Button, Text } from '@nix/ui';
import type { FinanceDashboard } from '@nix/api-client';
import type { ReactNode } from 'react';
import { Money, Tile } from './finance-shared';
import { formatMonth } from './money';

/** Keep monthly surplus, available cash and remaining debt distinct. Core owns all totals. */
export function FinanceMonthSummary({
  dashboard,
  currency,
  onAccounts,
  onHistory,
}: {
  readonly dashboard: FinanceDashboard;
  readonly currency: string;
  readonly onAccounts: () => void;
  readonly onHistory: () => void;
}): ReactNode {
  const projected = dashboard.position.source === 'plan';
  const figures = projected ? dashboard.plan : dashboard.actual;
  const afterDebt = dashboard.monthEndAfterDebt;
  return (
    <section
      className="@container flex min-w-0 flex-col gap-4 rounded-lg border border-divider bg-surface-raised p-3 @sm:p-5"
      aria-labelledby="month-end-title"
    >
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div>
          <Text as="h3" variant="h4" id="month-end-title">
            At the end of {formatMonth(dashboard.month, 'long')}
          </Text>
          <Text variant="bodySmall" tone="muted">
            {projected
              ? 'Forecast from your budget. Recorded spending is shown separately below.'
              : 'Monthly income, spending and cash use the recorded transactions in this closed month.'}
          </Text>
        </div>
        <Button variant="secondary" onClick={onAccounts}>
          View accounts and debts
        </Button>
      </div>
      <div className="grid gap-4 @lg:grid-cols-2">
        <div className="flex min-w-0 flex-col gap-2 border-l-4 border-accent-fill p-3">
          <Text variant="body" className="font-semibold">
            {figures.net < 0 ? 'Spending above income this month' : 'Money left this month'}
          </Text>
          <Text as="p" variant="h3" className="tabular-nums">
            <Money amount={Math.abs(figures.net)} currency={currency} />
          </Text>
          <Text variant="bodySmall" tone="muted">
            {figures.net < 0
              ? 'Your outgoings exceed your income. This reduces your savings or adds to what you owe.'
              : 'Income less this month’s outgoings, including card spending and refunds. This is your monthly surplus; cash held and remaining debt are shown separately.'}
          </Text>
        </div>
        <div className="flex min-w-0 flex-col gap-2 border-l-4 border-divider p-3">
          <Text variant="body" className="font-semibold">
            {afterDebt === undefined
              ? dashboard.position.netPosition < 0
                ? 'Card bills above cash held'
                : 'Cash and card position'
              : afterDebt < 0
                ? 'Debt above cash held'
                : 'Cash after all remaining debt'}
          </Text>
          <Text as="p" variant="h3" className="tabular-nums">
            <Money
              amount={Math.abs(afterDebt ?? dashboard.position.netPosition)}
              currency={currency}
            />
          </Text>
          <Text variant="bodySmall" tone="muted">
            {afterDebt === undefined
              ? 'Cash plus card credits, less unpaid cards. Card credits are not cash held. Remaining loans are listed under accounts.'
              : 'Cash held less unpaid cards and scheduled remaining loan balances. This is your overall position, not the amount saved this month.'}
          </Text>
        </div>
      </div>
      <div className="grid gap-3 @lg:grid-cols-3">
        <Tile
          label="Cash held at month end"
          value={<Money amount={dashboard.position.closingBank} currency={currency} />}
        />
        <Tile
          label="Net card balances"
          value={<Money amount={dashboard.position.cardOwed} currency={currency} />}
          caption="Positive means owed; negative means card credit"
        />
        {dashboard.monthEndDebt === undefined ? null : (
          <Tile
            label="Total remaining debt"
            value={<Money amount={dashboard.monthEndDebt} currency={currency} />}
            caption="Cards and scheduled loan balances"
          />
        )}
      </div>
      <div className="flex flex-wrap items-center justify-between gap-3 border-t border-divider pt-3">
        <Text variant="bodySmall">
          Recorded so far: <Money amount={dashboard.actual.income} currency={currency} /> income,{' '}
          <Money amount={dashboard.actual.outgoings} currency={currency} /> outgoings,{' '}
          <Money amount={dashboard.actual.net} currency={currency} signed /> left.
        </Text>
        <Button variant="ghost" onClick={onHistory}>
          Review recorded transactions
        </Button>
      </div>
    </section>
  );
}
