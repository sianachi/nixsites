import { Button, Icon, Text } from '@nix/ui';
import type { Finance } from '@nix/api-client';
import { TriangleAlert } from 'lucide-react';
import { useState, type ReactNode } from 'react';
import {
  EmptyPanel,
  ErrorPanel,
  LoadingPanel,
} from '@nix/web-foundation/components/states/status-panels';
import type { View } from '@nix/web-collections/core/container-model';
import type { ContainerData } from '@nix/web-collections/core/use-container';
import { CloseMonthDialog } from './close-month-dialog';
import { FinanceAccounts } from './finance-accounts';
import { FinanceBudget } from './finance-budget';
import { FinanceCashFlow } from './finance-cashflow';
import { FinanceDashboard } from './finance-dashboard';
import { SettingsDialog } from './finance-setup';
import { MonthNav } from './finance-shared';
import { FinanceTransactions, QuickAddDialog } from './finance-transactions';
import { useFinance, type FinanceState } from './use-finance';

export interface FinanceViewProps {
  readonly container: ContainerData;
  readonly view: View;
  readonly onOpen: (itemId: string) => void;
}

export type FinanceSection = 'dashboard' | 'budget' | 'transactions' | 'accounts' | 'cashflow';

const SECTIONS: readonly { readonly value: FinanceSection; readonly label: string }[] = [
  { value: 'dashboard', label: 'Overview' },
  { value: 'budget', label: 'Budget' },
  { value: 'transactions', label: 'History' },
  { value: 'accounts', label: 'Accounts' },
  { value: 'cashflow', label: 'Cash flow' },
];

/**
 * The finance module as one view over its root item.
 *
 * Every figure on screen comes from Core; the view chooses a month and a section and asks. The
 * month is shared across sections so switching from the budget to the accounts keeps the reader
 * in the same month, and it is clamped to the plan's horizon because Core refuses a month
 * outside it.
 */
