import { Button, Text } from '@nix/ui';
import type { CashFlowMonth } from '@nix/api-client';
import type { ReactNode } from 'react';
import { Money } from './finance-shared';
import { formatMonth } from './money';

/** Coordinates describe server figures; the browser never invents a balance. */
export function FinanceBalanceTrend({
  months,
  month,
  currency,
  onMonth,
}: {
  readonly months: readonly CashFlowMonth[];
  readonly month: string;
  readonly currency: string;
  readonly onMonth?: ((month: string) => void) | undefined;
}): ReactNode {
  const selectedIndex = Math.max(
    0,
    months.findIndex((row) => row.month === month),
  );
  const start = Math.min(Math.max(0, selectedIndex - 5), Math.max(0, months.length - 12));
  const visible = months.slice(start, start + 12);
  if (visible.length === 0) return null;
  const low = Math.min(0, ...visible.map((row) => row.netPosition));
  const high = Math.max(1, ...visible.map((row) => row.netPosition));
  const x = (index: number): number => 30 + (index / Math.max(1, visible.length - 1)) * 540;
  const y = (value: number): number => 180 - ((value - low) / (high - low)) * 160;
  return (
    <section
      aria-labelledby="balance-trend-title"
      className="flex min-w-0 flex-col gap-3 rounded-lg border border-divider p-4"
    >
      <Text as="h3" variant="h3" id="balance-trend-title">
        Cash and card position, month by month
      </Text>
      <Text variant="bodySmall" tone="muted">
        Cash plus card credits, less unpaid cards. Card credits can cover future card spending; they
        are not cash held. Remaining loans are shown under Accounts. Dashed segments are forecasts;
        solid segments are closed months.
      </Text>
      <div className="flex min-w-0 gap-3">
        <div className="flex min-w-0 max-w-1/3 flex-col justify-between py-3 text-right">
          <Text variant="bodySmall">
            <Money amount={high} currency={currency} round />
          </Text>
          <Text variant="bodySmall">
            <Money amount={low} currency={currency} round />
          </Text>
        </div>
        <svg
          className="h-48 min-w-0 flex-1 basis-0 text-accent-text"
          viewBox="0 0 600 200"
          preserveAspectRatio="xMidYMid meet"
          role="img"
          aria-label={`Month-end cash and card position from ${formatMonth(visible[0]?.month ?? month)} to ${formatMonth(visible.at(-1)?.month ?? month)}. Exact balances are in the monthly table.`}
        >
          <line
            x1="0"
            x2="600"
            y1={y(0)}
            y2={y(0)}
            className="text-divider"
            stroke="currentColor"
            strokeWidth="1"
            vectorEffect="non-scaling-stroke"
          />
          {visible.slice(1).map((row, index) => (
            <line
              key={row.month}
              x1={x(index)}
              y1={y(visible[index]?.netPosition ?? 0)}
              x2={x(index + 1)}
              y2={y(row.netPosition)}
              stroke="currentColor"
              strokeWidth="2"
              strokeDasharray={row.source === 'plan' ? '5 4' : undefined}
              vectorEffect="non-scaling-stroke"
            />
          ))}
          {visible.map((row, index) => (
            <circle
              key={row.month}
              cx={x(index)}
              cy={y(row.netPosition)}
              r={row.month === month ? 5 : 3}
              fill="currentColor"
            >
              <title>
                {formatMonth(row.month)}: {String(row.netPosition)} {currency},{' '}
                {row.source === 'plan' ? 'forecast' : 'recorded'}
              </title>
            </circle>
          ))}
        </svg>
      </div>
      <div className="flex justify-between gap-3">
        <Text variant="bodySmall" tone="muted">
          {formatMonth(visible[0]?.month ?? month)}
        </Text>
        <Text variant="bodySmall" tone="muted">
          {formatMonth(visible.at(-1)?.month ?? month)}
        </Text>
      </div>
      <div className="flex flex-wrap gap-2" aria-label="Open a month from the chart">
        {visible.map((row) =>
          onMonth === undefined ? (
            <Text key={row.month} variant="bodySmall">
              {formatMonth(row.month)}
            </Text>
          ) : (
            <Button
              key={row.month}
              variant={row.month === month ? 'secondary' : 'ghost'}
              aria-label={`Review ${formatMonth(row.month, 'long')}`}
              aria-current={row.month === month ? 'true' : undefined}
              onClick={() => {
                onMonth(row.month);
              }}
            >
              {formatMonth(row.month)}
            </Button>
          ),
        )}
      </div>
    </section>
  );
}
