import { internalCoreOrigin } from '../core/internal-url.ts';
import { isRecord } from '@nix/editor-schema';

export interface ImportBodyAuthorizationItem {
  readonly sourceId: string;
  readonly targetItemId: string;
  readonly itemType: string;
  readonly bodyRequired: boolean;
}

export interface ImportBodyAuthorization {
  readonly tenantId: string;
  readonly principalId: string;
  readonly workspaceId: string;
  readonly importId: string;
  readonly items: readonly ImportBodyAuthorizationItem[];
  readonly canWrite: boolean;
}

export interface CoreImportClient {
  authorizeBodies(
    importId: string,
    execution: { readonly jobId: string; readonly executionId: string },
  ): Promise<ImportBodyAuthorization>;
}

export class CoreImportError extends Error {
  public readonly status: number;
  public readonly code: string;

  public constructor(status: number, code: string, message: string) {
    super(message);
    this.name = 'CoreImportError';
    this.status = status;
    this.code = code;
  }
}

export function createCoreImportClient(input: {
  readonly coreBaseUrl: string;
  readonly internalSecret: string;
  readonly fetchImpl?: typeof fetch;
}): CoreImportClient {
  const fetchImpl = input.fetchImpl ?? globalThis.fetch;
  const coreBaseUrl = internalCoreOrigin(input.coreBaseUrl);
  return {
    async authorizeBodies(importId, execution) {
      let response: Response;
      try {
        response = await fetchImpl(
          `${coreBaseUrl}/internal/worker-executions/imports/${encodeURIComponent(importId)}/bodies/authorization`,
          {
            headers: {
              'x-nix-internal-secret': input.internalSecret,
              'x-nix-worker-job-id': execution.jobId,
              'x-nix-worker-execution-id': execution.executionId,
            },
            signal: AbortSignal.timeout(10_000),
            credentials: 'omit',
            redirect: 'error',
          },
        );
      } catch {
        throw new CoreImportError(
          503,
          'import_core_unavailable',
          'Core could not authorize this staged import.',
        );
      }
      if (!response.ok) {
        if (response.status === 409) {
          throw new CoreImportError(
            409,
            'import_execution_lost',
            'The import worker no longer owns this job lease.',
          );
        }
        if (response.status === 404) {
          throw new CoreImportError(404, 'import_not_found', 'No such staged import is available.');
        }
        if (response.status >= 500) {
          throw new CoreImportError(
            503,
            'import_core_unavailable',
            'Core could not authorize this staged import.',
          );
        }
        throw new CoreImportError(
          502,
          'import_authorization_refused',
          'Core refused the staged import authorization request.',
        );
      }
      return parseAuthorization(await response.json(), importId);
    },
  };
}

function parseAuthorization(value: unknown, importId: string): ImportBodyAuthorization {
  if (!isRecord(value)) throw invalidAuthorization();
  const items = value.items;
  if (
    !uuid(value.tenantId) ||
    !uuid(value.principalId) ||
    !uuid(value.workspaceId) ||
    value.importId !== importId ||
    value.canWrite !== true ||
    !Array.isArray(items) ||
    items.length === 0 ||
    items.length > 10_000
  ) {
    throw invalidAuthorization();
  }
  const seenSources = new Set<string>();
  const seenTargets = new Set<string>();
  const parsed = items.map((item): ImportBodyAuthorizationItem => {
    if (
      !isRecord(item) ||
      !sourceId(item.sourceId) ||
      !uuid(item.targetItemId) ||
      typeof item.itemType !== 'string' ||
      item.itemType.length === 0 ||
      item.itemType.length > 64 ||
      typeof item.bodyRequired !== 'boolean' ||
      seenSources.has(item.sourceId) ||
      seenTargets.has(item.targetItemId)
    ) {
      throw invalidAuthorization();
    }
    seenSources.add(item.sourceId);
    seenTargets.add(item.targetItemId);
    return {
      sourceId: item.sourceId,
      targetItemId: item.targetItemId,
      itemType: item.itemType,
      bodyRequired: item.bodyRequired,
    };
  });
  return {
    tenantId: value.tenantId,
    principalId: value.principalId,
    workspaceId: value.workspaceId,
    importId,
    items: parsed,
    canWrite: true,
  };
}

function invalidAuthorization(): CoreImportError {
  return new CoreImportError(
    502,
    'import_authorization_invalid',
    'Core returned an invalid import authorization response.',
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
