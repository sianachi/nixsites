import {
  ScrollRegion,
  Button,
  Input,
  Segmented,
  Select,
  Tag,
  Text,
  cn,
  focusRing,
  focusRingInset,
  inkWashStates,
} from '@nix/ui';
import {
  finance as financeApi,
  type BudgetCell,
  type BudgetGrid,
  type BudgetLine,
  type Finance,
} from '@nix/api-client';
import {
  useEffect,
  useId,
  useMemo,
  useRef,
  useState,
  type KeyboardEvent,
  type ReactNode,
} from 'react';
import {
  ErrorPanel,
  LoadingPanel,
  PartialNotice,
} from '@nix/web-foundation/components/states/status-panels';
import { useNarrowViewport } from '@nix/web-foundation/layout/viewport';
import { BudgetActualDialog } from './budget-actual-dialog';
import { LineDialog } from './finance-setup';
import { Money, SectionHeading, editableTextButton } from './finance-shared';
import { formatMonth, parseAmount } from './money';
import { useFinanceQuery, type FinanceState } from './use-finance';

type Figure = 'plan' | 'actual' | 'left';
type Span = 'month' | 'year';

const FIGURES: readonly { readonly value: Figure; readonly label: string }[] = [
  { value: 'plan', label: 'Plan' },
  { value: 'actual', label: 'Actual' },
  { value: 'left', label: 'Left' },
];

/**
 * The workbook's Budget, Actual and Variance sheets as one grid.
 *
 * One month shows plan, actual and what is left side by side; the year view shows one figure
 * across the selected calendar year. Every number is Core's. A plan cell is edited in
 * place; an actual cell opens what is behind it, where a new total can be typed or the
 * transactions changed one by one. Narrowed to an account, the grid keeps only that account's
 * lines and every total at the foot is that account's alone.
 */
