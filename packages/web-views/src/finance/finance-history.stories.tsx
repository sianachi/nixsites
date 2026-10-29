import {
  createNixClient,
  type Finance,
  type FinanceTransaction,
  type FinanceTransactions,
  type QueryEndpoint,
} from '@nix/api-client';
import { useRef, useState, type ReactElement } from 'react';
import { ApiClientOverrideProvider } from '@nix/web-platform/api/api-client-provider';
import { FinanceTransactions as History } from './finance-transactions';
import type { FinanceState } from './use-finance';

const ROOT = 'c1111111-1111-4111-8111-111111111111';
const ACCOUNT = 'c2222222-2222-4222-8222-222222222222';
const LINE = 'c4444444-4444-4444-8444-444444444444';
const fixture: Finance = {
  itemId: ROOT,
  settings: {
    currency: 'GBP',
    startMonth: '2025-01',
    endMonth: '2027-12',
    horizonMonths: 36,
    openingCash: 2000,
    emergencyFundMonths: 3,
    timezone: 'Europe/London',
  },
  containers: { accounts: ACCOUNT, lines: LINE, transactions: ROOT },
  accounts: [
    {
      id: ACCOUNT,
      name: 'Current account',
      type: 'current',
      limit: null,
      openingBalance: 2000,
      settlesFrom: null,
      apr: null,
      payment: null,
      overpayment: null,
      target: null,
      archived: false,
    },
  ],
  lines: [
    {
      id: LINE,
      name: 'Groceries',
      section: 'Everyday spending',
      flow: 'expense',
      accountId: ACCOUNT,
      amount: 300,
      overrides: {},
      scheduled: false,
      dueDay: null,
      loanAccount: null,
      archived: false,
      position: 1,
    },
  ],
  closedMonths: ['2026-08'],
  currentMonth: '2026-09',
  transactionCount: 64,
  problems: [],
};
const examples: readonly FinanceTransaction[] = Array.from({ length: 64 }, (_, index) => ({
  id: `c${String(index + 100).padStart(7, '0')}-5555-4555-8555-555555555555`,
  description:
    index === 0
      ? 'September salary'
      : index % 3 === 0
        ? 'Weekend market'
        : index % 2 === 0
          ? 'Local supermarket'
          : 'Coffee and lunch',
  date: `2026-${index < 54 ? '09' : '08'}-${String((index % 28) + 1).padStart(2, '0')}`,
  amount: index === 0 ? 3200 : -(index * 7.5 + 9.99),
  accountId: ACCOUNT,
  lineId: index === 0 || index % 5 === 0 ? null : LINE,
  source: index % 2 === 0 ? 'import' : 'manual',
  postedFor: null,
  importKey: null,
  cleared: false,
}));

function InteractiveHistory(): ReactElement {
  const rows = useRef([...examples]);
  const [finance, setFinance] = useState(fixture);
  const [generation, setGeneration] = useState(0);
  const [client] = useState(() => ({
    ...createNixClient({
      baseUrl: 'http://nix.invalid',
      tokens: {
        getAccessToken: () => Promise.resolve(null),
        refreshAccessToken: () => Promise.resolve(null),
      },
    }),
    query<T>(endpoint: QueryEndpoint<T>): Promise<T> {
      const filter = endpoint.query ?? {};
      const matched = rows.current
        .filter(
          (row) =>
            (filter.transactionId === undefined || filter.transactionId === row.id) &&
            (filter.month === undefined || row.date.startsWith(String(filter.month))) &&
            (filter.from === undefined || row.date >= String(filter.from)) &&
            (filter.to === undefined || row.date <= String(filter.to)) &&
            (filter.search === undefined ||
              row.description.toLowerCase().includes(String(filter.search).toLowerCase())) &&
            (filter.source === undefined || row.source === filter.source) &&
            (filter.accountId === undefined || row.accountId === filter.accountId) &&
            (filter.lineId === undefined || row.lineId === filter.lineId) &&
            (filter.unassigned === undefined || row.lineId === null) &&
            (filter.minAmount === undefined || Math.abs(row.amount) >= Number(filter.minAmount)) &&
            (filter.maxAmount === undefined || Math.abs(row.amount) <= Number(filter.maxAmount)),
        )
        .sort((left, right) => right.date.localeCompare(left.date));
      const offset = Number(filter.offset ?? 0);
      const limit = Number(filter.limit ?? 50);
      const inflow = matched.reduce((sum, row) => sum + Math.max(row.amount, 0), 0);
      const outflow = matched.reduce((sum, row) => sum + Math.max(-row.amount, 0), 0);
      const result: FinanceTransactions = {
        transactions: matched.slice(offset, offset + limit),
        total: matched.length,
        truncated: offset + limit < matched.length,
        offset,
        nextOffset: offset + limit < matched.length ? offset + limit : null,
        inflow,
        outflow,
        net: inflow - outflow,
      };
      return Promise.resolve(result as T);
    },
  }));
  const noop = (): Promise<null> => Promise.resolve(null);
  const state: FinanceState = {
    status: 'ready',
    finance,
    error: null,
    refreshing: false,
    refreshError: null,
    generation,
    reload: () => {
      setGeneration((value) => value + 1);
    },
    setSettings: noop,
    createAccount: noop,
    setAccount: noop,
    createLine: noop,
    setLine: noop,
    createTransaction: (input) => {
      rows.current.push({
        ...input,
        cleared: input.cleared ?? false,
        id: crypto.randomUUID(),
        source: 'manual',
        postedFor: null,
        importKey: null,
      });
      setGeneration((value) => value + 1);
      return Promise.resolve(null);
    },
    setTransaction: (id, input) => {
      rows.current = rows.current.map((row) => (row.id === id ? { ...row, ...input } : row));
      setGeneration((value) => value + 1);
      return Promise.resolve(null);
    },
    deleteTransaction: (id) => {
      rows.current = rows.current.filter((row) => row.id !== id);
      setGeneration((value) => value + 1);
      return Promise.resolve(null);
    },
    setActual: () => Promise.resolve('Use a transaction in this example.'),
    setMonth: (month, closed) => {
      setFinance((current) => ({
        ...current,
        closedMonths: closed
          ? [...new Set([...current.closedMonths, month])]
          : current.closedMonths.filter((value) => value !== month),
      }));
      setGeneration((value) => value + 1);
      return Promise.resolve(null);
    },
    postScheduled: () =>
      Promise.resolve({ month: '2026-09', posted: [], alreadyPosted: 0, skipped: 0 }),
    importStatement: () => Promise.resolve('Use existing records in this example.'),
  };
  return (
    <ApiClientOverrideProvider client={client}>
      <div className="mx-auto w-full max-w-5xl p-4">
        <History state={state} finance={finance} month="2026-09" />
      </div>
    </ApiClientOverrideProvider>
  );
}

export default { title: 'Nix/Finance history', parameters: { layout: 'padded' } };
export const SearchAndCorrect = { render: (): ReactElement => <InteractiveHistory /> };
