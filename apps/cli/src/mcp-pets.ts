import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { z } from 'zod';
import { executePetRuntime, executePetToolRun } from './commands/pets.ts';
import { identifier, toolResult, petSessionForMcp } from './mcp-support.ts';
import type { McpToolDeps } from './mcp-support.ts';

export function registerPetTools(server: McpServer, { options }: McpToolDeps): void {
  server.registerTool(
    'pet_runtime',
    {
      description:
        'Drive a pet companion runtime: status, connect, send, watch (long-poll for a change past `after`), tool_claim/tool_result, and settings. Uses a short-lived interactive session, never expanded PAT scopes.',
      inputSchema: {
        operation: z.enum([
          'status',
          'connect',
          'disconnect',
          'models',
          'read',
          'watch',
          'send',
          'interrupt',
          'reset',
          'settings',
          'tool_claim',
          'tool_result',
          'history',
          'read_history',
          'delete_history',
          'rename',
          'resume_history',
        ]),
        workspaceId: identifier.optional(),
        petId: identifier.optional(),
        rootItemId: identifier.optional(),
        allowEdits: z.boolean().optional(),
        historyId: identifier.optional(),
        title: z.string().max(120).optional(),
        message: z.string().max(20_000).optional(),
        model: z.string().max(160).optional(),
        workspaceTools: z.boolean().optional(),
        toolId: z.string().max(200).optional(),
        requestId: z.string().max(80).optional(),
        toolResult: z.string().max(32_000).optional(),
        toolSuccess: z.boolean().optional(),
        after: z.number().int().min(0).optional(),
        apiUrl: z.string().trim().min(1).optional(),
      },
    },
    (input) =>
      toolResult(async () => {
        const session = await petSessionForMcp(input.apiUrl, options);
        return executePetRuntime(session.client, input.operation, {
          ...(input.workspaceId ? { workspace: input.workspaceId } : {}),
          ...(input.petId ? { pet: input.petId } : {}),
          ...(input.rootItemId ? { rootItem: input.rootItemId } : {}),
          ...(input.allowEdits !== undefined ? { allowEdits: input.allowEdits } : {}),
          ...(input.historyId ? { historyId: input.historyId } : {}),
          ...(input.title !== undefined ? { title: input.title } : {}),
          ...(input.message !== undefined ? { message: input.message } : {}),
          ...(input.model !== undefined ? { model: input.model } : {}),
          ...(input.workspaceTools !== undefined ? { workspaceTools: input.workspaceTools } : {}),
          ...(input.toolId !== undefined ? { toolId: input.toolId } : {}),
          ...(input.requestId !== undefined ? { requestId: input.requestId } : {}),
          ...(input.toolResult !== undefined ? { toolResult: input.toolResult } : {}),
          ...(input.toolSuccess !== undefined ? { toolSuccess: input.toolSuccess } : {}),
          ...(input.after !== undefined ? { after: input.after } : {}),
        });
      }),
  );

  server.registerTool(
    'pet_tool_run',
    {
      description:
        'Preview, approve, or decline one pending companion workspace tool call, claiming before any write exactly as the web companion panel does. Uses a short-lived interactive session, never expanded PAT scopes.',
      inputSchema: {
        workspaceId: identifier,
        petId: identifier,
        rootItemId: identifier.optional(),
        allowEdits: z.boolean().optional(),
        toolId: z.string().max(200),
        decision: z.enum(['approve', 'decline', 'preview']),
        apiUrl: z.string().trim().min(1).optional(),
      },
    },
    ({ workspaceId, petId, toolId, decision, apiUrl, rootItemId, allowEdits }) =>
      toolResult(async () =>
        executePetToolRun(
          await petSessionForMcp(apiUrl, options),
          workspaceId,
          petId,
          toolId,
          decision,
          undefined,
          rootItemId ? { rootItemId, readOnly: !allowEdits } : undefined,
        ),
      ),
  );
}
