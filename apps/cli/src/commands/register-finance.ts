import type { Command } from 'commander';
import * as financeCommands from './finance.ts';
import { collectOption } from './program-support.ts';
import { type Act } from './shared.ts';

export function registerFinanceCommands(program: Command, act: Act): void {
  const money = program
    .command('finance')
    .description('Set up a finance root, record against it, and read what Core derives.');

  money
    .command('setup <rootId>')
    .description('Make an item a finance root, or change its settings.')
    .requiredOption('--currency <code>', 'three-letter ISO code, for example GBP')
    .requiredOption('--start-month <yyyy-mm>', 'first planned month')
    .option('--horizon <months>', 'months to plan', '17')
    .option('--opening-cash <amount>', 'cash the day before the start month', '0')
    .option('--emergency-months <months>', 'months of outgoings to hold', '3')
    .option('--timezone <iana>', 'where today is decided', 'Europe/London')
    .action((rootId: string, options: financeCommands.SetupOptions, command: Command) =>
      act(command, (profile, output) => financeCommands.setup(profile, rootId, options, output)),
    );

  money
    .command('get <rootId>')
    .description('Read settings, accounts, budget lines and closed months.')
    .action((rootId: string, _options: unknown, command: Command) =>
      act(command, (profile, output) => financeCommands.get(profile, rootId, output)),
    );

  const accountFlags = (target: Command): Command =>
    target
      .requiredOption('--name <name>', 'account name')
      .requiredOption('--type <type>', 'current, savings, debit, credit_card or loan')
      .option('--limit <amount>', 'credit limit')
      .option('--opening <amount>', 'balance carried into the start month')
      .option('--settles-from <accountId>', 'the account a card is paid from')
      .option('--apr <percent>', 'annual rate for a loan, for example 11')
      .option('--payment <amount>', 'standard monthly payment for a loan')
      .option('--overpayment <amount>', 'extra paid each month on a loan')
      .option('--target <amount>', 'savings target')
      .option('--archived', 'keep for history only');

  accountFlags(money.command('account-add <rootId>').description('Add an account.')).action(
    (rootId: string, options: financeCommands.AccountOptions, command: Command) =>
      act(command, (profile, output) =>
        financeCommands.addAccount(profile, rootId, options, output),
      ),
  );

  accountFlags(
    money.command('account-set <rootId> <accountId>').description('Change an account.'),
  ).action(
    (
      rootId: string,
      accountId: string,
      options: financeCommands.AccountOptions,
      command: Command,
    ) =>
      act(command, (profile, output) =>
        financeCommands.setAccount(profile, rootId, accountId, options, output),
      ),
  );

  const lineFlags = (target: Command): Command =>
    target
      .requiredOption('--name <name>', 'line name, for example Rent')
      .requiredOption('--section <section>', 'heading, for example Housing')
      .requiredOption('--flow <flow>', 'income or expense')
      .requiredOption('--account <accountId>', 'the account it is paid from or into')
      .option('--amount <amount>', 'planned amount each month', '0')
      .option('--scheduled', 'leaves on its own; post it from the plan')
      .option('--due-day <day>', 'day of the month a scheduled line goes out')
      .option('--loan-account <accountId>', 'plan the instalment of this loan instead')
      .option(
        '--override <yyyy-mm=amount>',
        'a different plan for one month, repeatable',
        collectOption,
        [],
      )
      .option('--archived', 'plan no further');

  lineFlags(money.command('line-add <rootId>').description('Add a budget line.')).action(
    (rootId: string, options: financeCommands.LineOptions, command: Command) =>
      act(command, (profile, output) => financeCommands.addLine(profile, rootId, options, output)),
  );

  lineFlags(
    money.command('line-set <rootId> <lineId>').description('Change a budget line.'),
  ).action(
    (rootId: string, lineId: string, options: financeCommands.LineOptions, command: Command) =>
      act(command, (profile, output) =>
        financeCommands.setLine(profile, rootId, lineId, options, output),
      ),
  );

  money
    .command('add <rootId>')
    .description('Record a transaction; a negative amount left the account.')
    .requiredOption('--amount <amount>', 'signed cash effect, for example -12.40')
    .requiredOption('--description <text>', 'payee or what it was for')
    .requiredOption('--account <accountId>', 'the account it moved on')
    .option('--line <lineId>', 'budget line it counts against')
    .option('--date <yyyy-mm-dd>', 'day it happened; defaults to today')
    .option('--cleared', 'seen on a statement')
    .action((rootId: string, options: financeCommands.AddOptions, command: Command) =>
      act(command, (profile, output) => financeCommands.add(profile, rootId, options, output)),
    );

  money
    .command('transaction-set <rootId> <transactionId>')
    .description('Replace a transaction under a finance root.')
    .requiredOption('--amount <amount>', 'signed cash effect, for example -12.40')
    .requiredOption('--description <text>', 'payee or what it was for')
    .requiredOption('--account <accountId>', 'the account it moved on')
    .requiredOption('--date <yyyy-mm-dd>', 'day it happened')
    .option('--line <lineId>', 'budget line it counts against')
    .option('--unassigned', 'remove its budget line assignment')
    .requiredOption('--cleared <true|false>', 'whether it has been seen on a statement')
    .action(
      (
        rootId: string,
        transactionId: string,
        options: financeCommands.SetTransactionOptions,
        command: Command,
      ) =>
        act(command, (profile, output) =>
          financeCommands.setTransaction(profile, rootId, transactionId, options, output),
        ),
    );

  money
    .command('transactions <rootId>')
    .description('List transactions, newest first.')
    .option('--month <yyyy-mm>', 'only this month')
    .option('--account <accountId>', 'only this account')
    .option('--line <lineId>', 'only this budget line')
    .option('--unassigned', 'only those with no budget line')
    .option('--limit <count>', 'at most this many')
    .option('--offset <count>', 'skip this many matching records')
    .option('--transaction <transactionId>', 'only this transaction')
    .option('--from <yyyy-mm-dd>', 'history start date, inclusive')
    .option('--to <yyyy-mm-dd>', 'history end date, inclusive')
    .option('--search <text>', 'search descriptions')
    .option('--source <source>', 'manual, scheduled or import')
    .option('--min-amount <amount>', 'minimum amount magnitude')
    .option('--max-amount <amount>', 'maximum amount magnitude')
    .action((rootId: string, options: financeCommands.TransactionsOptions, command: Command) =>
      act(command, (profile, output) =>
        financeCommands.transactions(profile, rootId, options, output),
      ),
    );

  money
    .command('budget <rootId>')
    .description('Lines by month with plan, actual and variance.')
    .option('--from <yyyy-mm>', 'first month; defaults to the current month')
    .option('--to <yyyy-mm>', 'last month; defaults to --from')
    .option('--account <accountId>', "only this account's lines, with its own totals")
    .action(
      (
        rootId: string,
        options: { from?: string; to?: string; account?: string },
        command: Command,
      ) =>
        act(command, (profile, output) => financeCommands.budget(profile, rootId, options, output)),
    );

  money
    .command('actual <rootId> <lineId> <month>')
    .description(
      "Bring a line's actual for a month to an amount; Core records the transaction that gets it there.",
    )
    .requiredOption('--amount <amount>', "the total, zero or more, in the line's own direction")
    .option('--description <text>', 'what to call the transaction; defaults to the line name')
    .option('--date <yyyy-mm-dd>', 'day to record it on, inside the month')
    .action(
      (
        rootId: string,
        lineId: string,
        value: string,
        options: financeCommands.ActualOptions,
        command: Command,
      ) =>
        act(command, (profile, output) =>
          financeCommands.actual(profile, rootId, lineId, value, options, output),
        ),
    );

  money
    .command('transaction-delete <rootId> <transactionId>')
    .description('Delete a transaction in an open month; it can be restored like any item.')
    .action((rootId: string, transactionId: string, command: Command) =>
      act(command, (profile, output) =>
        financeCommands.deleteTransaction(profile, rootId, transactionId, output),
      ),
    );

  money
    .command('accounts <rootId>')
    .description('Every account with the figure that matters for it in a month.')
    .option('--month <yyyy-mm>', 'defaults to the current month')
    .action((rootId: string, options: { month?: string }, command: Command) =>
      act(command, (profile, output) => financeCommands.accounts(profile, rootId, options, output)),
    );

  money
    .command('loan <rootId> <accountId>')
    .description('A loan schedule, and what a different overpayment buys.')
    .option('--overpayment <amount>', 'try this overpayment each month')
    .action(
      (rootId: string, accountId: string, options: { overpayment?: string }, command: Command) =>
        act(command, (profile, output) =>
          financeCommands.loan(profile, rootId, accountId, options, output),
        ),
    );

  money
    .command('cashflow <rootId>')
    .description('Cash month by month across the horizon.')
    .action((rootId: string, _options: unknown, command: Command) =>
      act(command, (profile, output) => financeCommands.cashFlow(profile, rootId, output)),
    );

  money
    .command('dashboard <rootId>')
    .description("The month's position, cards, loans, what to watch and what is due soon.")
    .option('--month <yyyy-mm>', 'defaults to the current month')
    .action((rootId: string, options: { month?: string }, command: Command) =>
      act(command, (profile, output) =>
        financeCommands.dashboard(profile, rootId, options, output),
      ),
    );

  money
    .command('month <rootId> <month>')
    .description('Read what closing a month would leave open, or close or reopen it.')
    .option('--close', 'close the month')
    .option('--reopen', 'reopen the month')
    .action(
      (
        rootId: string,
        value: string,
        options: { close?: boolean; reopen?: boolean },
        command: Command,
      ) =>
        act(command, (profile, output) =>
          financeCommands.month(profile, rootId, value, options, output),
        ),
    );

  money
    .command('post <rootId> <month>')
    .description("Post every scheduled line's planned amount for the month, once.")
    .action((rootId: string, value: string, _options: unknown, command: Command) =>
      act(command, (profile, output) =>
        financeCommands.postScheduled(profile, rootId, value, output),
      ),
    );

  money
    .command('import <rootId>')
    .description('Read a bank CSV into an account; previews unless --commit.')
    .requiredOption('--account <accountId>', 'the account the statement is for')
    .requiredOption('--file <path>', 'the CSV file')
    .option('--commit', 'write what the preview would')
    .action((rootId: string, options: financeCommands.ImportOptions, command: Command) =>
      act(command, (profile, output) =>
        financeCommands.importStatement(profile, rootId, options, output),
      ),
    );

  money
    .command('seed <rootId>')
    .description(
      'Set up a root from a plan file: settings, accounts, lines, actuals and month closes.',
    )
    .requiredOption('--file <path>', 'the plan JSON')
    .action((rootId: string, options: { file: string }, command: Command) =>
      act(command, (profile, output) => financeCommands.seed(profile, rootId, options, output)),
    );
}
