import type { PetToolCall } from '@nix/api-client';
import type { WorkspaceToolArgs } from '@nix/companion/tool-args';
import type { StructureFingerprint } from '@nix/companion';
import type { Problem } from '@nix/structure-spec';
import { Button, Icon, Text, cn, focusRing, inkWashStates } from '@nix/ui';
import { ChevronRight } from 'lucide-react';
import { useEffect, useRef, type ReactElement, type RefObject } from 'react';
import type { EditedRequest } from '../approval/edit-request';
import {
  APPLYING_WITHOUT_ASKING,
  DECLINED_BY_USER,
  DECLINED_FOR_PROBLEMS_PREFIX,
  DONE_WITHOUT_ASKING,
  NOT_RUN,
  buildOutcome,
  ranWithoutAsking,
} from './receipts';
import { describeReadSentence, readStatusText } from './read-sentence';

export type Resolver = (
  tool: PetToolCall,
  approved: boolean,
  fence?: StructureFingerprint,
  refusalResult?: string,
  reportProgress?: (completed: number, total: number) => void,
  withoutAsking?: boolean,
  refusalQuotesLockedContent?: boolean,
  edited?: EditedRequest,
) => Promise<boolean>;

/** One quiet line: what happened beside its outcome, with the whole line opening its details. Used for every read - which
 * never needs a decision - and for a write once it has one, so a long turn reads as a list of
 * outcomes rather than a stack of forms. */
function ActivityRow({
  sentence,
  status,
  details,
  detailsLabel = 'Result details',
  detailsExtra,
  actions,
  anchor = false,
  focusOnMount = false,
  rowRef,
}: {
  readonly sentence: string;
  readonly status: string;
  readonly details: string | undefined;
  readonly detailsLabel?: string;
  /** Shown above the text details, inside the same disclosure. */
  readonly detailsExtra?: ReactElement | undefined;
  readonly actions: ReactElement | undefined;
  /** The first thing waiting on the owner: the chat scrolls to its top. */
  readonly anchor?: boolean;
  /** The owner just decided with a click: this row is where they land, once. */
  readonly focusOnMount?: boolean;
  readonly rowRef?: RefObject<HTMLDivElement | null>;
}): ReactElement {
  const ownRef = useRef<HTMLDivElement | null>(null);
  const row = rowRef ?? ownRef;
  useEffect(() => {
    if (focusOnMount) row.current?.focus();
    // eslint-disable-next-line react-hooks/exhaustive-deps -- Justification: focus moves once, on mount, never on a later render.
  }, []);
  const line = (
    <div className="flex min-w-0 flex-1 flex-wrap items-baseline justify-between gap-x-2">
      <Text variant="bodySmall">{sentence}</Text>
      {/* UX fix U16: this word already sits beside its own sentence, which the row re-renders
       * whenever it changes - a second live-region announcement here was redundant noise. */}
      <Text variant="note" tone="muted">
        {status}
      </Text>
    </div>
  );
  return (
    <div
      ref={row}
      // Focusable by script only: after a decision the row is where the owner lands.
      tabIndex={-1}
      data-pet-latest-message={anchor ? '' : undefined}
      className="flex min-w-0 flex-col gap-1 focus:outline-none"
    >
      {details || detailsExtra ? (
        <details className="group">
          <summary
            className={cn(
              'flex cursor-default list-none items-center gap-1 rounded any-pointer-coarse:min-h-(--control-lg)',
              focusRing,
              inkWashStates,
            )}
          >
            <Icon
              icon={ChevronRight}
              size="sm"
              className="shrink-0 text-muted motion-safe:transition-transform group-open:rotate-90"
            />
            {line}
            <Text as="span" variant="note" className="sr-only">
              {detailsLabel}
            </Text>
          </summary>
          {detailsExtra}
          {details ? (
            <Text
              variant="note"
              className="max-h-60 overflow-y-auto overscroll-contain whitespace-pre-wrap wrap-anywhere"
            >
              {details}
            </Text>
          ) : null}
        </details>
      ) : (
        line
      )}
      {actions}
    </div>
  );
}

/** A read, running or done. Never a card: there is nothing here for the
 * owner to approve, only whether it ran. */