export function FinanceBudget({
  state,
  finance,
  month,
  onMonth,
}: {
  readonly state: FinanceState;
  readonly finance: Finance;
  readonly month: string;
  readonly onMonth: (month: string) => void;
}): ReactNode {
  const narrow = useNarrowViewport();
  const currency = finance.settings.currency;
  const [span, setSpan] = useState<Span>('month');
  const [figure, setFigure] = useState<Figure>('actual');
  const [accountId, setAccountId] = useState('');
  const [editing, setEditing] = useState<BudgetLine | null | 'new'>(null);
  // Only the address of the opened cell: the line and figures behind it are looked up from the
  // live grid on every render, so a change made inside the dialog is reflected the moment the
  // grid refetches rather than the dialog keeping the figures it opened with.
  const [opened, setOpened] = useState<{ readonly lineId: string; readonly month: string } | null>(
    null,
  );
  // The bulk "record planned as actual" action: idle, asking to confirm a count, working through
  // the lines one at a time, or reporting what actually went through.
  const [bulk, setBulk] = useState<
    | 'idle'
    | 'confirming'
    | 'running'
    | { readonly done: number; readonly failed: readonly string[] }
  >('idle');
  // Calendar years include earlier months, so the year view also explains historical spending.
  const yearFrom = `${month.slice(0, 4)}-01`;
  const yearTo = `${month.slice(0, 4)}-12`;
  const from =
    span === 'month'
      ? month
      : yearFrom < finance.settings.startMonth
        ? finance.settings.startMonth
        : yearFrom;
  const to =
    span === 'month'
      ? month
      : yearTo > finance.settings.endMonth
        ? finance.settings.endMonth
        : yearTo;
  const itemId = finance.itemId;
  const account = accountId === '' ? undefined : accountId;
  const endpoint = useMemo(
    () => financeApi.readBudget(itemId, from, to, account),
    [itemId, from, to, account],
  );
  const query = useFinanceQuery<BudgetGrid>(endpoint, state.generation);
  const chosenAccountName = finance.accounts.find((each) => each.id === accountId)?.name;
  const accountFilter = (
    <Select
      aria-label="Account"
      value={accountId}
      onChange={(event) => {
        setAccountId(event.target.value);
      }}
    >
      <option value="">Every account</option>
      {finance.accounts
        .filter((each) => each.type !== 'loan')
        .map((each) => (
          <option key={each.id} value={each.id}>
            {each.name}
          </option>
        ))}
    </Select>
  );
  if (query.data === null) {
    return query.status === 'error' ? (
      <ErrorPanel title="The budget could not be loaded" detail={query.error ?? ''} />
    ) : (
      <LoadingPanel label="budget" />
    );
  }
  const grid = query.data;
  // Labels follow the grid Core sent, not the select: stale data stays on screen while the next
  // read loads or after it fails, and a total must never be called one account's when it is not.
  const accountName = finance.accounts.find((each) => each.id === grid.accountId)?.name;
  const switching = query.status === 'loading' && (grid.accountId ?? '') !== accountId;
  const closedMonth = finance.closedMonths.includes(month);
  const mismatchedScope =
    (grid.accountId ?? '') !== accountId || grid.months[0] !== from || grid.months.at(-1) !== to;
  // Bulk recording always targets the selected month, including inside a calendar-year grid.
  const bulkCandidates = grid.sections
    .flatMap((section) => section.lines)
    .filter((row) => {
      const cell = row.cells.find((candidate) => candidate.month === month);
      return cell?.actual === 0 && cell.plan !== 0;
    });
  const runBulk = async (): Promise<void> => {
    setBulk('running');
    let done = 0;
    const failed: string[] = [];
    for (const row of bulkCandidates) {
      const cell = row.cells.find((candidate) => candidate.month === month);
      if (cell === undefined) continue;
      const outcome = await state.setActual(row.line.id, month, { amount: cell.plan });
      if (typeof outcome === 'string') failed.push(row.line.name);
      else done += 1;
    }
    setBulk({ done, failed });
  };
  const openedRow =
    opened === null
      ? undefined
      : grid.sections
          .flatMap((section) => section.lines)
          .find((row) => row.line.id === opened.lineId);
  const openedCell = openedRow?.cells.find((cell) => cell.month === opened?.month);
  const value = (cell: BudgetCell, flow: 'income' | 'expense'): number =>
    figure === 'plan'
      ? cell.plan
      : figure === 'actual'
        ? cell.actual
        : flow === 'income'
          ? cell.variance
          : -cell.variance;
  const savePlan = async (
    line: BudgetLine,
    forMonth: string,
    amount: number,
  ): Promise<string | null> => {
    // Typing the usual amount back clears the month's override rather than pinning it.
    const overrides: Record<string, number> = Object.fromEntries(
      Object.entries(line.overrides).filter(([key]) => key !== forMonth),
    );
    if (amount !== line.amount) overrides[forMonth] = amount;
    const refusal = await state.setLine(line.id, {
      name: line.name,
      section: line.section,
      flow: line.flow,
      accountId: line.accountId,
      amount: line.amount,
      overrides,
      scheduled: line.scheduled,
      dueDay: line.dueDay,
      loanAccount: line.loanAccount,
      archived: line.archived,
    });
    return refusal;
  };
  const scope = accountName === undefined ? '' : ` on ${accountName}`;
  const editHint = closedMonth
    ? ' This month is closed.'
    : ' Choose a plan to change it, or an actual to see and record what is behind it.';
  return (
    <div className="@container flex min-w-0 flex-col gap-4">
      <SectionHeading
        id="finance-budget-title"
        title="Budget"
        detail={
          span === 'month'
            ? `${formatMonth(month, 'long')}${scope}: plan, actual and what is left on each line.${editHint}`
            : `${month.slice(0, 4)} calendar year (${formatMonth(from)} to ${formatMonth(to)} covered by your plan)${scope}: ${FIGURES.find((option) => option.value === figure)?.label.toLowerCase() ?? ''} by month.${figure === 'plan' ? ' Choose a figure to change that month.' : figure === 'actual' ? ' Choose a figure to see what is behind it.' : ' Choose a figure to open its month.'}`
        }
        actions={
          <>
            {accountFilter}
            <Segmented<Span>
              label="Span"
              options={[
                { value: 'month', label: 'Month' },
                { value: 'year', label: 'Year' },
              ]}
              value={span}
              onChange={setSpan}
            />
            {span === 'year' ? (
              <Segmented<Figure>
                label="Figure"
                options={FIGURES}
                value={figure}
                onChange={setFigure}
              />
            ) : null}
            <Button
              variant="secondary"
              onClick={() => {
                setEditing('new');
              }}
            >
              Add a line
            </Button>
            {closedMonth ? null : (
              <Button
                variant="secondary"
                disabled={
                  bulkCandidates.length === 0 || mismatchedScope || query.status !== 'ready'
                }
                onClick={() => {
                  setBulk('confirming');
                }}
              >
                Record planned as actual
              </Button>
            )}
          </>
        }
      />
      {bulk === 'confirming' ? (
        <div className="flex flex-wrap items-center gap-3 rounded-lg bg-surface-raised p-3">
          <Text as="p" variant="bodySmall">
            Record the plan as the actual for {String(bulkCandidates.length)} line
            {bulkCandidates.length === 1 ? '' : 's'} with no actual yet in{' '}
            {formatMonth(month, 'long')}
            {scope}?
          </Text>
          <Button
            variant="secondary"
            onClick={() => {
              setBulk('idle');
            }}
          >
            Cancel
          </Button>
          <Button
            disabled={mismatchedScope || query.status !== 'ready'}
            onClick={() => {
              void runBulk();
            }}
          >
            Record
          </Button>
        </div>
      ) : null}
      {typeof bulk === 'object' ? (
        <Text as="p" variant="bodySmall" role="status">
          {bulk.failed.length === 0
            ? `Recorded the plan as the actual for ${String(bulk.done)} line${bulk.done === 1 ? '' : 's'}.`
            : `Recorded ${String(bulk.done)} of ${String(bulk.done + bulk.failed.length)}; failed for ${bulk.failed.join(', ')}.`}
        </Text>
      ) : null}
      {switching ? (
        <Text variant="bodySmall" tone="muted" role="status">
          Loading {chosenAccountName ?? 'every account'}. The figures shown are still those for{' '}
          {accountName ?? 'every account'}.
        </Text>
      ) : null}
      {query.status === 'loading' ? (
        <Text variant="bodySmall" tone="muted" role="status">
          Updating budget figures. Editing resumes when the latest figures arrive.
        </Text>
      ) : null}
      {query.status === 'error' && !mismatchedScope ? (
        <div className="flex flex-col gap-2">
          <PartialNotice pending="the latest figures" />
          <Button variant="secondary" onClick={state.reload}>
            Try again
          </Button>
        </div>
      ) : null}
      {mismatchedScope ? (
        query.status === 'error' ? (
          <ErrorPanel
            title="The selected budget could not be loaded"
            detail={query.error ?? ''}
            action={
              <Button variant="secondary" onClick={state.reload}>
                Try again
              </Button>
            }
          />
        ) : (
          <LoadingPanel label="selected budget" />
        )
      ) : grid.sections.length === 0 ? (
        <Text variant="bodySmall" tone="muted">
          {accountName === undefined
            ? 'No budget lines yet. Add the plan line by line: Salary under Income, Rent under Housing, Groceries under whichever card pays for them.'
            : `No budget lines are paid from ${accountName} yet.`}
        </Text>
      ) : (
        <>
          {narrow ? (
            <Text variant="caption" tone="muted">
              Swipe horizontally to compare the plan, actual and remaining amounts.
            </Text>
          ) : null}
          <ScrollRegion
            aria-label="Budget figures"
            className={cn('relative min-w-0 overflow-x-auto', focusRing)}
          >
            <table className="w-full min-w-max border-collapse">
              <caption className="sr-only">Budget lines by month</caption>
              <thead>
                <tr className="border-b border-divider text-left">
                  <th scope="col" className="py-2 pr-3">
                    <Text as="span" variant="caption" tone="muted">
                      Line
                    </Text>
                  </th>
                  <th scope="col" className="py-2 pr-3">
                    <Text as="span" variant="caption" tone="muted">
                      Paid from
                    </Text>
                  </th>
                  {span === 'month' ? (
                    <>
                      <NumberHeader label="Plan" />
                      <NumberHeader label="Actual" />
                      <NumberHeader label="Left / variance" />
                    </>
                  ) : (
                    grid.months.map((each) => <NumberHeader key={each} label={formatMonth(each)} />)
                  )}
                </tr>
              </thead>
              {grid.sections.map((section) => (
                <tbody key={`${section.flow}:${section.name}`}>
                  <tr className="border-b border-divider bg-surface-raised">
                    <th scope="rowgroup" colSpan={2} className="py-2 pr-3 text-left">
                      <Text as="span" variant="caption">
                        {section.name.toUpperCase()}
                      </Text>
                    </th>
                    {span === 'month' ? (
                      <>
                        <NumberCell>
                          <Money amount={section.totals[0]?.plan ?? 0} currency={currency} />
                        </NumberCell>
                        <NumberCell>
                          <Money amount={section.totals[0]?.actual ?? 0} currency={currency} />
                        </NumberCell>
                        <NumberCell>
                          <Left
                            value={left(section.totals[0] ?? EMPTY_CELL, section.flow)}
                            currency={currency}
                            flow={section.flow}
                          />
                        </NumberCell>
                      </>
                    ) : (
                      section.totals.map((cell) => (
                        <NumberCell key={cell.month}>
                          <Money amount={value(cell, section.flow)} currency={currency} />
                        </NumberCell>
                      ))
                    )}
                  </tr>
                  {section.lines.map((row) => (
                    <tr key={row.line.id} className="border-b border-divider">
                      <th scope="row" className="py-2 pr-3 text-left font-normal">
                        <button
                          type="button"
                          className={editableTextButton}
                          disabled={query.status !== 'ready'}
                          onClick={() => {
                            setEditing(row.line);
                          }}
                        >
                          <Text as="span" variant="bodySmall">
                            {row.line.name}
                          </Text>
                        </button>
                        {row.line.archived ? <Tag tone="muted">Archived</Tag> : null}
                        {row.line.scheduled ? <Tag tone="neutral">Scheduled</Tag> : null}
                      </th>
                      <td className="py-2 pr-3">
                        <Text as="span" variant="bodySmall" tone="muted">
                          {finance.accounts.find((each) => each.id === row.line.accountId)?.name ??
                            ''}
                        </Text>
                      </td>
                      {span === 'month' ? (
                        <>
                          <NumberCell>
                            <PlanCell
                              line={row.line}
                              month={month}
                              amount={row.cells[0]?.plan ?? 0}
                              currency={currency}
                              closed={closedMonth || query.status !== 'ready'}
                              onSave={(amount) => savePlan(row.line, month, amount)}
                            />
                          </NumberCell>
                          <NumberCell>
                            <ActualCell
                              line={row.line}
                              month={month}
                              cell={row.cells[0] ?? EMPTY_CELL}
                              currency={currency}
                              disabled={query.status !== 'ready'}
                              onOpen={() => {
                                setOpened({ lineId: row.line.id, month });
                              }}
                            />
                          </NumberCell>
                          <NumberCell>
                            <Left
                              value={left(row.cells[0] ?? EMPTY_CELL, section.flow)}
                              currency={currency}
                              flow={section.flow}
                            />
                          </NumberCell>
                        </>
                      ) : (
                        row.cells.map((cell) => (
                          <NumberCell key={cell.month}>
                            {figure === 'plan' ? (
                              <PlanCell
                                line={row.line}
                                month={cell.month}
                                amount={cell.plan}
                                currency={currency}
                                closed={
                                  finance.closedMonths.includes(cell.month) ||
                                  query.status !== 'ready'
                                }
                                onSave={(amount) => savePlan(row.line, cell.month, amount)}
                              />
                            ) : figure === 'actual' ? (
                              <ActualCell
                                line={row.line}
                                month={cell.month}
                                cell={cell}
                                currency={currency}
                                disabled={query.status !== 'ready'}
                                onOpen={() => {
                                  setOpened({ lineId: row.line.id, month: cell.month });
                                }}
                              />
                            ) : (
                              <button
                                type="button"
                                className={cellButton}
                                disabled={query.status !== 'ready'}
                                onClick={() => {
                                  onMonth(cell.month);
                                }}
                              >
                                <span className="sr-only">
                                  Open {formatMonth(cell.month, 'long')} for {row.line.name}:{' '}
                                </span>
                                <Money amount={value(cell, section.flow)} currency={currency} />
                              </button>
                            )}
                          </NumberCell>
                        ))
                      )}
                    </tr>
                  ))}
                </tbody>
              ))}
              <tfoot>
                {span === 'month' ? (
                  <Totals grid={grid} currency={currency} accountName={accountName} />
                ) : (
                  <>
                    <tr className="border-t border-divider">
                      <th scope="row" colSpan={2} className="py-2 pr-3 text-left">
                        <Text as="span" variant="bodySmall" className="font-medium">
                          {accountName === undefined ? 'Net' : `Net on ${accountName}`}
                        </Text>
                      </th>
                      {grid.totals.map((totals) => (
                        <NumberCell key={totals.month}>
                          <Money
                            amount={
                              figure === 'plan'
                                ? totals.plan.net
                                : figure === 'actual'
                                  ? totals.actual.net
                                  : totals.actual.net - totals.plan.net
                            }
                            currency={currency}
                            signed={figure === 'left'}
                          />
                        </NumberCell>
                      ))}
                    </tr>
                    <tr>
                      <th scope="row" colSpan={2} className="py-2 pr-3 text-left">
                        <Text as="span" variant="bodySmall" tone="muted">
                          Cumulative net since {formatMonth(finance.settings.startMonth)}
                        </Text>
                      </th>
                      {grid.totals.map((totals) => (
                        <NumberCell key={totals.month}>
                          <Money
                            amount={
                              figure === 'actual'
                                ? totals.cumulativeNetActual
                                : totals.cumulativeNetPlan
                            }
                            currency={currency}
                          />
                        </NumberCell>
                      ))}
                    </tr>
                  </>
                )}
              </tfoot>
            </table>
          </ScrollRegion>
        </>
      )}
      <LineDialog
        state={state}
        finance={finance}
        line={editing === 'new' || editing === null ? null : editing}
        open={editing !== null}
        onClose={() => {
          setEditing(null);
        }}
      />
      {opened === null || openedRow === undefined || openedCell === undefined ? null : (
        <BudgetActualDialog
          state={state}
          finance={finance}
          line={openedRow.line}
          month={opened.month}
          cell={openedCell}
          onClose={() => {
            setOpened(null);
          }}
        />
      )}
    </div>
  );
}

