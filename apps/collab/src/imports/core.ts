import { internalCoreOrigin } from '../core/internal-url.ts';
import { isRecord } from '@nix/editor-schema';
import {
  parseBodyAuthorizationItems,
  uuid,
  type BodyAuthorizationItem,
} from '../core/body-authorization.ts';

export type ImportBodyAuthorizationItem = BodyAuthorizationItem;

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
  const parsed = parseBodyAuthorizationItems(items, invalidAuthorization);
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
