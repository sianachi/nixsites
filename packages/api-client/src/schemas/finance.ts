import { z } from 'zod';
import type { components } from '../generated/api.js';

// Amounts are decimals Core has already validated to two places; the browser formats them and
// never sums them. Months travel as yyyy-MM.

const month = z.string().regex(/^\d{4}-\d{2}$/);
const uuid = z.uuid();

const financeSettingsSchema = z.object({
  currency: z.string().length(3),
  startMonth: month,
  endMonth: month,
  horizonMonths: z.int().positive(),
  openingCash: z.number(),
  emergencyFundMonths: z.number().nonnegative(),
  timezone: z.string(),
});

const financeContainersSchema = z.object({
  accounts: uuid,
  lines: uuid,
  transactions: uuid,
});

const financeAccountTypeSchema = z.enum(['current', 'savings', 'debit', 'credit_card', 'loan']);

export const financeAccountSchema = z.object({
  id: uuid,
  name: z.string(),
  type: financeAccountTypeSchema,
  limit: z.number().nullable(),
  openingBalance: z.number(),
  settlesFrom: uuid.nullable(),
  apr: z.number().nullable(),
  payment: z.number().nullable(),
  overpayment: z.number().nullable(),
  target: z.number().nullable(),
  archived: z.boolean(),
});

const budgetFlowSchema = z.enum(['income', 'expense']);

export const budgetLineSchema = z.object({
  id: uuid,
  name: z.string(),
  section: z.string(),
  flow: budgetFlowSchema,
  accountId: uuid,
  amount: z.number(),
  overrides: z.record(z.string(), z.number()),
  scheduled: z.boolean(),
  dueDay: z.int().nullable(),
  loanAccount: uuid.nullable(),
  archived: z.boolean(),
  position: z.number(),
});

const financeSourceSchema = z.enum(['manual', 'scheduled', 'import']);

export const financeTransactionSchema = z.object({
  id: uuid,
  description: z.string(),
  date: z.iso.date(),
  amount: z.number(),
  accountId: uuid,
  lineId: uuid.nullable(),
  source: financeSourceSchema,
  postedFor: month.nullable(),
  importKey: z.string().nullable(),
  cleared: z.boolean(),
});

export const financeSchema = z.object({
  itemId: uuid,
  settings: financeSettingsSchema,
  containers: financeContainersSchema,
  accounts: z.array(financeAccountSchema),
  lines: z.array(budgetLineSchema),
  closedMonths: z.array(month),
  currentMonth: month,
  transactionCount: z.int().nonnegative(),
  problems: z.array(z.string()),
});

export const financeTransactionsSchema = z.object({
  transactions: z.array(financeTransactionSchema),
  total: z.int().nonnegative(),
  truncated: z.boolean(),
  // Optional while an older Core runs during rollout; never derive totals from a partial page.
  offset: z.int().nonnegative().optional(),
  nextOffset: z.int().nonnegative().nullable().optional(),
  inflow: z.number().nonnegative().optional(),
  outflow: z.number().nonnegative().optional(),
  net: z.number().optional(),
});

const budgetCellSchema = z.object({
  month,
  plan: z.number(),
  actual: z.number(),
  variance: z.number(),
  transactions: z.int().nonnegative(),
});

const monthFiguresSchema = z.object({
  income: z.number(),
  paidThisMonth: z.number(),
  cardSpend: z.number(),
  outgoings: z.number(),
  net: z.number(),
});

export const budgetGridSchema = z.object({
  itemId: uuid,
  months: z.array(month),
  sections: z.array(
    z.object({
      name: z.string(),
      flow: budgetFlowSchema,
      lines: z.array(z.object({ line: budgetLineSchema, cells: z.array(budgetCellSchema) })),
      totals: z.array(budgetCellSchema),
    }),
  ),
  totals: z.array(
    z.object({
      month,
      closed: z.boolean(),
      plan: monthFiguresSchema,
      actual: monthFiguresSchema,
      unassignedOutflow: z.number(),
      unassignedInflow: z.number(),
      unassignedTransactions: z.int().nonnegative(),
      cumulativeNetPlan: z.number(),
      cumulativeNetActual: z.number(),
    }),
  ),
  /** The account the grid was narrowed to, when it was; every total is then that account's alone. */
  accountId: uuid.nullable(),
});

/** What recording a line's actual did: the figure before and after, and the transaction that moved it. */
export const budgetActualSchema = z.object({
  lineId: uuid,
  month,
  before: z.number(),
  after: z.number(),
  transaction: financeTransactionSchema.nullable(),
});

const figureSourceSchema = z.enum(['plan', 'actual']);

