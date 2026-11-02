import { type Month, dayNumber, monthYear, parseMonth, validZone } from './dates';
import { type Dec, ZERO, decOf, hasPlaces, isAmount } from './dec';

/** Core's FinanceJson, Finance* records and their validation, over a stored property bag. */

export type Bag = Record<string, unknown>;

export const isBag = (value: unknown): value is Bag =>
  typeof value === 'object' && value !== null && !Array.isArray(value);

const has = (bag: Bag, key: string): boolean => Object.hasOwn(bag, key) && bag[key] !== null;
const text = (bag: Bag, key: string): string | null =>
  typeof bag[key] === 'string' ? bag[key] : null;
const amount = (bag: Bag, key: string): Dec | null => decOf(bag[key]);
const bool = (bag: Bag, key: string): boolean | null =>
  typeof bag[key] === 'boolean' ? bag[key] : null;
const GUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const id = (bag: Bag, key: string): string | null => {
  const value = text(bag, key);
  return value !== null && GUID.test(value) ? value.toLowerCase() : null;
};
const date = (bag: Bag, key: string): string | null => {
  const value = text(bag, key);
  return value !== null && dayNumber(value) !== null ? value : null;
};
const month = (bag: Bag, key: string): Month | null => parseMonth(text(bag, key));
function whole(bag: Bag, key: string): number | null {
  const value = amount(bag, key);
  if (value === null || !hasPlaces(value, 0)) return null;
  const n = Number(value / 10n ** 12n);
  return n >= -(2 ** 31) && n < 2 ** 31 ? n : null;
}

/** A `{"yyyy-MM": amount}` object; one bad member makes the whole map null. */
function monthAmounts(bag: Bag, key: string): Map<Month, Dec> | null {
  if (!has(bag, key)) return new Map();
  const map = bag[key];
  if (!isBag(map)) return null;
  const result = new Map<Month, Dec>();
  for (const [name, node] of Object.entries(map)) {
    const parsed = parseMonth(name);
    const value = decOf(node);
    if (parsed === null || value === null || !isAmount(value)) return null;
    result.set(parsed, value);
  }
  return result;
}

/** An array of `yyyy-MM` strings; one bad member makes the list null. */
export function closedMonths(bag: Bag): Month[] | null {
  if (!Object.hasOwn(bag, '$fin_closed_months')) return [];
  const array = bag.$fin_closed_months;
  if (!Array.isArray(array)) return null;
  const months: Month[] = [];
  for (const node of array) {
    const parsed = typeof node === 'string' ? parseMonth(node) : null;
    if (parsed === null) return null;
    months.push(parsed);
  }
  return months;
}

const blank = (value: string): boolean => value.trim() === '';

export interface Settings {
  currency: string;
  startMonth: Month;
  horizonMonths: number;
  openingCash: Dec;
  emergencyFundMonths: Dec;
  timezone: string;
}

export const endMonth = (s: Settings): Month => s.startMonth + s.horizonMonths - 1;

function validateSettings(s: Settings): boolean {
  return (
    /^[A-Z]{3}$/.test(s.currency) &&
    s.horizonMonths >= 1 &&
    s.horizonMonths <= 120 &&
    monthYear(s.startMonth) >= 1970 &&
    monthYear(s.startMonth) <= 2200 &&
    isAmount(s.openingCash) &&
    s.emergencyFundMonths >= 0n &&
    s.emergencyFundMonths <= 36n * 10n ** 12n &&
    hasPlaces(s.emergencyFundMonths, 1) &&
    !blank(s.timezone) &&
    s.timezone.length <= 128 &&
    validZone(s.timezone)
  );
}

export function readSettings(bag: Bag): Settings | null {
  const currency = text(bag, '$fin_currency');
  const startMonth = month(bag, '$fin_start_month');
  const horizonMonths = whole(bag, '$fin_horizon_months');
  const openingCash = amount(bag, '$fin_opening_cash');
  const emergencyFundMonths = amount(bag, '$fin_emergency_months');
  const timezone = text(bag, '$fin_timezone');
  if (
    currency === null ||
    startMonth === null ||
    horizonMonths === null ||
    openingCash === null ||
    emergencyFundMonths === null ||
    timezone === null
  )
    return null;
  const settings = {
    currency,
    startMonth,
    horizonMonths,
    openingCash,
    emergencyFundMonths,
    timezone,
  };
  return validateSettings(settings) ? settings : null;
}

