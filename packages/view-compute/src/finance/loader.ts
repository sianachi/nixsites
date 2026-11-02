import type { MirrorItem } from '@nix/sync-core/mirror';

import type { ViewAnswer, ViewSource } from '../types';
import { Book } from './book';
import {
  type Account,
  type Containers,
  type Line,
  type Settings,
  type Transaction,
  closedMonths,
  claimsAccount,
  claimsLine,
  claimsTransaction,
  isBag,
  isCard,
  isConfigured,
  isIncome,
  isLoan,
  readAccount,
  readContainers,
  readLine,
  readSettings,
  readTransaction,
} from './records';

export const MAXIMUM_ACCOUNTS = 200;
export const MAXIMUM_LINES = 500;
export const MAXIMUM_TRANSACTIONS = 20_000;

export interface Snapshot {
  root: MirrorItem;
  settings: Settings;
  containers: Containers;
  book: Book;
  problems: string[];
}

/** A finished answer, or null when the synced copy cannot settle it (the caller says so). */
export type Failure = ViewAnswer | null;
export type Loaded = { snapshot: Snapshot } | { failure: Failure };

/** Core's status for a refusal code (FinanceEndpoints.Problem). */
export function refusal(code: string, detail: string): ViewAnswer {
  const status = code.endsWith('not_found')
    ? 404
    : code === 'items.locked'
      ? 423
      : [
            'finance.not_configured',
            'finance.month_closed',
            'finance.limit',
            'items.lifecycle_conflict',
          ].includes(code)
        ? 409
        : 422;
  return { status, code, detail };
}

const fail = (code: string, detail: string): Loaded => ({ failure: refusal(code, detail) });
const bagOf = (item: MirrorItem): Record<string, unknown> =>
  isBag(item.properties) ? item.properties : {};

/** Reads a finance root and everything under it from the synced copy (FinanceLoader.LoadAsync). */
export async function loadFinance(source: ViewSource, rootId: string): Promise<Loaded> {
  const root = await source.item(rootId);
  if (root?.lifecycleState !== 'active')
    return fail('items.not_found', 'No such finance root is visible and accessible.');
  const bag = bagOf(root);
  const settings = readSettings(bag);
  if (settings === null)
    return fail(
      isConfigured(bag) ? 'finance.invalid_settings' : 'finance.not_configured',
      'This item has no valid finance settings. Set them up first.',
    );
  const containers = readContainers(bag);
  if (containers === null)
    return fail(
      'finance.not_configured',
      'This finance root has lost its containers. Set it up again.',
    );

  const ids = [containers.accounts, containers.lines, containers.transactions];
  if (new Set(ids).size !== ids.length)
    return fail(
      'finance.not_configured',
      'This finance root has invalid containers. Set it up again.',
    );
  const everything = await source.workspaceItems(root.workspaceId);
  const byId = new Map(everything.map((item) => [item.id, item]));
  for (const id of ids) {
    const container = byId.get(id);
    if (container?.parentId !== root.id)
      return fail(
        'finance.not_configured',
        'This finance root has lost its containers. Set them up again.',
      );
    // A locked container withholds its figures; Core says which lock, so ask Core.
    if (container.locked) return { failure: null };
  }
  if (root.locked) return { failure: null };

  const childrenOf = (container: string, ceiling: number, what: string): MirrorItem[] | Loaded => {
    const children = everything.filter((item) => item.parentId === container);
    return children.length > ceiling
      ? fail(
          'finance.limit',
          `This version supports at most ${ceiling.toLocaleString('en-US')} ${what} per finance root. Its figures cannot be calculated safely.`,
        )
      : children;
  };
  const accountItems = childrenOf(containers.accounts, MAXIMUM_ACCOUNTS, 'accounts');
  if (!Array.isArray(accountItems)) return accountItems;
  const lineItems = childrenOf(containers.lines, MAXIMUM_LINES, 'budget lines');
  if (!Array.isArray(lineItems)) return lineItems;
  const transactionItems = childrenOf(
    containers.transactions,
    MAXIMUM_TRANSACTIONS,
    'transactions',
  );
  if (!Array.isArray(transactionItems)) return transactionItems;

  const problems: string[] = [];
  let accounts: Account[] = [];
  for (const item of accountItems) {
    const account = readAccount(item.id, item.title, bagOf(item));
    if (account !== null) accounts.push(account);
    else if (claimsAccount(bagOf(item)))
      problems.push(`Account '${item.title}' (${item.id}) could not be read.`);
  }
  let accountsById = new Map(accounts.map((a) => [a.id, a]));
  for (const account of [...accounts]) {
    const from = account.settlesFrom === null ? undefined : accountsById.get(account.settlesFrom);
    if (account.settlesFrom !== null && (from === undefined || isCard(from) || isLoan(from))) {
      accounts = accounts.filter((a) => a !== account);
      problems.push(
        `Account '${account.name}' (${account.id}) names a settlement account outside this finance root or with an unsupported type.`,
      );
    }
  }
  accountsById = new Map(accounts.map((a) => [a.id, a]));

  let lines: Line[] = [];
  for (const item of lineItems) {
    const line = readLine(item.id, item.title, BigInt(item.seq), bagOf(item));
    if (line !== null) lines.push(line);
    else if (claimsLine(bagOf(item)))
      problems.push(`Budget line '${item.title}' (${item.id}) could not be read.`);
  }
  for (const line of [...lines]) {
    const account = accountsById.get(line.accountId);
    const loan = line.loanAccount === null ? undefined : accountsById.get(line.loanAccount);
    if (
      account === undefined ||
      isLoan(account) ||
      (isIncome(line) && isCard(account)) ||
      (line.loanAccount !== null && (loan === undefined || !isLoan(loan)))
    ) {
      lines = lines.filter((l) => l !== line);
      problems.push(
        `Budget line '${line.name}' (${line.id}) names an account outside this finance root or with an unsupported type.`,
      );
    }
  }
  const linesById = new Map(lines.map((l) => [l.id, l]));

  const transactions: Transaction[] = [];
  for (const item of transactionItems) {
    const transaction = readTransaction(item.id, item.title, bagOf(item));
    const account = transaction === null ? undefined : accountsById.get(transaction.accountId);
    const line = transaction?.lineId == null ? undefined : linesById.get(transaction.lineId);
    if (
      transaction !== null &&
      account !== undefined &&
      !isLoan(account) &&
      (transaction.lineId === null || line?.accountId === transaction.accountId)
    )
      transactions.push(transaction);
    else if (claimsTransaction(bagOf(item)))
      problems.push(
        `Transaction '${item.title}' (${item.id}) could not be read or names an account or line outside this finance root.`,
      );
  }
  const closed = Object.hasOwn(bag, '$fin_closed_months') ? closedMonths(bag) : null;
  if (closed === null)
    return fail(
      'finance.invalid_closed_months',
      'The list of closed months is damaged. Correct it before reading or changing this finance root.',
    );
  return {
    snapshot: {
      root,
      settings,
      containers,
      book: new Book(settings, accounts, lines, transactions, closed),
      problems,
    },
  };
}
