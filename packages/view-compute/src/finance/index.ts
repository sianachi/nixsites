import type { ViewAnswer, ViewCompute, ViewSource } from '../types';
import {
  MAXIMUM_GRID_MONTHS,
  type Book,
  balanceAfter,
  cardCycle,
  cashFlow,
  computeGrid,
  loanSchedule,
  net,
} from './book';
import {
  type Month,
  dayNumber,
  dayText,
  localDay,
  monthDay,
  monthFirstDay,
  monthLastDay,
  monthOfDay,
  monthText,
  parseMonth,
} from './dates';
import { type Dec, ZERO, must, isAmount, num, parseDec, ratio, sum } from './dec';
import { MAXIMUM_TRANSACTIONS, type Loaded, type Snapshot, loadFinance, refusal } from './loader';
import { type Line, endMonth, isIncome } from './records';
import {
  accountBody,
  cardBody,
  cashFlowBody,
  cashFlowMonthBody,
  cellBody,
  containersBody,
  figuresBody,
  lineBody,
  loanMonthBody,
  settingsBody,
  summaryBody,
  transactionBody,
} from './wire';

const MAXIMUM_PAGE = 1000;
const DEFAULT_PAGE = 500;
const UPCOMING_DAYS = 14;
const MAXIMUM_WATCH = 8;
const GUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/** A request whose query Core's model binding would refuse with a 400; offline we do not guess. */
class Unanswerable extends Error {}

const ok = (body: unknown): ViewAnswer => ({ status: 200, body });
const raw = (url: URL, name: string): string | undefined => {
  const value = url.searchParams.get(name);
  return value === null || value === '' ? undefined : value;
};
const bound = <T>(value: T | null): T => {
  if (value === null) throw new Unanswerable();
  return value;
};
const guidParam = (url: URL, name: string): string | undefined => {
  const value = raw(url, name);
  return value === undefined ? undefined : bound(GUID.test(value) ? value.toLowerCase() : null);
};
const intParam = (url: URL, name: string): number | undefined => {
  const value = raw(url, name);
  return value === undefined
    ? undefined
    : bound(/^[+-]?\d{1,9}$/.test(value) ? Number(value) : null);
};
const decParam = (url: URL, name: string): Dec | undefined => {
  const value = raw(url, name);
  return value === undefined
    ? undefined
    : bound(/^[+-]?\d+(\.\d+)?$/.test(value) ? parseDec(value.replace(/^\+/, '')) : null);
};
const dateParam = (url: URL, name: string): string | undefined => {
  const value = raw(url, name);
  return value === undefined ? undefined : bound(dayNumber(value) === null ? null : value);
};
const boolParam = (url: URL, name: string): boolean | undefined => {
  const value = raw(url, name)?.toLowerCase();
  return value === undefined
    ? undefined
    : bound(value === 'true' ? true : value === 'false' ? false : null);
};

const INVALID_MONTH = refusal('finance.invalid_month', 'Months are written yyyy-MM.');
/** TryMonth: empty is "not given"; anything else must be yyyy-MM. */
function monthParam(text: string | undefined): Month | null | ViewAnswer {
  if (text === undefined || text === '') return null;
  return parseMonth(text) ?? INVALID_MONTH;
}
const isRefusal = (value: Month | null | ViewAnswer): value is ViewAnswer =>
  typeof value === 'object' && value !== null;

function currentMonth(snapshot: Snapshot, now: Date): Month {
  const { settings } = snapshot;
  const month = monthOfDay(localDay(now, settings.timezone));
  return Math.min(Math.max(month, settings.startMonth), endMonth(settings));
}

export const computeFinance: ViewCompute = async (source, request, match) => {
  try {
    return await answer(source, request.url, (match[1] ?? '').toLowerCase(), match[2] ?? '');
  } catch (error) {
    if (error instanceof Unanswerable) return null;
    throw error;
  }
};