const EMPTY_CELL: BudgetCell = { month: '', plan: 0, actual: 0, variance: 0, transactions: 0 };

/**
 * A figure that can be acted on. It sits in the same place as the plain figures around it, and
 * only the wash on hover and the ring on focus say it is a control, so the column still reads as
 * a column of numbers.
 */
const cellButton = cn(
  '-mx-1 rounded px-1 py-0.5 text-right tabular-nums transition-colors any-pointer-coarse:min-h-(--control-lg) any-pointer-coarse:min-w-(--control-lg)',
  // A dotted rule beneath says at rest that the figure is a control; the ring is inset because
  // the last column sits against the edge of a horizontal scroll clip.
  'underline decoration-dotted decoration-divider underline-offset-4',
  inkWashStates,
  focusRingInset,
);

/** Spending left against the plan, or income surplus/shortfall against it. */
function left(cell: BudgetCell, flow: 'income' | 'expense') {
  return flow === 'income' ? cell.variance : -cell.variance;
}

function NumberHeader({ label }: { readonly label: string }): ReactNode {
  return (
    <th scope="col" className="py-2 pl-3 text-right">
      <Text as="span" variant="caption" tone="muted">
        {label}
      </Text>
    </th>
  );
}

function NumberCell({ children }: { readonly children: ReactNode }): ReactNode {
  return (
    <td className="py-2 pl-3 text-right">
      <Text as="span" variant="bodySmall">
        {children}
      </Text>
    </td>
  );
}

