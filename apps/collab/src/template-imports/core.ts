import { internalCoreOrigin } from '../core/internal-url.ts';
import { isRecord } from '../is-record.ts';

const AUTHORIZATION_RESPONSE_BYTES = 2 * 1024 * 1024;
const AUTHORIZATION_ITEM_LIMIT = 10_000;

export interface TemplateImportBodyAuthorizationItem {
  readonly sourceId: string;
  readonly targetItemId: string;
  readonly itemType: string;
  readonly bodyRequired: boolean;
}

export interface TemplateImportBodyAuthorization {
  readonly tenantId: string;
  readonly principalId: string;
  readonly workspaceId: string;
  readonly importId: string;
  readonly operationId: string | null;
  readonly items: readonly TemplateImportBodyAuthorizationItem[];
  readonly canWrite: true;
}

export interface CoreTemplateImportClient {
  authorizeBodies(
    importId: string,
    execution: { readonly jobId: string; readonly executionId: string },
  ): Promise<TemplateImportBodyAuthorization>;
}

export class CoreTemplateImportError extends Error {
  public readonly status: number;
  public readonly code: string;

  public constructor(status: number, code: string, message: string) {
    super(message);
    this.name = 'CoreTemplateImportError';
    this.status = status;
    this.code = code;
  }
}

export function createCoreTemplateImportClient(input: {
  readonly coreBaseUrl: string;
  readonly internalSecret: string;
  readonly fetchImpl?: typeof fetch;
  readonly timeoutMs?: number;
}): CoreTemplateImportClient {
  const fetchImpl = input.fetchImpl ?? globalThis.fetch;
  const timeoutMs = input.timeoutMs ?? 10_000;
  const coreBaseUrl = internalCoreOrigin(input.coreBaseUrl);

  return {
    async authorizeBodies(importId, execution) {
      let response: Response;
      try {
        response = await fetchImpl(
          `${coreBaseUrl}/internal/worker-executions/template-imports/${encodeURIComponent(importId)}/bodies/authorization`,
          {
            method: 'GET',
            headers: {
              accept: 'application/json',
              'x-nix-internal-secret': input.internalSecret,
              'x-nix-worker-job-id': execution.jobId,
              'x-nix-worker-execution-id': execution.executionId,
            },
            signal: AbortSignal.timeout(timeoutMs),
            credentials: 'omit',
            redirect: 'error',
          },
        );
      } catch {
        throw unavailable();
      }

      if (!response.ok) {
        if (response.status === 409) {
          throw new CoreTemplateImportError(
            409,
            'template.execution_lost',
            'The template import worker no longer owns this execution.',
          );
        }
        if (response.status >= 500) throw unavailable();
        throw new CoreTemplateImportError(
          502,
          'template.authorization_refused',
          'Core refused the template import body authorization request.',
        );
      }

      return parseAuthorization(await readAuthorization(response), importId);
    },
  };
}

async function readAuthorization(response: Response): Promise<unknown> {
  const declaredLength = response.headers.get('content-length');
  if (declaredLength !== null) {
    const parsedLength = Number(declaredLength);
    if (
      !Number.isSafeInteger(parsedLength) ||
      parsedLength < 0 ||
      parsedLength > AUTHORIZATION_RESPONSE_BYTES
    ) {
      throw invalidAuthorization();
    }
  }

  if (response.body === null) throw invalidAuthorization();
  const reader = response.body.getReader();
  const chunks: Uint8Array[] = [];
  let length = 0;
  let finished = false;
  try {
    while (!finished) {
      const next: unknown = await reader.read();
      if (!isRecord(next) || typeof next.done !== 'boolean') throw invalidAuthorization();
      finished = next.done;
      if (finished) continue;
      if (!(next.value instanceof Uint8Array)) throw invalidAuthorization();
      const chunk = next.value;
      length += chunk.byteLength;
      if (length > AUTHORIZATION_RESPONSE_BYTES) {
        await reader.cancel();
        throw invalidAuthorization();
      }
      chunks.push(chunk);
    }
  } catch (error) {
    if (error instanceof CoreTemplateImportError) throw error;
    throw unavailable();
  }

  const bytes = new Uint8Array(length);
  let offset = 0;
  for (const chunk of chunks) {
    bytes.set(chunk, offset);
    offset += chunk.byteLength;
  }
  try {
    return JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(bytes)) as unknown;
  } catch {
    throw invalidAuthorization();
  }
}

function parseAuthorization(value: unknown, importId: string): TemplateImportBodyAuthorization {
  if (
    !isRecord(value) ||
    !Array.isArray(value.items) ||
    value.items.length > AUTHORIZATION_ITEM_LIMIT
  ) {
    throw invalidAuthorization();
  }
  if (
    !uuid(value.tenantId) ||
    !uuid(value.principalId) ||
    !uuid(value.workspaceId) ||
    value.importId !== importId ||
    (value.operationId !== null && !uuid(value.operationId)) ||
    value.canWrite !== true
  ) {
    throw invalidAuthorization();
  }

  const seenSources = new Set<string>();
  const seenTargets = new Set<string>();
  const items = value.items.map((candidate): TemplateImportBodyAuthorizationItem => {
    if (
      !isRecord(candidate) ||
      !sourceId(candidate.sourceId) ||
      !uuid(candidate.targetItemId) ||
      typeof candidate.itemType !== 'string' ||
      candidate.itemType.length === 0 ||
      candidate.itemType.length > 64 ||
      typeof candidate.bodyRequired !== 'boolean' ||
      seenSources.has(candidate.sourceId) ||
      seenTargets.has(candidate.targetItemId)
    ) {
      throw invalidAuthorization();
    }
    seenSources.add(candidate.sourceId);
    seenTargets.add(candidate.targetItemId);
    return {
      sourceId: candidate.sourceId,
      targetItemId: candidate.targetItemId,
      itemType: candidate.itemType,
      bodyRequired: candidate.bodyRequired,
    };
  });

  return {
    tenantId: value.tenantId,
    principalId: value.principalId,
    workspaceId: value.workspaceId,
    importId,
    operationId: value.operationId,
    items,
    canWrite: true,
  };
}

function unavailable(): CoreTemplateImportError {
  return new CoreTemplateImportError(
    503,
    'template.core_unavailable',
    'Core could not authorize this template import body write. Retrying is safe.',
  );
}

function invalidAuthorization(): CoreTemplateImportError {
  return new CoreTemplateImportError(
    502,
    'template.authorization_invalid',
    'Core returned an invalid template import body authorization response.',
  );
}

function sourceId(value: unknown): value is string {
  return (
    typeof value === 'string' &&
    value.length > 0 &&
    value.length <= 160 &&
    /^[A-Za-z0-9._:/-]+$/.test(value)
  );
}

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

function uuid(value: unknown): value is string {
  return typeof value === 'string' && UUID.test(value);
}
