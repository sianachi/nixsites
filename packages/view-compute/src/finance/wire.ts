/* eslint-disable @typescript-eslint/explicit-module-boundary-types -- these build Core response bodies; the inferred JSON shape is the contract */
import {
  type CardMonth,
  type CashFlow,
  type CashFlowMonth,
  type Cell,
  type Figures,
  type LoanMonth,
  type Schedule,
  balanceAfter,
  net,
  outgoings,
} from './book';
import { type Month, monthText } from './dates';
import { type Dec, num } from './dec';
import type { Account, Containers, Line, Settings, Transaction } from './records';
import { endMonth } from './records';

/** Core's response records (FinanceMapping), in the JSON shape the endpoints write. */

export const settingsBody = (s: Settings) => ({
  currency: s.currency,
  startMonth: monthText(s.startMonth),
  endMonth: monthText(endMonth(s)),
  horizonMonths: s.horizonMonths,
  openingCash: num(s.openingCash),
  emergencyFundMonths: num(s.emergencyFundMonths),
  timezone: s.timezone,
});

export const containersBody = (c: Containers) => ({
  accounts: c.accounts,
  lines: c.lines,
  transactions: c.transactions,
});

const opt = (d: Dec | null): number | null => (d === null ? null : num(d));

export const accountBody = (a: Account) => ({
  id: a.id,
  name: a.name,
  type: a.type,
  limit: opt(a.limit),
  openingBalance: num(a.openingBalance),
  settlesFrom: a.settlesFrom,
  apr: opt(a.apr),
  payment: opt(a.payment),
  overpayment: opt(a.overpayment),
  target: opt(a.target),
  archived: a.archived,
});

export const lineBody = (l: Line) => ({
  id: l.id,
  name: l.name,
  section: l.section,
  flow: l.flow,
  accountId: l.accountId,
  amount: num(l.amount),
  overrides: Object.fromEntries([...l.overrides].map(([m, v]) => [monthText(m), num(v)])),
  scheduled: l.scheduled,
  dueDay: l.dueDay,
  loanAccount: l.loanAccount,
  archived: l.archived,
  position: Number(l.position),
});

export const transactionBody = (t: Transaction) => ({
  id: t.id,
  description: t.description,
  date: t.date,
  amount: num(t.amount),
  accountId: t.accountId,
  lineId: t.lineId,
  source: t.source,
  postedFor: t.postedFor === null ? null : monthText(t.postedFor),
  importKey: t.importKey,
  cleared: t.cleared,
});

export const figuresBody = (f: Figures) => ({
  income: num(f.income),
  paidThisMonth: num(f.paid),
  cardSpend: num(f.cards),
  outgoings: num(outgoings(f)),
  net: num(net(f)),
});

export const cellBody = (c: Cell) => ({
  month: monthText(c.month),
  plan: num(c.plan),
  actual: num(c.actual),
  variance: num(c.actual - c.plan),
  transactions: c.transactions,
});

export const cardBody = (row: CardMonth, card: Account) => ({
  accountId: card.id,
  name: card.name,
  month: monthText(row.month),
  source: row.source === 'actual' ? 'actual' : 'plan',
  opening: num(row.opening),
  spend: num(row.spend),
  paymentOut: num(row.paymentOut),
  closing: num(row.closing),
  utilisation: opt(row.utilisation),
  limit: opt(card.limit),
  settlesFrom: card.settlesFrom,
});

export const summaryBody = (s: Schedule, asAt: Month) => ({
  opening: num(s.opening),
  apr: num(s.apr),
  payment: num(s.payment),
  overpayment: num(s.overpayment),
  monthsToClear: s.months.length,
  totalInterest: num(s.totalInterest),
  totalPaid: num(s.totalPaid),
  cleared: s.cleared,
  clearedIn: s.clearedIn === null ? null : monthText(s.clearedIn),
  balanceAfterMonth: num(balanceAfter(s, asAt)),
});

export const loanMonthBody = (m: LoanMonth) => ({
  number: m.number,
  month: monthText(m.month),
  opening: num(m.opening),
  interest: num(m.interest),
  payment: num(m.payment),
  principal: num(m.principal),
  closing: num(m.closing),
});

export const cashFlowMonthBody = (m: CashFlowMonth) => ({
  month: monthText(m.month),
  source: m.source === 'actual' ? 'actual' : 'plan',
  income: num(m.income),
  paidThisMonth: num(m.paid),
  cardSpend: num(m.cardSpend),
  cardPaymentOut: num(m.cardPaymentOut),
  cashNet: num(m.cashNet),
  closingBank: num(m.closingBank),
  cardOwed: num(m.cardOwed),
  netPosition: num(m.netPosition),
  emergencyTarget: num(m.emergencyTarget),
  bufferMet: m.bufferMet,
});

export const cashFlowBody = (itemId: string, p: CashFlow) => ({
  itemId,
  openingBank: num(p.openingBank),
  openingCardOwed: num(p.openingCardOwed),
  openingNetPosition: num(p.openingNetPosition),
  emergencyTarget: num(p.emergencyTarget),
  emergencyBasisMonth: monthText(p.emergencyBasisMonth),
  bufferMetIn: p.bufferMetIn === null ? null : monthText(p.bufferMetIn),
  months: p.months.map(cashFlowMonthBody),
});