/**
 * A line's plan for one month, edited where it is shown. Enter or leaving the field saves;
 * Escape puts the figure back and focus returns to it. A loan line's plan is its instalment, and
 * a closed month's plan is history, so neither is a control.
 */
function PlanCell({
  line,
  month,
  amount,
  currency,
  closed,
  onSave,
}: {
  readonly line: BudgetLine;
  readonly month: string;
  readonly amount: number;
  readonly currency: string;
  readonly closed: boolean;
  readonly onSave: (amount: number) => Promise<string | null>;
}): ReactNode {
  const [draft, setDraft] = useState<string | null>(null);
  const [problem, setProblem] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);
  const buttonRef = useRef<HTMLButtonElement>(null);
  // Set when the edit ends from the keyboard, so focus goes back to the figure the person was on;
  // a blur means they have already chosen where to go next.
  const returnFocus = useRef(false);
  useEffect(() => {
    if (draft === null && returnFocus.current) {
      returnFocus.current = false;
      buttonRef.current?.focus();
    }
  }, [draft]);
  const context = `Plan for ${line.name} in ${formatMonth(month, 'long')}`;
  if (line.loanAccount !== null) {
    return (
      <span>
        <Money amount={amount} currency={currency} />
        <Text as="span" variant="caption" tone="muted">
          {' '}
          (follows the loan)
        </Text>
      </span>
    );
  }
  if (closed) {
    return <Money amount={amount} currency={currency} />;
  }
  if (draft === null) {
    return (
      <button
        ref={buttonRef}
        type="button"
        className={cellButton}
        onClick={() => {
          setDraft(String(amount));
          setProblem(null);
        }}
      >
        <span className="sr-only">{context}: </span>
        <Money amount={amount} currency={currency} />
        {line.overrides[month] === undefined ? null : (
          <Text as="span" variant="caption" tone="muted">
            {' '}
            (this month)
          </Text>
        )}
      </button>
    );
  }
  return (
    <PlanEditor
      label={context}
      draft={draft}
      problem={problem}
      saving={saving}
      onChange={(next) => {
        setDraft(next);
        setProblem(null);
      }}
      onCancel={() => {
        returnFocus.current = true;
        setDraft(null);
      }}
      onCommit={async (fromKeyboard) => {
        if (saving) return;
        const parsed = parseAmount(draft);
        if (parsed === null || parsed < 0) {
          setProblem('Type an amount of zero or more, such as 250 or 250.50.');
          return;
        }
        if (parsed === amount) {
          returnFocus.current = fromKeyboard;
          setDraft(null);
          return;
        }
        setSaving(true);
        const refusal = await onSave(parsed);
        setSaving(false);
        if (refusal === null) {
          returnFocus.current = fromKeyboard;
          setDraft(null);
        } else {
          setProblem(refusal);
        }
      }}
    />
  );
}

