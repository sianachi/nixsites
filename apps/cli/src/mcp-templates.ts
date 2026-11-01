import type { McpServer, RegisteredTool } from '@modelcontextprotocol/sdk/server/mcp.js';

import { randomUUID } from 'node:crypto';
import { z } from 'zod';
import { templates as templateResources, templateInitializationSchema } from '@nix/api-client';
import {
  executeTemplateApply,
  executeTemplateArchiveCommit,
  executeTemplateArchiveExport,
  executeTemplateImportGet,
  executeTemplateArchivePreview,
  executeTemplateCapture,
  executeTemplateOperationResume,
  executeTemplateInitializationUpdate,
} from './commands/templates.ts';
import { identifier, toolResult } from './mcp-support.ts';
import type { McpToolDeps } from './mcp-support.ts';

export function registerTemplateTools(
  server: McpServer,
  { session }: McpToolDeps,
): RegisteredTool[] {
  server.registerTool(
    'list_templates',
    {
      description: 'List templates visible in a workspace, including their setup metadata.',
      inputSchema: { workspaceId: identifier },
    },
    ({ workspaceId }) =>
      toolResult(async () =>
        (await session()).client.query(templateResources.listTemplates(workspaceId)),
      ),
  );

  server.registerTool(
    'get_template',
    {
      description: 'Read a template, its item tree, and its initialization questions and rules.',
      inputSchema: { templateId: identifier },
    },
    ({ templateId }) =>
      toolResult(async () =>
        (await session()).client.query(templateResources.templateById(templateId)),
      ),
  );

  server.registerTool(
    'capture_template',
    {
      description: 'Capture a readable item subtree as a reusable workspace template.',
      inputSchema: {
        workspaceId: identifier,
        sourceItemId: identifier,
        title: z.string().trim().min(1).max(200),
        description: z.string().max(4_096).nullable().optional(),
        includeBody: z.boolean().default(false),
        includeChildren: z.boolean().default(false),
        idempotencyKey: z.string().min(1).max(200).optional(),
      },
    },
    ({
      workspaceId,
      sourceItemId,
      title,
      description,
      includeBody,
      includeChildren,
      idempotencyKey,
    }) =>
      toolResult(async () => {
        const key = idempotencyKey ?? `nixctl-mcp-capture:${sourceItemId}:${randomUUID()}`;
        const request = {
          workspaceId,
          sourceItemId,
          title,
          ...(description === undefined ? {} : { description }),
          includeBody,
          includeChildren,
          idempotencyKey: key,
        };
        const result = await executeTemplateCapture(await session(), request, false);
        return {
          capture: result,
          resume: result.fileTransferPending
            ? {
                kind: 'capture',
                jobId: result.fileTransferJobId,
                operationId: result.operationId,
                idempotencyKey: key,
                request,
              }
            : { idempotencyKey: key, request },
        };
      }),
  );

  server.registerTool(
    'preflight_template_application',
    {
      description:
        'Resolve inputs and preview a template against an exact destination and revision.',
      inputSchema: {
        templateId: identifier,
        mode: z.enum(['merge', 'create']),
        targetItemId: identifier.nullable().optional(),
        parentItemId: identifier.nullable().optional(),
        title: z.string().max(200).optional(),
        inputs: z.record(z.string(), z.string()).optional(),
        expectedRevision: z.number().int().nonnegative().optional(),
      },
    },
    ({ templateId, mode, targetItemId, parentItemId, title, inputs, expectedRevision }) =>
      toolResult(async () => {
        const current = await session();
        const detail = await current.client.query(templateResources.templateById(templateId));
        return current.client.execute(
          templateResources.preflightTemplate(templateId, {
            mode,
            ...(targetItemId === undefined ? {} : { targetItemId }),
            ...(parentItemId === undefined ? {} : { parentItemId }),
            ...(title === undefined ? {} : { title }),
            ...(inputs === undefined ? {} : { inputs }),
            expectedRevision: expectedRevision ?? detail.revision,
          }),
        );
      }),
  );

  server.registerTool(
    'apply_template',
    {
      description:
        'Preflight and apply a template; the server checks permissions and resolves links.',
      inputSchema: {
        templateId: identifier,
        mode: z.enum(['merge', 'create']),
        targetItemId: identifier.nullable().optional(),
        parentItemId: identifier.nullable().optional(),
        title: z.string().max(200).optional(),
        inputs: z.record(z.string(), z.string()).optional(),
        expectedRevision: z.number().int().nonnegative().optional(),
        idempotencyKey: z.string().min(1).max(200).optional(),
      },
    },
    ({
      templateId,
      mode,
      targetItemId,
      parentItemId,
      title,
      inputs,
      expectedRevision,
      idempotencyKey,
    }) =>
      toolResult(async () =>
        executeTemplateApply(
          await session(),
          {
            templateId,
            mode,
            ...(targetItemId === undefined ? {} : { targetItemId }),
            ...(parentItemId === undefined ? {} : { parentItemId }),
            ...(title === undefined ? {} : { title }),
            ...(inputs === undefined ? {} : { inputs }),
            ...(expectedRevision === undefined ? {} : { expectedRevision }),
            ...(idempotencyKey === undefined ? {} : { idempotencyKey }),
          },
          randomUUID,
          { waitForFileTransfer: false },
        ),
      ),
  );

  server.registerTool(
    'set_template_initialization',
    {
      description:
        'Author setup questions, per-field rules, and external reference policies, then save the template draft.',
      inputSchema: {
        templateId: identifier,
        initialization: z.record(z.string(), z.unknown()),
        title: z.string().trim().min(1).max(200).optional(),
        description: z.string().max(4_096).nullable().optional(),
        idempotencyKey: z.string().min(1).max(200).optional(),
      },
    },
    ({ templateId, initialization, title, description, idempotencyKey }) =>
      toolResult(async () => {
        const parsed = templateInitializationSchema.parse(initialization);
        const key = idempotencyKey ?? `nixctl-mcp-edit:${templateId}:${randomUUID()}`;
        return executeTemplateInitializationUpdate(
          await session(),
          templateId,
          parsed,
          {
            ...(title === undefined ? {} : { title }),
            ...(description === undefined ? {} : { description }),
            idempotencyKey: key,
          },
          randomUUID,
          false,
        );
      }),
  );

  const previewTemplateArchiveImport = server.registerTool(
    'preview_template_archive_import',
    {
      description:
        'Upload a local .nix template archive and validate its destination and digest before commit.',
      inputSchema: {
        workspaceId: identifier,
        path: z.string().trim().min(1).max(4_096),
        idempotencyKey: z.string().min(1).max(200).optional(),
      },
    },
    ({ workspaceId, path, idempotencyKey }) =>
      toolResult(async () => {
        const key = idempotencyKey ?? `nixctl-mcp-template-import:${randomUUID()}`;
        return executeTemplateArchivePreview(await session(), workspaceId, path, key);
      }),
  );

  server.registerTool(
    'get_template_archive_import',
    {
      description: 'Read the current state of an authorized template archive import.',
      inputSchema: { importId: identifier },
    },
    ({ importId }) => toolResult(async () => executeTemplateImportGet(await session(), importId)),
  );

  server.registerTool(
    'commit_template_archive_import',
    {
      description:
        'Publish a previewed template archive using its exact import ID and SHA-256 digest.',
      inputSchema: {
        importId: identifier,
        digest: z.string().regex(/^[0-9a-f]{64}$/),
      },
    },
    ({ importId, digest }) =>
      toolResult(async () => executeTemplateArchiveCommit(await session(), importId, digest)),
  );

  const exportTemplateArchive = server.registerTool(
    'export_template_archive',
    {
      description:
        'Write a portable template archive to a local path and return its size and media type.',
      inputSchema: {
        templateId: identifier,
        path: z.string().trim().min(1).max(4_096),
      },
    },
    ({ templateId, path }) =>
      toolResult(async () => executeTemplateArchiveExport(await session(), templateId, path)),
  );

  server.registerTool(
    'resume_template_file_copy',
    {
      description:
        'Wait for a Core file-copy operation, then replay the original idempotent template command.',
      inputSchema: {
        kind: z.enum(['capture', 'apply', 'draft']),
        jobId: identifier,
        request: z.record(z.string(), z.unknown()),
      },
    },
    ({ kind, jobId, request }) =>
      toolResult(async () =>
        executeTemplateOperationResume(await session(), { kind, jobId, request }),
      ),
  );

  return [previewTemplateArchiveImport, exportTemplateArchive];
}