export const isConfigured = (bag: Bag): boolean => has(bag, '$fin_currency');

export interface Containers {
  accounts: string;
  lines: string;
  transactions: string;
}

export function readContainers(bag: Bag): Containers | null {
  const accounts = id(bag, '$fin_accounts_id');
  const lines = id(bag, '$fin_lines_id');
  const transactions = id(bag, '$fin_transactions_id');
  return accounts === null || lines === null || transactions === null
    ? null
    : { accounts, lines, transactions };
}

export interface Account {
  id: string;
  name: string;
  type: string;
  limit: Dec | null;
  openingBalance: Dec;
  settlesFrom: string | null;
  apr: Dec | null;
  payment: Dec | null;
  overpayment: Dec | null;
  target: Dec | null;
  archived: boolean;
}

export const isCard = (account: Account): boolean => account.type === 'credit_card';
export const isLoan = (account: Account): boolean => account.type === 'loan';
export const instalment = (account: Account): Dec =>
  (account.payment ?? ZERO) + (account.overpayment ?? ZERO);

function validAccount(a: Account): boolean {
  if (blank(a.name) || a.name.length > 120) return false;
  if (!['current', 'savings', 'debit', 'credit_card', 'loan'].includes(a.type)) return false;
  if (!isAmount(a.openingBalance) || (a.type !== 'current' && a.openingBalance < 0n)) return false;
  if (a.limit !== null && (!isAmount(a.limit) || a.limit <= 0n)) return false;
  if (!isCard(a) && a.limit !== null) return false;
  if (a.target !== null && (!isAmount(a.target) || a.target <= 0n)) return false;
  if (a.target !== null && a.type !== 'savings') return false;
  if (isCard(a) && a.settlesFrom === null) return false;
  if (!isCard(a) && a.settlesFrom !== null) return false;
  if (a.settlesFrom === a.id) return false;
  if (isLoan(a)) {
    if (a.apr === null || a.apr < 0n || a.apr > 2n * 10n ** 12n || !hasPlaces(a.apr, 6))
      return false;
    if (a.payment === null || !isAmount(a.payment) || a.payment <= 0n) return false;
    if (a.overpayment !== null && (!isAmount(a.overpayment) || a.overpayment < 0n)) return false;
  } else if (a.apr !== null || a.payment !== null || a.overpayment !== null) return false;
  return true;
}

const claims = (bag: Bag, kind: string): boolean => text(bag, '$fin_kind') === kind;
export const claimsAccount = (bag: Bag): boolean => claims(bag, 'account');
export const claimsLine = (bag: Bag): boolean => claims(bag, 'line');
export const claimsTransaction = (bag: Bag): boolean => claims(bag, 'transaction');

export function readAccount(itemId: string, name: string, bag: Bag): Account | null {
  if (!claimsAccount(bag)) return null;
  const type = text(bag, '$fin_account_type');
  const opening = amount(bag, '$fin_opening_balance');
  if (type === null || opening === null) return null;
  const optional = (key: string): Dec | null | undefined =>
    has(bag, key) ? (amount(bag, key) ?? undefined) : null;
  const limit = optional('$fin_limit');
  const apr = optional('$fin_apr');
  const payment = optional('$fin_payment');
  const overpayment = optional('$fin_overpayment');
  const target = optional('$fin_target');
  const settlesFrom = has(bag, '$fin_settles_from') ? id(bag, '$fin_settles_from') : null;
  if (
    limit === undefined ||
    apr === undefined ||
    payment === undefined ||
    overpayment === undefined ||
    target === undefined ||
    (has(bag, '$fin_settles_from') && settlesFrom === null)
  )
    return null;
  const account: Account = {
    id: itemId,
    name,
    type,
    limit,
    openingBalance: opening,
    settlesFrom,
    apr,
    payment,
    overpayment,
    target,
    archived: bool(bag, '$fin_archived') ?? false,
  };
  return validAccount(account) ? account : null;
}

