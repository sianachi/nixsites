import type { JobCompletion, LeaseJob, JobState } from './dispatch.ts';

/**
 * Core's `/internal` surface for the sites worker: job dispatch and the lease-bound
 * `worker-executions/sites` routes. Shapes are those of `SiteContracts.cs` / `SiteWorkerEndpoints.cs`
 * (camelCase), not the planning document's.
 */

export class CoreResponseError extends Error {
  override readonly name = 'CoreResponseError';
  readonly status: number;
  /** Core's problem `code` extension when it sent one, e.g. `sites.build_closed`. */
  readonly code: string | null;
  readonly detail: string;
  constructor(status: number, code: string | null, detail: string) {
    super(`Core answered ${String(status)}${code === null ? '' : ` (${code})`}.`);
    this.status = status;
    this.code = code;
    this.detail = detail;
  }
}

export interface SiteWorkerFile {
  readonly fileItemId: string;
  readonly fileVersionId: string;
  readonly sha256: string;
  readonly mediaType: string;
  readonly byteLength: number;
  /** The current version's file name; a download is published under a safe form of it. */
  readonly fileName?: string | null;
  readonly url: string;
  readonly expiresAt: string;
}

export interface SiteWorkerBody {
  readonly sourceUrl: string;
  readonly bearerToken: string;
  readonly expiresAt: string;
}

export interface UploadEntry {
  readonly path: string;
  readonly kind: 'build' | 'asset';
  readonly byteLength: number;
  readonly sha256: string;
  readonly mediaType: string;
}

export interface UploadTarget {
  readonly path: string;
  readonly key: string;
  readonly uploadUrl: string;
  readonly expiresAt: string;
}

export interface HostWrite {
  readonly hostname: string;
  readonly key: string;
  readonly body: string;
  readonly uploadUrl: string;
  readonly expiresAt: string;
}

export interface ActivationOp {
  readonly op: 'put' | 'delete';
  readonly hostname: string;
  readonly key: string;
  readonly body: string | null;
  readonly url: string;
  readonly expiresAt: string;
  /** For a delete: read the manifest first, and delete only one that names this site. */
  readonly readUrl: string | null;
}

export interface PurgeTarget {
  readonly key: string;
  readonly deleteUrl: string;
  readonly expiresAt: string;
}

export interface CoreClientOptions {
  readonly baseUrl: string;
  readonly secret: string;
  /** Sent on every call so Core can show what this service runs in Settings > About. */
  readonly release?: { readonly version: string; readonly commit: string };
  readonly fetch?: typeof globalThis.fetch;
  readonly timeoutMs?: number;
}

/** Which execution a domain call speaks for; Core fences every call on it. */
export interface Execution {
  readonly jobId: string;
  readonly executionId: string;
}

const MAX_RESPONSE_BYTES = 16 << 20;

export class CoreClient {
  private readonly doFetch: typeof globalThis.fetch;
  private readonly timeoutMs: number;

  private readonly options: CoreClientOptions;

  constructor(options: CoreClientOptions) {
    this.options = options;
    this.doFetch = options.fetch ?? globalThis.fetch;
    this.timeoutMs = options.timeoutMs ?? 30_000;
  }

  private async call(
    method: string,
    path: string,
    body: unknown,
    execution: Execution | null,
    signal: AbortSignal | undefined,
  ): Promise<{ status: number; json: unknown }> {
    const headers: Record<string, string> = {
      'x-nix-internal-secret': this.options.secret,
      accept: 'application/json',
    };
    if (body !== undefined) headers['content-type'] = 'application/json';
    if (this.options.release !== undefined) {
      headers['x-nix-service'] = 'sites-worker';
      headers['x-nix-release-version'] = this.options.release.version;
      headers['x-nix-release-commit'] = this.options.release.commit;
    }
    if (execution !== null) {
      headers['x-nix-worker-job-id'] = execution.jobId;
      headers['x-nix-worker-execution-id'] = execution.executionId;
    }
    const timeout = AbortSignal.timeout(this.timeoutMs);
    const response = await this.doFetch(`${this.options.baseUrl}${path}`, {
      method,
      headers,
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
      redirect: 'manual',
      signal: signal === undefined ? timeout : AbortSignal.any([signal, timeout]),
    });
    const text = await response.text();
    if (text.length > MAX_RESPONSE_BYTES) {
      throw new Error('Core answered with more bytes than the worker accepts.');
    }
    let json: unknown = null;
    if (text !== '') {
      try {
        json = JSON.parse(text);
      } catch {
        json = null;
      }
    }
    return { status: response.status, json };
  }