async function answer(
  source: ViewSource,
  url: URL,
  itemId: string,
  rest: string,
): Promise<ViewAnswer | null> {
  const loan = /^\/accounts\/([^/]+)\/loan$/.exec(rest);
  const month = /^\/months\/([^/]+)$/.exec(rest);
  const load = async (): Promise<Loaded> => loadFinance(source, itemId);
  const now = source.now();

  if (rest === '') {
    const loaded = await load();
    if ('failure' in loaded) return loaded.failure;
    return ok(describe(loaded.snapshot, now));
  }
  if (rest === '/accounts') {
    const asked = monthParam(raw(url, 'month'));
    if (isRefusal(asked)) return asked;
    const loaded = await load();
    return 'failure' in loaded
      ? loaded.failure
      : ok(accounts(loaded.snapshot, asked ?? currentMonth(loaded.snapshot, now), itemId));
  }
  if (loan !== null) {
    if (!GUID.test(loan[1] ?? '')) return null;
    const overpayment = decParam(url, 'overpayment');
    if (overpayment !== undefined && (!isAmount(overpayment) || overpayment < ZERO))
      return refusal('finance.invalid_account', 'An overpayment is an amount of zero or more.');
    const loaded = await load();
    return 'failure' in loaded
      ? loaded.failure
      : loanAnswer(loaded.snapshot, (loan[1] ?? '').toLowerCase(), overpayment, now);
  }
  if (rest === '/transactions') {
    const asked = monthParam(raw(url, 'month'));
    if (isRefusal(asked)) return asked;
    const query = {
      month: asked,
      accountId: guidParam(url, 'accountId'),
      lineId: guidParam(url, 'lineId'),
      unassigned: boolParam(url, 'unassigned') ?? false,
      limit: intParam(url, 'limit') ?? 0,
      from: dateParam(url, 'from'),
      to: dateParam(url, 'to'),
      search: url.searchParams.get('search') ?? undefined,
      source: raw(url, 'source'),
      minAmount: decParam(url, 'minAmount'),
      maxAmount: decParam(url, 'maxAmount'),
      offset: intParam(url, 'offset') ?? 0,
      transactionId: guidParam(url, 'transactionId'),
    };
    const loaded = await load();
    return 'failure' in loaded ? loaded.failure : transactions(loaded.snapshot.book, query);
  }
  if (rest === '/budget') {
    const from = monthParam(raw(url, 'from'));
    const to = monthParam(raw(url, 'to'));
    if (isRefusal(from)) return from;
    if (isRefusal(to)) return to;
    const accountId = guidParam(url, 'accountId');
    const loaded = await load();
    return 'failure' in loaded
      ? loaded.failure
      : budget(loaded.snapshot, from, to, accountId, itemId, now);
  }
  if (rest === '/cashflow') {
    const loaded = await load();
    return 'failure' in loaded
      ? loaded.failure
      : ok(
          cashFlowBody(itemId, cashFlow(loaded.snapshot.book, currentMonth(loaded.snapshot, now))),
        );
  }
  if (rest === '/dashboard') {
    const asked = monthParam(raw(url, 'month'));
    if (isRefusal(asked)) return asked;
    const loaded = await load();
    return 'failure' in loaded ? loaded.failure : dashboard(loaded.snapshot, asked, itemId, now);
  }
  if (month !== null) {
    const asked = parseMonth(month[1]);
    if (asked === null) return INVALID_MONTH;
    const loaded = await load();
    return 'failure' in loaded ? loaded.failure : checklist(loaded.snapshot, asked);
  }
  return null;
}

function describe(snapshot: Snapshot, now: Date) {
  const { root, settings, containers, book, problems } = snapshot;
  return {
    itemId: root.id,
    settings: settingsBody(settings),
    containers: containersBody(containers),
    accounts: book.accounts.map(accountBody),
    lines: book.lines.map(lineBody),
    closedMonths: book.closedMonths.map(monthText),
    currentMonth: monthText(currentMonth(snapshot, now)),
    transactionCount: book.transactions.length,
    problems,
  };
}

function accounts(snapshot: Snapshot, month: Month, itemId: string) {
  const { book, settings } = snapshot;
  const last = dayText(monthLastDay(month));
  return {
    itemId,
    month: monthText(month),
    accounts: book.accounts.map((account) => {
      let card = null;
      let loan = null;
      let recorded: Dec | null = null;
      let progress: Dec | null = null;
      if (account.type === 'credit_card') {
        const row = cardCycle(book, account, 'auto', month, month).find((r) => r.month === month);
        card = row === undefined ? null : cardBody(row, account);
      } else if (account.type === 'loan') {
        loan = summaryBody(loanSchedule(account, settings.startMonth), month);
      } else {
        recorded =
          account.openingBalance +
          sum(
            book.transactions.filter((t) => t.accountId === account.id && t.date <= last),
            (t) => t.amount,
          );
        if (account.target !== null && account.target > ZERO)
          progress = ratio(recorded, account.target, 4);
      }
      return {
        account: accountBody(account),
        recordedBalance: recorded === null ? null : num(recorded),
        card,
        loan,
        savingsProgress: progress === null ? null : num(progress),
      };
    }),
  };
}

