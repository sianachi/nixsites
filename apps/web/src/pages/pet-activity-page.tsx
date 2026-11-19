import { Button, Text, focusRing } from '@nix/ui';
import type { PetRunResponse } from '@nix/api-client';
import type { ReactElement, ReactNode } from 'react';
import { Link } from 'react-router';
import {
  EmptyPanel,
  ErrorPanel,
  LoadingPanel,
} from '@nix/web-foundation/components/states/status-panels';
import { paneScroller } from '@nix/web-foundation/layout/regions';
import { useWorkspace } from '@nix/web-workspaces/workspaces/workspace-context';
import { petRunStatusText } from '../panel/pet-run-card';
import { usePetRunFeed } from '../panel/use-pet-run-feed';
import { petJobHref } from './editor/pet-job-routing';

const waiting = new Set(['waiting_for_input', 'waiting_for_approval', 'review_required']);
const active = new Set(['queued', 'running', 'waiting_for_handoff']);

function ActivityRow({ run }: { readonly run: PetRunResponse }): ReactElement {
  const proposal = run.status === 'waiting_for_approval' ? run.proposals.at(-1) : undefined;
  const needsReview = proposal?.status === 'pending' || proposal?.status === 'stale';
  const decisionId =
    run.status === 'waiting_for_input' ? run.question?.id : needsReview ? proposal.id : undefined;
  const status =
    proposal?.status === 'stale' ? 'Draft needs refresh' : petRunStatusText(run.status);
  const firstLine = run.brief.trim().split(/\r?\n/, 1)[0] ?? '';
  const title = firstLine.length === 0 ? 'Pet job' : firstLine;
  const summary = title.length > 160 ? `${title.slice(0, 159).trimEnd()}…` : title;

  return (
    <li className="min-w-0 border-b border-divider">
      <Link
        to={petJobHref(run.workspaceId, run.itemId, run.id, decisionId)}
        className={`flex min-w-0 flex-wrap items-baseline justify-between gap-x-4 gap-y-1 px-2 py-2 hover:bg-surface ${focusRing}`}
      >
        <Text as="span" className="min-w-0 flex-1 break-words">
          {summary}
        </Text>{' '}
        <Text as="span" variant="note" tone="muted">
          {status}
        </Text>
      </Link>
    </li>
  );
}

function ActivityFrame({ children }: { readonly children: ReactNode }): ReactElement {
  return (
    <div className={`${paneScroller} flex flex-col gap-4 p-3 sm:p-4`}>
      <Text variant="h3" as="h1">
        Pet activity
      </Text>
      {children}
    </div>
  );
}

export function PetActivityPage(): ReactElement {
  const { workspaceId } = useWorkspace();
  return <PetActivity key={workspaceId} workspaceId={workspaceId} />;
}

function PetActivity({ workspaceId }: { readonly workspaceId: string }): ReactElement {
  const { feed, retry } = usePetRunFeed('workspace', workspaceId);
  if (feed.status === 'loading') {
    return (
      <ActivityFrame>
        <LoadingPanel label="pet activity" />
      </ActivityFrame>
    );
  }
  if (feed.status === 'error') {
    return (
      <ActivityFrame>
        <ErrorPanel
          title="Pet activity could not be loaded"
          detail="Try loading the jobs again."
          action={<Button onClick={retry}>Try again</Button>}
        />
      </ActivityFrame>
    );
  }
  if (feed.status !== 'ready' || !feed.data.enabled) {
    return (
      <ActivityFrame>
        <EmptyPanel
          title="Pet jobs are unavailable"
          detail="Check the companion settings for this workspace."
        />
      </ActivityFrame>
    );
  }
  const groups = [
    { label: 'Needs attention', runs: feed.data.runs.filter((run) => waiting.has(run.status)) },
    { label: 'In progress', runs: feed.data.runs.filter((run) => active.has(run.status)) },
    {
      label: 'Recent jobs',
      runs: feed.data.runs.filter((run) => !waiting.has(run.status) && !active.has(run.status)),
    },
  ];
  return (
    <ActivityFrame>
      {feed.refreshFailed === true ? (
        <Text as="div" variant="note" tone="muted" role="status">
          Could not refresh the jobs. Nix will try again.
        </Text>
      ) : null}
      {feed.data.runs.length === 0 ? (
        <EmptyPanel
          title="No pet jobs yet"
          detail="Open the pet dialog on a task to hand your pet a job."
        />
      ) : (
        groups
          .filter(({ runs }) => runs.length > 0)
          .map(({ label, runs }) => (
            <section key={label} aria-label={label} className="flex min-w-0 flex-col gap-2">
              <Text variant="h5" as="h2">
                {label}
              </Text>
              <ul className="min-w-0">
                {runs.map((run) => (
                  <ActivityRow key={run.id} run={run} />
                ))}
              </ul>
            </section>
          ))
      )}
    </ActivityFrame>
  );
}