/** The field a plan is typed into, with whatever is wrong with it said beside it. */
function PlanEditor({
  label,
  draft,
  problem,
  saving,
  onChange,
  onCancel,
  onCommit,
}: {
  readonly label: string;
  readonly draft: string;
  readonly problem: string | null;
  readonly saving: boolean;
  readonly onChange: (draft: string) => void;
  readonly onCancel: () => void;
  readonly onCommit: (fromKeyboard: boolean) => Promise<void>;
}): ReactNode {
  const inputRef = useRef<HTMLInputElement>(null);
  const problemId = useId();
  // Escape unmounts a focused field, and a browser may fire blur on the way out; the cancel has
  // to win over the save that blur would otherwise start.
  const cancelled = useRef(false);
  // Focus lands in the field once, when it replaces the figure the person chose.
  useEffect(() => {
    inputRef.current?.focus();
    inputRef.current?.select();
  }, []);
  const onKeyDown = (event: KeyboardEvent<HTMLInputElement>): void => {
    if (event.key === 'Enter') {
      event.preventDefault();
      void onCommit(true);
    } else if (event.key === 'Escape') {
      // The edit's Escape, not the pane's or the overlay's.
      event.preventDefault();
      event.stopPropagation();
      cancelled.current = true;
      onCancel();
    }
  };
  return (
    <span className="inline-flex flex-col items-end gap-1">
      <Input
        ref={inputRef}
        aria-label={label}
        aria-invalid={problem === null ? undefined : true}
        aria-describedby={problem === null ? undefined : problemId}
        aria-busy={saving ? true : undefined}
        readOnly={saving}
        inputMode="decimal"
        className="w-28 text-right"
        value={draft}
        onChange={(event) => {
          onChange(event.target.value);
        }}
        onKeyDown={onKeyDown}
        onBlur={() => {
          if (cancelled.current) return;
          void onCommit(false);
        }}
      />
      {problem === null ? null : (
        <Text as="span" id={problemId} variant="caption" role="alert" className="text-left">
          {problem}
        </Text>
      )}
    </span>
  );
}

