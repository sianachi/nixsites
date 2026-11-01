import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { z } from 'zod';
import { workspaces } from '@nix/api-client';
import { identifier, workspaceRole, toolResult } from './mcp-support.ts';
import type { McpToolDeps } from './mcp-support.ts';

export function registerMemberTools(server: McpServer, { session }: McpToolDeps): void {
  server.registerTool(
    'change_workspace_member_role',
    {
      description: "Change a principal's direct membership role when permitted by the server.",
      inputSchema: { workspaceId: identifier, principalId: identifier, role: workspaceRole },
    },
    ({ workspaceId, principalId, role }) =>
      toolResult(async () =>
        (await session()).client.execute(
          workspaces.changeMemberRole(workspaceId, principalId, role),
        ),
      ),
  );

  server.registerTool(
    'remove_workspace_member',
    {
      description: "Remove a principal's direct membership when permitted by the server.",
      inputSchema: { workspaceId: identifier, principalId: identifier, confirm: z.literal(true) },
    },
    ({ workspaceId, principalId }) =>
      toolResult(async () => {
        await (await session()).client.execute(workspaces.removeMember(workspaceId, principalId));
        return { removed: true, principalId };
      }),
  );

  server.registerTool(
    'list_workspace_assignable_principals',
    {
      description:
        'List active direct and group-derived workspace principals available for assignment.',
      inputSchema: {
        workspaceId: identifier,
        query: z.string().trim().max(128).optional(),
        limit: z.number().int().min(1).max(100).default(50),
        cursor: z.string().max(128).optional(),
      },
    },
    ({ workspaceId, query, limit, cursor }) =>
      toolResult(async () =>
        (await session()).client.query(
          workspaces.listAssignablePrincipalsPage(workspaceId, {
            ...(query === undefined ? {} : { query }),
            limit,
            ...(cursor === undefined ? {} : { cursor }),
          }),
        ),
      ),
  );

  server.registerTool(
    'leave_workspace',
    {
      description: 'Leave a workspace when doing so preserves ownership.',
      inputSchema: { workspaceId: identifier, confirm: z.literal(true) },
    },
    ({ workspaceId }) =>
      toolResult(async () => {
        await (await session()).client.execute(workspaces.leaveWorkspace(workspaceId));
        return { left: true, workspaceId };
      }),
  );
}
