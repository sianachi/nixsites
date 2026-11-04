import { readBounded } from './provider-errors.ts';
import type { ConversationToolExecutor } from './types.ts';
import { isRecord, UUID } from './util.ts';

export interface CoreClientOptions {
  baseUrl: string;
  secret: string;
  release: { version: string; commit: string };
  fetch?: typeof fetch | undefined;
}

const RESPONSE_LIMIT = 256 << 10;

/** Core's internal calls: the secret and the release headers, to one origin only. */
export class CoreClient {
  private readonly options: CoreClientOptions;

  constructor(options: CoreClientOptions) {
    this.options = options;
  }

  private headers(): Record<string, string> {
    const headers: Record<string, string> = {
      'Content-Type': 'application/json',
      Accept: 'application/json',
      'X-Nix-Internal-Secret': this.options.secret,
    };
    const { version, commit } = this.options.release;
    if (version !== '' || commit !== '') {
      headers['X-Nix-Service'] = 'companion';
      headers['X-Nix-Release-Version'] = version;
      headers['X-Nix-Release-Commit'] = commit;
    }
    return headers;
  }

  /**
   * Whether Core accepts the secret. Core's /healthz is anonymous, so it would prove nothing; this
   * leases a job kind that cannot exist, as the Go host and the sites worker do.
   */
  async ping(signal: AbortSignal): Promise<boolean> {
    try {
      const response = await (this.options.fetch ?? fetch)(
        `${this.options.baseUrl}/internal/worker-dispatch/jobs/lease`,
        {
          method: 'POST',
          headers: this.headers(),
          body: JSON.stringify({ owner: 'companion', kind: 'readiness.probe', limit: 1 }),
          redirect: 'manual',
          signal,
        },
      );
      if (response.status !== 200) {
        void response.body?.cancel();
        return false;
      }
      const jobs: unknown = JSON.parse(await readBounded(response, 4 << 10));
      return Array.isArray(jobs) && jobs.length === 0;
    } catch {
      return false;
    }
  }

  /** Runs a saved conversation's tool in Core, which rechecks access and consent. */
  readonly executeConversationTool: ConversationToolExecutor = async (
    signal,
    conversationId,
    tenantId,
    principalId,
    requestId,
    args,
  ) => {
    let parsed: unknown;
    try {
      parsed = JSON.parse(args);
    } catch {
      throw new Error('invalid conversation tool request');
    }
    if (
      ![conversationId, tenantId, principalId, requestId].every((id) => UUID.test(id)) ||
      Buffer.byteLength(args) > 40000
    ) {
      throw new Error('invalid conversation tool request');
    }
    const response = await (this.options.fetch ?? fetch)(
      `${this.options.baseUrl}/internal/conversations/${encodeURIComponent(conversationId)}/tools`,
      {
        method: 'POST',
        headers: this.headers(),
        body: JSON.stringify({ tenantId, principalId, requestId, arguments: parsed }),
        redirect: 'manual',
        signal,
      },
    );
    if (!response.ok) {
      void response.body?.cancel();
      throw new Error(`worker API answered HTTP ${String(response.status)}`);
    }
    if (
      !(response.headers.get('content-type') ?? '').toLowerCase().startsWith('application/json')
    ) {
      throw new Error('worker API response is not JSON');
    }
    const text = await readBounded(response, RESPONSE_LIMIT);
    const body: unknown = JSON.parse(text);
    if (
      !isRecord(body) ||
      Object.keys(body).some((key) => !['success', 'result', 'lockedContent'].includes(key))
    ) {
      throw new Error('worker API response is invalid');
    }
    const result = typeof body.result === 'string' ? body.result : '';
    if (result.length > 128000) throw new Error('worker API response is too large');
    return {
      text: result,
      success: body.success === true,
      lockedContent: body.lockedContent === true,
    };
  };
}