function loanAnswer(
  snapshot: Snapshot,
  accountId: string,
  overpayment: Dec | undefined,
  now: Date,
): ViewAnswer {
  const { book, settings } = snapshot;
  const account = book.accountsById.get(accountId);
  if (account?.type !== 'loan')
    return refusal('finance.account_not_found', 'No such loan under this finance root.');
  const current = currentMonth(snapshot, now);
  const baseline = loanSchedule(account, settings.startMonth);
  const alternative =
    overpayment === undefined ? baseline : loanSchedule(account, settings.startMonth, overpayment);
  return ok({
    accountId: account.id,
    name: account.name,
    baseline: summaryBody(baseline, current),
    alternative: summaryBody(alternative, current),
    monthsSaved: baseline.months.length - alternative.months.length,
    interestSaved: num(baseline.totalInterest - alternative.totalInterest),
    months: alternative.months.map(loanMonthBody),
  });
}

interface TransactionQuery {
  month: Month | null;
  accountId: string | undefined;
  lineId: string | undefined;
  unassigned: boolean;
  limit: number;
  from: string | undefined;
  to: string | undefined;
  search: string | undefined;
  source: string | undefined;
  minAmount: Dec | undefined;
  maxAmount: Dec | undefined;
  offset: number;
  transactionId: string | undefined;
}

function transactionsProblem(q: TransactionQuery): string | null {
  if (q.from !== undefined && q.to !== undefined && q.from > q.to)
    return 'The start date must come before or equal the end date.';
  if ((q.search?.length ?? 0) > 200) return 'Search must be at most 200 characters.';
  if (q.source !== undefined && !['manual', 'scheduled', 'import'].includes(q.source))
    return 'Source must be manual, scheduled or import.';
  const bad = (d: Dec | undefined) => d !== undefined && (d < ZERO || !isAmount(d));
  if (
    bad(q.minAmount) ||
    bad(q.maxAmount) ||
    (q.minAmount !== undefined && q.maxAmount !== undefined && q.minAmount > q.maxAmount)
  )
    return 'Amount bounds must be ordered nonnegative amounts with at most two decimal places.';
  if (q.offset < 0 || q.offset > MAXIMUM_TRANSACTIONS)
    return `Offset must be between zero and ${String(MAXIMUM_TRANSACTIONS)}.`;
  return null;
}

function transactions(book: Book, q: TransactionQuery): ViewAnswer {
  const problem = transactionsProblem(q);
  if (problem !== null) return refusal('finance.invalid_filter', problem);
  const limit = q.limit <= 0 ? DEFAULT_PAGE : Math.min(q.limit, MAXIMUM_PAGE);
  const search = q.search?.trim().toUpperCase();
  const absolute = (d: Dec) => (d < ZERO ? -d : d);
  const matching = book.transactions
    .filter(
      (t) =>
        (q.transactionId === undefined || t.id === q.transactionId) &&
        (q.month === null || monthOfDay(dayNumber(t.date) ?? 0) === q.month) &&
        (q.accountId === undefined || t.accountId === q.accountId) &&
        (q.lineId === undefined || t.lineId === q.lineId) &&
        (!q.unassigned || t.lineId === null) &&
        (q.from === undefined || t.date >= q.from) &&
        (q.to === undefined || t.date <= q.to) &&
        (search === undefined || search === '' || t.description.toUpperCase().includes(search)) &&
        (q.source === undefined || t.source === q.source) &&
        (q.minAmount === undefined || absolute(t.amount) >= q.minAmount) &&
        (q.maxAmount === undefined || absolute(t.amount) <= q.maxAmount),
    )
    .sort(
      (a, b) =>
        (a.date < b.date ? 1 : a.date > b.date ? -1 : 0) ||
        (a.description < b.description ? -1 : a.description > b.description ? 1 : 0) ||
        (a.id < b.id ? -1 : a.id > b.id ? 1 : 0),
    );
  const page = matching.slice(q.offset, q.offset + limit).map(transactionBody);
  const next = q.offset + page.length;
  const truncated = next < matching.length;
  return ok({
    transactions: page,
    total: matching.length,
    truncated,
    offset: q.offset,
    nextOffset: truncated ? next : null,
    inflow: num(
      sum(
        matching.filter((t) => t.amount > ZERO),
        (t) => t.amount,
      ),
    ),
    outflow: num(
      -sum(
        matching.filter((t) => t.amount < ZERO),
        (t) => t.amount,
      ),
    ),
    net: num(sum(matching, (t) => t.amount)),
  });
}

