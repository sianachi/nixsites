import { Button, Text } from '@nix/ui';
import type { Finance, FinanceTransaction } from '@nix/api-client';
import type { ReactNode } from 'react';
import { Money } from './finance-shared';

export interface SessionChange {
  readonly before: FinanceTransaction;
  readonly after: FinanceTransaction;
}

/** The edits made on this screen, each with a way to review its undo. */
export function SessionChanges({
  changes,
  lines,
  currency,
  onReview,
}: {
  readonly changes: readonly SessionChange[];
  readonly lines: ReadonlyMap<string, Finance['lines'][number]>;
  readonly currency: string;
  readonly onReview: (change: SessionChange) => void;
}): ReactNode {
  return (
    <details className="rounded-lg border border-divider p-3">
      <summary className="cursor-pointer text-muted any-pointer-coarse:min-h-(--control-lg)">
        Changes in this visit ({String(changes.length)})
      </summary>
      <Text variant="caption" tone="muted" className="mt-2">
        Recent edits made in this history screen. This list clears when you leave or reload; saved
        records remain in your finances.
      </Text>
      <ul className="mt-3 flex flex-col gap-3">
        {changes.map((change, index) => (
          <li
            key={`${change.before.id}-${String(index)}`}
            className="flex flex-wrap items-center justify-between gap-3"
          >
            <Text variant="bodySmall">
              {change.before.description}:{' '}
              <Money amount={change.before.amount} currency={currency} signed /> to{' '}
              <Money amount={change.after.amount} currency={currency} signed />;{' '}
              {lines.get(change.before.lineId ?? '')?.name ?? 'Unassigned'} to{' '}
              {lines.get(change.after.lineId ?? '')?.name ?? 'Unassigned'}
            </Text>
            <Button
              variant="secondary"
              onClick={() => {
                onReview(change);
              }}
            >
              Review undo
            </Button>
          </li>
        ))}
      </ul>
    </details>
  );
}

export function sameEditableTransaction(
  left: FinanceTransaction,
  right: FinanceTransaction,
): boolean {
  return (
    left.description === right.description &&
    left.amount === right.amount &&
    left.date === right.date &&
    left.accountId === right.accountId &&
    left.lineId === right.lineId &&
    left.cleared === right.cleared
  );
}
