import { fireEvent, render, screen } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';
import type { FinanceDashboard } from '@nix/api-client';
import { FinanceMonthSummary } from '../../../finance/finance-month-summary';

const dashboard = {
  month: '2026-09',
  plan: { net: 300 },
  actual: { income: 1000, outgoings: 1200, net: -200 },
  position: { source: 'plan', closingBank: 2000, cardOwed: 500, netPosition: 1500 },
  monthEndDebt: 3000,
  monthEndAfterDebt: -1000,
} as FinanceDashboard;

describe('month-end savings and debt', () => {
  it('distinguishes a monthly surplus from an overall debt shortfall and labels forecasts', () => {
    const onAccounts = vi.fn();
    const onHistory = vi.fn();
    render(
      <FinanceMonthSummary
        dashboard={dashboard}
        currency="GBP"
        onAccounts={onAccounts}
        onHistory={onHistory}
      />,
    );
    expect(screen.getByText('Money left this month')).toBeInTheDocument();
    expect(screen.getByText('£300.00')).toBeInTheDocument();
    expect(screen.getByText('Debt above cash held')).toBeInTheDocument();
    expect(screen.getByText('Debt above cash held').parentElement).toHaveTextContent('£1,000.00');
    expect(screen.getByText('£3,000.00')).toBeInTheDocument();
    expect(screen.getByText(/Forecast from your budget/)).toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: 'View accounts and debts' }));
    expect(onAccounts).toHaveBeenCalledOnce();
    fireEvent.click(screen.getByRole('button', { name: 'Review recorded transactions' }));
    expect(onHistory).toHaveBeenCalledOnce();
  });

  it('uses recorded figures for a closed month rather than its planned surplus', () => {
    render(
      <FinanceMonthSummary
        dashboard={{ ...dashboard, position: { ...dashboard.position, source: 'actual' } }}
        currency="GBP"
        onAccounts={vi.fn()}
        onHistory={vi.fn()}
      />,
    );
    expect(screen.getByText('Spending above income this month')).toBeInTheDocument();
    expect(screen.getByText('£200.00')).toBeInTheDocument();
    expect(screen.queryByText('£300.00')).not.toBeInTheDocument();
    expect(
      screen.getByText(/Monthly income, spending and cash use the recorded transactions/),
    ).toBeInTheDocument();
  });

  it('does not present loan-inclusive totals when an older server omits them', () => {
    const older = { ...dashboard };
    delete older.monthEndDebt;
    delete older.monthEndAfterDebt;
    render(
      <FinanceMonthSummary
        dashboard={older}
        currency="GBP"
        onAccounts={vi.fn()}
        onHistory={vi.fn()}
      />,
    );
    expect(screen.getByText('Cash and card position')).toBeInTheDocument();
    expect(screen.queryByText('Total remaining debt')).not.toBeInTheDocument();
    expect(screen.getByText(/Remaining loans are listed under accounts/)).toBeInTheDocument();
  });

  it('shows card credits separately without adding them to cash after remaining debt', () => {
    render(
      <FinanceMonthSummary
        dashboard={{
          ...dashboard,
          position: { ...dashboard.position, cardOwed: -100, netPosition: 2100 },
          monthEndDebt: 500,
          monthEndAfterDebt: 1500,
        }}
        currency="GBP"
        onAccounts={vi.fn()}
        onHistory={vi.fn()}
      />,
    );
    expect(screen.getByText('Net card balances').parentElement).toHaveTextContent('-£100.00');
    expect(screen.getByText(/negative means card credit/)).toBeInTheDocument();
    expect(screen.getByText('Cash after all remaining debt').parentElement).toHaveTextContent(
      '£1,500.00',
    );
    expect(screen.queryByText('£2,100.00')).not.toBeInTheDocument();
  });
});