const cardMonthSchema = z.object({
  accountId: uuid,
  name: z.string(),
  month,
  source: figureSourceSchema,
  opening: z.number(),
  spend: z.number(),
  paymentOut: z.number(),
  closing: z.number(),
  utilisation: z.number().nullable(),
  limit: z.number().nullable(),
  settlesFrom: uuid.nullable(),
});

const loanSummarySchema = z.object({
  opening: z.number(),
  apr: z.number(),
  payment: z.number(),
  overpayment: z.number(),
  monthsToClear: z.int().nonnegative(),
  totalInterest: z.number(),
  totalPaid: z.number(),
  cleared: z.boolean(),
  clearedIn: month.nullable(),
  balanceAfterMonth: z.number(),
});

export const financeAccountsSchema = z.object({
  itemId: uuid,
  month,
  accounts: z.array(
    z.object({
      account: financeAccountSchema,
      recordedBalance: z.number().nullable(),
      card: cardMonthSchema.nullable(),
      loan: loanSummarySchema.nullable(),
      savingsProgress: z.number().nullable(),
    }),
  ),
});

export const loanScheduleSchema = z.object({
  accountId: uuid,
  name: z.string(),
  baseline: loanSummarySchema,
  alternative: loanSummarySchema,
  monthsSaved: z.int(),
  interestSaved: z.number(),
  months: z.array(
    z.object({
      number: z.int().positive(),
      month,
      opening: z.number(),
      interest: z.number(),
      payment: z.number(),
      principal: z.number(),
      closing: z.number(),
    }),
  ),
});

const cashFlowMonthSchema = z.object({
  month,
  source: figureSourceSchema,
  income: z.number(),
  paidThisMonth: z.number(),
  cardSpend: z.number(),
  cardPaymentOut: z.number(),
  cashNet: z.number(),
  closingBank: z.number(),
  cardOwed: z.number(),
  netPosition: z.number(),
  emergencyTarget: z.number(),
  bufferMet: z.boolean(),
});

export const cashFlowSchema = z.object({
  itemId: uuid,
  openingBank: z.number(),
  openingCardOwed: z.number(),
  openingNetPosition: z.number(),
  emergencyTarget: z.number(),
  emergencyBasisMonth: month,
  bufferMetIn: month.nullable(),
  months: z.array(cashFlowMonthSchema),
});

const watchItemSchema = z.object({
  lineId: uuid.nullable(),
  name: z.string(),
  section: z.string(),
  plan: z.number(),
  actual: z.number(),
  variance: z.number(),
});

const upcomingSchema = z.object({
  kind: z.enum(['line', 'card']),
  lineId: uuid.nullable(),
  accountId: uuid.nullable(),
  name: z.string(),
  due: z.iso.date(),
  amount: z.number(),
  posted: z.boolean(),
});

export const financeDashboardSchema = z.object({
  itemId: uuid,
  month,
  closed: z.boolean(),
  plan: monthFiguresSchema,
  actual: monthFiguresSchema,
  savingsRatePlan: z.number().nullable(),
  savingsRateActual: z.number().nullable(),
  position: cashFlowMonthSchema,
  openingNetPosition: z.number(),
  emergencyTarget: z.number(),
  bufferMetIn: month.nullable(),
  cardFloat: z.number(),
  cards: z.array(cardMonthSchema),
  loans: z.array(
    z.object({
      accountId: uuid,
      name: z.string(),
      balance: z.number(),
      clearedIn: month.nullable(),
      totalInterest: z.number(),
    }),
  ),
  watch: z.array(watchItemSchema),
  upcoming: z.array(upcomingSchema),
  horizonEnd: cashFlowMonthSchema,
  horizonNet: z.number(),
  monthEndDebt: z.number().optional(),
  monthEndAfterDebt: z.number().optional(),
});

export const financeMonthSchema = z.object({
  month,
  closed: z.boolean(),
  closedMonths: z.array(month),
});

export const monthChecklistSchema = z.object({
  month,
  closed: z.boolean(),
  scheduledPosted: z.int().nonnegative(),
  scheduledUnposted: z.int().nonnegative(),
  unassignedTransactions: z.int().nonnegative(),
  unassignedOutflow: z.number(),
  overPlan: z.array(watchItemSchema),
  plan: monthFiguresSchema,
  actual: monthFiguresSchema,
});

export const postScheduledSchema = z.object({
  month,
  posted: z.array(financeTransactionSchema),
  alreadyPosted: z.int().nonnegative(),
  skipped: z.int().nonnegative(),
});

