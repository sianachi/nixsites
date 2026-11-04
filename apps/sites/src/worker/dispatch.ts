import { CoreResponseError, type CoreClient, type Execution } from './core-client.ts';

/**
 * Runs one leased job: keeps the lease alive while the handler works and completes it through
 * Core's dispatch route. Core owns the durable job and its lease; the poller leases it under a
 * fresh execution id and hands it here. A lease lost mid-run leaves the job for the next lease,
 * never a second completion.
 */

export interface LeaseJob {
  readonly id: string;
  readonly tenantId: string;
  readonly workspaceId: string | null;
  readonly actorId: string | null;
  readonly kind: string;
  readonly payload: unknown;
  readonly attempts: number;
  readonly cancellationRequested: boolean;
}

export interface JobState {
  readonly status: string;
  readonly cancellationRequested: boolean;
  readonly leaseOwned: boolean;
  readonly leaseUntil: string | null;
}

/** A failure the handler wants reported with a code, as the Go `jobrunner.JobError`. */
export class JobError extends Error {
  override readonly name = 'JobError';
  readonly code: string;
  readonly retryable: boolean;
  constructor(code: string, detail: string, retryable = false) {
    super(detail);
    this.code = code;
    this.retryable = retryable;
  }
}

export interface JobContext {
  readonly job: LeaseJob;
  readonly execution: Execution;
  /** Aborts when the lease is lost or cancellation is requested. */
  readonly signal: AbortSignal;
}

export type JobHandler = (context: JobContext) => Promise<unknown>;

/** The body of `POST /internal/worker-dispatch/jobs/{id}/complete`. */
export interface JobCompletion {
  readonly owner: string;
  readonly succeeded: boolean;
  readonly retryable: boolean;
  readonly result?: unknown;
  readonly errorCode?: string;
  readonly errorDetail?: string;
}

export type RunOutcome = 'completed' | 'lease_lost' | 'already_settled';

export interface RunnerOptions {
  readonly core: Pick<CoreClient, 'complete' | 'renew' | 'state'>;
  /** Job kind to handler. A kind not listed is failed permanently. */
  readonly handlers: Readonly<Record<string, JobHandler>>;
  readonly leaseSeconds: number;
  readonly renewSeconds: number;
  readonly log?: (message: string, fields?: Record<string, unknown>) => void;
}

const ERROR_CODE = /^[A-Za-z0-9_.-]{1,64}$/;

export class JobRunner {
  private readonly log: (message: string, fields?: Record<string, unknown>) => void;

  private readonly options: RunnerOptions;

  constructor(options: RunnerOptions) {
    this.options = options;
    this.log = options.log ?? (() => undefined);
  }

  /** Runs a job this execution already holds the lease for and completes it. */
  async run(job: LeaseJob, executionId: string): Promise<RunOutcome> {
    const handler = this.options.handlers[job.kind];
    const outcome =
      handler === undefined
        ? {
            value: undefined,
            failure: new JobError('worker_kind_unsupported', `No handler runs ${job.kind}.`),
            leaseLost: false,
            cancelled: false,
          }
        : await this.execute(job, executionId, handler);
    if (outcome.leaseLost) return 'lease_lost';

    let accepted: boolean;
    try {
      accepted = await this.options.core.complete(job.id, this.completion(executionId, outcome));
    } catch (error) {
      this.log('worker job completion failed', { jobId: job.id, error: String(error) });
      return 'lease_lost';
    }
    if (!accepted) {
      // Core already settled the job (cancelled, or a replica's completion won): nothing to redo.
      this.log('worker job completion refused', { jobId: job.id });
      return 'already_settled';
    }
    return 'completed';
  }

  private async execute(job: LeaseJob, executionId: string, handler: JobHandler): Promise<Outcome> {
    const work = new AbortController();
    // A holder rather than two lets: the timer callback writes them while the handler runs.
    const flags = { leaseLost: false, cancelled: false };
    const { core, leaseSeconds, renewSeconds } = this.options;

    const timer = setInterval(() => {
      void (async () => {
        try {
          const state = await core.state(job.id, executionId, work.signal);
          if (!state?.leaseOwned) {
            flags.leaseLost = true;
          } else if (state.cancellationRequested) {
            flags.cancelled = true;
          } else if (!(await core.renew(job.id, executionId, leaseSeconds, work.signal))) {
            flags.leaseLost = true;
          }
        } catch {
          // A failed lease check is a lost lease: the work must not outlive what protects it.
          flags.leaseLost = true;
        }
        if (flags.leaseLost || flags.cancelled) work.abort();
      })();
    }, renewSeconds * 1000);

    let value: unknown;
    let failure: unknown = null;
    try {
      value = await handler({
        job,
        execution: { jobId: job.id, executionId },
        signal: work.signal,
      });
    } catch (error) {
      failure = error;
    } finally {
      clearInterval(timer);
    }

    if (failure instanceof CoreResponseError && failure.status === 409 && !flags.leaseLost) {
      // A 409 is "your lease is gone" or a refusal of this particular request. Ask Core which.
      try {
        const state = await core.state(job.id, executionId);
        if (!state?.leaseOwned) flags.leaseLost = true;
      } catch {
        flags.leaseLost = true;
      }
    }
    work.abort();
    return { value, failure, leaseLost: flags.leaseLost, cancelled: flags.cancelled };
  }

  private completion(executionId: string, outcome: Outcome): JobCompletion {
    if (outcome.cancelled) {
      return {
        owner: executionId,
        succeeded: false,
        retryable: false,
        errorCode: 'job_cancelled',
        errorDetail: 'The job was cancelled.',
      };
    }
    if (outcome.failure === null) {
      return {
        owner: executionId,
        succeeded: true,
        retryable: false,
        ...(outcome.value === undefined ? {} : { result: outcome.value }),
      };
    }
    const failure = outcome.failure;
    let code = 'worker_failed';
    let detail = 'The worker could not complete the job.';
    let retryable = false;
    if (failure instanceof JobError) {
      code = failure.code;
      detail = failure.message;
      retryable = failure.retryable;
    } else if (failure instanceof CoreResponseError) {
      code = 'core_refused';
      detail = `Core refused a request${failure.code === null ? '' : ` (${failure.code})`}: ${failure.detail}`;
    }
    if (!ERROR_CODE.test(code)) code = 'worker_failed';
    return {
      owner: executionId,
      succeeded: false,
      retryable,
      errorCode: code,
      errorDetail: detail.slice(0, 2000),
    };
  }
}

interface Outcome {
  readonly value: unknown;
  readonly failure: unknown;
  readonly leaseLost: boolean;
  readonly cancelled: boolean;
}
