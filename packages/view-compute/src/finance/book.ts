import type { Month } from './dates';
import { type Dec, ZERO, must, mul, roundMoney, roundRatio, S, sum } from './dec';
import {
  type Account,
  type Line,
  type Settings,
  type Transaction,
  endMonth,
  instalment,
  isCard,
  isIncome,
  isLoan,
  transactionMonth,
} from './records';

/** Core's FinanceBook and the pure calculators over it (grid, cards, loans, cash flow). */

export type Source = 'plan' | 'actual' | 'auto';

export interface Figures {
  income: Dec;
  paid: Dec;
  cards: Dec;
}
export const outgoings = (f: Figures): Dec => f.paid + f.cards;
export const net = (f: Figures): Dec => f.income - outgoings(f);

const key = (a: string | null, m: Month): string => `${a ?? ''}|${String(m)}`;

export class Book {
  readonly lines: readonly Line[];
  readonly accountsById: ReadonlyMap<string, Account>;
  readonly linesById: ReadonlyMap<string, Line>;
  private readonly closed: ReadonlySet<Month>;
  private readonly byLineMonth = new Map<string, { sum: Dec; count: number }>();
  private readonly unassignedOutflow = new Map<string, Dec>();
  private readonly unassignedCardCredit = new Map<string, Dec>();
  private readonly unassignedInflow = new Map<string, Dec>();
  private readonly unassignedCount = new Map<string, number>();

  constructor(
    readonly settings: Settings,
    readonly accounts: readonly Account[],
    lines: readonly Line[],
    readonly transactions: readonly Transaction[],
    closedMonths: readonly Month[],
  ) {
    this.lines = [...lines].sort((a, b) =>
      a.position < b.position ? -1 : a.position > b.position ? 1 : 0,
    );
    this.accountsById = new Map(accounts.map((a) => [a.id, a]));
    this.linesById = new Map(this.lines.map((l) => [l.id, l]));
    this.closed = new Set(closedMonths);
    const add = (map: Map<string, Dec>, k: string, by: Dec) =>
      map.set(k, (map.get(k) ?? ZERO) + by);
    for (const t of transactions) {
      const month = transactionMonth(t);
      const line = t.lineId !== null && this.linesById.has(t.lineId) ? t.lineId : null;
      const running = this.byLineMonth.get(key(line, month)) ?? { sum: ZERO, count: 0 };
      this.byLineMonth.set(key(line, month), {
        sum: running.sum + t.amount,
        count: running.count + 1,
      });
      if (line !== null) continue;
      const k = key(t.accountId, month);
      this.unassignedCount.set(k, (this.unassignedCount.get(k) ?? 0) + 1);
      if (t.amount < 0n) add(this.unassignedOutflow, k, -t.amount);
      // A positive unassigned card transaction is a refund: it reduces the statement, not the bank.
      else if (this.accountsById.get(t.accountId)?.type === 'credit_card')
        add(this.unassignedCardCredit, k, t.amount);
      else add(this.unassignedInflow, k, t.amount);
    }
  }

  get closedMonths(): Month[] {
    return [...this.closed].sort((a, b) => a - b);
  }
  isClosed = (month: Month): boolean => this.closed.has(month);

  plan(line: Line, month: Month): Dec {
    if (line.archived) return ZERO;
    const loan = line.loanAccount === null ? undefined : this.accountsById.get(line.loanAccount);
    if (loan !== undefined && isLoan(loan)) return instalment(loan);
    return line.overrides.get(month) ?? line.amount;
  }

  actual(line: Line, month: Month): Dec {
    const sum = this.byLineMonth.get(key(line.id, month))?.sum ?? ZERO;
    return isIncome(line) ? sum : -sum;
  }

  transactionCount = (line: Line, month: Month): number =>
    this.byLineMonth.get(key(line.id, month))?.count ?? 0;

  figure(line: Line, month: Month, source: Source): Dec {
    if (source === 'plan') return this.plan(line, month);
    if (source === 'actual') return this.actual(line, month);
    return this.isClosed(month) ? this.actual(line, month) : this.plan(line, month);
  }

