import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import type {
  BudgetCell,
  BudgetLine,
  Finance,
  FinanceTransaction,
  QueryEndpoint,
} from '@nix/api-client';
import type * as UseFinanceModule from '../../../finance/use-finance';

const queried = vi.hoisted((): { transactions: FinanceTransaction[] } => ({ transactions: [] }));

beforeEach(() => {
  queried.transactions = [];
});

vi.mock('../../../finance/use-finance', async () => {
  const actual = await vi.importActual<typeof UseFinanceModule>('../../../finance/use-finance');
  return {
    ...actual,
    useFinanceQuery: <T,>(endpoint: QueryEndpoint<T>) => {
      void endpoint;
      return {
        status: 'ready',
        data: {
          transactions: queried.transactions,
          total: queried.transactions.length,
          truncated: false,
        },
        error: null,
      };
    },
  };
});

import { BudgetActualDialog } from '../../../finance/budget-actual-dialog';
import type { FinanceState as FinanceViewState } from '../../../finance/use-finance';

const accountId = 'c3333333-3333-4333-8333-333333333333';
const line: BudgetLine = {
  id: 'c4444444-4444-4444-8444-444444444444',
  name: 'Groceries',
  section: 'Everyday spending',
  flow: 'expense',
  accountId,
  amount: 100,
  overrides: {},
  scheduled: false,
  dueDay: null,
  loanAccount: null,
  archived: false,
  position: 1,
};

const finance = {
  itemId: 'c1111111-1111-4111-8111-111111111111',
  settings: {
    currency: 'GBP',
    startMonth: '2026-09',
    endMonth: '2027-08',
    timezone: 'Europe/London',
  },
  accounts: [{ id: accountId, name: 'Everyday card', type: 'current' }],
  lines: [line],
  closedMonths: [],
} as unknown as Finance;

const cell: BudgetCell = {
  month: '2026-09',
  plan: 100,
  actual: 25,
  variance: -75,
  transactions: 1,
};

const setActual = vi.fn<FinanceViewState['setActual']>();
const state = {
  generation: 0,
  setActual,
  deleteTransaction: vi.fn(),
  createTransaction: vi.fn(),
  setTransaction: vi.fn(),
} as unknown as FinanceViewState;

const transaction: FinanceTransaction = {
  id: 'c6666666-6666-4666-8666-666666666666',
  description: 'Corner shop',
  date: '2026-09-05',
  amount: -12.4,
  accountId,
  lineId: line.id,
  source: 'manual',
  postedFor: null,
  importKey: null,
  cleared: false,
};

function mount(onClose: () => void = () => undefined) {
  return render(
    <BudgetActualDialog
      state={state}
      finance={finance}
      line={line}
      month="2026-09"
      cell={cell}
      onClose={onClose}
    />,
  );
}

it('keeps the existing deletion confirmation when the row context menu requests deletion', () => {
  queried.transactions = [transaction];
  const deleteTransaction = vi.fn<FinanceViewState['deleteTransaction']>();
  render(
    <BudgetActualDialog
      state={{ ...state, deleteTransaction }}
      finance={finance}
      line={line}
      month="2026-09"
      cell={cell}
      onClose={() => undefined}
    />,
  );

  fireEvent.contextMenu(screen.getByRole('row', { name: /Corner shop/ }), {
    clientX: 40,
    clientY: 60,
  });
  fireEvent.click(screen.getByRole('menuitem', { name: 'Delete transaction' }));

  expect(screen.getByRole('button', { name: 'Yes, delete Corner shop' })).toBeInTheDocument();
  expect(screen.getByRole('button', { name: 'Keep Corner shop' })).toHaveFocus();
  expect(deleteTransaction).not.toHaveBeenCalled();
});

