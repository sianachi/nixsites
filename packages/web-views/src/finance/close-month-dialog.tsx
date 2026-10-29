import { Button, Dialog, Text } from '@nix/ui';
import { finance as financeApi, type Finance, type MonthChecklist } from '@nix/api-client';
import { useMemo, useState, type ReactNode } from 'react';
import { LoadingPanel } from '@nix/web-foundation/components/states/status-panels';
import { Money, WriteError } from './finance-shared';
import { formatMonth } from './money';
import { useFinanceQuery, type FinanceState } from './use-finance';

/**
 * Closing a month is what typing "y" on the workbook's Actual sheet used to be: from here on the
 * month reads from its transactions and every later month re-chains. The dialog shows what
 * would be left unresolved, and offers to post the direct debits that have not been posted, but
 * it does not refuse to close over them; a month can be reopened.
 */
export function CloseMonthDialog({
  state,
  finance,
  month,
  open,
  onClose,
}: {
  readonly state: FinanceState;
  readonly finance: Finance;
  readonly month: string;
  readonly open: boolean;
  readonly onClose: () => void;
}): ReactNode {
  const closed = finance.closedMonths.includes(month);
  const currency = finance.settings.currency;
  const itemId = finance.itemId;
  const endpoint = useMemo(
    () => (open ? financeApi.readMonth(itemId, month) : null),
    [itemId, month, open],
  );
  const query = useFinanceQuery<MonthChecklist>(endpoint, state.generation);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [posted, setPosted] = useState<string | null>(null);

  const act = async (nextClosed: boolean): Promise<void> => {
    setBusy(true);
    const refusal = await state.setMonth(month, nextClosed);
    setBusy(false);
    setError(refusal);
    if (refusal === null) onClose();
  };
  const post = async (): Promise<void> => {
    setBusy(true);
    const outcome = await state.postScheduled(month);
    setBusy(false);
    if (typeof outcome === 'string') {
      setError(outcome);
      return;
    }
    setError(null);
    setPosted(
      outcome.posted.length === 0
        ? 'Everything scheduled was already posted.'
        : `Posted ${String(outcome.posted.length)} scheduled ${outcome.posted.length === 1 ? 'line' : 'lines'}.`,
    );
  };

  const checklist = query.data;
  return (
    <Dialog
      open={open}
      title={
        closed ? `Reopen ${formatMonth(month, 'long')}?` : `Close ${formatMonth(month, 'long')}?`
      }
      onClose={onClose}
      actions={
        <>
          <Button type="button" variant="secondary" onClick={onClose}>
            Not yet
          </Button>
          <Button
            type="button"
            disabled={busy}
            onClick={() => {
              void act(!closed);
            }}
          >
            {closed ? 'Reopen month' : 'Close month'}
          </Button>
        </>
      }
    >
      <div className="@container flex min-w-0 flex-col gap-4">
        {checklist === null ? (
          query.status === 'error' ? (
            <Text as="p" variant="bodySmall" role="alert">
              {query.error}
            </Text>
          ) : (
            <LoadingPanel label="the month's checklist" />
          )
        ) : (
          <>
            <ul className="flex flex-col gap-2">
              <ChecklistRow
                ok={checklist.scheduledUnposted === 0}
                text={
                  checklist.scheduledUnposted === 0
                    ? `${String(checklist.scheduledPosted)} scheduled ${checklist.scheduledPosted === 1 ? 'line' : 'lines'} posted`
                    : `${String(checklist.scheduledUnposted)} scheduled ${checklist.scheduledUnposted === 1 ? 'line' : 'lines'} not posted yet`
                }
                action={
                  checklist.scheduledUnposted === 0 || closed ? undefined : (
                    <Button
                      type="button"
                      variant="secondary"
                      disabled={busy}
                      onClick={() => {
                        void post();
                      }}
                    >
                      Post them
                    </Button>
                  )
                }
              />
              <ChecklistRow
                ok={checklist.unassignedTransactions === 0}
                text={
                  checklist.unassignedTransactions === 0 ? (
                    'Every transaction has a budget line'
                  ) : (
                    <>
                      {String(checklist.unassignedTransactions)}{' '}
                      {checklist.unassignedTransactions === 1 ? 'transaction' : 'transactions'} with
                      no budget line,{' '}
                      <Money amount={checklist.unassignedOutflow} currency={currency} /> out
                    </>
                  )
                }
              />
              <ChecklistRow
                ok={checklist.overPlan.length === 0}
                text={
                  checklist.overPlan.length === 0
                    ? 'Nothing over its plan'
                    : `${String(checklist.overPlan.length)} ${checklist.overPlan.length === 1 ? 'line' : 'lines'} over plan: ${checklist.overPlan
                        .map((item) => item.name)
                        .join(', ')}`
                }
              />
            </ul>
            <Text as="p" variant="bodySmall" tone="muted">
              Planned net <Money amount={checklist.plan.net} currency={currency} />, actual net{' '}
              <Money amount={checklist.actual.net} currency={currency} />.{' '}
              {closed
                ? 'Reopening switches the month back to its plan in the cash flow until it is closed again.'
                : 'Closing switches the month from plan to actual in the cash flow; every later month recalculates. Nothing can be recorded into a closed month until it is reopened.'}
            </Text>
          </>
        )}
        {posted === null ? null : (
          <Text as="p" variant="bodySmall" role="status">
            {posted}
          </Text>
        )}
        <WriteError message={error} />
      </div>
    </Dialog>
  );
}

function ChecklistRow({
  ok,
  text,
  action,
}: {
  readonly ok: boolean;
  readonly text: ReactNode;
  readonly action?: ReactNode;
}): ReactNode {
  return (
    <li className="flex min-w-0 flex-col items-start justify-between gap-3 rounded-lg bg-surface-raised p-3 @sm:flex-row @sm:items-center">
      <Text as="span" variant="bodySmall" tone={ok ? 'muted' : 'default'}>
        {ok ? 'Done: ' : 'Open: '}
        {text}
      </Text>
      {action}
    </li>
  );
}