  resolve = (source: Source, month: Month): Source =>
    source === 'auto' ? (this.isClosed(month) ? 'actual' : 'plan') : source;

  private total(map: ReadonlyMap<string, Dec>, month: Month, account?: string): Dec {
    if (account !== undefined) return map.get(key(account, month)) ?? ZERO;
    let total = ZERO;
    for (const [k, v] of map) if (k.endsWith(`|${String(month)}`)) total += v;
    return total;
  }
  unassignedOutflowOf = (month: Month, account?: string): Dec =>
    this.total(this.unassignedOutflow, month, account);
  unassignedInflowOf = (month: Month, account?: string): Dec =>
    this.total(this.unassignedInflow, month, account);
  unassignedCountOf(month: Month, account?: string): number {
    if (account !== undefined) return this.unassignedCount.get(key(account, month)) ?? 0;
    return this.byLineMonth.get(key(null, month))?.count ?? 0;
  }
  private cardCredit = (account: string, month: Month): Dec =>
    this.unassignedCardCredit.get(key(account, month)) ?? ZERO;

  linesOn = (accountId: string): Line[] => this.lines.filter((l) => l.accountId === accountId);
  onCard = (line: Line): boolean => {
    const account = this.accountsById.get(line.accountId);
    return account !== undefined && isCard(account);
  };

  cardSpend(card: Account, month: Month, source: Source): Dec {
    const resolved = this.resolve(source, month);
    const lines = sum(
      this.linesOn(card.id).filter((l) => !isIncome(l)),
      (l) => this.figure(l, month, resolved),
    );
    return resolved === 'actual'
      ? lines + this.unassignedOutflowOf(month, card.id) - this.cardCredit(card.id, month)
      : lines;
  }

  figures(month: Month, source: Source, accountId?: string): Figures {
    const resolved = this.resolve(source, month);
    let income = ZERO;
    let paid = ZERO;
    let cards = ZERO;
    for (const line of accountId === undefined ? this.lines : this.linesOn(accountId)) {
      const f = this.figure(line, month, resolved);
      if (isIncome(line)) income += f;
      else if (this.onCard(line)) cards += f;
      else paid += f;
    }
    if (resolved === 'actual')
      for (const account of accountId === undefined
        ? this.accounts
        : this.accounts.filter((a) => a.id === accountId)) {
        income += this.unassignedInflowOf(month, account.id);
        const unassigned = this.unassignedOutflowOf(month, account.id);
        if (isCard(account)) cards += unassigned - this.cardCredit(account.id, month);
        else paid += unassigned;
      }
    return { income, paid, cards };
  }

  get cards(): Account[] {
    return this.accounts.filter((a) => isCard(a) && !a.archived);
  }
  get loans(): Account[] {
    return this.accounts.filter((a) => isLoan(a) && !a.archived);
  }
}

// --- Budget grid -----------------------------------------------------------------------------

export const MAXIMUM_GRID_MONTHS = 36;

export interface Cell {
  month: Month;
  plan: Dec;
  actual: Dec;
  transactions: number;
}

export interface Section {
  name: string;
  flow: string;
  lines: { line: Line; cells: Cell[] }[];
  totals: Cell[];
}

export interface MonthTotals {
  month: Month;
  closed: boolean;
  plan: Figures;
  actual: Figures;
  unassignedOutflow: Dec;
  unassignedInflow: Dec;
  unassignedTransactions: number;
  cumulativeNetPlan: Dec;
  cumulativeNetActual: Dec;
}

export interface Grid {
  months: Month[];
  sections: Section[];
  totals: MonthTotals[];
  accountId: string | null;
}

