import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { z } from 'zod';
import {
  callOperation,
  findOperations,
  isHumanOnlyOperation,
  operationById,
  operationRisk,
} from '@nix/api-client';
import { toolResult } from './mcp-support.ts';
import type { McpToolDeps } from './mcp-support.ts';

export function registerActionTools(server: McpServer, { session }: McpToolDeps): void {
  server.registerTool(
    'find_nix_action',
    {
      description:
        'Find Nix operations for anything the typed tools do not cover, by plain-language query. ' +
        'Returns each operation with its path, query and body shape; run one with run_nix_action. ' +
        'Operations that manage your credentials, pet settings, push subscriptions or calendar connections are not offered.',
      inputSchema: {
        query: z.string().min(1).max(300),
        limit: z.number().int().min(1).max(20).optional(),
      },
    },
    ({ query, limit }) =>
      toolResult(() =>
        Promise.resolve({
          operations: findOperations(
            query,
            limit ?? 8,
            (entry) => !isHumanOnlyOperation(entry),
          ).map((entry) => ({
            operationId: entry.id,
            method: entry.method,
            path: entry.path,
            summary: entry.summary,
            detail: entry.detail,
            pathParams: entry.pathParams,
            queryParams: entry.queryParams,
            body: entry.body,
            risk: operationRisk(entry),
          })),
        }),
      ),
  );
  server.registerTool(
    'run_nix_action',
    {
      description:
        'Run one operation found with find_nix_action. Prefer a typed tool when one exists. Core still ' +
        'enforces your permissions, locks and access scopes. An operation with a risk (irreversible, ' +
        'access, public) changes things that are hard to undo or who can see them: confirm with the user, then pass confirm: true.',
      inputSchema: {
        operationId: z.string().min(1).max(100),
        path: z.record(z.string(), z.string()).optional(),
        query: z.record(z.string(), z.union([z.string(), z.number(), z.boolean()])).optional(),
        body: z.unknown().optional(),
        confirm: z.boolean().optional(),
      },
    },
    ({ operationId, path, query, body, confirm }) =>
      toolResult(async () => {
        const entry = operationById(operationId);
        if (entry === undefined) throw new Error(`There is no Nix operation '${operationId}'.`);
        if (isHumanOnlyOperation(entry))
          throw new Error(
            `${operationId} manages credentials, grants or approvals, or steers a chat; do this yourself in Nix.`,
          );
        const risk = operationRisk(entry);
        // Same rule as the typed member and invitation tools: risky changes need an explicit yes.
        if (risk !== undefined && confirm !== true)
          throw new Error(
            `${operationId} is ${risk === 'irreversible' ? 'irreversible' : risk === 'access' ? 'an access change' : 'a public change'}; confirm with the user, then call again with confirm: true.`,
          );
        const result = await callOperation((await session()).client, operationId, {
          path,
          query,
          body,
        });
        return risk === undefined ? { result } : { risk, result };
      }),
  );
}
