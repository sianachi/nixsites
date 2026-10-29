import {
  createNixClient,
  type BudgetGrid,
  type BudgetLine,
  type CashFlow,
  type Finance,
  type FinanceDashboard,
  type QueryEndpoint,
} from '@nix/api-client';
import type { ReactElement } from 'react';
import { waitFor, within } from '@testing-library/dom';

import { ApiClientOverrideProvider } from '@nix/web-platform/api/api-client-provider';
import { AccountDialog, LineDialog, SettingsDialog } from './finance-setup';
import { CloseMonthDialog } from './close-month-dialog';
import { FinanceDashboard as Dashboard } from './finance-dashboard';
import { FinanceCashFlow } from './finance-cashflow';
import { FinanceBudget } from './finance-budget';
import { BudgetActualDialog } from './budget-actual-dialog';
import { QuickAddDialog } from './finance-transactions';
import { FinanceBalanceTrend } from './finance-balance-trend';
import { FinanceView } from './finance-view';
import { storyContainer } from '../core/story-container';
import { recordStoryView } from '../core/story-container';
import type { FinanceState } from './use-finance';

const ROOT = 'c1111111-1111-4111-8111-111111111111';
const ACCOUNT = 'c2222222-2222-4222-8222-222222222222';
const CARD = 'c3333333-3333-4333-8333-333333333333';
const LINE = 'c4444444-4444-4444-8444-444444444444';

const groceriesLine: BudgetLine = {
  id: LINE,
  name: 'Groceries',
  section: 'Everyday spending',
  flow: 'expense',
  accountId: CARD,
  amount: 200,
  overrides: {},
  scheduled: false,
  dueDay: null,
  loanAccount: null,
  archived: false,
  position: 1,
};

const finance: Finance = {
  itemId: ROOT,
  settings: {
    currency: 'GBP',
    startMonth: '2026-08',
    endMonth: '2027-12',
    horizonMonths: 17,
    openingCash: 2000,
    emergencyFundMonths: 3,
    timezone: 'Europe/London',
  },
  containers: { accounts: ACCOUNT, lines: LINE, transactions: CARD },
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
    {
      id: CARD,
      name: 'Everyday card',
      type: 'credit_card',
      limit: 3000,
      openingBalance: 100,
      settlesFrom: ACCOUNT,
      apr: null,
      payment: null,
      overpayment: null,
      target: null,
      archived: false,
    },
  ],
  lines: [groceriesLine],
  closedMonths: [],
  currentMonth: '2026-09',
  transactionCount: 3,
  problems: [],
};

const dashboard: FinanceDashboard = {
  itemId: ROOT,
  month: '2026-09',
  closed: false,
  plan: { income: 4000, paidThisMonth: 1500, cardSpend: 400, outgoings: 1900, net: 2100 },
  actual: { income: 4000, paidThisMonth: 1500, cardSpend: 480, outgoings: 1980, net: 2020 },
  savingsRatePlan: 0.525,
  savingsRateActual: 0.505,
  position: {
    month: '2026-09',
    source: 'plan',
    income: 4000,
    paidThisMonth: 1500,
    cardSpend: 400,
    cardPaymentOut: 400,
    cashNet: 2100,
    closingBank: 6500,
    cardOwed: 400,
    netPosition: 6100,
    emergencyTarget: 5700,
    bufferMet: true,
  },
  openingNetPosition: 1900,
  monthEndDebt: 400,
  monthEndAfterDebt: 6100,
  emergencyTarget: 5700,
  bufferMetIn: '2026-09',
  cardFloat: 400,
  cards: [
    {
      accountId: CARD,
      name: 'Everyday card',
      month: '2026-09',
      source: 'plan',
      opening: 400,
      spend: 400,
      paymentOut: 400,
      closing: 400,
      utilisation: 400 / 3000,
      limit: 3000,
      settlesFrom: ACCOUNT,
    },
  ],
  loans: [],
  watch: [
    {
      lineId: LINE,
      name: 'Groceries',
      section: 'Everyday spending',
      plan: 200,
      actual: 248,
      variance: 48,
    },
  ],
  upcoming: [
    {
      kind: 'line',
      lineId: LINE,
      accountId: ACCOUNT,
      name: 'Rent',
      due: '2026-10-01',
      amount: 900,
      posted: false,
    },
  ],
  horizonEnd: {
    month: '2027-12',
    source: 'plan',
    income: 4000,
    paidThisMonth: 1500,
    cardSpend: 400,
    cardPaymentOut: 400,
    cashNet: 2100,
    closingBank: 40400,
    cardOwed: 400,
    netPosition: 40000,
    emergencyTarget: 5550,
    bufferMet: true,
  },
  horizonNet: 38100,
};

