import type { ItemBody } from '@nix/export';
import type { Pool } from 'pg';

import { TemplateBodyError, writeArchiveBodies } from '../templates/bodies.ts';
import type { CoreTemplateImportClient } from './core.ts';
import { isRecord } from '@nix/editor-schema';

const BODY_WRITE_LIMIT = 10_000;
const WRITE_BATCH_SIZE = 32;

export interface TemplateImportBodyService {
  write(input: {
    readonly importId: string;
    readonly jobId: string;
    readonly executionId: string;
    readonly body: unknown;
  }): Promise<{ readonly writtenTargetItemIds: readonly string[] }>;
}

interface RequestedWrite {
  readonly sourceId: string;
  readonly body: ItemBody;
}

export class TemplateImportBodyError extends Error {
  public readonly status: number;
  public readonly code: string;

  public constructor(message: string, status = 422, code = 'template.import_body_invalid') {
    super(message);
    this.name = 'TemplateImportBodyError';
    this.status = status;
    this.code = code;
  }
}

export function createTemplateImportBodyService(input: {
  readonly pool: Pool;
  readonly core: CoreTemplateImportClient;
}): TemplateImportBodyService {
  return {
    async write(request) {
      const requested = parseWrites(request.body);
      const authorization = await input.core.authorizeBodies(request.importId, {
        jobId: request.jobId,
        executionId: request.executionId,
      });
      const required = authorization.items.filter((item) => item.bodyRequired);
      if (requested.length !== required.length) throw invalid();

      const requestedBySource = new Map(requested.map((write) => [write.sourceId, write]));
      const prepared = required.map((item) => {
        const write = requestedBySource.get(item.sourceId);
        if (write === undefined) throw invalid();
        return {
          sourceId: item.sourceId,
          targetItemId: item.targetItemId,
          itemType: item.itemType,
          body: write.body,
        };
      });
      const mappings = new Map(
        authorization.items.map((item) => [item.sourceId, item.targetItemId] as const),
      );

      try {
        const writtenTargetItemIds: string[] = [];
        for (let offset = 0; offset < prepared.length; offset += WRITE_BATCH_SIZE) {
          const written = await writeArchiveBodies(
            input.pool,
            {
              tenantId: authorization.tenantId,
              principalId: authorization.principalId,
              workspaceId: authorization.workspaceId,
              itemType: 'template-import',
              canWrite: authorization.canWrite,
            },
            prepared.slice(offset, offset + WRITE_BATCH_SIZE),
            mappings,
            {
              jobId: request.jobId,
              executionId: request.executionId,
              kind: 'template.commit',
            },
          );
          writtenTargetItemIds.push(...written);
        }
        return { writtenTargetItemIds };
      } catch (error) {
        if (error instanceof TemplateBodyError) {
          if (error.code === 'template.execution_lost') {
            throw new TemplateImportBodyError(error.message, 409, error.code);
          }
          throw invalid(error.message);
        }
        throw error;
      }
    },
  };
}

function parseWrites(value: unknown): readonly RequestedWrite[] {
  if (!isRecord(value) || !Array.isArray(value.writes) || value.writes.length > BODY_WRITE_LIMIT) {
    throw invalid('Expected a bounded writes array.');
  }
  const seen = new Set<string>();
  return value.writes.map((candidate): RequestedWrite => {
    if (
      !isRecord(candidate) ||
      !sourceId(candidate.sourceId) ||
      !archiveBody(candidate.body) ||
      seen.has(candidate.sourceId)
    ) {
      throw invalid();
    }
    seen.add(candidate.sourceId);
    return { sourceId: candidate.sourceId, body: candidate.body };
  });
}

function archiveBody(value: unknown): value is ItemBody {
  if (
    !isRecord(value) ||
    !Number.isSafeInteger(value.schemaVersion) ||
    Number(value.schemaVersion) < 1
  ) {
    return false;
  }
  const representations = ['prosemirror', 'sheet', 'canvas'].filter((key) => key in value);
  return representations.length === 1 && isRecord(value[representations[0] ?? '']);
}

function invalid(message = 'The body set does not match the authorized template import plan.') {
  return new TemplateImportBodyError(message);
}

function sourceId(value: unknown): value is string {
  return (
    typeof value === 'string' &&
    value.length > 0 &&
    value.length <= 160 &&
    /^[A-Za-z0-9._:/-]+$/.test(value)
  );
}
