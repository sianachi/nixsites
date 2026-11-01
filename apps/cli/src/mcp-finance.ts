import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { z } from 'zod';
import { finance } from '@nix/api-client';
import {
  identifier,
  financeMonthInput,
  financeMoneyInput,
  financeAccountInput,
  financeLineInput,
  financeTransactionInput,
  toolResult,
} from './mcp-support.ts';
import type { McpToolDeps } from './mcp-support.ts';

export function registerFinanceTools(server: McpServer, { session }: McpToolDeps): void {
  server.registerTool(
    'read_finance',
    {
      description: 'Read a finance root: settings, accounts, budget lines and closed months.',
      inputSchema: { rootId: identifier },
    },
    ({ rootId }) =>
      toolResult(async () => (await session()).client.query(finance.readFinance(rootId))),
  );

  server.registerTool(
    'set_finance_settings',
    {
      description: 'Set the currency, planning window, opening cash and emergency fund target.',
      inputSchema: {
        rootId: identifier,
        currency: z.string().trim().length(3),
        startMonth: financeMonthInput,
        horizonMonths: z.number().int().min(1).max(120),
        openingCash: financeMoneyInput,
        emergencyFundMonths: z.number().min(0).max(36),
        timezone: z.string().trim().min(1).max(128),
      },
    },
    ({ rootId, currency, startMonth, horizonMonths, openingCash, emergencyFundMonths, timezone }) =>
      toolResult(async () =>
        (await session()).client.execute(
          finance.setSettings(rootId, {
            currency,
            startMonth,
            horizonMonths,
            openingCash,
            emergencyFundMonths,
            timezone,
          }),
        ),
      ),
  );

  server.registerTool(
    'read_finance_accounts',
    {
      description: 'Read account balances, card cycles and loan summaries for a month.',
      inputSchema: { rootId: identifier, month: financeMonthInput.optional() },
    },
    ({ rootId, month }) =>
      toolResult(async () => (await session()).client.query(finance.readAccounts(rootId, month))),
  );

  server.registerTool(
    'create_finance_account',
    {
      description: 'Add a current, savings, debit, credit card or loan account.',
      inputSchema: { rootId: identifier, ...financeAccountInput },
    },
    ({ rootId, ...account }) =>
      toolResult(async () =>
        (await session()).client.execute(finance.createAccount(rootId, account)),
      ),
  );

  server.registerTool(
    'set_finance_account',
    {
      description: 'Replace the settings for an account under a finance root.',
      inputSchema: { rootId: identifier, accountId: identifier, ...financeAccountInput },
    },
    ({ rootId, accountId, ...account }) =>
      toolResult(async () =>
        (await session()).client.execute(finance.setAccount(rootId, accountId, account)),
      ),
  );

  server.registerTool(
    'finance_loan',
    {
      description: 'Read a loan payoff schedule and compare an alternative monthly overpayment.',
      inputSchema: {
        rootId: identifier,
        accountId: identifier,
        overpayment: financeMoneyInput.nonnegative().optional(),
      },
    },
    ({ rootId, accountId, overpayment }) =>
      toolResult(async () =>
        (await session()).client.query(finance.readLoan(rootId, accountId, overpayment)),
      ),
  );

  server.registerTool(
    'create_finance_line',
    {
      description: 'Add an income or expense line to the finance plan.',
      inputSchema: { rootId: identifier, ...financeLineInput },
    },
    ({ rootId, ...line }) =>
      toolResult(async () => (await session()).client.execute(finance.createLine(rootId, line))),
  );

  server.registerTool(
    'set_finance_line',
    {
      description: 'Replace a budget line under a finance root.',
      inputSchema: { rootId: identifier, lineId: identifier, ...financeLineInput },
    },
    ({ rootId, lineId, ...line }) =>
      toolResult(async () =>
        (await session()).client.execute(finance.setLine(rootId, lineId, line)),
      ),
  );

  server.registerTool(
    'finance_dashboard',
    {
      description:
        "A finance root's month: net, position, cards, loans, what to watch and what is due.",
      inputSchema: {
        rootId: identifier,
        month: financeMonthInput.optional(),
      },
    },
    ({ rootId, month }) =>
      toolResult(async () => (await session()).client.query(finance.readDashboard(rootId, month))),
  );

  server.registerTool(
    'finance_budget',
    {
      description:
        'Budget lines by month with plan, actual and variance; defaults to the current month.',
      inputSchema: {
        rootId: identifier,
        from: financeMonthInput.optional(),
        to: financeMonthInput.optional(),
        accountId: identifier.optional(),
      },
    },
    ({ rootId, from, to, accountId }) =>
      toolResult(async () =>
        (await session()).client.query(finance.readBudget(rootId, from, to, accountId)),
      ),
  );

  server.registerTool(
    'set_finance_actual',
    {
      description:
        "Bring a budget line's actual for a month to an amount. Core records the one transaction that gets it there: the whole amount when nothing is recorded yet, otherwise an adjustment for the difference.",
      inputSchema: {
        rootId: identifier,
        lineId: identifier,
        month: financeMonthInput,
        amount: financeMoneyInput.nonnegative(),
        description: z.string().trim().min(1).max(200).nullable().default(null),
        date: z.iso.date().nullable().default(null),
      },
    },
    ({ rootId, lineId, month, amount, description, date }) =>
      toolResult(async () =>
        (await session()).client.execute(
          finance.setActual(rootId, lineId, month, { amount, description, date }),
        ),
      ),
  );

  server.registerTool(
    'delete_finance_transaction',
    {
      description: 'Delete a transaction in an open month; it can be restored like any item.',
      inputSchema: { rootId: identifier, transactionId: identifier },
    },
    ({ rootId, transactionId }) =>
      toolResult(async () => {
        await (await session()).client.execute(finance.deleteTransaction(rootId, transactionId));
        return { deleted: transactionId };
      }),
  );

  server.registerTool(
    'add_finance_transaction',
    {
      description:
        'Record a transaction on a finance root. Amount is the cash effect: negative left the account.',
      inputSchema: {
        rootId: identifier,
        ...financeTransactionInput,
      },
    },
    ({ rootId, ...transaction }) =>
      toolResult(async () =>
        (await session()).client.execute(finance.createTransaction(rootId, transaction)),
      ),
  );

  server.registerTool(
    'list_finance_transactions',
    {
      description: 'Search transaction history with full-match totals and bounded pages.',
      inputSchema: {
        rootId: identifier,
        month: financeMonthInput.optional(),
        accountId: identifier.optional(),
        transactionId: identifier.optional(),
        lineId: identifier.optional(),
        unassigned: z.boolean().default(false),
        limit: z.number().int().min(1).max(1000).optional(),
        offset: z.number().int().min(0).max(20_000).optional(),
        from: z.iso.date().optional(),
        to: z.iso.date().optional(),
        search: z.string().max(200).optional(),
        source: z.enum(['manual', 'scheduled', 'import']).optional(),
        minAmount: z.number().nonnegative().optional(),
        maxAmount: z.number().nonnegative().optional(),
      },
    },
    ({
      rootId,
      month,
      accountId,
      transactionId,
      lineId,
      unassigned,
      limit,
      offset,
      from,
      to,
      search,
      source,
      minAmount,
      maxAmount,
    }) =>
      toolResult(async () =>
        (await session()).client.query(
          finance.listTransactions(rootId, {
            ...(month === undefined ? {} : { month }),
            ...(accountId === undefined ? {} : { accountId }),
            ...(transactionId === undefined ? {} : { transactionId }),
            ...(lineId === undefined ? {} : { lineId }),
            ...(unassigned ? { unassigned } : {}),
            ...(limit === undefined ? {} : { limit }),
            ...(offset === undefined ? {} : { offset }),
            ...(from === undefined ? {} : { from }),
            ...(to === undefined ? {} : { to }),
            ...(search === undefined ? {} : { search }),
            ...(source === undefined ? {} : { source }),
            ...(minAmount === undefined ? {} : { minAmount }),
            ...(maxAmount === undefined ? {} : { maxAmount }),
          }),
        ),
      ),
  );

  server.registerTool(
    'set_finance_transaction',
    {
      description: 'Replace a transaction on a finance root.',
      inputSchema: {
        rootId: identifier,
        transactionId: identifier,
        ...financeTransactionInput,
      },
    },
    ({ rootId, transactionId, ...transaction }) =>
      toolResult(async () =>
        (await session()).client.execute(
          finance.setTransaction(rootId, transactionId, transaction),
        ),
      ),
  );

  server.registerTool(
    'post_finance_scheduled',
    {
      description: "Post every scheduled budget line's planned amount for a month, once.",
      inputSchema: { rootId: identifier, month: financeMonthInput },
    },
    ({ rootId, month }) =>
      toolResult(async () =>
        (await session()).client.execute(finance.postScheduled(rootId, month)),
      ),
  );

  server.registerTool(
    'set_finance_month',
    {
      description: 'Close or reopen a month on a finance root.',
      inputSchema: {
        rootId: identifier,
        month: financeMonthInput,
        closed: z.boolean(),
      },
    },
    ({ rootId, month, closed }) =>
      toolResult(async () =>
        (await session()).client.execute(finance.setMonth(rootId, month, closed)),
      ),
  );

  server.registerTool(
    'finance_cashflow',
    {
      description: 'Read projected and actual cash month by month across the finance horizon.',
      inputSchema: { rootId: identifier },
    },
    ({ rootId }) =>
      toolResult(async () => (await session()).client.query(finance.readCashFlow(rootId))),
  );

  server.registerTool(
    'finance_month',
    {
      description: 'Read the checklist, totals and outstanding scheduled lines for a month.',
      inputSchema: { rootId: identifier, month: financeMonthInput },
    },
    ({ rootId, month }) =>
      toolResult(async () => (await session()).client.query(finance.readMonth(rootId, month))),
  );

  server.registerTool(
    'import_finance_statement',
    {
      description: 'Preview or commit bank statement CSV contents for an account.',
      inputSchema: {
        rootId: identifier,
        accountId: identifier,
        csv: z.string().min(1).max(1_048_576),
        commit: z.boolean().default(false),
      },
    },
    ({ rootId, accountId, csv, commit }) =>
      toolResult(async () =>
        (await session()).client.execute(
          finance.importStatement(rootId, { accountId, csv, commit }),
        ),
      ),
  );
}
