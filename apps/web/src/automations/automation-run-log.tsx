import type { AutomationRunResponse as AutomationRun } from '@nix/api-client';
import { Button, Tag, Text, cn, focusRing, type TagTone } from '@nix/ui';
import type { ReactNode } from 'react';
import { Link } from 'react-router';

import { formatDateTime } from '@nix/web-foundation/lib/date-format';
import { describeRunOrigin, describeRunReason, describeRunStatus } from './automation-draft';

/**
 * A rule's runs, newest first, with every reason code said in words.
 *
 * Core keeps at most 500 runs a rule and none older than 30 days, and a skip reason it adds later
 * (a lock, say) still reaches this list as a code - rendered as "Stopped with reason code ..."
 * rather than dropped, so a new reason is visible the day it ships.
 */

export interface AutomationRunLogProps {
  readonly status: 'loading' | 'ready' | 'error';
  readonly runs: readonly AutomationRun[];
  readonly error: string | null;
  readonly hasMore: boolean;
  readonly loadingMore: boolean;
  readonly onLoadMore: () => void;
  readonly onRetry: () => void;
  /** Where an item mentioned by a run opens. */
  readonly itemHref: (itemId: string) => string;
}

function statusTone(status: string): TagTone {
  if (status === 'succeeded') return 'accent';
  if (status === 'failed') return 'neutral';
  return 'muted';
}

export function AutomationRunLog(props: AutomationRunLogProps): ReactNode {
  const { status, runs, error, hasMore, loadingMore, onLoadMore, onRetry, itemHref } = props;

  return (
    <section aria-labelledby="automation-runs-heading" className="flex min-w-0 flex-col gap-3">
      <Text id="automation-runs-heading" variant="h6" as="h3">
        Run log
      </Text>
      {status === 'loading' ? <Text role="status">Loading the run log…</Text> : null}
      {status === 'error' ? (
        <div className="flex flex-wrap items-center gap-2">
          <Text variant="note" role="alert">
            {error ?? 'The run log could not be loaded.'}
          </Text>
          <Button type="button" variant="secondary" onClick={onRetry}>
            Try again
          </Button>
        </div>
      ) : null}
      {status === 'ready' && runs.length === 0 ? (
        <Text variant="note" tone="muted">
          This automation has not run yet. Runs are kept for 30 days.
        </Text>
      ) : null}
      {runs.length > 0 ? (
        <ol aria-label="Runs, newest first" className="flex flex-col divide-y divide-divider">
          {runs.map((run) => (
            <li key={run.id} className="flex min-w-0 flex-col gap-1 py-2 wrap-anywhere">
              <div className="flex flex-wrap items-center gap-2">
                <Tag tone={statusTone(run.status)}>{describeRunStatus(run.status)}</Tag>
                <Text variant="note" as="span">
                  {formatDateTime(new Date(run.createdAt))}
                </Text>
                <Text variant="caption" as="span" tone="muted">
                  {describeRunOrigin(run.origin)}
                </Text>
              </div>
              {run.reason === null ? null : (
                <Text variant="note" tone="muted">
                  {describeRunReason(run.reason)}
                </Text>
              )}
              {run.itemId === null ? null : (
                <Link to={itemHref(run.itemId)} className={cn('w-fit underline', focusRing)}>
                  <Text variant="note" as="span" tone="accent">
                    Open the item
                  </Text>
                </Link>
              )}
            </li>
          ))}
        </ol>
      ) : null}
      {status === 'ready' && error !== null ? (
        <Text variant="note" role="alert">
          {error}
        </Text>
      ) : null}
      {hasMore ? (
        <div>
          <Button type="button" variant="secondary" disabled={loadingMore} onClick={onLoadMore}>
            {loadingMore ? 'Loading older runs…' : 'Show older runs'}
          </Button>
        </div>
      ) : null}
    </section>
  );
}