function budget(
  snapshot: Snapshot,
  askedFrom: Month | null,
  askedTo: Month | null,
  accountId: string | undefined,
  itemId: string,
  now: Date,
): ViewAnswer {
  const { book } = snapshot;
  const from = askedFrom ?? askedTo ?? currentMonth(snapshot, now);
  const to = askedTo ?? from;
  if (to < from || to - from >= MAXIMUM_GRID_MONTHS)
    return refusal(
      'finance.invalid_range',
      `Choose an ordered range of at most ${String(MAXIMUM_GRID_MONTHS)} months.`,
    );
  if (accountId !== undefined && !book.accountsById.has(accountId))
    return refusal('finance.account_not_found', 'No such account under this finance root.');
  const grid = computeGrid(book, from, to, accountId);
  return ok({
    itemId,
    months: grid.months.map(monthText),
    sections: grid.sections.map((section) => ({
      name: section.name,
      flow: section.flow,
      lines: section.lines.map((row) => ({
        line: lineBody(row.line),
        cells: row.cells.map(cellBody),
      })),
      totals: section.totals.map(cellBody),
    })),
    totals: grid.totals.map((t) => ({
      month: monthText(t.month),
      closed: t.closed,
      plan: figuresBody(t.plan),
      actual: figuresBody(t.actual),
      unassignedOutflow: num(t.unassignedOutflow),
      unassignedInflow: num(t.unassignedInflow),
      unassignedTransactions: t.unassignedTransactions,
      cumulativeNetPlan: num(t.cumulativeNetPlan),
      cumulativeNetActual: num(t.cumulativeNetActual),
    })),
    accountId: grid.accountId,
  });
}

interface WatchRow {
  lineId: string | null;
  name: string;
  section: string;
  plan: Dec;
  actual: Dec;
  variance: Dec;
}

function watch(book: Book, month: Month) {
  const items: WatchRow[] = book.lines
    .filter((line) => !isIncome(line))
    .map((line) => ({
      lineId: line.id,
      name: line.name,
      section: line.section,
      plan: book.plan(line, month),
      actual: book.actual(line, month),
    }))
    .map((item) => ({ ...item, variance: item.actual - item.plan }))
    .filter((item) => item.variance > ZERO)
    .sort((a, b) => (a.variance < b.variance ? 1 : a.variance > b.variance ? -1 : 0))
    .slice(0, MAXIMUM_WATCH);
  const unassigned = book.unassignedOutflowOf(month);
  if (unassigned > ZERO)
    items.unshift({
      lineId: null,
      name: 'Unassigned spending',
      section: 'Unassigned',
      plan: ZERO,
      actual: unassigned,
      variance: unassigned,
    });
  return items.map((item) => ({
    lineId: item.lineId,
    name: item.name,
    section: item.section,
    plan: num(item.plan),
    actual: num(item.actual),
    variance: num(item.variance),
  }));
}

const scheduledLines = (book: Book, month: Month): Line[] =>
  book.lines.filter((line) => line.scheduled && !line.archived && book.plan(line, month) > ZERO);
const isPosted = (book: Book, line: Line, month: Month): boolean =>
  book.transactions.some((t) => t.lineId === line.id && t.postedFor === month);

function checklist(snapshot: Snapshot, month: Month): ViewAnswer {
  const { book, settings } = snapshot;
  if (month < settings.startMonth || month > endMonth(settings))
    return refusal(
      'finance.invalid_month',
      `Choose a month between ${monthText(settings.startMonth)} and ${monthText(endMonth(settings))}.`,
    );
  const lines = scheduledLines(book, month);
  const posted = lines.filter((line) => isPosted(book, line, month)).length;
  return ok({
    month: monthText(month),
    closed: book.isClosed(month),
    scheduledPosted: posted,
    scheduledUnposted: lines.length - posted,
    unassignedTransactions: book.unassignedCountOf(month),
    unassignedOutflow: num(book.unassignedOutflowOf(month)),
    overPlan: watch(book, month),
    plan: figuresBody(book.figures(month, 'plan')),
    actual: figuresBody(book.figures(month, 'actual')),
  });
}