  private async expect<T>(
    method: string,
    path: string,
    body: unknown,
    execution: Execution,
    signal?: AbortSignal,
  ): Promise<T> {
    const { status, json } = await this.call(method, path, body, execution, signal);
    if (status < 200 || status >= 300) {
      const problem = (json ?? {}) as { code?: unknown; detail?: unknown };
      throw new CoreResponseError(
        status,
        typeof problem.code === 'string' ? problem.code : null,
        typeof problem.detail === 'string' ? problem.detail : '',
      );
    }
    return json as T;
  }

  // -- dispatch (lease) ------------------------------------------------------

  /** Leases up to one job of exactly `kind` under `owner`; the lease is the claim. */
  async lease(
    kind: string,
    owner: string,
    leaseSeconds: number,
    signal?: AbortSignal,
  ): Promise<LeaseJob[]> {
    const { status, json } = await this.call(
      'POST',
      '/internal/worker-dispatch/jobs/lease',
      { owner, kind, limit: 1, leaseSeconds },
      null,
      signal,
    );
    if (status !== 200 || !Array.isArray(json)) {
      throw new Error(`The lease answered ${String(status)}.`);
    }
    return (json as (Omit<LeaseJob, 'payload'> & { payload: unknown })[]).map((job) => ({
      ...job,
      // Core stores payloads as JSON text and may expose that text as a string.
      payload: typeof job.payload === 'string' ? (JSON.parse(job.payload) as unknown) : job.payload,
    }));
  }

  /** Completes a leased job; false on 409 (the job is already settled or the lease is gone). */
  async complete(jobId: string, completion: JobCompletion): Promise<boolean> {
    const { status } = await this.call(
      'POST',
      `/internal/worker-dispatch/jobs/${jobId}/complete`,
      completion,
      null,
      undefined,
    );
    if (status === 409) return false;
    if (status < 200 || status >= 300)
      throw new Error(`The completion answered ${String(status)}.`);
    return true;
  }

  /** The claimed job, or null on 409 (another execution owns it). */
  async claim(jobId: string, executionId: string, leaseSeconds: number): Promise<LeaseJob | null> {
    const { status, json } = await this.call(
      'POST',
      `/internal/worker-dispatch/jobs/${jobId}/claim`,
      { owner: executionId, leaseSeconds },
      null,
      undefined,
    );
    if (status === 409) return null;
    if (status !== 200) throw new Error(`The claim answered ${String(status)}.`);
    const job = json as Omit<LeaseJob, 'payload'> & { payload: unknown };
    // Core stores payloads as JSON text and may expose that text as a string.
    const payload =
      typeof job.payload === 'string' ? (JSON.parse(job.payload) as unknown) : job.payload;
    return { ...job, payload };
  }

  async renew(
    jobId: string,
    executionId: string,
    leaseSeconds: number,
    signal?: AbortSignal,
  ): Promise<boolean> {
    const { status } = await this.call(
      'POST',
      `/internal/worker-dispatch/jobs/${jobId}/renew`,
      { owner: executionId, leaseSeconds },
      null,
      signal,
    );
    if (status === 409) return false;
    if (status < 200 || status >= 300) throw new Error(`The renewal answered ${String(status)}.`);
    return true;
  }

  async state(jobId: string, executionId: string, signal?: AbortSignal): Promise<JobState | null> {
    const { status, json } = await this.call(
      'GET',
      `/internal/worker-dispatch/jobs/${jobId}/state?owner=${encodeURIComponent(executionId)}`,
      undefined,
      null,
      signal,
    );
    if (status === 404) return null;
    if (status !== 200) throw new Error(`The state lookup answered ${String(status)}.`);
    return json as JobState;
  }

  /**
   * Whether Core accepts this worker's credential and its dispatch store is up. Leases a job kind
   * that cannot exist, so the probe can never consume application work.
   */
  async ping(owner: string, signal?: AbortSignal): Promise<boolean> {
    try {
      const { status, json } = await this.call(
        'POST',
        '/internal/worker-dispatch/jobs/lease',
        { owner, kind: 'readiness.probe', limit: 1 },
        null,
        signal,
      );
      return status === 200 && Array.isArray(json) && json.length === 0;
    } catch {
      return false;
    }
  }