/** A line's actual for one month: the figure, how many transactions made it, and a way in. */
function ActualCell({
  line,
  month,
  cell,
  currency,
  onOpen,
  disabled = false,
}: {
  readonly line: BudgetLine;
  readonly month: string;
  readonly cell: BudgetCell;
  readonly currency: string;
  readonly onOpen: () => void;
  readonly disabled?: boolean;
}): ReactNode {
  return (
    <button type="button" className={cellButton} disabled={disabled} onClick={onOpen}>
      <span className="sr-only">
        Actual for {line.name} in {formatMonth(month, 'long')}:{' '}
      </span>
      <Money amount={cell.actual} currency={currency} />
      {cell.transactions > 0 ? (
        <>
          <Text as="span" variant="caption" tone="muted" aria-hidden="true">
            {' '}
            ({String(cell.transactions)})
          </Text>
          <span className="sr-only">
            , {String(cell.transactions)} {cell.transactions === 1 ? 'transaction' : 'transactions'}
          </span>
        </>
      ) : null}
    </button>
  );
}

/** What is left of the plan: for spending, plan minus actual; for income, actual minus plan. */
function Left({
  value,
  currency,
  flow,
}: {
  readonly value: number;
  readonly currency: string;
  readonly flow: 'income' | 'expense';
}): ReactNode {
  if (value < 0) {
    return (
      <span className="flex items-center justify-end gap-1">
        <Money amount={Math.abs(value)} currency={currency} />
        <Tag tone="accent">{flow === 'income' ? 'short' : 'over'}</Tag>
      </span>
    );
  }
  return <Money amount={value} currency={currency} />;
}

