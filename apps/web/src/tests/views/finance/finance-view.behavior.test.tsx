import { fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { Finance, FinanceDashboard, QueryEndpoint } from '@nix/api-client';
import { aContainer } from '@nix/web-collections/testing/container-fixture';
import { aView } from '@nix/web-collections/testing/view-fixture';
import { FinanceView } from '../../../views/finance/finance-view';
import type { FinanceState } from '../../../views/finance/use-finance';
import type * as UseFinance from '../../../views/finance/use-finance';

// The view is exercised against a hand-built state, the way the habit tracker's behaviour test
// is: what the person sees and does is the subject, and Core's arithmetic is the backend's.

const rootId = 'c1111111-1111-4111-8111-111111111111';
const accountId = 'c2222222-2222-4222-8222-222222222222';
const cardId = 'c3333333-3333-4333-8333-333333333333';
const lineId = 'c4444444-4444-4444-8444-444444444444';

const finance: Finance = {
  itemId: rootId,
  settings: {
    currency: 'GBP',
    startMonth: '2026-08',
    endMonth: '2027-12',
    horizonMonths: 17,
    openingCash: 2000,
    emergencyFundMonths: 3,
    timezone: 'Europe/London',
  },
  containers: { accounts: accountId, lines: lineId, transactions: cardId },
  accounts: [
    {
      id: accountId,
      name: 'Example current account',
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
      id: cardId,
      name: 'PrimaryCard',
      type: 'credit_card',
      limit: 3000,
      openingBalance: 100,
      settlesFrom: accountId,
      apr: null,
      payment: null,
      overpayment: null,
      target: null,
      archived: false,
    },
  ],
  lines: [
    {
      id: lineId,
      name: 'Groceries',
      section: 'PrimaryCard',
      flow: 'expense',
      accountId: cardId,
      amount: 200,
      overrides: {},
      scheduled: false,
      dueDay: null,
      loanAccount: null,
      archived: false,
      position: 1,
    },
  ],
  closedMonths: [],
  currentMonth: '2026-09',
  transactionCount: 3,
  problems: [],
};

const figures = { income: 4000, paidThisMonth: 1500, cardSpend: 400, outgoings: 1900, net: 2100 };
const position = {
  month: '2026-09',
  source: 'plan' as const,
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
};
const dashboard: FinanceDashboard = {
  itemId: rootId,
  month: '2026-09',
  closed: false,
  plan: figures,
  actual: { ...figures, cardSpend: 480, outgoings: 1980, net: 2020 },
  savingsRatePlan: 0.525,
  savingsRateActual: 0.505,
  position,
  openingNetPosition: 1900,
  emergencyTarget: 5700,
  bufferMetIn: '2026-09',
  cardFloat: 480,
  cards: [
    {
      accountId: cardId,
      name: 'PrimaryCard',
      month: '2026-09',
      source: 'plan',
      opening: 400,
      spend: 480,
      paymentOut: 400,
      closing: 480,
      utilisation: 0.16,
      limit: 3000,
      settlesFrom: accountId,
    },
  ],
  loans: [],
  watch: [
    { lineId, name: 'Commuting', section: 'PrimaryCard', plan: 100, actual: 172, variance: 72 },
  ],
  upcoming: [
    {
      kind: 'line',
      lineId,
      accountId,
      name: 'Rent',
      due: '2026-10-01',
      amount: 900,
      posted: false,
    },
  ],
  horizonEnd: { ...position, month: '2027-12', netPosition: 40000 },
  horizonNet: 38100,
};

const createTransaction = vi.fn<FinanceState['createTransaction']>();
const setMonth = vi.fn<FinanceState['setMonth']>();
const reload = vi.fn();
let status: FinanceState['status'] = 'ready';
let current: Finance | null = finance;
let refreshing = false;
let refreshError: string | null = null;

vi.mock('../../../views/finance/use-finance', async () => {
  const actual = await vi.importActual<typeof UseFinance>('../../../views/finance/use-finance');
  return {
    ...actual,
    useFinance: (): FinanceState => ({
      status,
      finance: current,
      error: status === 'error' ? 'The server is away.' : null,
      refreshing,
      refreshError,
      generation: 0,
      reload,
      setSettings: vi.fn(),
      createAccount: vi.fn(),
      setAccount: vi.fn(),
      createLine: vi.fn(),
      setLine: vi.fn(),
      createTransaction,
      setTransaction: vi.fn(),
      deleteTransaction: vi.fn(),
      setActual: vi.fn(),
      setMonth,
      postScheduled: vi.fn(),
      importStatement: vi.fn(),
    }),
    useFinanceQuery: <T,>(endpoint: QueryEndpoint<T> | null) => {
      if (endpoint === null) return { status: 'loading', data: null, error: null };
      if (endpoint.operation === 'finance.dashboard') {
        return { status: 'ready', data: dashboard as unknown as T, error: null };
      }
      if (endpoint.operation === 'finance.month') {
        return {
          status: 'ready',
          data: {
            month: '2026-09',
            closed: false,
            scheduledPosted: 3,
            scheduledUnposted: 1,
            unassignedTransactions: 0,
            unassignedOutflow: 0,
            overPlan: [],
            plan: figures,
            actual: figures,
          } as unknown as T,
          error: null,
        };
      }
      return { status: 'loading', data: null, error: null };
    },
  };
});

const mount = () =>
  render(
    <FinanceView
      container={aContainer({ itemId: rootId, children: [] })}
      view={aView({ id: 'view-1', name: 'Finances', kind: 'finance' })}
      onOpen={vi.fn()}
    />,
  );

beforeEach(() => {
  status = 'ready';
  current = finance;
  refreshing = false;
  refreshError = null;
  createTransaction.mockResolvedValue(null);
  setMonth.mockResolvedValue(null);
});

afterEach(() => {
  vi.clearAllMocks();
});

describe('the finance view', () => {
  it('shows the dashboard for the current month with the figures Core sent', () => {
    mount();
    expect(screen.getByRole('heading', { name: 'Finances' })).toBeInTheDocument();
    expect(screen.getByText('September 2026')).toBeInTheDocument();
    expect(
      screen.getByRole('heading', { name: 'At the end of September 2026' }),
    ).toBeInTheDocument();
    expect(screen.getByText('Money left this month')).toBeInTheDocument();
    expect(screen.getByText('Commuting')).toBeInTheDocument();
    expect(screen.getByText('Commuting').closest('li')).toHaveTextContent('+£72.00 over');
    expect(screen.getByText('Rent')).toBeInTheDocument();
    expect(screen.getByRole('meter', { name: 'Cash and card buffer progress' })).toHaveAttribute(
      'aria-valuenow',
      '100',
    );
    expect(screen.getByText('PrimaryCard')).toBeInTheDocument();
    expect(screen.getByText('16% used')).toBeInTheDocument();
  });

  it('records a transaction from the quick-add with the cash effect negative for money out', async () => {
    mount();
    fireEvent.click(screen.getByRole('button', { name: 'Add transaction' }));
    const dialog = screen.getByRole('dialog', { name: 'Add a transaction' });
    fireEvent.change(within(dialog).getByLabelText('Amount'), { target: { value: '12.40' } });
    fireEvent.change(within(dialog).getByLabelText('Description'), {
      target: { value: 'Example shop' },
    });
    fireEvent.change(within(dialog).getByLabelText('Budget line'), { target: { value: lineId } });
    fireEvent.change(within(dialog).getByLabelText('Date'), { target: { value: '2026-09-21' } });
    fireEvent.click(within(dialog).getByRole('button', { name: 'Record' }));
    await waitFor(() => {
      expect(createTransaction).toHaveBeenCalledWith({
        description: 'Example shop',
        date: '2026-09-21',
        amount: -12.4,
        accountId: cardId,
        lineId,
        cleared: false,
      });
    });
    await waitFor(() => {
      expect(screen.queryByRole('dialog', { name: 'Add a transaction' })).not.toBeInTheDocument();
    });
  });

  it('closes the month from the checklist', async () => {
    mount();
    fireEvent.click(screen.getByRole('button', { name: 'Close month' }));
    const dialog = screen.getByRole('dialog', { name: 'Close September 2026?' });
    expect(within(dialog).getByText(/1 scheduled line not posted yet/)).toBeInTheDocument();
    fireEvent.click(within(dialog).getByRole('button', { name: 'Close month' }));
    await waitFor(() => {
      expect(setMonth).toHaveBeenCalledWith('2026-09', true);
    });
  });

  it('walks months only inside the plan', () => {
    mount();
    fireEvent.click(screen.getByRole('button', { name: 'Previous month' }));
    expect(screen.getByText('August 2026')).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Previous month' })).toBeDisabled();
  });

  it('jumps directly to a historical month and returns to the current month', () => {
    mount();
    fireEvent.change(screen.getByRole('combobox', { name: 'Month' }), {
      target: { value: '2026-08' },
    });
    expect(screen.getByRole('combobox', { name: 'Month' })).toHaveValue('2026-08');
    fireEvent.click(screen.getByRole('button', { name: 'This month' }));
    expect(screen.getByRole('combobox', { name: 'Month' })).toHaveValue('2026-09');
  });

  it('keeps the This month button, disabled, while already on the current month', () => {
    mount();
    expect(screen.getByRole('button', { name: 'This month' })).toBeDisabled();
  });

  it('keeps the selected month inside a shortened plan horizon', () => {
    const result = mount();
    fireEvent.click(screen.getByRole('button', { name: 'Next month' }));
    expect(screen.getByText('October 2026')).toBeInTheDocument();

    current = {
      ...finance,
      settings: { ...finance.settings, endMonth: '2026-09', horizonMonths: 2 },
    };
    result.rerender(
      <FinanceView
        container={aContainer({ itemId: rootId, children: [] })}
        view={aView({ id: 'view-1', name: 'Finances', kind: 'finance' })}
        onOpen={vi.fn()}
      />,
    );

    expect(screen.getByText('September 2026')).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Next month' })).toBeDisabled();
  });

  it('offers set-up when the item has no finance settings', () => {
    status = 'unconfigured';
    current = null;
    mount();
    expect(screen.getByText('Set up your finances')).toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: 'Set up' }));
    expect(screen.getByRole('dialog', { name: 'Set up finances' })).toBeInTheDocument();
  });

  it('says what went wrong and offers to try again', () => {
    status = 'error';
    current = null;
    mount();
    expect(screen.getByRole('alert')).toHaveTextContent('The server is away.');
    fireEvent.click(screen.getByRole('button', { name: 'Try again' }));
    expect(reload).toHaveBeenCalled();
  });

  it('keeps the section and an open dialog mounted when a background reload fails', () => {
    const result = mount();
    fireEvent.click(screen.getByRole('button', { name: 'Add transaction' }));
    expect(screen.getByRole('dialog', { name: 'Add a transaction' })).toBeInTheDocument();

    // A write elsewhere under the root bumped the generation and the reload failed - the root
    // stays 'ready' with the data it already had, so nothing here should unmount.
    refreshError = 'The finances could not be loaded.';
    result.rerender(
      <FinanceView
        container={aContainer({ itemId: rootId, children: [] })}
        view={aView({ id: 'view-1', name: 'Finances', kind: 'finance' })}
        onOpen={vi.fn()}
      />,
    );

    expect(screen.getByRole('dialog', { name: 'Add a transaction' })).toBeInTheDocument();
    expect(screen.getByRole('heading', { name: 'Finances' })).toBeInTheDocument();
    expect(screen.getByRole('alert')).toHaveTextContent('The finances could not be loaded.');
  });
});
