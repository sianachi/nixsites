import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { randomUUID } from 'node:crypto';
import { z } from 'zod';
import { templateInitializationSchema } from '@nix/api-client';
import {
  executeTemplateDraftBegin,
  executeTemplateDraftGet,
  executeTemplateDraftUpdate,
  executeTemplateDraftItemUpdate,
  executeTemplateDraftSave,
  executeTemplateDraftDiscard,
} from './commands/templates.ts';
import { identifier, toolResult } from './mcp-support.ts';
import type { McpToolDeps } from './mcp-support.ts';

export function registerTemplateDraftTools(server: McpServer, { session }: McpToolDeps): void {
  server.registerTool(
    'begin_template_draft',
    {
      description:
        'Copy a template into an editable draft, waiting for file copies to finish before returning.',
      inputSchema: {
        templateId: identifier,
        idempotencyKey: z.string().min(1).max(200).optional(),
      },
    },
    ({ templateId, idempotencyKey }) =>
      toolResult(async () => {
        const current = await session();
        const key = idempotencyKey ?? `nixctl-mcp-draft:${templateId}:${randomUUID()}`;
        const draft = await executeTemplateDraftBegin(current, templateId, key, false);
        return {
          draft,
          resume: draft.fileTransferPending
            ? {
                kind: 'draft',
                jobId: draft.fileTransferJobId,
                operationId: draft.operationId,
                idempotencyKey: key,
                request: { templateId, idempotencyKey: key },
              }
            : { idempotencyKey: key },
        };
      }),
  );

  server.registerTool(
    'get_template_draft',
    {
      description: 'Read an active template draft and its item tree.',
      inputSchema: { templateId: identifier, operationId: identifier },
    },
    ({ templateId, operationId }) =>
      toolResult(async () => executeTemplateDraftGet(await session(), templateId, operationId)),
  );

  server.registerTool(
    'update_template_draft',
    {
      description: 'Update a draft title, description, or setup questions and rules.',
      inputSchema: {
        templateId: identifier,
        operationId: identifier,
        title: z.string().trim().min(1).max(200).optional(),
        description: z.string().max(4_096).nullable().optional(),
        initialization: z.record(z.string(), z.unknown()).optional(),
      },
    },
    ({ templateId, operationId, title, description, initialization }) =>
      toolResult(async () =>
        executeTemplateDraftUpdate(await session(), templateId, operationId, {
          ...(title === undefined ? {} : { title }),
          ...(description === undefined ? {} : { description }),
          ...(initialization === undefined
            ? {}
            : { initialization: templateInitializationSchema.parse(initialization) }),
        }),
      ),
  );

  server.registerTool(
    'update_template_draft_item',
    {
      description: 'Update a draft item title, properties, schema, or views.',
      inputSchema: {
        templateId: identifier,
        operationId: identifier,
        sourceId: identifier,
        title: z.string().trim().min(1).max(200).optional(),
        properties: z.record(z.string(), z.unknown()).nullable().optional(),
        schema: z
          .object({ properties: z.array(z.unknown()), inherit: z.boolean() })
          .nullable()
          .optional(),
        views: z.unknown().optional(),
      },
    },
    ({ templateId, operationId, sourceId, title, properties, schema, views }) =>
      toolResult(async () =>
        executeTemplateDraftItemUpdate(await session(), templateId, operationId, sourceId, {
          ...(title === undefined ? {} : { title }),
          ...(properties === undefined ? {} : { properties }),
          ...(schema === undefined ? {} : { schema }),
          ...(views === undefined ? {} : { views }),
        }),
      ),
  );

  server.registerTool(
    'save_template_draft',
    {
      description: 'Publish a completed template draft as a new revision.',
      inputSchema: { templateId: identifier, operationId: identifier },
    },
    ({ templateId, operationId }) =>
      toolResult(async () => executeTemplateDraftSave(await session(), templateId, operationId)),
  );

  server.registerTool(
    'discard_template_draft',
    {
      description: 'Discard an unfinished template draft.',
      inputSchema: { templateId: identifier, operationId: identifier },
    },
    ({ templateId, operationId }) =>
      toolResult(async () => executeTemplateDraftDiscard(await session(), templateId, operationId)),
  );
}