export function ReadActivityRow({
  tool,
  args,
  busy,
  autoRun,
  submitted,
  onResolve,
  anchor,
}: {
  readonly anchor: boolean;
  readonly tool: PetToolCall;
  readonly args: WorkspaceToolArgs;
  readonly busy: boolean;
  readonly autoRun: boolean;
  readonly submitted: string | undefined;
  readonly onResolve: Resolver;
}): ReactElement {
  const autoRunKey = useRef('');
  useEffect(() => {
    if (
      !autoRun ||
      tool.status !== 'pending' ||
      submitted ||
      busy ||
      autoRunKey.current === tool.id
    )
      return;
    // Security fix S3: only remember this tool as auto-run once `onResolve` actually started it.
    // A second auto-run read that arrives while the first is still claiming returns early (the
    // lock is held) without ever running - if the key were set beforehand, that second read would
    // never be retried. Leaving it unset here lets this effect fire again once `busy` clears.
    void (async () => {
      const started = await onResolve(tool, true);
      if (started) autoRunKey.current = tool.id;
    })();
  }, [autoRun, tool, submitted, busy, onResolve]);

  const row = useRef<HTMLDivElement | null>(null);
  // The buttons leave with the decision, so focus moves to the row as they are clicked.
  const decide = (approved: boolean) => {
    row.current?.focus();
    void onResolve(tool, approved);
  };
  const needsClick = !autoRun && tool.status === 'pending' && !submitted;
  return (
    <ActivityRow
      sentence={describeReadSentence(tool, args, autoRun)}
      status={readStatusText(tool, autoRun, submitted)}
      details={tool.result || undefined}
      anchor={anchor && needsClick}
      rowRef={row}
      actions={
        needsClick ? (
          <div className="flex flex-wrap gap-2">
            <Button
              variant="primary"
              disabled={busy}
              onClick={() => {
                decide(true);
              }}
            >
              Approve request
            </Button>
            <Button
              variant="ghost"
              disabled={busy}
              onClick={() => {
                decide(false);
              }}
            >
              Decline request
            </Button>
          </div>
        ) : undefined
      }
    />
  );
}

/** UX fix U14: the status word a write's receipt shows, mapped from `tool.status` rather than a
 * raw enum - "Done", never "completed"; "Stopped", never "interrupted" - and never the richer
 * internal receipt text a build or a template save also tracks for its own bookkeeping. */
function writeStatusText(
  tool: PetToolCall,
  declinedForProblems: boolean,
  problemCount: number,
  petName: string,
  submitted: string | undefined,
  incompleteBuild: boolean,
): string {
  if (declinedForProblems)
    return `Sent ${String(problemCount)} problem${problemCount === 1 ? '' : 's'} back to ${petName}`;
  // The receipt says so when the owner's switch, not a click, let this run: a long turn must
  // stay readable as "what ran on its own" against "what I approved", also after reopening.
  const withoutAsking = ranWithoutAsking(submitted);
  switch (tool.status) {
    case 'pending':
      return submitted ?? 'Waiting for your approval';
    case 'claimed':
      return withoutAsking ? APPLYING_WITHOUT_ASKING : 'Applying…';
    case 'completed':
      if (withoutAsking) return submitted ?? DONE_WITHOUT_ASKING;
      return incompleteBuild ? 'Incomplete' : 'Done';
    case 'failed':
      if (tool.result === DECLINED_BY_USER) return 'Declined';
      if (submitted === NOT_RUN) return NOT_RUN;
      return withoutAsking
        ? "Didn't finish (ran without asking) - check your workspace before retrying"
        : "Didn't finish - check your workspace before retrying";
    case 'interrupted':
      return 'Stopped';
  }
}

/** A write once it has an outcome: approved and run, declined, or auto-declined because its
 * preview had problems. The full approval card (rendered inline in `PetWorkToolCard` below) only
 * shows before that - see `isCompactWrite`. */
export function WriteReceiptRow({
  tool,
  headline,
  problems,
  petName,
  submitted,
  progress,
  cleanup,
  applied,
  ownerReason,
  focusOnMount,
}: {
  readonly focusOnMount: boolean;
  readonly tool: PetToolCall;
  /** For a write that was not run: why, in the owner's words. */
  readonly ownerReason?: string | undefined;
  readonly headline: string;
  readonly problems: readonly Problem[];
  /** What a write that ran without asking stored, so the owner can still read it afterwards:
   * the preview they would have approved and every text it carried. */
  readonly applied?: ReactElement | undefined;
  readonly petName: string;
  readonly submitted: string | undefined;
  readonly progress: string | undefined;
  readonly cleanup: ReactElement | null | undefined;
}): ReactElement {
  const declinedForProblems = tool.result.startsWith(DECLINED_FOR_PROBLEMS_PREFIX);
  return (
    <ActivityRow
      sentence={headline}
      status={writeStatusText(
        tool,
        declinedForProblems,
        problems.length,
        petName,
        submitted,
        buildOutcome(tool.result)?.complete === false,
      )}
      details={
        declinedForProblems
          ? problems.map((problem) => problem.message).join('\n')
          : submitted === NOT_RUN
            ? ownerReason
            : tool.result || undefined
      }
      detailsLabel={
        declinedForProblems
          ? 'Show problems'
          : submitted === NOT_RUN
            ? 'Why it did not run'
            : applied
              ? 'What was applied'
              : 'Result details'
      }
      detailsExtra={applied}
      focusOnMount={focusOnMount}
      actions={
        progress || cleanup ? (
          <div className="flex flex-col gap-2">
            {progress ? (
              <Text variant="note" role="status">
                {progress}
              </Text>
            ) : null}
            {cleanup}
          </div>
        ) : undefined
      }
    />
  );
}
