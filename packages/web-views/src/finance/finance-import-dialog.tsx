import {
  Button,
  Dialog,
  Field,
  Input,
  Select,
  Table,
  Text,
  Textarea,
  cn,
  focusRing,
} from '@nix/ui';
import { type Finance, type FinanceImport } from '@nix/api-client';
import { useState, type ReactNode } from 'react';
import { Money, WriteError } from './finance-shared';
import { formatDay } from './money';
import { type FinanceState } from './use-finance';

interface ImportDialogProps {
  readonly state: FinanceState;
  readonly finance: Finance;
  readonly open: boolean;
  readonly onClose: () => void;
}

export function ImportDialog(props: ImportDialogProps): ReactNode {
  return props.open ? <ImportForm {...props} /> : null;
}

function ImportForm({ state, finance, onClose }: ImportDialogProps): ReactNode {
  const currency = finance.settings.currency;
  const cashAccounts = finance.accounts.filter(
    (account) => account.type !== 'loan' && !account.archived,
  );
  const [accountId, setAccountId] = useState(cashAccounts[0]?.id ?? '');
  const [csv, setCsv] = useState('');
  const [preview, setPreview] = useState<FinanceImport | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const run = async (commit: boolean): Promise<void> => {
    if (accountId === '' || csv.trim() === '') {
      setError('Choose an account and paste or choose a CSV export.');
      return;
    }
    setBusy(true);
    const outcome = await state.importStatement({ accountId, csv, commit });
    setBusy(false);
    if (typeof outcome === 'string') {
      setError(outcome);
      return;
    }
    setError(null);
    setPreview(outcome);
    if (commit) onClose();
  };
  const readFile = (file: File | undefined): void => {
    if (file === undefined) return;
    void file.text().then((text) => {
      setCsv(text);
      setPreview(null);
    });
  };
  return (
    <Dialog open title="Import a bank statement" onClose={onClose} presentation="workspace">
      <div className="flex flex-col gap-4">
        <Text as="p" variant="bodySmall" tone="muted">
          A CSV as your bank exports it, with a header row naming a date, an amount (or money in and
          money out) and a description. Rows already recorded are skipped, and a row that matches a
          transaction you typed is linked to it rather than added again.
        </Text>
        <Field label="Into account">
          {(control) => (
            <Select
              {...control}
              value={accountId}
              onChange={(event) => {
                setAccountId(event.target.value);
              }}
            >
              {cashAccounts.map((account) => (
                <option key={account.id} value={account.id}>
                  {account.name}
                </option>
              ))}
            </Select>
          )}
        </Field>
        <Field label="CSV file">
          {(control) => (
            <Input
              {...control}
              type="file"
              accept=".csv,text/csv,text/plain"
              onChange={(event) => {
                readFile(event.target.files?.[0]);
              }}
            />
          )}
        </Field>
        <Field label="Or paste the CSV">
          {(control) => (
            <Textarea
              {...control}
              rows={6}
              className="font-mono"
              value={csv}
              onChange={(event) => {
                setCsv(event.target.value);
                setPreview(null);
              }}
            />
          )}
        </Field>
        {preview === null ? null : (
          <div className="flex flex-col gap-2" role="status">
            <Text as="p" variant="bodySmall">
              {String(preview.rows)} rows: {String(preview.created)} new, {String(preview.matched)}{' '}
              matching something already typed, {String(preview.duplicates)} already imported,{' '}
              {String(preview.unreadable)} unreadable.
            </Text>
            <div
              role="region"
              aria-label="Statement import preview"
              // eslint-disable-next-line jsx-a11y/no-noninteractive-tabindex -- Justification: keyboard users need to reach the scrollable statement preview.
              tabIndex={0}
              className={cn('max-h-64 min-w-0 overflow-auto', focusRing)}
            >
              <Table<FinanceImport['preview'][number]>
                caption="Statement rows"
                columns={[
                  { key: 'row', header: 'Row', cell: (row) => String(row.row) },
                  {
                    key: 'date',
                    header: 'Date',
                    cell: (row) => (row.date === null ? '' : formatDay(row.date)),
                  },
                  {
                    key: 'description',
                    header: 'Description',
                    rowHeader: true,
                    cell: (row) => row.description,
                  },
                  {
                    key: 'amount',
                    header: 'Amount',
                    align: 'end',
                    cell: (row) =>
                      row.amount === null ? (
                        ''
                      ) : (
                        <Money amount={row.amount} currency={currency} signed />
                      ),
                  },
                  {
                    key: 'status',
                    header: 'Outcome',
                    cell: (row) =>
                      row.status === 'new'
                        ? row.suggestedLineId === null
                          ? 'New, unassigned'
                          : `New, ${finance.lines.find((line) => line.id === row.suggestedLineId)?.name ?? 'assigned'}`
                        : row.status === 'matched'
                          ? 'Matches a typed transaction'
                          : row.status === 'duplicate'
                            ? 'Already imported'
                            : (row.problem ?? 'Unreadable'),
                  },
                ]}
                rows={preview.preview}
                rowKey={(row) => String(row.row)}
                emptyMessage="No rows were read."
              />
            </div>
          </div>
        )}
        <WriteError message={error} />
        <div className="flex flex-wrap justify-end gap-2">
          <Button type="button" variant="secondary" onClick={onClose}>
            Cancel
          </Button>
          <Button
            type="button"
            variant="secondary"
            disabled={busy}
            onClick={() => {
              void run(false);
            }}
          >
            Preview
          </Button>
          <Button
            type="button"
            disabled={busy || preview === null || preview.created + preview.matched === 0}
            onClick={() => {
              void run(true);
            }}
          >
            Import {preview === null ? '' : `${String(preview.created)} new`}
          </Button>
        </div>
      </div>
    </Dialog>
  );
}
