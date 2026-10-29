import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import {
  createNixClient,
  type BudgetLine,
  type Finance,
  type FinanceTransaction,
  type QueryEndpoint,
} from '@nix/api-client';
import { ApiClientOverrideProvider } from '@nix/web-platform/api/api-client-provider';
import type * as UseFinanceModule from '../../../finance/use-finance';

const queries = vi.hoisted(
  (): { transactions: unknown; seen: Readonly<Record<string, unknown>>[] } => ({
    transactions: null,
    seen: [],
  }),
);

vi.mock('../../../finance/use-finance', async () => {
  const actual = await vi.importActual<typeof UseFinanceModule>('../../../finance/use-finance');
  return {
    ...actual,
    useFinanceQuery: <T,>(endpoint: QueryEndpoint<T>) => {
      queries.seen.push(endpoint.query ?? {});
      return { status: 'ready', data: queries.transactions, error: null };
    },
  };
});

import {
  FinanceTransactions,
  QuickAddDialog,
  TransactionDialog,
} from '../../../finance/finance-transactions';
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

const createTransaction = vi.fn<FinanceViewState['createTransaction']>();

const state = {
  generation: 0,
  createTransaction,
  setTransaction: vi.fn(),
  deleteTransaction: vi.fn(),
} as unknown as FinanceViewState;

function mount(onClose: () => void = () => undefined) {
  return render(
    <QuickAddDialog state={state} finance={finance} month="2026-09" open onClose={onClose} />,
  );
}

beforeEach(() => {
  createTransaction.mockReset().mockResolvedValue(null);
});

describe('recording a transaction and adding another', () => {
  it('clears the amount and description but keeps date, account and line, and stays open', async () => {
    mount();
    fireEvent.change(screen.getByLabelText('Amount'), { target: { value: '12.40' } });
    fireEvent.change(screen.getByLabelText('Description'), { target: { value: 'Corner shop' } });
    fireEvent.change(screen.getByLabelText('Budget line'), { target: { value: line.id } });
    fireEvent.change(screen.getByLabelText('Account'), { target: { value: accountId } });
    fireEvent.change(screen.getByLabelText('Date'), { target: { value: '2026-09-05' } });

    fireEvent.click(screen.getByRole('button', { name: 'Save and add another' }));

    await waitFor(() => {
      expect(createTransaction).toHaveBeenCalledWith(
        expect.objectContaining({
          description: 'Corner shop',
          amount: -12.4,
          accountId,
          lineId: line.id,
        }),
      );
    });
    expect(screen.getByRole('dialog', { name: 'Add a transaction' })).toBeInTheDocument();
    expect(screen.getByLabelText('Amount')).toHaveValue('');
    expect(screen.getByLabelText('Description')).toHaveValue('');
    expect(screen.getByLabelText('Budget line')).toHaveValue(line.id);
    expect(screen.getByLabelText('Account')).toHaveValue(accountId);
    expect(screen.getByLabelText('Date')).toHaveValue('2026-09-05');
  });

  it('does not clear the form or close when the save is refused', async () => {
    createTransaction.mockResolvedValue('The account could not be reached.');
    mount();
    fireEvent.change(screen.getByLabelText('Amount'), { target: { value: '12.40' } });
    fireEvent.change(screen.getByLabelText('Description'), { target: { value: 'Corner shop' } });

    fireEvent.click(screen.getByRole('button', { name: 'Save and add another' }));
    await waitFor(() => {
      expect(screen.getByText('The account could not be reached.')).toBeInTheDocument();
    });
    expect(screen.getByLabelText('Description')).toHaveValue('Corner shop');
  });

  it('closes on the ordinary Record button instead of staying open', async () => {
    const onClose = vi.fn();
    mount(onClose);
    fireEvent.change(screen.getByLabelText('Amount'), { target: { value: '12.40' } });
    fireEvent.click(screen.getByRole('button', { name: 'Record' }));
    await waitFor(() => {
      expect(onClose).toHaveBeenCalled();
    });
  });
});