const noop = (): Promise<null> => Promise.resolve(null);
const state: FinanceState = {
  status: 'ready',
  finance,
  error: null,
  refreshing: false,
  refreshError: null,
  generation: 0,
  reload: () => undefined,
  setSettings: noop,
  createAccount: noop,
  setAccount: noop,
  createLine: noop,
  setLine: noop,
  createTransaction: noop,
  setTransaction: noop,
  deleteTransaction: noop,
  setActual: () => Promise.resolve('Recording is unavailable in this example.'),
  setMonth: noop,
  postScheduled: () =>
    Promise.resolve({ month: '2026-09', posted: [], alreadyPosted: 0, skipped: 0 }),
  importStatement: () => Promise.resolve('Preview is unavailable in this example.'),
};

const cashFlow: CashFlow = {
  itemId: ROOT,
  openingBank: 2000,
  openingCardOwed: 100,
  openingNetPosition: 1900,
  emergencyTarget: 5700,
  emergencyBasisMonth: '2026-09',
  bufferMetIn: '2026-09',
  months: [dashboard.position, { ...dashboard.horizonEnd, month: '2027-04' }],
};

const groceriesCell = { month: '2026-09', plan: 200, actual: 248, variance: 48, transactions: 3 };
const budgetGrid: BudgetGrid = {
  itemId: ROOT,
  months: ['2026-09'],
  sections: [
    {
      name: 'Everyday spending',
      flow: 'expense',
      lines: finance.lines.map((line) => ({ line, cells: [groceriesCell] })),
      totals: [groceriesCell],
    },
  ],
  totals: [
    {
      month: '2026-09',
      closed: false,
      plan: dashboard.plan,
      actual: dashboard.actual,
      unassignedOutflow: 38.5,
      unassignedInflow: 0,
      unassignedTransactions: 2,
      cumulativeNetPlan: 4200,
      cumulativeNetActual: 4040,
    },
  ],
  accountId: null,
};

const groceriesTransactions = {
  transactions: [
    {
      id: 'c5555555-5555-4555-8555-555555555555',
      description: 'Example shop',
      date: '2026-09-03',
      amount: -59,
      accountId: CARD,
      lineId: LINE,
      source: 'manual' as const,
      postedFor: null,
      importKey: null,
      cleared: false,
    },
    {
      id: 'c6666666-6666-4666-8666-666666666666',
      description: 'Example market',
      date: '2026-09-12',
      amount: -189,
      accountId: CARD,
      lineId: LINE,
      source: 'import' as const,
      postedFor: null,
      importKey: 'abc',
      cleared: true,
    },
  ],
  total: 2,
  truncated: false,
};

