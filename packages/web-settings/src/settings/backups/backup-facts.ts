import type { BackupRun, BackupStep } from '@nix/api-client';

/** A nightly job that last succeeded longer ago than this is overdue: a day, plus two hours. */
export const BACKUP_STALE_AFTER_MS = 26 * 60 * 60 * 1000;

export interface BackupStepFacts {
  readonly step: BackupStep;
  /** The newest success in the loaded runs, or null when the window holds none. */
  readonly lastSuccess: BackupRun | null;
  /** The newest failure in the loaded runs, or null. */
  readonly lastError: BackupRun | null;
  /** How many of the loaded runs belong to this step. */
  readonly runCount: number;
  /** No success in the window, or the newest one is older than {@link BACKUP_STALE_AFTER_MS}. */
  readonly stale: boolean;
}

/**
 * What the status screen says about one step. Pure sentences about data, so the section and its
 * tests agree on what "overdue" means. Runs arrive newest first; this does not rely on it.
 */
export function backupStepFacts(
  runs: readonly BackupRun[],
  step: BackupStep,
  now: Date,
): BackupStepFacts {
  const mine = runs
    .filter((run) => run.step === step)
    .toSorted((a, b) => Date.parse(b.startedAt) - Date.parse(a.startedAt));
  const lastSuccess = mine.find((run) => run.status === 'succeeded') ?? null;
  const lastError = mine.find((run) => run.status === 'failed') ?? null;
  const stale =
    lastSuccess === null ||
    now.getTime() - Date.parse(lastSuccess.finishedAt) > BACKUP_STALE_AFTER_MS;
  return { step, lastSuccess, lastError, runCount: mine.length, stale };
}