function Totals({
  grid,
  currency,
  accountName,
}: {
  readonly grid: BudgetGrid;
  readonly currency: string;
  readonly accountName: string | undefined;
}): ReactNode {
  const totals = grid.totals[0];
  if (totals === undefined) return null;
  const on = accountName === undefined ? '' : ` on ${accountName}`;
  const rows: readonly {
    readonly label: string;
    readonly plan: number;
    readonly actual: number;
    readonly remainder: number;
    readonly signed?: boolean;
    readonly hint?: string;
  }[] = [
    {
      label: 'Paid this month',
      plan: totals.plan.paidThisMonth,
      actual: totals.actual.paidThisMonth,
      remainder: totals.plan.paidThisMonth - totals.actual.paidThisMonth,
      hint: 'Direct debits and debit spending',
    },
    {
      label: 'Card spend, paid next month',
      plan: totals.plan.cardSpend,
      actual: totals.actual.cardSpend,
      remainder: totals.plan.cardSpend - totals.actual.cardSpend,
    },
    {
      label: `Total outgoings${on}`,
      plan: totals.plan.outgoings,
      actual: totals.actual.outgoings,
      remainder: totals.plan.outgoings - totals.actual.outgoings,
    },
    {
      label: `Net${on}`,
      plan: totals.plan.net,
      actual: totals.actual.net,
      remainder: totals.actual.net - totals.plan.net,
      signed: true,
      hint: 'Income less outgoings',
    },
    {
      label: `Cumulative net${on} since ${formatMonth(grid.months[0] ?? '')}`,
      plan: totals.cumulativeNetPlan,
      actual: totals.cumulativeNetActual,
      remainder: totals.cumulativeNetActual - totals.cumulativeNetPlan,
      signed: true,
    },
  ];
  return (
    <>
      {totals.unassignedTransactions > 0 ? (
        <tr className="border-t border-divider">
          <th scope="row" colSpan={2} className="py-2 pr-3 text-left">
            <Text as="span" variant="bodySmall">
              Unassigned
            </Text>
            <Text as="span" variant="caption" tone="muted">
              {' '}
              {String(totals.unassignedTransactions)} with no budget line
            </Text>
          </th>
          <NumberCell>
            <Money amount={0} currency={currency} />
          </NumberCell>
          <NumberCell>
            <Money
              amount={totals.unassignedOutflow - totals.unassignedInflow}
              currency={currency}
            />
          </NumberCell>
          <NumberCell>
            <Left
              value={totals.unassignedInflow - totals.unassignedOutflow}
              currency={currency}
              flow="expense"
            />
          </NumberCell>
        </tr>
      ) : null}
      {rows.map((row) => (
        <tr key={row.label} className="border-t border-divider">
          <th scope="row" colSpan={2} className="py-2 pr-3 text-left">
            <Text as="span" variant="bodySmall" className="font-medium">
              {row.label}
            </Text>
            {row.hint === undefined ? null : (
              <Text as="span" variant="caption" tone="muted">
                {' '}
                {row.hint}
              </Text>
            )}
          </th>
          <NumberCell>
            <Money amount={row.plan} currency={currency} />
          </NumberCell>
          <NumberCell>
            <Money amount={row.actual} currency={currency} />
          </NumberCell>
          <NumberCell>
            <Money amount={row.remainder} currency={currency} signed={row.signed ?? false} />
          </NumberCell>
        </tr>
      ))}
    </>
  );
}
