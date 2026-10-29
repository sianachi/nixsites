import { Button, Dialog, Text } from '@nix/ui';
import type { Finance, FinanceTransaction } from '@nix/api-client';
import type { ReactNode } from 'react';
import { monthOf } from './money';

/** Confirms moving the selected rows to one line before the writes start. */
export function AssignPreviewDialog({
  finance,
  lines,
  rows,
  selected,
  assignLineId,
  onApply,
  onClose,
}: {
  readonly finance: Finance;
  readonly lines: ReadonlyMap<string, Finance['lines'][number]>;
  readonly rows: readonly FinanceTransaction[] | undefined;
  readonly selected: ReadonlySet<string>;
  readonly assignLineId: string;
  readonly onApply: () => void;
  readonly onClose: () => void;
}): ReactNode {
  return (
    <Dialog
      open
      title="Review category change"
      onClose={() => {
        onClose();
      }}
    >
      <div className="flex flex-col gap-4">
        <Text variant="body">
          Move {String(selected.size)} transactions to {lines.get(assignLineId)?.name}. Amounts and
          accounts stay the same; category totals will update.
        </Text>
        <ul className="flex flex-col gap-2">
          {rows
            ?.filter((row) => selected.has(row.id))
            .map((row) => (
              <li key={row.id}>
                <Text variant="bodySmall">
                  {row.description}:{' '}
                  {row.lineId === null ? 'Unassigned' : lines.get(row.lineId)?.name} to{' '}
                  {lines.get(assignLineId)?.name}
                  {finance.closedMonths.includes(monthOf(row.date)) ? ' (closed month)' : ''}
                </Text>
              </li>
            ))}
        </ul>
        {rows?.some(
          (row) => selected.has(row.id) && finance.closedMonths.includes(monthOf(row.date)),
        ) ? (
          <Text variant="bodySmall" role="alert">
            Some selected transactions belong to closed months. Correct these individually first so
            you can reopen and close each month safely.
          </Text>
        ) : (
          <Button
            onClick={() => {
              onApply();
            }}
          >
            Apply category change
          </Button>
        )}
        <Button
          variant="secondary"
          onClick={() => {
            onClose();
          }}
        >
          Cancel
        </Button>
      </div>
    </Dialog>
  );
}
