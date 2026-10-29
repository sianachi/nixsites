import { Button, Tag, Text, cn, focusRing } from '@nix/ui';
import {
  finance as financeApi,
  type Finance,
  type FinanceDashboard as Dashboard,
} from '@nix/api-client';
import { useMemo, useState, type ReactNode } from 'react';
import {
  ErrorPanel,
  LoadingPanel,
  PartialNotice,
} from '@nix/web-foundation/components/states/status-panels';
import type { FinanceSection } from './finance-view';
import { Meter, Money } from './finance-shared';
import { FinanceMonthSummary } from './finance-month-summary';
import { formatDay, formatMonth, formatPercent, shiftMonth } from './money';
import { useFinanceQuery, type FinanceState } from './use-finance';

/** The month's position, the cards, the loans, what needs watching and what is due soon. */
export function FinanceDashboard({
  state,
  finance,
  month,
  onSection,
  onHistory,
}: {
  readonly state: FinanceState;
  readonly finance: Finance;
  readonly month: string;
  readonly onSection: (section: FinanceSection) => void;
  readonly onHistory?: (filter: {
    lineId?: string;
    accountId?: string;
    unassigned?: boolean;
  }) => void;
}): ReactNode {
  const itemId = finance.itemId;
  const endpoint = useMemo(() => financeApi.readDashboard(itemId, month), [itemId, month]);
  const query = useFinanceQuery<Dashboard>(endpoint, state.generation);
  const [compare, setCompare] = useState(false);
  const previousMonth = shiftMonth(month, -1);
  const previousEndpoint = useMemo(
    () =>
      compare && previousMonth >= finance.settings.startMonth
        ? financeApi.readDashboard(itemId, previousMonth)
        : null,
    [compare, itemId, previousMonth, finance.settings.startMonth],
  );
  const previous = useFinanceQuery<Dashboard>(previousEndpoint, state.generation);
  const previousDashboard = previous.data;
  const currency = finance.settings.currency;
  if (query.data?.month !== month) {
    return query.status === 'error' ? (
      <ErrorPanel title="The dashboard could not be loaded" detail={query.error ?? ''} />
    ) : (
      <LoadingPanel label="dashboard" />
    );
  }
  const dashboard = query.data;
  const bufferFraction =
    dashboard.emergencyTarget > 0 ? dashboard.position.netPosition / dashboard.emergencyTarget : 0;
  return (
    <div
      className="@container flex min-w-0 flex-col gap-6"
      aria-labelledby="finance-dashboard-title"
    >
      <Text as="h3" variant="h3" id="finance-dashboard-title" className="sr-only">
        Dashboard for {formatMonth(month, 'long')}
      </Text>
      {query.status === 'error' ? <PartialNotice pending="the latest figures" /> : null}
      <FinanceMonthSummary
        dashboard={dashboard}
        currency={currency}
        onAccounts={() => {
          onSection('accounts');
        }}
        onHistory={() => {
          if (onHistory === undefined) onSection('transactions');
          else onHistory({});
        }}
      />
      {previousMonth < finance.settings.startMonth ? null : (
        <details
          onToggle={(event) => {
            setCompare(event.currentTarget.open);
          }}
          className="rounded-lg border border-divider p-4"
        >
          <summary className="cursor-pointer text-base font-semibold any-pointer-coarse:min-h-(--control-lg)">
            Compare with {formatMonth(previousMonth, 'long')}
          </summary>
          <Text variant="bodySmall" tone="muted" className="mt-3">
            Recorded transactions in each month. An open month can still be incomplete.
          </Text>
          {previousDashboard?.month !== previousMonth ? (
            previous.status === 'error' ? (
              <ErrorPanel
                title="The previous month could not be loaded"
                detail={previous.error ?? ''}
              />
            ) : compare ? (
              <LoadingPanel label="previous month" />
            ) : null
          ) : (
            <div
              role="region"
              aria-label="Monthly finance comparison"
              // eslint-disable-next-line jsx-a11y/no-noninteractive-tabindex -- Justification: keyboard users need to reach horizontally clipped comparison columns.
              tabIndex={0}
              className={cn('mt-3 min-w-0 overflow-x-auto', focusRing)}
            >
              <table className="w-full min-w-max border-collapse text-left">
                <caption className="sr-only">
                  Recorded income, outgoings and money left compared with last month
                </caption>
                <thead>
                  <tr>
                    <th scope="col" className="p-2">
                      <Text variant="bodySmall">Recorded</Text>
                    </th>
                    <th scope="col" className="p-2">
                      <Text variant="bodySmall">{formatMonth(previousMonth)}</Text>
                    </th>
                    <th scope="col" className="p-2">
                      <Text variant="bodySmall">{formatMonth(dashboard.month)}</Text>
                    </th>
                  </tr>
                </thead>
                <tbody>
                  {(
                    [
                      { label: 'Income', key: 'income' },
                      { label: 'Outgoings', key: 'outgoings' },
                      { label: 'Money left', key: 'net' },
                    ] as const
                  ).map((row) => (
                    <tr key={row.key} className="border-t border-divider">
                      <th scope="row" className="p-2">
                        <Text variant="bodySmall">{row.label}</Text>
                      </th>
                      <td className="p-2">
                        <Money amount={previousDashboard.actual[row.key]} currency={currency} />
                      </td>
                      <td className="p-2">
                        <Money amount={dashboard.actual[row.key]} currency={currency} />
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
              {previous.status === 'error' ? (
                <PartialNotice pending="the latest comparison" />
              ) : null}
            </div>
          )}
        </details>
      )}

      <div className="grid gap-6 @3xl:grid-cols-2">
        <section
          className="@container flex min-w-0 flex-col gap-3"
          aria-labelledby="finance-watch-title"
        >
          <Text as="h4" variant="h5" id="finance-watch-title">
            Spending to review
          </Text>
          {dashboard.watch.length === 0 ? (
            <Text variant="bodySmall" tone="muted">
              Nothing is over its plan this month.
            </Text>
          ) : (
            <ul className="flex flex-col gap-2">
              {dashboard.watch.map((item) => (
                <li
                  key={item.lineId ?? 'unassigned'}
                  className="flex min-w-0 flex-col items-start justify-between gap-3 rounded-lg bg-surface-raised p-3 @sm:flex-row @sm:items-center"
                >
                  <div className="min-w-0">
                    <Button
                      variant="ghost"
                      className="h-auto min-h-(--control-md) max-w-full justify-start px-0 text-left wrap-anywhere"
                      onClick={() => {
                        if (onHistory === undefined) onSection('budget');
                        else
                          onHistory(
                            item.lineId === null ? { unassigned: true } : { lineId: item.lineId },
                          );
                      }}
                    >
                      {item.name}
                    </Button>
                    <Text variant="caption" tone="muted">
                      {item.lineId === null ? (
                        'Recorded against no budget line'
                      ) : (
                        <>
                          <Money amount={item.actual} currency={currency} /> of{' '}
                          <Money amount={item.plan} currency={currency} /> planned
                        </>
                      )}
                    </Text>
                  </div>
                  <Tag tone="accent">
                    <Money amount={item.variance} currency={currency} signed /> over
                  </Tag>
                </li>
              ))}
            </ul>
          )}
          <Button
            variant="ghost"
            onClick={() => {
              onSection('budget');
            }}
          >
            Open the budget
          </Button>
        </section>

        <section
          className="@container flex min-w-0 flex-col gap-3"
          aria-labelledby="finance-upcoming-title"
        >
          <Text as="h4" variant="h5" id="finance-upcoming-title">
            Due in the next two weeks
          </Text>
          {dashboard.upcoming.length === 0 ? (
            <Text variant="bodySmall" tone="muted">
              Nothing scheduled is due in the next fourteen days.
            </Text>
          ) : (
            <ul className="flex flex-col gap-2">
              {dashboard.upcoming.map((item) => (
                <li
                  key={`${item.kind}:${item.lineId ?? item.accountId ?? ''}:${item.due}`}
                  className="flex min-w-0 flex-col items-start justify-between gap-3 rounded-lg bg-surface-raised p-3 @sm:flex-row @sm:items-center"
                >
                  <div className="min-w-0">
                    <Text as="p" variant="bodySmall" className="truncate font-medium">
                      {item.name}
                    </Text>
                    <Text variant="caption" tone="muted">
                      {formatDay(item.due)}
                      {item.kind === 'line' ? (item.posted ? ', posted' : ', not yet posted') : ''}
                    </Text>
                  </div>
                  <Text as="span" variant="bodySmall">
                    <Money amount={item.amount} currency={currency} />
                  </Text>
                </li>
              ))}
            </ul>
          )}
        </section>
      </div>

      <section className="flex flex-col gap-3" aria-labelledby="finance-buffer-title">
        <Text as="h4" variant="h5" id="finance-buffer-title">
          Cash and card buffer
        </Text>
        {dashboard.emergencyTarget <= 0 ? (
          <Text variant="bodySmall" tone="muted">
            No emergency target is set. Choose months of outgoings under Settings.
          </Text>
        ) : (
          <div className="flex flex-col gap-2 rounded-lg bg-surface-raised p-3">
            <Text as="p" variant="bodySmall">
              <Money amount={dashboard.position.netPosition} currency={currency} round /> of{' '}
              <Money amount={dashboard.emergencyTarget} currency={currency} round />
              {dashboard.bufferMetIn === null
                ? ', not reached inside the plan'
                : `, reached in ${formatMonth(dashboard.bufferMetIn)}`}
            </Text>
            <Meter fraction={bufferFraction} label="Cash and card buffer progress" />
            <Text variant="caption" tone="muted">
              Includes card credits; cash held is shown above. The target is based on your chosen
              months of outgoings.
            </Text>
          </div>
        )}
      </section>

      {dashboard.cards.length === 0 && dashboard.loans.length === 0 ? null : (
        <div className="grid gap-6 @3xl:grid-cols-2">
          {dashboard.cards.length === 0 ? null : (
            <section className="flex flex-col gap-3" aria-labelledby="finance-cards-title">
              <Text as="h4" variant="h5" id="finance-cards-title">
                Cards
              </Text>
              <ul className="flex flex-col gap-2">
                {dashboard.cards.map((card) => (
                  <li key={card.accountId} className="rounded-lg bg-surface-raised p-3">
                    <div className="flex min-w-0 flex-wrap items-center justify-between gap-3">
                      <Text as="p" variant="bodySmall" className="min-w-0 font-medium">
                        {card.name}
                      </Text>
                      {card.closing < 0 ? (
                        <Tag tone="muted">Card credit</Tag>
                      ) : card.utilisation === null ? (
                        <Tag tone="muted">No limit set</Tag>
                      ) : (
                        <Tag tone={card.utilisation > 0.3 ? 'accent' : 'neutral'}>
                          {formatPercent(card.utilisation)} used
                        </Tag>
                      )}
                    </div>
                    <Text variant="caption" tone="muted">
                      {card.spend < 0 ? 'Refunds above spending: ' : 'Spent '}
                      <Money amount={Math.abs(card.spend)} currency={currency} /> this month;{' '}
                      <Money amount={card.paymentOut} currency={currency} /> collected;{' '}
                      <Money amount={Math.abs(card.closing)} currency={currency} />{' '}
                      {card.closing < 0 ? 'card credit' : 'owed'} at month end
                    </Text>
                  </li>
                ))}
              </ul>
            </section>
          )}
          {dashboard.loans.length === 0 ? null : (
            <section className="flex flex-col gap-3" aria-labelledby="finance-loans-title">
              <Text as="h4" variant="h5" id="finance-loans-title">
                Loans
              </Text>
              <ul className="flex flex-col gap-2">
                {dashboard.loans.map((loan) => (
                  <li key={loan.accountId} className="rounded-lg bg-surface-raised p-3">
                    <Text as="p" variant="bodySmall" className="font-medium">
                      {loan.name}
                    </Text>
                    <Text variant="caption" tone="muted">
                      <Money amount={loan.balance} currency={currency} /> left
                      {loan.clearedIn === null
                        ? ', not cleared inside the schedule'
                        : `, cleared ${formatMonth(loan.clearedIn)}`}
                      ; <Money amount={loan.totalInterest} currency={currency} round /> interest in
                      all
                    </Text>
                  </li>
                ))}
              </ul>
              <Button
                variant="ghost"
                onClick={() => {
                  onSection('accounts');
                }}
              >
                Try an overpayment
              </Button>
            </section>
          )}
        </div>
      )}
    </div>
  );
}
