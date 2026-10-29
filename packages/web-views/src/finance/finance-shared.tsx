import { Button, Select, Text, cn, focusRing, inkWashStates } from '@nix/ui';
import { ChevronLeft, ChevronRight } from 'lucide-react';
import type { ReactNode } from 'react';
import { formatMoney, formatMoneyRound, formatMonth, shiftMonth } from './money';

/**
 * A piece of text that is also a button: a line's name, a transaction's description. The dotted
 * rule beneath says at rest that it opens something; the wash on hover and the ring on focus say
 * the same for pointer and keyboard.
 */
export const editableTextButton = cn(
  '-mx-1 rounded px-1 py-0.5 text-left any-pointer-coarse:min-h-(--control-lg) any-pointer-coarse:min-w-(--control-lg)',
  'underline decoration-dotted decoration-divider underline-offset-4',
  inkWashStates,
  focusRing,
);

/** A figure, printed; never computed here. */
export function Money({
  amount,
  currency,
  signed = false,
  round = false,
}: {
  readonly amount: number;
  readonly currency: string;
  readonly signed?: boolean;
  readonly round?: boolean;
}): ReactNode {
  return (
    <span className="wrap-anywhere tabular-nums">
      {round ? formatMoneyRound(amount, currency) : formatMoney(amount, currency, { signed })}
    </span>
  );
}

/** A headline number with a label above and, optionally, a line of context beneath. */
export function Tile({
  label,
  value,
  caption,
  children,
}: {
  readonly label: string;
  readonly value: ReactNode;
  readonly caption?: ReactNode;
  readonly children?: ReactNode;
}): ReactNode {
  return (
    <div className="flex min-w-0 flex-col gap-1 rounded-lg bg-surface-raised p-3">
      <Text variant="caption" tone="muted">
        {label}
      </Text>
      <Text as="p" variant="h4">
        {value}
      </Text>
      {caption === undefined ? null : (
        <Text variant="bodySmall" tone="muted">
          {caption}
        </Text>
      )}
      {children}
    </div>
  );
}

/** A proportion, drawn; the number beside it is what a reader relies on. */
export function Meter({
  fraction,
  label,
}: {
  readonly fraction: number;
  readonly label: string;
}): ReactNode {
  const clamped = Math.max(0, Math.min(1, fraction));
  const width = `${String(Math.round(clamped * 100))}%`;
  // prettier-ignore
  const bar = <span aria-hidden="true" className="block h-full rounded-full bg-accent-fill" style={{ width }} />; // design-token-exempt: width encodes the data proportion rather than a chosen design dimension.
  return (
    <div
      role="meter"
      aria-label={label}
      aria-valuemin={0}
      aria-valuemax={100}
      aria-valuenow={Math.round(clamped * 100)}
      className="h-2 w-full overflow-hidden rounded-full bg-surface"
    >
      {bar}
    </div>
  );
}

/** Previous, the month, next. Bounded to the plan's horizon so a reader cannot walk off it. */
export function MonthNav({
  month,
  min,
  max,
  onChange,
  current,
}: {
  readonly month: string;
  readonly min: string;
  readonly max: string;
  readonly onChange: (month: string) => void;
  readonly current?: string;
}): ReactNode {
  return (
    <div
      className="grid min-w-0 grid-cols-[auto_minmax(0,1fr)_auto] items-center gap-2 @lg:grid-cols-[auto_minmax(0,1fr)_auto_auto]"
      aria-label="Choose a month"
    >
      <Button
        variant="secondary"
        aria-label="Previous month"
        disabled={month <= min}
        onClick={() => {
          onChange(shiftMonth(month, -1));
        }}
      >
        <ChevronLeft size={18} aria-hidden="true" />
      </Button>
      <Select
        className="min-w-0"
        aria-label="Month"
        value={month}
        onChange={(event) => {
          onChange(event.target.value);
        }}
      >
        {Array.from(
          {
            length: Math.min(
              120,
              Math.max(
                1,
                (Number(max.slice(0, 4)) - Number(min.slice(0, 4))) * 12 +
                  Number(max.slice(5)) -
                  Number(min.slice(5)) +
                  1,
              ),
            ),
          },
          (_, index) => shiftMonth(min, index),
        ).map((option) => (
          <option key={option} value={option}>
            {formatMonth(option, 'long')}
          </option>
        ))}
      </Select>
      <Button
        variant="secondary"
        aria-label="Next month"
        disabled={month >= max}
        onClick={() => {
          onChange(shiftMonth(month, 1));
        }}
      >
        <ChevronRight size={18} aria-hidden="true" />
      </Button>
      {current === undefined ? null : (
        <Button
          variant="ghost"
          className="col-span-3 @lg:col-span-1"
          disabled={month === current}
          onClick={() => {
            onChange(current);
          }}
        >
          This month
        </Button>
      )}
    </div>
  );
}

export function SectionHeading({
  id,
  title,
  detail,
  actions,
}: {
  readonly id: string;
  readonly title: string;
  readonly detail?: string;
  readonly actions?: ReactNode;
}): ReactNode {
  return (
    <header className="flex min-w-0 flex-col gap-3 border-b border-divider pb-3 @lg:flex-row @lg:items-end @lg:justify-between">
      <div className="min-w-0">
        <Text as="h3" variant="h4" id={id}>
          {title}
        </Text>
        {detail === undefined ? null : (
          <Text variant="bodySmall" tone="muted">
            {detail}
          </Text>
        )}
      </div>
      {actions === undefined ? null : <div className="flex flex-wrap gap-2">{actions}</div>}
    </header>
  );
}

/** A write's refusal, shown where the person is looking. */
export function WriteError({ message }: { readonly message: string | null }): ReactNode {
  if (message === null) return null;
  return (
    <Text as="p" variant="bodySmall" role="alert">
      {message}
    </Text>
  );
}