describe('a stray tap outside the sheet', () => {
  it('keeps typed input instead of silently discarding it', () => {
    mount();
    fireEvent.change(screen.getByLabelText('Description'), { target: { value: 'Corner shop' } });
    fireEvent.change(screen.getByLabelText('Amount'), { target: { value: '12.40' } });

    const dialog = screen.getByRole('dialog', { name: 'Add a transaction' });
    // A backdrop click, as the browser sends it: pressed and released on the element itself.
    fireEvent.mouseDown(dialog);
    fireEvent.click(dialog);

    expect(screen.getByRole('dialog', { name: 'Add a transaction' })).toBeInTheDocument();
    expect(screen.getByText('Discard what you typed?')).toBeInTheDocument();

    fireEvent.click(screen.getByRole('button', { name: 'Keep editing' }));

    expect(screen.getByLabelText('Description')).toHaveValue('Corner shop');
    expect(screen.getByLabelText('Amount')).toHaveValue('12.40');
  });

  it('discards through the prompt and closes only then', () => {
    const onClose = vi.fn();
    mount(onClose);
    fireEvent.change(screen.getByLabelText('Description'), { target: { value: 'Corner shop' } });

    const dialog = screen.getByRole('dialog', { name: 'Add a transaction' });
    fireEvent.mouseDown(dialog);
    fireEvent.click(dialog);
    fireEvent.click(screen.getByRole('button', { name: 'Discard' }));

    expect(onClose).toHaveBeenCalledTimes(1);
  });
});

const otherLine: BudgetLine = {
  ...line,
  id: 'c5555555-5555-4555-8555-555555555555',
  name: 'Transport',
};

const transactionA: FinanceTransaction = {
  id: 'c6666666-6666-4666-8666-666666666666',
  description: 'Corner shop',
  date: '2026-09-05',
  amount: -12.4,
  accountId,
  lineId: null,
  source: 'manual',
  postedFor: null,
  importKey: null,
  cleared: false,
};

const transactionB: FinanceTransaction = {
  ...transactionA,
  id: 'c7777777-7777-4777-8777-777777777777',
  description: 'Bus fare',
  amount: -3.2,
};

describe('bulk-assigning a selection of transactions to a budget line', () => {
  const setTransaction = vi.fn<FinanceViewState['setTransaction']>();
  const bulkState = {
    generation: 0,
    createTransaction: vi.fn(),
    setTransaction,
    deleteTransaction: vi.fn(),
  } as unknown as FinanceViewState;

  const mountList = () =>
    render(
      <FinanceTransactions
        state={bulkState}
        finance={{ ...finance, lines: [line, otherLine] }}
        month="2026-09"
      />,
    );

  beforeEach(() => {
    setTransaction.mockReset();
    queries.transactions = {
      transactions: [transactionA, transactionB],
      total: 2,
      truncated: false,
    };
  });

  it('assigns every selected transaction, one write per row', async () => {
    setTransaction.mockResolvedValue(null);
    mountList();

    fireEvent.click(screen.getByLabelText(`Select ${transactionA.description}`));
    fireEvent.click(screen.getByLabelText(`Select ${transactionB.description}`));
    fireEvent.change(screen.getByLabelText('Assign to line'), { target: { value: line.id } });
    fireEvent.click(screen.getByRole('button', { name: 'Preview change' }));
    expect(setTransaction).not.toHaveBeenCalled();
    fireEvent.click(screen.getByRole('button', { name: 'Apply category change' }));

    await waitFor(() => {
      expect(setTransaction).toHaveBeenCalledTimes(2);
    });
    expect(setTransaction).toHaveBeenCalledWith(
      transactionA.id,
      expect.objectContaining({ lineId: line.id }),
    );
    expect(setTransaction).toHaveBeenCalledWith(
      transactionB.id,
      expect.objectContaining({ lineId: line.id }),
    );
  });

  it('reports a partial failure honestly and keeps the failed row selected', async () => {
    setTransaction.mockImplementation((transactionId: string) =>
      Promise.resolve(
        transactionId === transactionB.id ? 'That budget line no longer exists.' : null,
      ),
    );
    mountList();

    fireEvent.click(screen.getByLabelText(`Select ${transactionA.description}`));
    fireEvent.click(screen.getByLabelText(`Select ${transactionB.description}`));
    fireEvent.change(screen.getByLabelText('Assign to line'), { target: { value: line.id } });
    fireEvent.click(screen.getByRole('button', { name: 'Preview change' }));
    expect(setTransaction).not.toHaveBeenCalled();
    fireEvent.click(screen.getByRole('button', { name: 'Apply category change' }));

    await waitFor(() => {
      expect(
        screen.getByText('Assigned 1 of 2; 1 was refused: That budget line no longer exists. (1)'),
      ).toBeInTheDocument();
    });
    expect(screen.getByLabelText(`Select ${transactionA.description}`)).not.toBeChecked();
    expect(screen.getByLabelText(`Select ${transactionB.description}`)).toBeChecked();
  });

  it('reports each distinct refusal reason with its own count, not just the last one', async () => {
    const transactionC: FinanceTransaction = {
      ...transactionA,
      id: 'c8888888-8888-4888-8888-888888888888',
      description: 'Coffee',
    };
    queries.transactions = {
      transactions: [transactionA, transactionB, transactionC],
      total: 3,
      truncated: false,
    };
    setTransaction.mockImplementation((transactionId: string) =>
      Promise.resolve(
        transactionId === transactionA.id
          ? null
          : transactionId === transactionB.id
            ? 'That budget line no longer exists.'
            : 'The account is closed.',
      ),
    );
    mountList();

    fireEvent.click(screen.getByLabelText(`Select ${transactionA.description}`));
    fireEvent.click(screen.getByLabelText(`Select ${transactionB.description}`));
    fireEvent.click(screen.getByLabelText(`Select ${transactionC.description}`));
    fireEvent.change(screen.getByLabelText('Assign to line'), { target: { value: line.id } });
    fireEvent.click(screen.getByRole('button', { name: 'Preview change' }));
    expect(setTransaction).not.toHaveBeenCalled();
    fireEvent.click(screen.getByRole('button', { name: 'Apply category change' }));

    await waitFor(() => {
      expect(
        screen.getByText(
          'Assigned 1 of 3; 2 were refused: That budget line no longer exists. (1), The account is closed. (1)',
        ),
      ).toBeInTheDocument();
    });
  });
});

