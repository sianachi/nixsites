import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { z } from 'zod';
import { operations, workspaces } from '@nix/api-client';
import { executeTemplateImportCancel } from './commands/templates.ts';
import { identifier, workspaceRole, pageInput, toolResult } from './mcp-support.ts';
import type { McpToolDeps } from './mcp-support.ts';

export function registerWorkspaceTools(server: McpServer, { session }: McpToolDeps): void {
  server.registerTool(
    'list_workspaces',
    {
      description: 'List one bounded page of Nix workspaces reachable by the current principal.',
      inputSchema: pageInput,
    },
    ({ limit, cursor }) =>
      toolResult(async () =>
        (await session()).client.query(
          workspaces.listWorkspacesPage({ limit, ...(cursor === undefined ? {} : { cursor }) }),
        ),
      ),
  );

  server.registerTool(
    'create_workspace',
    {
      description: 'Create a shared Nix workspace owned by the current principal.',
      inputSchema: { name: z.string().trim().min(1).max(200) },
    },
    ({ name }) =>
      toolResult(async () => (await session()).client.execute(workspaces.createWorkspace(name))),
  );

  server.registerTool(
    'rename_workspace',
    {
      description: 'Rename a workspace when the server grants that capability.',
      inputSchema: { workspaceId: identifier, name: z.string().trim().min(1).max(200) },
    },
    ({ workspaceId, name }) =>
      toolResult(async () =>
        (await session()).client.execute(workspaces.renameWorkspace(workspaceId, name)),
      ),
  );

  server.registerTool(
    'set_workspace_sharing',
    {
      description:
        'Close or open a workspace to new members (membershipLocked), and turn live collaboration ' +
        'on or off (off means one editor at a time). Owners only; an omitted field is left as it is.',
      inputSchema: {
        workspaceId: identifier,
        membershipLocked: z.boolean().optional(),
        collaboration: z.boolean().optional(),
      },
    },
    ({ workspaceId, membershipLocked, collaboration }) =>
      toolResult(async () =>
        (await session()).client.execute(
          workspaces.setWorkspaceSharing(workspaceId, {
            ...(membershipLocked === undefined ? {} : { membershipLocked }),
            ...(collaboration === undefined ? {} : { collaboration }),
          }),
        ),
      ),
  );

  server.registerTool(
    'list_workspace_invitations',
    {
      description: 'List invitation history for a workspace.',
      inputSchema: { workspaceId: identifier, ...pageInput },
    },
    ({ workspaceId, limit, cursor }) =>
      toolResult(async () =>
        (await session()).client.query(
          workspaces.listInvitationsPage(workspaceId, {
            limit,
            ...(cursor === undefined ? {} : { cursor }),
          }),
        ),
      ),
  );

  server.registerTool(
    'list_workspace_invitees',
    {
      description:
        'List active Nix users in the organization with Core-decided invitation eligibility; search by name or email.',
      inputSchema: {
        workspaceId: identifier,
        ...pageInput,
        query: z.string().trim().max(128).optional(),
      },
    },
    ({ workspaceId, limit, cursor, query }) =>
      toolResult(async () =>
        (await session()).client.query(
          workspaces.listInviteesPage(workspaceId, {
            limit,
            ...(query === undefined ? {} : { query }),
            ...(cursor === undefined ? {} : { cursor }),
          }),
        ),
      ),
  );

  server.registerTool(
    'invite_workspace_member',
    {
      description:
        'Grant an existing Nix user provisional access as an owner, editor, commenter (read and comment, no edits), or viewer.',
      inputSchema: {
        workspaceId: identifier,
        principalId: identifier,
        role: workspaceRole,
      },
    },
    ({ workspaceId, principalId, role }) =>
      toolResult(async () =>
        (await session()).client.execute(
          workspaces.createInvitation(workspaceId, principalId, role),
        ),
      ),
  );

  server.registerTool(
    'accept_workspace_invitation',
    {
      description: 'Accept a workspace invitation addressed to the current principal.',
      inputSchema: { workspaceId: identifier, invitationId: identifier },
    },
    ({ workspaceId, invitationId }) =>
      toolResult(async () => {
        await (
          await session()
        ).client.execute(workspaces.acceptInvitation(workspaceId, invitationId));
        return { accepted: true, invitationId };
      }),
  );

  server.registerTool(
    'decline_workspace_invitation',
    {
      description: 'Decline a workspace invitation and remove provisional access.',
      inputSchema: { workspaceId: identifier, invitationId: identifier, confirm: z.literal(true) },
    },
    ({ workspaceId, invitationId }) =>
      toolResult(async () => {
        await (
          await session()
        ).client.execute(workspaces.declineInvitation(workspaceId, invitationId));
        return { declined: true, invitationId };
      }),
  );

  server.registerTool(
    'revoke_workspace_invitation',
    {
      description: 'Revoke a pending workspace invitation.',
      inputSchema: { workspaceId: identifier, invitationId: identifier, confirm: z.literal(true) },
    },
    ({ workspaceId, invitationId }) =>
      toolResult(async () => {
        await (
          await session()
        ).client.execute(workspaces.revokeInvitation(workspaceId, invitationId));
        return { revoked: true, invitationId };
      }),
  );

  server.registerTool(
    'get_operation',
    {
      description: 'Read the current state of an operation visible to the current principal.',
      inputSchema: { operationId: identifier },
    },
    ({ operationId }) =>
      toolResult(async () =>
        (await session()).client.query(operations.operationById(operationId), {
          forceRefresh: true,
        }),
      ),
  );

  server.registerTool(
    'cancel_template_archive_import',
    {
      description: 'Cancel a template archive import visible to the current principal.',
      inputSchema: { importId: identifier, confirm: z.literal(true) },
    },
    ({ importId }) =>
      toolResult(async () => executeTemplateImportCancel(await session(), importId)),
  );

  server.registerTool(
    'list_workspace_members',
    {
      description: 'List principal and group workspace grants with server-decided capabilities.',
      inputSchema: { workspaceId: identifier, ...pageInput },
    },
    ({ workspaceId, limit, cursor }) =>
      toolResult(async () =>
        (await session()).client.query(
          workspaces.listMembersPage(workspaceId, {
            limit,
            ...(cursor === undefined ? {} : { cursor }),
          }),
        ),
      ),
  );
}