export function FinanceView({ container }: FinanceViewProps): ReactNode {
  const state = useFinance(container.itemId);
  const [section, setSection] = useState<FinanceSection>('dashboard');
  // The chosen month, or the current one until the person chooses; derived, so a root that
  // finishes loading does not need an effect to pick a month.
  const [chosen, setMonth] = useState<string | null>(null);
  const [quickAdd, setQuickAdd] = useState(false);
  const [closing, setClosing] = useState(false);
  const [settings, setSettings] = useState(false);
  const [historyFilter, setHistoryFilter] = useState<{
    lineId?: string;
    accountId?: string;
    unassigned?: boolean;
  }>({});
  const selectedMonth = chosen ?? state.finance?.currentMonth ?? null;

  if (state.status === 'loading') {
    return <LoadingPanel label="finances" />;
  }
  if (state.status === 'error') {
    return (
      <ErrorPanel
        title="The finances could not be loaded"
        detail={state.error ?? 'Try again in a moment.'}
        action={
          <Button variant="secondary" onClick={state.reload}>
            Try again
          </Button>
        }
      />
    );
  }
  if (state.status === 'unconfigured' || state.finance === null || selectedMonth === null) {
    return (
      <>
        <EmptyPanel
          title="Set up your finances"
          detail="Choose a currency, the first month of the plan and the cash you are starting with. Nix creates the containers for accounts, budget lines and transactions under this item."
          action={
            <Button
              onClick={() => {
                setSettings(true);
              }}
            >
              Set up
            </Button>
          }
        />
        <SettingsDialog
          state={state}
          finance={null}
          open={settings}
          onClose={() => {
            setSettings(false);
          }}
        />
      </>
    );
  }
  const finance: Finance = state.finance;
  const month =
    selectedMonth < finance.settings.startMonth
      ? finance.settings.startMonth
      : selectedMonth > finance.settings.endMonth
        ? finance.settings.endMonth
        : selectedMonth;
  const closed = finance.closedMonths.includes(month);
  return (
    <section
      className="@container flex min-w-0 flex-col gap-6"
      aria-labelledby="finance-title"
      aria-busy={state.refreshing}
    >
      {state.refreshError === null ? null : (
        <div
          role="alert"
          className="flex flex-wrap items-start gap-2 rounded-md border border-divider p-3"
        >
          <Icon icon={TriangleAlert} className="size-4 text-accent-text" />
          <Text variant="note" as="span" tone="accent">
            {state.refreshError} The figures may be out of date.
          </Text>
          <Button variant="secondary" onClick={state.reload}>
            Retry
          </Button>
        </div>
      )}
      <header className="flex min-w-0 flex-col gap-3 @3xl:flex-row @3xl:items-center @3xl:justify-between">
        <Text as="h2" variant="h4" id="finance-title" className="sr-only">
          Finances
        </Text>
        <MonthNav
          month={month}
          min={finance.settings.startMonth}
          max={finance.settings.endMonth}
          onChange={setMonth}
          current={finance.currentMonth}
        />
        <div className="flex min-w-0 flex-wrap gap-2">
          {section === 'transactions' ? null : (
            <Button
              onClick={() => {
                setQuickAdd(true);
              }}
            >
              Add transaction
            </Button>
          )}
          <Button
            variant="secondary"
            onClick={() => {
              setClosing(true);
            }}
          >
            {closed ? 'Reopen month' : 'Close month'}
          </Button>
          <Button
            variant="secondary"
            onClick={() => {
              setSettings(true);
            }}
          >
            Settings
          </Button>
        </div>
      </header>
      {closed ? (
        <Text variant="bodySmall" tone="muted" role="status">
          Closed month. Reopen it to make a correction.
        </Text>
      ) : null}
      {finance.problems.length === 0 ? null : (
        <div role="alert" className="rounded-lg border border-divider bg-surface-raised p-3">
          <Text as="p" variant="bodySmall">
            Some records could not be read and are left out of every figure:
          </Text>
          <ul className="list-disc pl-5">
            {finance.problems.map((problem) => (
              <Text as="li" key={problem} variant="bodySmall" tone="muted">
                {problem}
              </Text>
            ))}
          </ul>
        </div>
      )}
      <nav
        aria-label="Finance section"
        className="flex gap-2 overflow-x-auto border-b border-divider pb-3"
      >
        {SECTIONS.map((option) => (
          <Button
            key={option.value}
            variant={section === option.value ? 'primary' : 'ghost'}
            className="shrink-0 whitespace-nowrap"
            aria-current={section === option.value ? 'page' : undefined}
            onClick={() => {
              setSection(option.value);
              if (option.value === 'transactions') setHistoryFilter({});
            }}
          >
            {option.label}
          </Button>
        ))}
      </nav>
      <FinanceSectionBody
        section={section}
        state={state}
        finance={finance}
        month={month}
        onMonth={setMonth}
        onSection={setSection}
        historyFilter={historyFilter}
        onHistory={(filter) => {
          setHistoryFilter(filter);
          setSection('transactions');
        }}
      />
      <QuickAddDialog
        state={state}
        finance={finance}
        month={month}
        open={quickAdd}
        onClose={() => {
          setQuickAdd(false);
        }}
      />
      <CloseMonthDialog
        state={state}
        finance={finance}
        month={month}
        open={closing}
        onClose={() => {
          setClosing(false);
        }}
      />
      <SettingsDialog
        state={state}
        finance={finance}
        open={settings}
        onClose={() => {
          setSettings(false);
        }}
      />
    </section>
  );
}

function FinanceSectionBody({
  section,
  state,
  finance,
  month,
  onMonth,
  onSection,
  historyFilter,
  onHistory,
}: {
  readonly section: FinanceSection;
  readonly state: FinanceState;
  readonly finance: Finance;
  readonly month: string;
  readonly onMonth: (month: string) => void;
  readonly onSection: (section: FinanceSection) => void;
  readonly historyFilter: { lineId?: string; accountId?: string; unassigned?: boolean };
  readonly onHistory: (filter: {
    lineId?: string;
    accountId?: string;
    unassigned?: boolean;
  }) => void;
}): ReactNode {
  switch (section) {
    case 'dashboard':
      return (
        <FinanceDashboard
          state={state}
          finance={finance}
          month={month}
          onSection={onSection}
          onHistory={onHistory}
        />
      );
    case 'budget':
      return <FinanceBudget state={state} finance={finance} month={month} onMonth={onMonth} />;
    case 'transactions':
      return (
        <FinanceTransactions
          key={`${historyFilter.lineId ?? ''}:${historyFilter.accountId ?? ''}:${String(historyFilter.unassigned ?? false)}`}
          state={state}
          finance={finance}
          month={month}
          initialLineId={historyFilter.lineId}
          initialAccountId={historyFilter.accountId}
          initialUnassigned={historyFilter.unassigned}
        />
      );
    case 'accounts':
      return <FinanceAccounts state={state} finance={finance} month={month} />;
    case 'cashflow':
      return (
        <FinanceCashFlow
          state={state}
          finance={finance}
          month={month}
          onMonth={(selected) => {
            onMonth(selected);
            onSection('dashboard');
          }}
        />
      );
  }
}