describe('searchable transaction history', () => {
  beforeEach(() => {
    queries.seen = [];
    queries.transactions = {
      transactions: [transactionA],
      total: 51,
      truncated: true,
      offset: 0,
      nextOffset: 50,
      inflow: 3200,
      outflow: 500,
      net: 2700,
    };
  });
  it('opens the existing transaction editor from the row context menu', () => {
    render(<FinanceTransactions state={state} finance={finance} month="2026-09" />);

    fireEvent.contextMenu(screen.getByRole('row', { name: /Corner shop/ }), {
      clientX: 40,
      clientY: 60,
    });
    fireEvent.click(screen.getByRole('menuitem', { name: 'Edit transaction' }));

    expect(screen.getByRole('dialog', { name: 'Edit Corner shop' })).toBeInTheDocument();
    expect(screen.getByLabelText('Description')).toHaveValue(transactionA.description);
    expect(screen.getByLabelText('Amount')).toHaveValue('12.4');
  });
  it('searches all history on Core and paginates the result while retaining full totals', () => {
    render(<FinanceTransactions state={state} finance={finance} month="2026-09" />);
    fireEvent.click(screen.getByRole('button', { name: 'All history' }));
    fireEvent.change(screen.getByRole('searchbox', { name: 'Search transactions' }), {
      target: { value: 'shop' },
    });
    fireEvent.click(screen.getByRole('button', { name: 'Search' }));
    expect(queries.seen.at(-1)).toMatchObject({ search: 'shop', offset: '0', limit: '50' });
    expect(queries.seen.at(-1)).not.toHaveProperty('month');
    expect(screen.getByText('+£2,700.00')).toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: 'Next 50' }));
    expect(queries.seen.at(-1)).toMatchObject({ search: 'shop', offset: '50' });
  });
  it('validates reversed custom dates before sending a new query', () => {
    render(<FinanceTransactions state={state} finance={finance} month="2026-09" />);
    fireEvent.click(screen.getByRole('button', { name: 'Date range' }));
    fireEvent.change(screen.getByLabelText('From date'), { target: { value: '2026-12-01' } });
    fireEvent.click(screen.getByRole('button', { name: 'Search' }));
    expect(
      screen.getByText('Choose a start and end date, with the earlier date first.'),
    ).toBeInTheDocument();
    expect(queries.seen.at(-1)).not.toMatchObject({ from: '2026-12-01' });
  });
});