it('disables deletion through the row context menu for a closed month', () => {
  queried.transactions = [transaction];
  render(
    <BudgetActualDialog
      state={state}
      finance={{ ...finance, closedMonths: ['2026-09'] }}
      line={line}
      month="2026-09"
      cell={cell}
      onClose={() => undefined}
    />,
  );

  fireEvent.contextMenu(screen.getByRole('row', { name: /Corner shop/ }), {
    clientX: 40,
    clientY: 60,
  });

  expect(screen.getByRole('menuitem', { name: 'Delete transaction' })).toBeDisabled();
});

describe('a stray tap outside the sheet, while a new total is mid-edit', () => {
  it('keeps the retyped total instead of silently discarding it', () => {
    mount();
    fireEvent.change(screen.getByRole('textbox', { name: "Bring this month's total to" }), {
      target: { value: '40' },
    });

    const dialog = screen.getByRole('dialog');
    fireEvent.mouseDown(dialog);
    fireEvent.click(dialog);

    expect(screen.getByRole('dialog')).toBeInTheDocument();
    expect(screen.getByText('Discard what you typed?')).toBeInTheDocument();

    fireEvent.click(screen.getByRole('button', { name: 'Keep editing' }));

    expect(screen.getByRole('textbox', { name: "Bring this month's total to" })).toHaveValue('40');
  });

  it('discards through the prompt and closes only then', () => {
    const onClose = vi.fn();
    mount(onClose);
    fireEvent.change(screen.getByRole('textbox', { name: "Bring this month's total to" }), {
      target: { value: '40' },
    });

    const dialog = screen.getByRole('dialog');
    fireEvent.mouseDown(dialog);
    fireEvent.click(dialog);
    fireEvent.click(screen.getByRole('button', { name: 'Discard' }));

    expect(onClose).toHaveBeenCalledTimes(1);
  });

  it('does not prompt when the total was never touched', () => {
    const onClose = vi.fn();
    mount(onClose);

    const dialog = screen.getByRole('dialog');
    fireEvent.mouseDown(dialog);
    fireEvent.click(dialog);

    expect(onClose).toHaveBeenCalledTimes(1);
    expect(screen.queryByText('Discard what you typed?')).not.toBeInTheDocument();
  });
});

it('freezes a saved total while retrying month closure and avoids a duplicate adjustment', async () => {
  const setMonth = vi
    .fn<FinanceViewState['setMonth']>()
    .mockResolvedValueOnce(null)
    .mockResolvedValueOnce('Server unavailable.')
    .mockResolvedValueOnce(null);
  const saveTotal = vi.fn<FinanceViewState['setActual']>().mockResolvedValue({
    lineId: line.id,
    month: '2026-09',
    before: 25,
    after: 80,
    transaction: null,
  });
  const onClose = vi.fn();
  render(
    <BudgetActualDialog
      state={{ ...state, setActual: saveTotal, setMonth }}
      finance={{ ...finance, closedMonths: ['2026-09'] }}
      line={line}
      month="2026-09"
      cell={cell}
      onClose={onClose}
    />,
  );
  fireEvent.click(screen.getByRole('button', { name: 'Reopen to update total' }));
  await waitFor(() => {
    expect(screen.getByLabelText("Bring this month's total to")).toBeInTheDocument();
  });
  fireEvent.change(screen.getByLabelText("Bring this month's total to"), {
    target: { value: '80' },
  });
  fireEvent.click(screen.getByRole('button', { name: 'Record' }));
  await waitFor(() => {
    expect(screen.getByLabelText('Saved total')).toBeDisabled();
  });
  expect(screen.getByLabelText('Saved total')).toHaveValue('80');
  expect(screen.queryByRole('button', { name: /Same as planned/ })).not.toBeInTheDocument();
  expect(screen.getByRole('button', { name: 'Add transaction' })).toBeDisabled();
  expect(screen.getByText(/the total will not be recorded again/)).toBeInTheDocument();
  fireEvent.click(screen.getByRole('button', { name: 'Retry closing month' }));
  await waitFor(() => {
    expect(onClose).toHaveBeenCalled();
  });
  expect(saveTotal).toHaveBeenCalledTimes(1);
  expect(setMonth).toHaveBeenCalledTimes(3);
});
