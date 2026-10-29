import type { BackupRun, BackupStep } from '@nix/api-client';
import { Button, Tag, Text } from '@nix/ui';
import { useEffect, useState, type ReactElement } from 'react';

import {
  EmptyPanel,
  ErrorPanel,
  LoadingPanel,
} from '@nix/web-foundation/components/states/status-panels';
import { formatDateTime, formatRelativeTime } from '@nix/web-foundation/lib/date-format';
import { SettingsSection } from '../shared/settings-section';
import { backupStepFacts } from './backup-facts';
import { useBackupRuns } from './use-backup-runs';

const STEPS: readonly { readonly step: BackupStep; readonly label: string }[] = [
  { step: 'local', label: 'Local' },
  { step: 'offsite', label: 'Off-site' },
];

/** How often an open tab re-reads the clock, so a step that goes overdue is shown without a reload. */
const CLOCK_TICK_MS = 60_000;

function when(run: BackupRun): string {
  const at = new Date(run.finishedAt);
  return `${formatDateTime(at)} (${formatRelativeTime(at)})`;
}

/**
 * Nightly backup results, read-only, for the deployment's operators. Leads with the age of the
 * last success because a backup that never ran leaves no row to be red about. The error is a
 * fixed phrase the backup scripts write; it renders as text, never as markup.
 */
export function BackupsSection(): ReactElement {
  const { status, runs, error, reload } = useBackupRuns();
  const [now, setNow] = useState(() => new Date());
  useEffect(() => {
    const timer = setInterval(() => {
      setNow(new Date());
    }, CLOCK_TICK_MS);
    return () => {
      clearInterval(timer);
    };
  }, []);

  return (
    <SettingsSection
      title="Backups"
      summary="Last night's backup of this deployment, on the server and off-site"
    >
      <details>
        <summary className="min-h-11 cursor-pointer text-sm text-accent-text">
          More<span className="sr-only"> about backups</span>
        </summary>
        <Text variant="note" tone="muted">
          A step is overdue when it has not succeeded in the last 26 hours.
        </Text>
      </details>

      {status === 'loading' ? <LoadingPanel label="backup status" /> : null}
      {status === 'error' ? (
        <ErrorPanel
          title="Backup status could not be loaded"
          detail={error ?? 'Something went wrong reading backup status.'}
          action={
            <Button
              variant="secondary"
              onClick={() => {
                void reload();
              }}
            >
              Try again
            </Button>
          }
        />
      ) : null}
      {status === 'ready' && runs.length === 0 ? (
        <EmptyPanel
          title="No backup has been recorded"
          detail="The nightly backup records a row after each run. If it should have run, check the backup job."
        />
      ) : null}
      {status === 'ready' && runs.length > 0
        ? STEPS.map(({ step, label }) => {
            const facts = backupStepFacts(runs, step, now);
            const never = facts.runCount === 0;
            // Off-site may be unconfigured, so no rows is "never", not a fault. Local must always run.
            const unconfigured = never && step === 'offsite';
            return (
              <div
                key={step}
                role="group"
                aria-label={label}
                className="flex flex-col gap-2 rounded-md border border-divider p-3"
              >
                <div className="flex flex-wrap items-center gap-2">
                  <Text variant="h5" as="h3">
                    {label}
                  </Text>
                  {unconfigured ? (
                    <Tag tone="muted">Never</Tag>
                  ) : facts.stale ? (
                    <Tag tone="accent">Overdue</Tag>
                  ) : (
                    <Tag tone="muted">On schedule</Tag>
                  )}
                </div>
                <dl className="grid gap-x-4 gap-y-1 sm:grid-cols-[8rem_1fr]">
                  <Text as="dt" variant="note" tone="muted">
                    Last success
                  </Text>
                  <Text as="dd" variant="bodySmall">
                    {never
                      ? 'Never'
                      : facts.lastSuccess === null
                        ? `None in the last ${String(facts.runCount)} ${facts.runCount === 1 ? 'run' : 'runs'}`
                        : when(facts.lastSuccess)}
                  </Text>
                  <Text as="dt" variant="note" tone="muted">
                    Last error
                  </Text>
                  <Text as="dd" variant="bodySmall">
                    {facts.lastError === null
                      ? 'None'
                      : `${when(facts.lastError)}: ${facts.lastError.error ?? 'failed'}`}
                  </Text>
                </dl>
              </div>
            );
          })
        : null}
    </SettingsSection>
  );
}