describe('closed-month transaction correction', () => {
  it('reopens before writing and closes again after a successful correction', async () => {
    const setMonth = vi.fn<FinanceViewState['setMonth']>().mockResolvedValue(null);
    const setTransaction = vi.fn<FinanceViewState['setTransaction']>().mockResolvedValue(null);
    const onClose = vi.fn();
    render(
      <TransactionDialog
        state={{ ...state, setMonth, setTransaction }}
        finance={{ ...finance, closedMonths: ['2026-09'] }}
        transaction={transactionA}
        onClose={onClose}
      />,
    );
    expect(screen.getByRole('button', { name: 'Save changes' })).toBeDisabled();
    fireEvent.click(screen.getByRole('button', { name: 'Reopen to correct' }));
    await waitFor(() => {
      expect(setMonth).toHaveBeenCalledWith('2026-09', false);
    });
    fireEvent.change(screen.getByLabelText('Amount'), { target: { value: '17.40' } });
    fireEvent.click(screen.getByRole('button', { name: 'Save changes' }));
    await waitFor(() => {
      expect(setTransaction).toHaveBeenCalledWith(
        transactionA.id,
        expect.objectContaining({ amount: -17.4 }),
      );
    });
    await waitFor(() => {
      expect(setMonth).toHaveBeenCalledWith('2026-09', true);
    });
    expect(onClose).toHaveBeenCalled();
  });
  it('retries closing without saving the correction twice', async () => {
    const setMonth = vi
      .fn<FinanceViewState['setMonth']>()
      .mockResolvedValueOnce(null)
      .mockResolvedValueOnce('Try again.')
      .mockResolvedValueOnce(null);
    const setTransaction = vi.fn<FinanceViewState['setTransaction']>().mockResolvedValue(null);
    const onClose = vi.fn();
    render(
      <TransactionDialog
        state={{ ...state, setMonth, setTransaction }}
        finance={{ ...finance, closedMonths: ['2026-09'] }}
        transaction={transactionA}
        onClose={onClose}
      />,
    );
    fireEvent.click(screen.getByRole('button', { name: 'Reopen to correct' }));
    await waitFor(() => expect(screen.getByRole('button', { name: 'Save changes' })).toBeEnabled());
    fireEvent.click(screen.getByRole('button', { name: 'Save changes' }));
    await waitFor(() =>
      expect(screen.getByRole('button', { name: 'Retry closing month' })).toBeInTheDocument(),
    );
    fireEvent.click(screen.getByRole('button', { name: 'Retry closing month' }));
    await waitFor(() => {
      expect(onClose).toHaveBeenCalled();
    });
    expect(setTransaction).toHaveBeenCalledTimes(1);
  });
});