export function computeGrid(book: Book, from: Month, to: Month, accountId?: string): Grid {
  const months = Array.from({ length: to - from + 1 }, (_, i) => from + i);
  const groups = new Map<string, { name: string; flow: string; lines: Line[] }>();
  for (const line of accountId === undefined ? book.lines : book.linesOn(accountId)) {
    const k = JSON.stringify([line.section, line.flow]);
    const group = groups.get(k) ?? { name: line.section, flow: line.flow, lines: [] };
    group.lines.push(line);
    groups.set(k, group);
  }
  const sections: Section[] = [...groups.values()].map((group) => {
    const rows = group.lines.map((line) => ({
      line,
      cells: months.map((month) => ({
        month,
        plan: book.plan(line, month),
        actual: book.actual(line, month),
        transactions: book.transactionCount(line, month),
      })),
    }));
    const totals = months.map((month, i) => ({
      month,
      plan: sum(rows, (r) => must(r.cells[i]).plan),
      actual: sum(rows, (r) => must(r.cells[i]).actual),
      transactions: rows.reduce((n, r) => n + must(r.cells[i]).transactions, 0),
    }));
    return { name: group.name, flow: group.flow, lines: rows, totals };
  });

  // The running net counts from the plan's first month, not the window's.
  let cumulativePlan = ZERO;
  let cumulativeActual = ZERO;
  for (let month = Math.min(book.settings.startMonth, from); month <= from - 1; month++) {
    cumulativePlan += net(book.figures(month, 'plan', accountId));
    cumulativeActual += net(book.figures(month, 'actual', accountId));
  }
  const totals: MonthTotals[] = months.map((month) => {
    const plan = book.figures(month, 'plan', accountId);
    const actual = book.figures(month, 'actual', accountId);
    cumulativePlan += net(plan);
    cumulativeActual += net(actual);
    return {
      month,
      closed: book.isClosed(month),
      plan,
      actual,
      unassignedOutflow: book.unassignedOutflowOf(month, accountId),
      unassignedInflow: book.unassignedInflowOf(month, accountId),
      unassignedTransactions: book.unassignedCountOf(month, accountId),
      cumulativeNetPlan: cumulativePlan,
      cumulativeNetActual: cumulativeActual,
    };
  });
  return { months, sections, totals, accountId: accountId ?? null };
}

// --- Cards, loans, cash flow -----------------------------------------------------------------

export interface CardMonth {
  month: Month;
  source: Source;
  opening: Dec;
  spend: Dec;
  paymentOut: Dec;
  closing: Dec;
  utilisation: Dec | null;
}

/** The timing of a card paid in full: this month's spend is collected next month. */
export function cardCycle(
  book: Book,
  card: Account,
  source: Source,
  from: Month,
  to: Month,
): CardMonth[] {
  const rows: CardMonth[] = [];
  let opening = card.openingBalance;
  // The cycle chains from the start month whatever window is asked for.
  for (let month = book.settings.startMonth; month <= to; month++) {
    const resolved = book.resolve(source, month);
    const spend = book.cardSpend(card, month, resolved);
    // Paid in full only when a balance is due; card credits carry forward.
    const paymentOut = opening > ZERO ? opening : ZERO;
    const closing = opening + spend - paymentOut;
    if (month >= from) {
      const utilisation =
        card.limit !== null && card.limit > ZERO
          ? roundRatio(closing, card.limit, 4, 'even')
          : null;
      rows.push({ month, source: resolved, opening, spend, paymentOut, closing, utilisation });
    }
    opening = closing;
  }
  return rows;
}

export interface LoanMonth {
  number: number;
  month: Month;
  opening: Dec;
  interest: Dec;
  payment: Dec;
  principal: Dec;
  closing: Dec;
}

export interface Schedule {
  opening: Dec;
  apr: Dec;
  payment: Dec;
  overpayment: Dec;
  months: LoanMonth[];
  totalInterest: Dec;
  totalPaid: Dec;
  cleared: boolean;
  clearedIn: Month | null;
}

const MAXIMUM_LOAN_MONTHS = 600;
const HALF_PENNY = 5n * 10n ** 9n;