const monthClient = {
  ...createNixClient({
    baseUrl: 'http://nix.invalid',
    tokens: {
      getAccessToken: () => Promise.resolve(null),
      refreshAccessToken: () => Promise.resolve(null),
    },
  }),
  query<T>(endpoint: { operation: string }): Promise<T> {
    if (endpoint.operation === 'finance.month') {
      return Promise.resolve({
        month: '2026-09',
        closed: false,
        scheduledPosted: 3,
        scheduledUnposted: 1,
        unassignedTransactions: 2,
        unassignedOutflow: 38.5,
        overPlan: [{ lineId: LINE, name: 'Groceries', plan: 200, actual: 248, variance: 48 }],
        plan: dashboard.plan,
        actual: dashboard.actual,
      } as T);
    }
    if (endpoint.operation === 'finance.dashboard') return Promise.resolve(dashboard as T);
    if (endpoint.operation === 'finance.budget') return Promise.resolve(budgetGrid as T);
    if (endpoint.operation === 'finance.transactions') {
      return Promise.resolve(groceriesTransactions as T);
    }
    if (endpoint.operation === 'finance.cashFlow') return Promise.resolve(cashFlow as T);
    throw new Error(`No finance story response for ${endpoint.operation}.`);
  },
};

function Stage({ children }: { readonly children: ReactElement }): ReactElement {
  return <div className="mx-auto w-full max-w-5xl p-6">{children}</div>;
}

export default {
  title: 'Nix/Finance',
  parameters: { layout: 'padded' },
};

export const DashboardOverview = {
  render: (): ReactElement => (
    <ApiClientOverrideProvider client={monthClient}>
      <Stage>
        <Dashboard state={state} finance={finance} month="2026-09" onSection={() => undefined} />
      </Stage>
    </ApiClientOverrideProvider>
  ),
};

export const DashboardWithCardCredit = {
  render: (): ReactElement => (
    <ApiClientOverrideProvider
      client={{
        ...monthClient,
        query<T>(endpoint: { operation: string }): Promise<T> {
          if (endpoint.operation !== 'finance.dashboard') return monthClient.query<T>(endpoint);
          return Promise.resolve({
            ...dashboard,
            position: { ...dashboard.position, cardOwed: -500, netPosition: 7000 },
            monthEndDebt: 0,
            monthEndAfterDebt: 6500,
            cardFloat: -500,
            cards: dashboard.cards.map((card) => ({
              ...card,
              opening: -900,
              paymentOut: 0,
              closing: -500,
              utilisation: -500 / 3000,
            })),
          } as T);
        },
      }}
    >
      <Stage>
        <Dashboard state={state} finance={finance} month="2026-09" onSection={() => undefined} />
      </Stage>
    </ApiClientOverrideProvider>
  ),
};

export const BudgetGridMonth = {
  render: (): ReactElement => (
    <ApiClientOverrideProvider client={monthClient}>
      <Stage>
        <FinanceBudget state={state} finance={finance} month="2026-09" onMonth={() => undefined} />
      </Stage>
    </ApiClientOverrideProvider>
  ),
  play: async ({ canvasElement }: { canvasElement: HTMLElement }): Promise<void> => {
    await within(canvasElement).findByRole('region', { name: 'Budget figures' });
    await waitFor(() => {
      const root = canvasElement.ownerDocument.documentElement;
      if (root.scrollWidth > root.clientWidth + 1) {
        throw new Error('Budget columns or their accessible labels escape the screen.');
      }
    });
  },
};

export const BudgetGridClosedMonth = {
  render: (): ReactElement => (
    <ApiClientOverrideProvider client={monthClient}>
      <Stage>
        <FinanceBudget
          state={state}
          finance={{ ...finance, closedMonths: ['2026-09'] }}
          month="2026-09"
          onMonth={() => undefined}
        />
      </Stage>
    </ApiClientOverrideProvider>
  ),
  play: BudgetGridMonth.play,
};

export const BudgetGridOneAccount = {
  render: (): ReactElement => (
    <ApiClientOverrideProvider
      client={{
        ...monthClient,
        query<T>(endpoint: { operation: string }): Promise<T> {
          if (endpoint.operation === 'finance.budget') {
            return Promise.resolve({ ...budgetGrid, accountId: CARD } as T);
          }
          return monthClient.query<T>(endpoint);
        },
      }}
    >
      <Stage>
        <FinanceBudget state={state} finance={finance} month="2026-09" onMonth={() => undefined} />
      </Stage>
    </ApiClientOverrideProvider>
  ),
};