const financeImportRowSchema = z.object({
  row: z.int().positive(),
  date: z.iso.date().nullable(),
  amount: z.number().nullable(),
  description: z.string(),
  status: z.enum(['new', 'duplicate', 'matched', 'unreadable']),
  suggestedLineId: uuid.nullable(),
  problem: z.string().nullable(),
  transactionId: uuid.nullable(),
});

export const financeImportSchema = z.object({
  rows: z.int().nonnegative(),
  readable: z.int().nonnegative(),
  created: z.int().nonnegative(),
  duplicates: z.int().nonnegative(),
  matched: z.int().nonnegative(),
  unreadable: z.int().nonnegative(),
  committed: z.boolean(),
  preview: z.array(financeImportRowSchema),
  problem: z.string().nullable(),
});

export type FinanceAccountType = z.infer<typeof financeAccountTypeSchema>;
export type FinanceAccount = z.infer<typeof financeAccountSchema>;
export type BudgetFlow = z.infer<typeof budgetFlowSchema>;
export type BudgetLine = z.infer<typeof budgetLineSchema>;
export type FinanceTransaction = z.infer<typeof financeTransactionSchema>;
export type Finance = z.infer<typeof financeSchema>;
export type FinanceTransactions = z.infer<typeof financeTransactionsSchema>;
export type BudgetCell = z.infer<typeof budgetCellSchema>;
export type BudgetGrid = z.infer<typeof budgetGridSchema>;
export type BudgetActual = z.infer<typeof budgetActualSchema>;
export type FinanceAccounts = z.infer<typeof financeAccountsSchema>;
export type LoanSchedule = z.infer<typeof loanScheduleSchema>;
export type CashFlowMonth = z.infer<typeof cashFlowMonthSchema>;
export type CashFlow = z.infer<typeof cashFlowSchema>;
export type Upcoming = z.infer<typeof upcomingSchema>;
export type FinanceDashboard = z.infer<typeof financeDashboardSchema>;
export type FinanceMonth = z.infer<typeof financeMonthSchema>;
export type MonthChecklist = z.infer<typeof monthChecklistSchema>;
export type PostScheduled = z.infer<typeof postScheduledSchema>;
export type FinanceImport = z.infer<typeof financeImportSchema>;

// Keep boundary parsing tied to the explicitly generated Core contract.
// Additive rollout fields are absent on older Core instances.
type RolloutOptional<T, K extends keyof T> = Omit<T, K> & { [P in K]?: T[P] | undefined };
const _finance = financeSchema satisfies z.ZodType<components['schemas']['FinanceResponse']>;
const _account = financeAccountSchema satisfies z.ZodType<
  components['schemas']['FinanceAccountResponse']
>;
const _line = budgetLineSchema satisfies z.ZodType<components['schemas']['BudgetLineResponse']>;
const _transaction = financeTransactionSchema satisfies z.ZodType<
  components['schemas']['FinanceTransactionResponse']
>;
const _transactions = financeTransactionsSchema satisfies z.ZodType<
  RolloutOptional<
    components['schemas']['FinanceTransactionsResponse'],
    'offset' | 'nextOffset' | 'inflow' | 'outflow' | 'net'
  >
>;
const _grid = budgetGridSchema satisfies z.ZodType<components['schemas']['BudgetGridResponse']>;
const _actual = budgetActualSchema satisfies z.ZodType<
  components['schemas']['BudgetActualResponse']
>;
const _accounts = financeAccountsSchema satisfies z.ZodType<
  components['schemas']['FinanceAccountsResponse']
>;
const _loan = loanScheduleSchema satisfies z.ZodType<components['schemas']['LoanScheduleResponse']>;
const _cashFlow = cashFlowSchema satisfies z.ZodType<components['schemas']['CashFlowResponse']>;
const _dashboard = financeDashboardSchema satisfies z.ZodType<
  RolloutOptional<
    components['schemas']['FinanceDashboardResponse'],
    'monthEndDebt' | 'monthEndAfterDebt'
  >
>;
const _month = financeMonthSchema satisfies z.ZodType<
  components['schemas']['FinanceMonthResponse']
>;
const _checklist = monthChecklistSchema satisfies z.ZodType<
  components['schemas']['MonthChecklistResponse']
>;
const _posted = postScheduledSchema satisfies z.ZodType<
  components['schemas']['PostScheduledResponse']
>;
const _import = financeImportSchema satisfies z.ZodType<
  components['schemas']['FinanceImportResponse']
>;
void _finance;
void _account;
void _line;
void _transaction;
void _transactions;
void _grid;
void _actual;
void _accounts;
void _loan;
void _cashFlow;
void _dashboard;
void _month;
void _checklist;
void _posted;
void _import;