export function loanSchedule(loan: Account, start: Month, overpayment?: Dec): Schedule {
  const opening = loan.openingBalance;
  const apr = loan.apr ?? ZERO;
  const payment = loan.payment ?? ZERO;
  const extra = overpayment ?? loan.overpayment ?? ZERO;
  const months: LoanMonth[] = [];
  let balance = roundMoney(opening);
  let totalInterest = ZERO;
  let totalPaid = ZERO;
  for (let number = 1; balance > HALF_PENNY && number <= MAXIMUM_LOAN_MONTHS; number++) {
    // balance * apr / 12, to the penny, ties away from zero, computed exactly.
    const interest = roundRatio(balance * apr, 12n * S * S, 2, 'away');
    const due = payment + extra < balance + interest ? payment + extra : balance + interest;
    const paid = roundMoney(due);
    const principal = paid - interest;
    const closing = roundMoney(balance - principal);
    months.push({
      number,
      month: start + number - 1,
      opening: balance,
      interest,
      payment: paid,
      principal,
      closing,
    });
    totalInterest += interest;
    totalPaid += paid;
    balance = closing;
  }
  const cleared = balance <= HALF_PENNY;
  return {
    opening,
    apr,
    payment,
    overpayment: extra,
    months,
    totalInterest,
    totalPaid,
    cleared,
    clearedIn: cleared && months.length > 0 ? must(months[months.length - 1]).month : null,
  };
}

export function balanceAfter(schedule: Schedule, month: Month): Dec {
  const row = [...schedule.months].reverse().find((r) => r.month <= month);
  return row === undefined ? schedule.opening : row.closing;
}

export interface CashFlowMonth {
  month: Month;
  source: Source;
  income: Dec;
  paid: Dec;
  cardSpend: Dec;
  cardPaymentOut: Dec;
  cashNet: Dec;
  closingBank: Dec;
  cardOwed: Dec;
  netPosition: Dec;
  emergencyTarget: Dec;
  bufferMet: boolean;
}

export interface CashFlow {
  openingBank: Dec;
  openingCardOwed: Dec;
  openingNetPosition: Dec;
  emergencyTarget: Dec;
  emergencyBasisMonth: Month;
  bufferMetIn: Month | null;
  months: CashFlowMonth[];
}

export function cashFlow(book: Book, basis: Month): CashFlow {
  const { settings } = book;
  const end = endMonth(settings);
  const cycles = book.cards.map((card) => cardCycle(book, card, 'auto', settings.startMonth, end));
  const openingCardOwed = sum(book.cards, (c) => c.openingBalance);
  const target = (month: Month): Dec =>
    roundMoney(mul(settings.emergencyFundMonths, outgoings(book.figures(month, 'plan'))));
  const months: CashFlowMonth[] = [];
  let bank = settings.openingCash;
  let bufferMetIn: Month | null = null;
  for (let month = settings.startMonth; month <= end; month++) {
    const source = book.resolve('auto', month);
    const f = book.figures(month, source);
    const row = (pick: (c: CardMonth) => Dec): Dec =>
      sum(cycles, (cycle) => {
        const found = cycle.find((r) => r.month === month);
        return found === undefined ? ZERO : pick(found);
      });
    const cardPaymentOut = row((c) => c.paymentOut);
    const cardOwed = row((c) => c.closing);
    const cashNet = f.income - f.paid - cardPaymentOut;
    bank += cashNet;
    const netPosition = bank - cardOwed;
    const monthTarget = target(month);
    const met = monthTarget > ZERO && netPosition >= monthTarget;
    if (met && bufferMetIn === null) bufferMetIn = month;
    months.push({
      month,
      source,
      income: f.income,
      paid: f.paid,
      cardSpend: f.cards,
      cardPaymentOut,
      cashNet,
      closingBank: bank,
      cardOwed,
      netPosition,
      emergencyTarget: monthTarget,
      bufferMet: met,
    });
  }
  return {
    openingBank: settings.openingCash,
    openingCardOwed,
    openingNetPosition: settings.openingCash - openingCardOwed,
    emergencyTarget: target(basis),
    emergencyBasisMonth: basis,
    bufferMetIn,
    months,
  };
}