export const BehindAnActualClosedMonth = {
  render: (): ReactElement => (
    <ApiClientOverrideProvider client={monthClient}>
      <Stage>
        <BudgetActualDialog
          state={state}
          finance={{ ...finance, closedMonths: ['2026-09'] }}
          line={finance.lines[0] ?? groceriesLine}
          month="2026-09"
          cell={groceriesCell}
          onClose={() => undefined}
        />
      </Stage>
    </ApiClientOverrideProvider>
  ),
};

export const BehindAnActual = {
  render: (): ReactElement => (
    <ApiClientOverrideProvider client={monthClient}>
      <Stage>
        <BudgetActualDialog
          state={state}
          finance={finance}
          line={finance.lines[0] ?? groceriesLine}
          month="2026-09"
          cell={groceriesCell}
          onClose={() => undefined}
        />
      </Stage>
    </ApiClientOverrideProvider>
  ),
};

export const SetUpFinances = {
  render: (): ReactElement => (
    <Stage>
      <SettingsDialog state={state} finance={null} open onClose={() => undefined} />
    </Stage>
  ),
};

export const AddAccount = {
  render: (): ReactElement => (
    <Stage>
      <AccountDialog
        state={state}
        finance={finance}
        account={null}
        open
        onClose={() => undefined}
      />
    </Stage>
  ),
};

export const AddBudgetLine = {
  render: (): ReactElement => (
    <Stage>
      <LineDialog state={state} finance={finance} line={null} open onClose={() => undefined} />
    </Stage>
  ),
};

export const RecordTransaction = {
  render: (): ReactElement => (
    <Stage>
      <QuickAddDialog
        state={state}
        finance={finance}
        month="2026-09"
        open
        onClose={() => undefined}
      />
    </Stage>
  ),
};

export const CloseMonthChecklist = {
  render: (): ReactElement => (
    <ApiClientOverrideProvider client={monthClient}>
      <Stage>
        <CloseMonthDialog
          state={state}
          finance={finance}
          month="2026-09"
          open
          onClose={() => undefined}
        />
      </Stage>
    </ApiClientOverrideProvider>
  ),
};

export const MonthlyEmergencyTargets = {
  render: (): ReactElement => (
    <ApiClientOverrideProvider client={monthClient}>
      <Stage>
        <FinanceCashFlow state={state} finance={finance} month="2027-04" />
      </Stage>
    </ApiClientOverrideProvider>
  ),
};

export const NarrowFinances = {
  render: (): ReactElement => (
    <ApiClientOverrideProvider
      client={{
        ...monthClient,
        query<T>(endpoint: QueryEndpoint<T>): Promise<T> {
          if (endpoint.operation === 'finance.read') {
            return Promise.resolve(
              endpoint.schema.parse({ ...finance, closedMonths: [finance.currentMonth] }),
            );
          }
          return monthClient.query(endpoint);
        },
      }}
    >
      <div className="max-w-sm">
        <FinanceView
          container={storyContainer([], [], { itemId: ROOT })}
          view={recordStoryView('finance')}
          onOpen={() => undefined}
        />
      </div>
    </ApiClientOverrideProvider>
  ),
};

export const NarrowLargeBalanceTrend = {
  render: (): ReactElement => (
    <div className="max-w-xs">
      <FinanceBalanceTrend
        months={cashFlow.months.map((row, index) => ({
          ...row,
          netPosition: index === 0 ? -12_345_678_901_234 : 98_765_432_109_876,
        }))}
        month="2026-09"
        currency="GBP"
        onMonth={() => undefined}
      />
    </div>
  ),
};
