import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { z } from 'zod';
import { executePetRuntime, executePetToolRun } from './commands/pets.ts';
import { identifier, toolResult, petSessionForMcp } from './mcp-support.ts';
import type { McpToolDeps } from './mcp-support.ts';
import { petPlans } from '@nix/api-client';
import { randomUUID } from 'node:crypto';
import {
  decisionContextPath,
  executePlanDecision,
  executePlanDecisionHandoff,
} from './commands/pet-plans.ts';

export function registerPetTools(server: McpServer, { options }: McpToolDeps): void {
  server.registerTool(
    'pet_plans',
    {
      description:
        'Inspect durable companion plans and their receipts. Decisions require an exact named-client handoff authorized in the owner browser. Handoff secrets stay in private local storage.',
      inputSchema: {
        operation: z.enum([
          'list',
          'inspect',
          'sharing_handoff',
          'decision_handoff',
          'handoff_status',
          'cancel',
          'receipts',
          'undo_handoff',
        ]),
        workspaceId: identifier,
        runId: identifier.optional(),
        clientName: z.string().min(1).max(80).optional(),
        approve: z.boolean().optional(),
        contextId: identifier.optional(),
        stepId: identifier.optional(),
        apiUrl: z.string().optional(),
      },
    },
    (input) =>
      toolResult(async () => {
        const session = await petSessionForMcp(input.apiUrl, options);
        if (input.operation === 'list')
          return session.client.query(petPlans.list(input.workspaceId), { forceRefresh: true });
        if (!input.runId) throw new Error('Choose a run to inspect.');
        if (input.operation === 'sharing_handoff')
          return {
            browserPath: `/w/${input.workspaceId}/pet/plans/${input.runId}/review`,
            instruction: 'Review the provider and source sharing in your signed-in Nix browser.',
          };
        if (input.operation === 'decision_handoff') {
          if (!input.clientName) throw new Error('Name the client receiving this exact decision.');
          return executePlanDecisionHandoff(
            session,
            input.workspaceId,
            input.runId,
            input.clientName,
            input.approve ?? true,
            options.sessionDeps?.env,
          );
        }
        if (input.operation === 'handoff_status') {
          if (!input.contextId) throw new Error('Choose the requested handoff.');
          return session.client.query(
            petPlans.handoffStatus(input.workspaceId, input.runId, input.contextId),
            { forceRefresh: true },
          );
        }
        const run = await session.client.query(petPlans.read(input.workspaceId, input.runId), {
          forceRefresh: true,
        });
        if (input.operation === 'cancel')
          return session.client.execute(
            petPlans.cancel(input.workspaceId, input.runId, {
              expectedRunRevision: run.revision,
              requestId: randomUUID(),
            }),
          );
        if (input.operation === 'undo_handoff') {
          if (!run.plan || !input.stepId)
            throw new Error('Choose an applied step with a supported receipt.');
          const step = run.plan.steps.find((value) => value.id === input.stepId);
          if (!step?.undoId) throw new Error('This step has no supported undo receipt.');
          return {
            browserPath: `/w/${input.workspaceId}/pet/plans/${input.runId}/review?stepId=${input.stepId}`,
            stepId: input.stepId,
            instruction: 'Review this receipt and choose Undo in your signed-in Nix browser.',
          };
        }
        return run;
      }),
  );
  server.registerTool(
    'pet_plan_decide',
    {
      description:
        'Submit an exact one-use plan decision from a previously browser-authorized context in private storage. A PAT or textual approval alone cannot authorize it.',
      inputSchema: { contextId: identifier, apiUrl: z.string().optional() },
    },
    (input) =>
      toolResult(async () =>
        executePlanDecision(
          await petSessionForMcp(input.apiUrl, options),
          decisionContextPath(input.contextId, options.sessionDeps?.env),
        ),
      ),
  );
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
