import { Checkbox, Table, Tag, Text, cn, focusRing, type TableColumn } from '@nix/ui';
import type { BudgetLine, FinanceAccount, FinanceTransaction } from '@nix/api-client';
import type { ReactNode } from 'react';
import { Money, editableTextButton } from './finance-shared';
import { formatDay } from './money';

const SOURCE_LABEL: Partial<Record<FinanceTransaction['source'], string>> = {
  scheduled: 'Posted from plan',
  import: 'Imported',
};

/**
 * Three columns so a phone needs no sideways scroll: select, the transaction (description to
 * edit, with its day, category and account beneath), and the amount. Money out carries a minus
 * sign, so the direction never depends on colour.
 */
export function TransactionTable({
  rows,
  lines,
  accounts,
  currency,
  selected,
  disabled,
  onToggle,
  onEdit,
}: {
  readonly rows: readonly FinanceTransaction[];
  readonly lines: ReadonlyMap<string, BudgetLine>;
  readonly accounts: ReadonlyMap<string, FinanceAccount>;
  readonly currency: string;
  readonly selected: ReadonlySet<string>;
  readonly disabled: boolean;
  readonly onToggle: (id: string, checked: boolean) => void;
  readonly onEdit: (row: FinanceTransaction) => void;
}): ReactNode {
  const columns: readonly TableColumn<FinanceTransaction>[] = [
    {
      key: 'select',
      header: 'Select',
      cell: (row) => (
        <Checkbox
          aria-label={`Select ${row.description}`}
          checked={selected.has(row.id)}
          disabled={disabled}
          onChange={(event) => {
            onToggle(row.id, event.target.checked);
          }}
        />
      ),
    },
    {
      key: 'description',
      header: 'Transaction',
      rowHeader: true,
      cell: (row) => (
        <div className="flex min-w-0 flex-col gap-0.5">
          <button
            type="button"
            className={cn(editableTextButton, 'self-start')}
            disabled={disabled}
            onClick={() => {
              onEdit(row);
            }}
          >
            {row.description}
          </button>
          <Text
            as="span"
            variant="caption"
            tone="muted"
            className="flex flex-wrap items-center gap-x-2"
          >
            <span>{`${formatDay(row.date)} ${row.date.slice(0, 4)}`}</span>
            {row.lineId === null ? (
              <Tag tone="accent">Unassigned</Tag>
            ) : (
              <span>{lines.get(row.lineId)?.name ?? 'Unknown line'}</span>
            )}
            <span>{accounts.get(row.accountId)?.name ?? 'Unknown account'}</span>
            {SOURCE_LABEL[row.source] === undefined ? null : (
              <span>{SOURCE_LABEL[row.source]}</span>
            )}
          </Text>
        </div>
      ),
    },
    {
      key: 'amount',
      header: 'Amount',
      align: 'end',
      cell: (row) => (
        <span className="font-medium">
          <Money amount={row.amount} currency={currency} signed />
        </span>
      ),
    },
  ];
  return (
    <div
      role="region"
      aria-label="Transaction history"
      // eslint-disable-next-line jsx-a11y/no-noninteractive-tabindex -- Justification: keyboard users need to reach horizontally clipped transaction columns.
      tabIndex={0}
      className={cn('min-w-0 overflow-x-auto', focusRing)}
    >
      <Table<FinanceTransaction>
        caption="Matching transactions, newest first"
        columns={columns}
        rows={rows}
        rowKey={(row) => row.id}
        rowContextMenuLabel={(row) => `Actions for ${row.description}`}
        rowContextMenu={(row) => [
          {
            label: 'Edit transaction',
            disabled,
            onSelect: () => {
              onEdit(row);
            },
          },
        ]}
        emptyMessage="No matching transactions. Try another date range or clear your filters."
      />
    </div>
  );
}
