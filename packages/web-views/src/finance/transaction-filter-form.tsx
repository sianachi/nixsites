import { Button, Field, Input, Segmented, Select } from '@nix/ui';
import type { Finance } from '@nix/api-client';
import { useState, type ReactNode } from 'react';
import { WriteError } from './finance-shared';
import { parseAmount } from './money';

export type HistoryRange = 'month' | 'all' | 'custom';

/** The applied (submitted) text, source, date and amount filters. */
export interface AppliedFilters {
  readonly search: string;
  readonly source: string;
  readonly from: string;
  readonly to: string;
  readonly minAmount: string;
  readonly maxAmount: string;
}

/** The search form; keeps its own draft fields and reports applied filters upward. */
export function TransactionFilterForm({
  finance,
  month,
  monthEnd,
  range,
  accountId,
  lineFilter,
  unassigned,
  filters,
  onRange,
  onAccount,
  onCategory,
  onApply,
  onClear,
}: {
  readonly finance: Finance;
  readonly month: string;
  readonly monthEnd: string;
  readonly range: HistoryRange;
  readonly accountId: string;
  readonly lineFilter: string;
  readonly unassigned: boolean;
  readonly filters: AppliedFilters;
  readonly onRange: (value: HistoryRange, from: string, to: string) => void;
  readonly onAccount: (id: string) => void;
  /** The raw select value: a line id, `unassigned` or empty. */
  readonly onCategory: (value: string) => void;
  readonly onApply: (next: AppliedFilters) => void;
  readonly onClear: (from: string, to: string) => void;
}): ReactNode {
  const currency = finance.settings.currency;
  const [search, setSearch] = useState('');
  const [source, setSource] = useState('');
  const [minAmount, setMinAmount] = useState('');
  const [maxAmount, setMaxAmount] = useState('');
  const [from, setFrom] = useState(`${month}-01`);
  const [to, setTo] = useState(monthEnd);
  const [filterError, setFilterError] = useState<string | null>(null);
  const applyFilters = (): void => {
    const min = minAmount === '' ? null : parseAmount(minAmount);
    const max = maxAmount === '' ? null : parseAmount(maxAmount);
    if (
      (minAmount !== '' && (min === null || min < 0)) ||
      (maxAmount !== '' && (max === null || max < 0)) ||
      (min !== null && max !== null && min > max)
    ) {
      setFilterError('Enter valid amounts of zero or more, with the smaller amount first.');
      return;
    }
    if (range === 'custom' && (from === '' || to === '' || from > to)) {
      setFilterError('Choose a start and end date, with the earlier date first.');
      return;
    }
    setFilterError(null);
    onApply({
      search: search.trim(),
      source,
      from,
      to,
      minAmount: min === null ? '' : String(min),
      maxAmount: max === null ? '' : String(max),
    });
  };
  return (
    <form
      className="flex flex-col gap-3 rounded-lg border border-divider p-4"
      onSubmit={(event) => {
        event.preventDefault();
        applyFilters();
      }}
    >
      <div className="flex flex-wrap items-end gap-3">
        <Field label="Search transactions" className="min-w-0 flex-1 basis-48">
          {(control) => (
            <Input
              {...control}
              type="search"
              placeholder="Payee or description"
              value={search}
              onChange={(event) => {
                setSearch(event.target.value);
              }}
            />
          )}
        </Field>
        <Segmented<HistoryRange>
          className="min-w-0 flex-wrap"
          label="History period"
          options={[
            { value: 'month', label: 'Selected month' },
            { value: 'all', label: 'All history' },
            { value: 'custom', label: 'Date range' },
          ]}
          value={range}
          onChange={(value) => {
            onRange(value, from, to);
          }}
        />
        <Button type="submit">Search</Button>
        {filters.search !== '' ||
        filters.source !== '' ||
        accountId !== '' ||
        lineFilter !== '' ||
        unassigned ||
        filters.minAmount !== '' ||
        filters.maxAmount !== '' ? (
          <Button
            variant="ghost"
            onClick={() => {
              setSearch('');
              setSource('');
              setMinAmount('');
              setMaxAmount('');
              setFilterError(null);
              onClear(from, to);
            }}
          >
            Clear filters
          </Button>
        ) : null}
      </div>
      {range === 'custom' ? (
        <div className="grid min-w-0 grid-cols-1 gap-3 @sm:grid-cols-2">
          <Field label="From date" className="min-w-0">
            {(control) => (
              <Input
                {...control}
                type="date"
                value={from}
                onChange={(event) => {
                  setFrom(event.target.value);
                }}
              />
            )}
          </Field>
          <Field label="To date" className="min-w-0">
            {(control) => (
              <Input
                {...control}
                type="date"
                value={to}
                onChange={(event) => {
                  setTo(event.target.value);
                }}
              />
            )}
          </Field>
        </div>
      ) : null}
      <details>
        <summary className="cursor-pointer text-muted any-pointer-coarse:min-h-(--control-lg)">
          Filter by account, category or amount
        </summary>
        <div className="mt-3 grid min-w-0 grid-cols-1 gap-3 @lg:grid-cols-2">
          <Field label="Account">
            {(control) => (
              <Select
                {...control}
                value={accountId}
                onChange={(event) => {
                  onAccount(event.target.value);
                }}
              >
                <option value="">Every account</option>
                {finance.accounts
                  .filter((account) => account.type !== 'loan')
                  .map((account) => (
                    <option key={account.id} value={account.id}>
                      {account.name}
                    </option>
                  ))}
              </Select>
            )}
          </Field>
          <Field label="Category">
            {(control) => (
              <Select
                {...control}
                value={unassigned ? 'unassigned' : lineFilter}
                onChange={(event) => {
                  onCategory(event.target.value);
                }}
              >
                <option value="">Every category</option>
                <option value="unassigned">Unassigned</option>
                {finance.lines.map((line) => (
                  <option key={line.id} value={line.id}>
                    {line.name}
                    {line.archived ? ' (archived)' : ''}
                  </option>
                ))}
              </Select>
            )}
          </Field>
          <Field label="Source">
            {(control) => (
              <Select
                {...control}
                value={source}
                onChange={(event) => {
                  setSource(event.target.value);
                }}
              >
                <option value="">Every source</option>
                <option value="manual">By hand</option>
                <option value="import">Imported statement</option>
                <option value="scheduled">Posted from plan</option>
              </Select>
            )}
          </Field>
          <div className="grid min-w-0 grid-cols-1 gap-3 @sm:grid-cols-2">
            <Field label="Amount from" hint={currency} className="min-w-0">
              {(control) => (
                <Input
                  {...control}
                  inputMode="decimal"
                  value={minAmount}
                  onChange={(event) => {
                    setMinAmount(event.target.value);
                  }}
                />
              )}
            </Field>
            <Field label="Amount to" hint="Money in or out" className="min-w-0">
              {(control) => (
                <Input
                  {...control}
                  inputMode="decimal"
                  value={maxAmount}
                  onChange={(event) => {
                    setMaxAmount(event.target.value);
                  }}
                />
              )}
            </Field>
          </div>
        </div>
        <Button type="submit" variant="secondary" className="mt-3">
          Apply filters
        </Button>
      </details>
      <WriteError message={filterError} />
    </form>
  );
}