function dashboard(snapshot: Snapshot, asked: Month | null, itemId: string, now: Date): ViewAnswer {
  const { book, settings } = snapshot;
  const current = currentMonth(snapshot, now);
  const month = asked ?? current;
  const end = endMonth(settings);
  if (month < settings.startMonth || month > end)
    return refusal(
      'finance.invalid_month',
      `Choose a month between ${monthText(settings.startMonth)} and ${monthText(end)}.`,
    );
  const plan = book.figures(month, 'plan');
  const actual = book.figures(month, 'actual');
  const projection = cashFlow(book, current);
  const position = must(projection.months.find((m) => m.month === month));
  const cards = book.cards.map((card) => ({
    card,
    row: must(cardCycle(book, card, 'auto', month, month).find((r) => r.month === month)),
  }));
  const loans = book.loans.map((loan) => {
    const schedule = loanSchedule(loan, settings.startMonth);
    return {
      accountId: loan.id,
      name: loan.name,
      balance: balanceAfter(schedule, month),
      clearedIn: schedule.clearedIn === null ? null : monthText(schedule.clearedIn),
      totalInterest: schedule.totalInterest,
    };
  });
  let horizonNet = ZERO;
  for (let each = settings.startMonth; each <= end; each++)
    horizonNet += net(book.figures(each, 'auto'));
  const monthEndDebt =
    sum(cards, (pair) => (pair.row.closing > ZERO ? pair.row.closing : ZERO)) +
    sum(loans, (loan) => loan.balance);
  const rate = (f: typeof plan) => (f.income === ZERO ? null : num(ratio(net(f), f.income, 4)));
  return ok({
    itemId,
    month: monthText(month),
    closed: book.isClosed(month),
    plan: figuresBody(plan),
    actual: figuresBody(actual),
    savingsRatePlan: rate(plan),
    savingsRateActual: rate(actual),
    position: cashFlowMonthBody(position),
    openingNetPosition: num(projection.openingNetPosition),
    emergencyTarget: num(position.emergencyTarget),
    bufferMetIn: projection.bufferMetIn === null ? null : monthText(projection.bufferMetIn),
    cardFloat: num(sum(cards, (pair) => pair.row.closing)),
    cards: cards.map((pair) => cardBody(pair.row, pair.card)),
    loans: loans.map((loan) => ({
      accountId: loan.accountId,
      name: loan.name,
      balance: num(loan.balance),
      clearedIn: loan.clearedIn,
      totalInterest: num(loan.totalInterest),
    })),
    watch: watch(book, month),
    upcoming: upcoming(snapshot, localDay(now, settings.timezone), cards),
    horizonEnd: cashFlowMonthBody(must(projection.months[projection.months.length - 1])),
    horizonNet: num(horizonNet),
    monthEndDebt: num(monthEndDebt),
    monthEndAfterDebt: num(position.closingBank - monthEndDebt),
  });
}

function upcoming(
  { book, settings }: Snapshot,
  today: number,
  cards: { card: { id: string; name: string }; row: { month: Month; closing: Dec } }[],
) {
  const end = today + UPCOMING_DAYS;
  const items: {
    kind: string;
    lineId: string | null;
    accountId: string;
    name: string;
    due: number;
    amount: Dec;
    posted: boolean;
  }[] = [];
  const thisMonth = monthOfDay(today);
  for (const month of [thisMonth, thisMonth + 1]) {
    if (month < settings.startMonth || month > endMonth(settings)) continue;
    for (const line of scheduledLines(book, month)) {
      const due = monthDay(month, line.dueDay ?? 1);
      if (due >= today && due <= end)
        items.push({
          kind: 'line',
          lineId: line.id,
          accountId: line.accountId,
          name: line.name,
          due,
          amount: book.plan(line, month),
          posted: isPosted(book, line, month),
        });
    }
  }
  for (const { card, row } of cards) {
    const due = monthFirstDay(row.month + 1);
    if (row.closing > ZERO && due >= today && due <= end)
      items.push({
        kind: 'card',
        lineId: null,
        accountId: card.id,
        name: `${card.name} statement`,
        due,
        amount: row.closing,
        posted: false,
      });
  }
  return items
    .sort((a, b) => a.due - b.due || (a.name < b.name ? -1 : a.name > b.name ? 1 : 0))
    .map((item) => ({
      kind: item.kind,
      lineId: item.lineId,
      accountId: item.accountId,
      name: item.name,
      due: dayText(item.due),
      amount: num(item.amount),
      posted: item.posted,
    }));
}