describe('restoring changes from this visit', () => {
  it('shows no changes disclosure before anything was edited', async () => {
    queries.transactions = { transactions: [transactionA], total: 1, truncated: false };
    const client = {
      ...createNixClient({
        baseUrl: 'http://nix.invalid',
        tokens: {
          getAccessToken: () => Promise.resolve(null),
          refreshAccessToken: () => Promise.resolve(null),
        },
      }),
      query: vi.fn(),
    };
    render(
      <ApiClientOverrideProvider client={client}>
        <FinanceTransactions state={state} finance={finance} month="2026-09" />
      </ApiClientOverrideProvider>,
    );
    await screen.findByRole('button', { name: 'Corner shop' });
    expect(screen.queryByText(/Changes in this visit/)).not.toBeInTheDocument();
  });

  it('checks latest values and refuses to overwrite a later change', async () => {
    queries.transactions = { transactions: [transactionA], total: 1, truncated: false };
    const setTransaction = vi.fn<FinanceViewState['setTransaction']>().mockResolvedValue(null);
    const current = { ...transactionA, amount: -88 };
    const query = vi
      .fn()
      .mockResolvedValue({ transactions: [current], total: 1, truncated: false });
    const client = {
      ...createNixClient({
        baseUrl: 'http://nix.invalid',
        tokens: {
          getAccessToken: () => Promise.resolve(null),
          refreshAccessToken: () => Promise.resolve(null),
        },
      }),
      query,
    };
    render(
      <ApiClientOverrideProvider client={client}>
        <FinanceTransactions
          state={{ ...state, setTransaction }}
          finance={finance}
          month="2026-09"
        />
      </ApiClientOverrideProvider>,
    );
    fireEvent.click(screen.getByRole('button', { name: 'Corner shop' }));
    fireEvent.change(screen.getByLabelText('Amount'), { target: { value: '17.40' } });
    fireEvent.click(screen.getByRole('button', { name: 'Save changes' }));
    await waitFor(() => expect(screen.queryByRole('dialog')).not.toBeInTheDocument());
    fireEvent.click(screen.getByText('Changes in this visit (1)'));
    fireEvent.click(screen.getByRole('button', { name: 'Review undo' }));
    fireEvent.click(screen.getByRole('button', { name: 'Restore previous values' }));
    await waitFor(() =>
      expect(
        screen.getByText(
          'This transaction has changed since that edit. Open its current record and review the changes before correcting it.',
        ),
      ).toBeInTheDocument(),
    );
    expect(setTransaction).toHaveBeenCalledTimes(1);
    expect(query).toHaveBeenCalledWith(
      expect.objectContaining({ query: { transactionId: transactionA.id } }),
      expect.objectContaining({ forceRefresh: true }),
    );
  });
  it('restores captured values when the record still matches the saved edit', async () => {
    queries.transactions = { transactions: [transactionA], total: 1, truncated: false };
    const setTransaction = vi.fn<FinanceViewState['setTransaction']>().mockResolvedValue(null);
    const after = { ...transactionA, amount: -17.4 };
    const client = {
      ...createNixClient({
        baseUrl: 'http://nix.invalid',
        tokens: {
          getAccessToken: () => Promise.resolve(null),
          refreshAccessToken: () => Promise.resolve(null),
        },
      }),
      query: vi.fn().mockResolvedValue({ transactions: [after], total: 1, truncated: false }),
    };
    render(
      <ApiClientOverrideProvider client={client}>
        <FinanceTransactions
          state={{ ...state, setTransaction }}
          finance={finance}
          month="2026-09"
        />
      </ApiClientOverrideProvider>,
    );
    fireEvent.click(screen.getByRole('button', { name: 'Corner shop' }));
    fireEvent.change(screen.getByLabelText('Amount'), { target: { value: '17.40' } });
    fireEvent.click(screen.getByRole('button', { name: 'Save changes' }));
    await waitFor(() => expect(screen.queryByRole('dialog')).not.toBeInTheDocument());
    fireEvent.click(screen.getByText('Changes in this visit (1)'));
    fireEvent.click(screen.getByRole('button', { name: 'Review undo' }));
    expect(screen.getByLabelText('Amount')).toHaveValue('12.4');
    fireEvent.click(screen.getByRole('button', { name: 'Restore previous values' }));
    await waitFor(() => {
      expect(setTransaction).toHaveBeenLastCalledWith(
        transactionA.id,
        expect.objectContaining({ amount: -12.4 }),
      );
    });
    expect(
      screen.getByText('Restored the previous values. Totals are refreshing.'),
    ).toBeInTheDocument();
  });
});

describe('historical edit safety', () => {
  it('keeps the dialog open during an in-flight reopen', async () => {
    let finishReopen: ((value: null) => void) | undefined;
    const setMonth = vi.fn<FinanceViewState['setMonth']>().mockReturnValue(
      new Promise<null>((resolve) => {
        finishReopen = resolve;
      }),
    );
    const onClose = vi.fn();
    render(
      <TransactionDialog
        state={{ ...state, setMonth }}
        finance={{ ...finance, closedMonths: ['2026-09'] }}
        transaction={transactionA}
        onClose={onClose}
      />,
    );
    fireEvent.click(screen.getByRole('button', { name: 'Reopen to correct' }));
    expect(screen.getByRole('button', { name: 'Cancel' })).toBeDisabled();
    fireEvent.click(screen.getByRole('button', { name: 'Saving transaction' }));
    expect(onClose).not.toHaveBeenCalled();
    finishReopen?.(null);
    await waitFor(() => {
      expect(screen.getByRole('button', { name: 'Save changes' })).toBeEnabled();
    });
  });
  it('retains an archived account and category on an old record', () => {
    const historical = { ...transactionA, lineId: line.id };
    render(
      <TransactionDialog
        state={state}
        finance={{
          ...finance,
          accounts: finance.accounts.map((account) => ({ ...account, archived: true })),
          lines: [{ ...line, archived: true }],
        }}
        transaction={historical}
        onClose={() => undefined}
      />,
    );
    expect(screen.getByLabelText('Account')).toHaveValue(accountId);
    expect(screen.getByRole('option', { name: 'Everyday card (archived)' })).toBeInTheDocument();
    expect(screen.getByLabelText('Budget line')).toHaveValue(line.id);
    expect(screen.getByRole('option', { name: 'Groceries (archived)' })).toBeInTheDocument();
  });
});