  // -- build -----------------------------------------------------------------

  manifest(execution: Execution, signal?: AbortSignal): Promise<unknown> {
    return this.expect(
      'GET',
      `/internal/worker-executions/sites/builds/${execution.jobId}`,
      undefined,
      execution,
      signal,
    );
  }

  pages(
    execution: Execution,
    after: number,
    limit: number,
    signal?: AbortSignal,
  ): Promise<{ pages: unknown[]; next: number | null }> {
    return this.expect(
      'GET',
      `/internal/worker-executions/sites/builds/${execution.jobId}/pages?after=${String(after)}&limit=${String(limit)}`,
      undefined,
      execution,
      signal,
    );
  }

  body(execution: Execution, itemId: string, signal?: AbortSignal): Promise<SiteWorkerBody> {
    return this.expect(
      'GET',
      `/internal/worker-executions/sites/builds/${execution.jobId}/bodies/${itemId}`,
      undefined,
      execution,
      signal,
    );
  }

  /** The image capability, or null when Core says the image is not available to this site. */
  async file(
    execution: Execution,
    fileItemId: string,
    sourceItemId: string,
    signal?: AbortSignal,
  ): Promise<SiteWorkerFile | null> {
    try {
      return await this.expect<SiteWorkerFile>(
        'GET',
        `/internal/worker-executions/sites/builds/${execution.jobId}/files/${encodeURIComponent(fileItemId)}?source=${encodeURIComponent(sourceItemId)}`,
        undefined,
        execution,
        signal,
      );
    } catch (error) {
      if (
        error instanceof CoreResponseError &&
        error.status === 404 &&
        error.code === 'sites.file_unavailable'
      ) {
        return null;
      }
      throw error;
    }
  }

  async uploads(
    execution: Execution,
    entries: readonly UploadEntry[],
    signal?: AbortSignal,
  ): Promise<UploadTarget[]> {
    const response = await this.expect<{ targets: UploadTarget[] }>(
      'POST',
      `/internal/worker-executions/sites/builds/${execution.jobId}/uploads`,
      { entries },
      execution,
      signal,
    );
    return response.targets;
  }

  async seal(
    execution: Execution,
    request: {
      fileCount: number;
      totalBytes: number;
      buildIndexSha256: string;
      loss: readonly string[];
    },
    signal?: AbortSignal,
  ): Promise<HostWrite[]> {
    const response = await this.expect<{ writes: HostWrite[] }>(
      'POST',
      `/internal/worker-executions/sites/builds/${execution.jobId}/seal`,
      request,
      execution,
      signal,
    );
    return response.writes;
  }

  async activated(execution: Execution, signal?: AbortSignal): Promise<void> {
    await this.expect(
      'POST',
      `/internal/worker-executions/sites/builds/${execution.jobId}/activated`,
      undefined,
      execution,
      signal,
    );
  }

  // -- activation ------------------------------------------------------------

  activation(
    execution: Execution,
    signal?: AbortSignal,
  ): Promise<{ activationId: string; reason: string; siteId: string; ops: ActivationOp[] }> {
    return this.expect(
      'GET',
      `/internal/worker-executions/sites/activations/${execution.jobId}`,
      undefined,
      execution,
      signal,
    );
  }

  async applied(execution: Execution, signal?: AbortSignal): Promise<void> {
    await this.expect(
      'POST',
      `/internal/worker-executions/sites/activations/${execution.jobId}/applied`,
      undefined,
      execution,
      signal,
    );
  }

  // -- purge -----------------------------------------------------------------

  purgeObjects(
    execution: Execution,
    after: string | null,
    limit: number,
    signal?: AbortSignal,
  ): Promise<{ objects: PurgeTarget[]; next: string | null }> {
    const cursor = after === null ? '' : `&after=${encodeURIComponent(after)}`;
    return this.expect(
      'GET',
      `/internal/worker-executions/sites/purges/${execution.jobId}/objects?limit=${String(limit)}${cursor}`,
      undefined,
      execution,
      signal,
    );
  }

  async purgeDeleted(
    execution: Execution,
    keys: readonly string[],
    signal?: AbortSignal,
  ): Promise<number> {
    const response = await this.expect<{ removed: number }>(
      'POST',
      `/internal/worker-executions/sites/purges/${execution.jobId}/objects/deleted`,
      { keys },
      execution,
      signal,
    );
    return response.removed;
  }
}
