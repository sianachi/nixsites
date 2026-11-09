import {
  Button,
  Checkbox,
  ScrollRegion,
  Select,
  Table,
  Tag,
  Text,
  cn,
  focusRing,
  type TableColumn,
} from '@nix/ui';
import type { BudgetLine, FinanceAccount, FinanceTransaction } from '@nix/api-client';
import type { ReactNode } from 'react';
import { Money, WriteError, editableTextButton } from './finance-shared';
import { formatDay, formatMonth, monthOf } from './money';
import { LineOptions } from './transaction-dialog';

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
  closedMonths,
  suggestions,
  lineError,
  onToggle,
  onEdit,
  onSetLine,
  onReopen,
}: {
  readonly rows: readonly FinanceTransaction[];
  readonly lines: ReadonlyMap<string, BudgetLine>;
  readonly accounts: ReadonlyMap<string, FinanceAccount>;
  readonly currency: string;
  readonly selected: ReadonlySet<string>;
  readonly disabled: boolean;
  readonly closedMonths: readonly string[];
  /** A line worth offering for an unassigned row, from an earlier row with the same description. */
  readonly suggestions: ReadonlyMap<string, BudgetLine>;
  /** The row whose category change was refused because its month is closed. */
  readonly lineError: { readonly id: string; readonly month: string } | null;
  readonly onToggle: (id: string, checked: boolean) => void;
  readonly onEdit: (row: FinanceTransaction) => void;
  readonly onSetLine: (row: FinanceTransaction, lineId: string) => void;
  readonly onReopen: (month: string) => void;
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
            <span>{accounts.get(row.accountId)?.name ?? 'Unknown account'}</span>
            {SOURCE_LABEL[row.source] === undefined ? null : (
              <span>{SOURCE_LABEL[row.source]}</span>
            )}
            {closedMonths.includes(monthOf(row.date)) ? <Tag>Closed month</Tag> : null}
          </Text>
          <div className="flex min-w-0 flex-wrap items-center gap-2">
            <Select
              className={cn('min-w-0 flex-1 basis-48', row.lineId === null && 'border-accent')}
              aria-label={`Category for ${row.description}`}
              value={row.lineId ?? ''}
              disabled={disabled}
              onChange={(event) => {
                onSetLine(row, event.target.value);
              }}
            >
              <option value="">{row.lineId === null ? 'Choose category…' : 'Unassigned'}</option>
              <LineOptions lines={[...lines.values()]} retainedId={row.lineId ?? undefined} />
            </Select>
            {suggestions.get(row.id) === undefined ? null : (
              <Button
                variant="secondary"
                disabled={disabled}
                aria-label={`Use ${suggestions.get(row.id)?.name ?? ''} for ${row.description}`}
                onClick={() => {
                  onSetLine(row, suggestions.get(row.id)?.id ?? '');
                }}
              >
                {`${suggestions.get(row.id)?.name ?? ''}?`}
              </Button>
            )}
          </div>
          {lineError?.id === row.id ? (
            <div className="flex flex-wrap items-center gap-2">
              <WriteError message={`${formatMonth(lineError.month, 'long')} is closed.`} />
              <Button
                variant="secondary"
                onClick={() => {
                  onReopen(lineError.month);
                }}
              >
                Reopen it
              </Button>
            </div>
          ) : null}
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
    <ScrollRegion
      aria-label="Transaction history"
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
        rowFlash={(row) => `${row.lineId ?? ''}|${String(row.amount)}|${row.description}`}
        emptyMessage="No matching transactions. Try another date range or clear your filters."
      />
    </ScrollRegion>
  );
}
