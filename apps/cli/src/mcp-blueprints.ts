import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { z } from 'zod';
import { readStructureForSession } from './commands/structure.ts';
import { evaluateBlueprint, executeBlueprintBuild } from './commands/blueprint.ts';
import { identifier, toolResult } from './mcp-support.ts';
import type { McpToolDeps } from './mcp-support.ts';

export function registerStructureAndBlueprintTools(
  server: McpServer,
  { session }: McpToolDeps,
): void {
  server.registerTool(
    'structure_read',
    {
      description: "Read an item's effective fields, views and bounded child count.",
      inputSchema: { itemId: identifier },
    },
    ({ itemId }) => toolResult(async () => readStructureForSession(await session(), itemId)),
  );

  server.registerTool(
    'blueprint_validate',
    {
      description: 'Validate a blueprint without writing items.',
      inputSchema: { specJson: z.string().min(1), parentId: identifier.optional() },
    },
    ({ specJson, parentId }) =>
      toolResult(async () => {
        const raw: unknown = JSON.parse(specJson);
        const evaluated = await evaluateBlueprint(
          raw,
          { parent: parentId },
          parentId ? await session() : undefined,
        );
        return evaluated.report;
      }),
  );

  server.registerTool(
    'blueprint_describe',
    {
      description: 'Preview a blueprint without writing items.',
      inputSchema: { specJson: z.string().min(1), parentId: identifier.optional() },
    },
    ({ specJson, parentId }) =>
      toolResult(async () => {
        const raw: unknown = JSON.parse(specJson);
        const evaluated = await evaluateBlueprint(
          raw,
          { parent: parentId },
          parentId ? await session() : undefined,
        );
        return evaluated.preview ?? evaluated.report;
      }),
  );

  server.registerTool(
    'blueprint_build',
    {
      description: 'Build a validated blueprint as a draft. Requires explicit confirmation.',
      inputSchema: {
        specJson: z.string().min(1),
        parentId: identifier.optional(),
        workspaceId: identifier.optional(),
        confirm: z.boolean(),
      },
    },
    ({ specJson, parentId, workspaceId, confirm }) =>
      toolResult(async () => {
        if (!confirm) throw new Error('Set confirm: true to build this blueprint.');
        const raw: unknown = JSON.parse(specJson);
        return executeBlueprintBuild(
          raw,
          { parent: parentId, workspace: workspaceId, yes: true },
          await session(),
        );
      }),
  );
}
