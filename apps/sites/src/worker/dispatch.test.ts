import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { CoreResponseError } from './core-client.ts';
import {
  JobError,
  JobRunner,
  type JobCompletion,
  type JobHandler,
  type JobState,
  type LeaseJob,
} from './dispatch.ts';

const JOB = '10000000-0000-4000-8000-000000000001';
const EXECUTION = 'sites-test:0b8f6a3e-0000-4000-8000-000000000000';
const job: LeaseJob = {
  id: JOB,
  tenantId: 't',
  workspaceId: 'w',
  actorId: 'a',
  kind: 'site.build',
  payload: {},
  attempts: 1,
  cancellationRequested: false,
};
const owned: JobState = {
  status: 'running',
  cancellationRequested: false,
  leaseOwned: true,
  leaseUntil: null,
};

function setup(overrides: {
  state?: () => Promise<JobState | null>;
  renew?: () => Promise<boolean>;
  handler?: JobHandler;
  complete?: (completion: JobCompletion) => Promise<boolean>;
}) {
  const completed: JobCompletion[] = [];
  const runner = new JobRunner({
    core: {
      state: overrides.state ?? (() => Promise.resolve(owned)),
      renew: overrides.renew ?? (() => Promise.resolve(true)),
      complete: async (_jobId, completion) => {
        const accepted = (await overrides.complete?.(completion)) ?? true;
        completed.push(completion);
        return accepted;
      },
    },
    handlers: { 'site.build': overrides.handler ?? (() => Promise.resolve({ ok: true })) },
    leaseSeconds: 60,
    renewSeconds: 20,
  });
  return { runner, completed };
}

beforeEach(() => vi.useFakeTimers());
afterEach(() => vi.useRealTimers());

describe('JobRunner', () => {
  it('runs a leased job and completes it under the leasing execution', async () => {
    const { runner, completed } = setup({});
    expect(await runner.run(job, EXECUTION)).toBe('completed');
    expect(completed).toEqual([
      { owner: EXECUTION, succeeded: true, retryable: false, result: { ok: true } },
    ]);
  });

  it('fails a kind it has no handler for without retrying', async () => {
    const { runner, completed } = setup({});
    expect(await runner.run({ ...job, kind: 'site.other' }, EXECUTION)).toBe('completed');
    expect(completed[0]).toMatchObject({
      succeeded: false,
      retryable: false,
      errorCode: 'worker_kind_unsupported',
    });
  });

  it('aborts the work and completes nothing when the lease is lost', async () => {
    let aborted = false;
    const { runner, completed } = setup({
      state: () => Promise.resolve({ ...owned, leaseOwned: false }),
      handler: ({ signal }) =>
        new Promise((_resolve, reject) => {
          signal.addEventListener('abort', () => {
            aborted = true;
            reject(new Error('aborted'));
          });
        }),
    });
    const pending = runner.run(job, EXECUTION);
    await vi.advanceTimersByTimeAsync(20_000);
    expect(await pending).toBe('lease_lost');
    expect(aborted).toBe(true);
    expect(completed).toHaveLength(0);
  });

  it('renews on each interval while the work runs', async () => {
    const renew = vi.fn(() => Promise.resolve(true));
    let finish: () => void = () => undefined;
    const { runner } = setup({
      renew,
      handler: () =>
        new Promise(
          (resolve) =>
            (finish = () => {
              resolve(null);
            }),
        ),
    });
    const pending = runner.run(job, EXECUTION);
    await vi.advanceTimersByTimeAsync(41_000);
    finish();
    expect(await pending).toBe('completed');
    expect(renew).toHaveBeenCalledTimes(2);
  });

  it('reports a requested cancellation as job_cancelled', async () => {
    const { runner, completed } = setup({
      state: () => Promise.resolve({ ...owned, cancellationRequested: true }),
      handler: ({ signal }) =>
        new Promise((_resolve, reject) => {
          signal.addEventListener('abort', () => {
            reject(new Error('aborted'));
          });
        }),
    });
    const pending = runner.run(job, EXECUTION);
    await vi.advanceTimersByTimeAsync(20_000);
    expect(await pending).toBe('completed');
    expect(completed[0]).toMatchObject({ succeeded: false, errorCode: 'job_cancelled' });
  });

  it('reports a handler error with its code, and falls back for an invalid code', async () => {
    const coded = setup({
      handler: () => Promise.reject(new JobError('site_body_withheld', 'a body was withheld')),
    });
    await coded.runner.run(job, EXECUTION);
    expect(coded.completed[0]).toMatchObject({
      succeeded: false,
      retryable: false,
      errorCode: 'site_body_withheld',
      errorDetail: 'a body was withheld',
    });
    const bad = setup({ handler: () => Promise.reject(new JobError('has a space', 'x')) });
    await bad.runner.run(job, EXECUTION);
    expect(bad.completed[0]).toMatchObject({ errorCode: 'worker_failed' });
    const unknown = setup({ handler: () => Promise.reject(new Error('secret internals')) });
    await unknown.runner.run(job, EXECUTION);
    expect(unknown.completed[0]).toMatchObject({
      errorCode: 'worker_failed',
      errorDetail: 'The worker could not complete the job.',
    });
  });

  it('treats a 409 as lost only when Core no longer says the lease is owned', async () => {
    const refusal = () =>
      Promise.reject(new CoreResponseError(409, 'sites.build_closed', 'closed'));
    const stillOwned = setup({ handler: refusal });
    expect(await stillOwned.runner.run(job, EXECUTION)).toBe('completed');
    expect(stillOwned.completed[0]).toMatchObject({ succeeded: false, errorCode: 'core_refused' });
    const lost = setup({
      handler: refusal,
      state: () => Promise.resolve({ ...owned, leaseOwned: false }),
    });
    expect(await lost.runner.run(job, EXECUTION)).toBe('lease_lost');
    expect(lost.completed).toHaveLength(0);
  });

  it('reports a completion Core refused as already settled', async () => {
    const { runner } = setup({ complete: () => Promise.resolve(false) });
    expect(await runner.run(job, EXECUTION)).toBe('already_settled');
  });

  it('reports a completion that could not reach Core as a lost lease', async () => {
    const { runner } = setup({ complete: () => Promise.reject(new Error('down')) });
    expect(await runner.run(job, EXECUTION)).toBe('lease_lost');
  });
});