export interface Line {
  id: string;
  name: string;
  section: string;
  flow: string;
  accountId: string;
  amount: Dec;
  overrides: Map<Month, Dec>;
  scheduled: boolean;
  dueDay: number | null;
  loanAccount: string | null;
  archived: boolean;
  position: bigint;
}

export const isIncome = (line: Line): boolean => line.flow === 'income';

function validLine(l: Line): boolean {
  if (blank(l.name) || l.name.length > 120) return false;
  if (blank(l.section) || l.section.length > 60) return false;
  if (!isIncome(l) && l.flow !== 'expense') return false;
  if (!isAmount(l.amount) || l.amount < 0n) return false;
  if (l.overrides.size > 240 || [...l.overrides.values()].some((v) => !isAmount(v) || v < 0n))
    return false;
  if (l.dueDay !== null && (l.dueDay < 1 || l.dueDay > 31)) return false;
  if (l.scheduled && l.dueDay === null) return false;
  if (l.loanAccount !== null && isIncome(l)) return false;
  return true;
}

export function readLine(itemId: string, name: string, position: bigint, bag: Bag): Line | null {
  if (!claimsLine(bag)) return null;
  const section = text(bag, '$fin_section');
  const flow = text(bag, '$fin_flow');
  const accountId = id(bag, '$fin_account');
  const planned = amount(bag, '$fin_amount');
  const overrides = monthAmounts(bag, '$fin_overrides');
  if (
    section === null ||
    flow === null ||
    accountId === null ||
    planned === null ||
    overrides === null ||
    (has(bag, '$fin_due_day') && whole(bag, '$fin_due_day') === null) ||
    (has(bag, '$fin_loan_account') && id(bag, '$fin_loan_account') === null)
  )
    return null;
  const line: Line = {
    id: itemId,
    name,
    section,
    flow,
    accountId,
    amount: planned,
    overrides,
    scheduled: bool(bag, '$fin_scheduled') ?? false,
    dueDay: whole(bag, '$fin_due_day'),
    loanAccount: id(bag, '$fin_loan_account'),
    archived: bool(bag, '$fin_archived') ?? false,
    position,
  };
  return validLine(line) ? line : null;
}

export interface Transaction {
  id: string;
  description: string;
  date: string;
  amount: Dec;
  accountId: string;
  lineId: string | null;
  source: string;
  postedFor: Month | null;
  importKey: string | null;
  cleared: boolean;
}

export const transactionMonth = (t: Transaction): Month => parseMonth(t.date.slice(0, 7)) ?? 0;

function validTransaction(t: Transaction): boolean {
  if (blank(t.description) || t.description.length > 200) return false;
  if (!isAmount(t.amount) || t.amount === ZERO) return false;
  const year = Number(t.date.slice(0, 4));
  if (year < 1970 || year > 2200) return false;
  if (!['manual', 'scheduled', 'import'].includes(t.source)) return false;
  if ((t.source === 'scheduled') !== (t.postedFor !== null)) return false;
  if (t.postedFor !== null && t.lineId === null) return false;
  if (t.postedFor !== null && t.postedFor !== transactionMonth(t)) return false;
  if (t.importKey !== null && (t.importKey.length === 0 || t.importKey.length > 64)) return false;
  return true;
}

export function readTransaction(itemId: string, description: string, bag: Bag): Transaction | null {
  if (!claimsTransaction(bag)) return null;
  const day = date(bag, '$fin_date');
  const cash = amount(bag, '$fin_amount');
  const accountId = id(bag, '$fin_account');
  if (
    day === null ||
    cash === null ||
    accountId === null ||
    (has(bag, '$fin_line') && id(bag, '$fin_line') === null) ||
    (has(bag, '$fin_posted_for') && month(bag, '$fin_posted_for') === null)
  )
    return null;
  const transaction: Transaction = {
    id: itemId,
    description,
    date: day,
    amount: cash,
    accountId,
    lineId: id(bag, '$fin_line'),
    source: text(bag, '$fin_source') ?? 'manual',
    postedFor: month(bag, '$fin_posted_for'),
    importKey: text(bag, '$fin_import_key'),
    cleared: bool(bag, '$fin_cleared') ?? false,
  };
  return validTransaction(transaction) ? transaction : null;
}
