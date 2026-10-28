import { SCHEMA_VERSION } from '@nix/editor-schema';
import type { ItemBody } from '@nix/export';
import { markdownToDocument } from '@nix/markdown';
import type { Pool } from 'pg';

import { TemplateBodyError, writeArchiveBodies } from '../templates/bodies.ts';
import type { CoreImportClient, ImportBodyAuthorizationItem } from './core.ts';
import { isRecord } from '../is-record.ts';

export interface ImportBodyService {
  write(input: {
    readonly importId: string;
    readonly jobId: string;
    readonly executionId: string;
    readonly body: unknown;
  }): Promise<{ readonly written: number }>;
}

interface PlannedBody {
  readonly encoding: 'markdown' | 'plain_text' | 'prosemirror' | 'archive';
  readonly text?: string;
  readonly document?: unknown;
  readonly archive?: unknown;
}

interface PlannedWrite {
  readonly sourceId: string;
  readonly body: PlannedBody;
}

export class ImportBodyError extends Error {
  public readonly status: number;
  public readonly code: string;

  public constructor(status: number, code: string, message: string) {
    super(message);
    this.name = 'ImportBodyError';
    this.status = status;
    this.code = code;
  }
}

export function createImportBodyService(input: {
  readonly pool: Pool;
  readonly core: CoreImportClient;
}): ImportBodyService {
  return {
    async write(request) {
      const writes = parseWrites(request.body);
      const authorization = await input.core.authorizeBodies(request.importId, {
        jobId: request.jobId,
        executionId: request.executionId,
      });
      const bySource = new Map(authorization.items.map((item) => [item.sourceId, item]));
      const expected = authorization.items.filter((item) => item.bodyRequired);
      if (writes.length !== expected.length) {
        throw invalid('The body set does not match the staged import plan.');
      }
      const seen = new Set<string>();
      const mappings = new Map(
        authorization.items.map((item) => [item.sourceId, item.targetItemId] as const),
      );
      const prepared = writes.map((write) => {
        const item = bySource.get(write.sourceId);
        if (item === undefined || !item.bodyRequired || seen.has(write.sourceId)) {
          throw invalid('The body set does not match the staged import plan.');
        }
        seen.add(write.sourceId);
        return {
          sourceId: write.sourceId,
          targetItemId: item.targetItemId,
          itemType: item.itemType,
          body: materializeBody(item, write.body),
        };
      });
      if (expected.some((item) => !seen.has(item.sourceId))) {
        throw invalid('The body set does not match the staged import plan.');
      }

      const operationAuthorization = {
        tenantId: authorization.tenantId,
        principalId: authorization.principalId,
        workspaceId: authorization.workspaceId,
        itemType: 'import',
        canWrite: authorization.canWrite,
      };
      // Staged envelopes remain invisible until Core finalizes them. Small chunks keep Yjs
      // materialization bounded; an interrupted batch is safe to retry because existing staged
      // content documents are never overwritten.
      for (let offset = 0; offset < prepared.length; offset += 32) {
        await writeArchiveBodies(
          input.pool,
          operationAuthorization,
          prepared.slice(offset, offset + 32),
          mappings,
          {
            jobId: request.jobId,
            executionId: request.executionId,
            kind: 'import.commit',
          },
        );
      }
      return { written: prepared.length };
    },
  };
}

function parseWrites(value: unknown): readonly PlannedWrite[] {
  if (!isRecord(value) || !Array.isArray(value.writes) || value.writes.length > 10_000) {
    throw invalid('Expected a bounded writes array.');
  }
  return value.writes.map((candidate): PlannedWrite => {
    if (!isRecord(candidate) || !sourceId(candidate.sourceId) || !isRecord(candidate.body)) {
      throw invalid('An imported body is malformed.');
    }
    const encoding = candidate.body.encoding;
    if (
      encoding !== 'markdown' &&
      encoding !== 'plain_text' &&
      encoding !== 'prosemirror' &&
      encoding !== 'archive'
    ) {
      throw invalid('An imported body uses an unsupported encoding.');
    }
    if (
      ((encoding === 'markdown' || encoding === 'plain_text') &&
        typeof candidate.body.text !== 'string') ||
      (encoding === 'prosemirror' && !isRecord(candidate.body.document)) ||
      (encoding === 'archive' && !isRecord(candidate.body.archive))
    ) {
      throw invalid('An imported body does not contain its declared representation.');
    }
    return {
      sourceId: candidate.sourceId,
      body: {
        encoding,
        ...(typeof candidate.body.text === 'string' ? { text: candidate.body.text } : {}),
        ...(isRecord(candidate.body.document) ? { document: candidate.body.document } : {}),
        ...(isRecord(candidate.body.archive) ? { archive: candidate.body.archive } : {}),
      },
    };
  });
}

function materializeBody(item: ImportBodyAuthorizationItem, body: PlannedBody): ItemBody {
  if (body.encoding === 'archive') {
    return body.archive as ItemBody;
  }
  if (item.itemType === 'canvas' || item.itemType === 'sheet' || item.itemType === 'spreadsheet') {
    throw invalid('Only native archive bodies can initialize this item type.');
  }
  if (body.encoding === 'prosemirror') {
    return { schemaVersion: SCHEMA_VERSION, prosemirror: body.document };
  }
  if (body.encoding === 'markdown') {
    const parsed = markdownToDocument(body.text ?? '');
    if (!parsed.ok) {
      throw new ImportBodyError(422, 'import_markdown_invalid', parsed.reason);
    }
    return { schemaVersion: SCHEMA_VERSION, prosemirror: parsed.doc };
  }
  return { schemaVersion: SCHEMA_VERSION, prosemirror: plainTextDocument(body.text ?? '') };
}

function plainTextDocument(value: string): unknown {
  const lines = value.split('\n');
  return {
    type: 'doc',
    content: lines.map((line) =>
      line.length === 0
        ? { type: 'paragraph' }
        : { type: 'paragraph', content: [{ type: 'text', text: line }] },
    ),
  };
}

function invalid(message: string): ImportBodyError {
  return new ImportBodyError(422, 'import_body_invalid', message);
}

function sourceId(value: unknown): value is string {
  return (
    typeof value === 'string' &&
    value.length > 0 &&
    value.length <= 160 &&
    /^[A-Za-z0-9._:/-]+$/.test(value)
  );
}

export function importBodyProblem(error: unknown): ImportBodyError | null {
  if (error instanceof ImportBodyError) return error;
  if (error instanceof TemplateBodyError) {
    return new ImportBodyError(
      error.code === 'template.execution_lost' ? 409 : 422,
      error.code.replace(/^template\./, 'import.'),
      error.message,
    );
  }
  return null;
}
