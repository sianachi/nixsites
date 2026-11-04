import { randomUUID } from 'node:crypto';

import type { CoreClient } from './core-client.ts';
import type { JobRunner } from './dispatch.ts';

/**
 * Leases site jobs from Core instead of waiting for a broker hint: every `pollSeconds`, each slot
 * asks `POST /internal/worker-dispatch/jobs/lease` for one job of each kind it runs (the kind
 * match is exact, so a slot never takes another worker's job) and runs it to completion. A lease
 * is the claim, so a restart, a lost hint and a second replica all converge on the same rows.
 */

export interface PollerOptions {
  readonly core: Pick<CoreClient, 'lease'>;
  readonly runner: Pick<JobRunner, 'run'>;
  readonly kinds: readonly string[];
  readonly workerId: string;
  readonly leaseSeconds: number;
  readonly pollSeconds: number;
  readonly concurrency: number;
  readonly log?: (message: string, fields?: Record<string, unknown>) => void;
  /** Injected for tests. */
  readonly newId?: () => string;
}

export class Poller {
  private readonly options: PollerOptions;
  private readonly log: (message: string, fields?: Record<string, unknown>) => void;
  private readonly newId: () => string;

  constructor(options: PollerOptions) {
    this.options = options;
    this.log = options.log ?? (() => undefined);
    this.newId = options.newId ?? randomUUID;
  }

  executionId(): string {
    const id = this.newId();
    const prefix = this.options.workerId.trim().slice(0, 128 - 1 - id.length);
    return `${prefix}:${id}`;
  }

  /** Runs every slot until `signal` aborts; resolves once the running jobs have finished. */
  async run(signal: AbortSignal): Promise<void> {
    const slots: Promise<void>[] = [];
    for (let index = 0; index < this.options.concurrency; index += 1) {
      slots.push(this.slot(signal));
    }
    await Promise.all(slots);
  }

  /** One pass over every kind; true when a job ran. */
  async poll(signal?: AbortSignal): Promise<boolean> {
    let ran = false;
    for (const kind of this.options.kinds) {
      if (signal?.aborted === true) return ran;
      const executionId = this.executionId();
      let jobs;
      try {
        jobs = await this.options.core.lease(kind, executionId, this.options.leaseSeconds, signal);
      } catch (error) {
        this.log('worker lease failed', { kind, error: String(error) });
        continue;
      }
      for (const job of jobs) {
        ran = true;
        const outcome = await this.options.runner.run(job, executionId);
        if (outcome !== 'completed') {
          this.log('worker job not completed by this execution', { jobId: job.id, outcome });
        }
      }
    }
    return ran;
  }

  private async slot(signal: AbortSignal): Promise<void> {
    // A function, not the property: the poll awaits in between, which narrowing cannot see.
    const stopped = (): boolean => signal.aborted;
    while (!stopped()) {
      const ran = await this.poll(signal);
      if (ran || stopped()) continue;
      await new Promise<void>((resolve) => {
        const timer = setTimeout(resolve, this.options.pollSeconds * 1000);
        signal.addEventListener(
          'abort',
          () => {
            clearTimeout(timer);
            resolve();
          },
          { once: true },
        );
      });
    }
  }
}
