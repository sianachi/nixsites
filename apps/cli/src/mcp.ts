/** Workspace administration tools exposed over the Model Context Protocol. */

import type { McpServer, RegisteredTool } from '@modelcontextprotocol/sdk/server/mcp.js';
import { registerTemplateDraftTools } from './mcp-template-drafts.ts';
import { registerWorkspaceTools } from './mcp-workspaces.ts';
import { registerHabitAndCommentTools } from './mcp-habits-comments.ts';
import { registerMemberTools } from './mcp-members.ts';
import { registerDocumentAndFileTools } from './mcp-files.ts';
import { registerTemplateTools } from './mcp-templates.ts';
import { registerPetTools } from './mcp-pets.ts';
import { registerStructureAndBlueprintTools } from './mcp-blueprints.ts';
import { registerNotificationAndReminderTools } from './mcp-notifications.ts';
import { registerCalendarTools } from './mcp-calendar.ts';
import { registerAutomationTools } from './mcp-automations.ts';
import { registerItemTools } from './mcp-items.ts';
import { registerHistoryTools } from './mcp-history.ts';
import { registerActionTools } from './mcp-actions.ts';
import { registerRecordTools } from './mcp-records.ts';
import { registerConversationMcpTools } from './mcp-conversations.ts';
import { resolveSession, type SessionDeps } from './commands/shared.ts';
import { toolResult } from './mcp-support.ts';
import type { Session } from './session.ts';

export interface WorkspaceMcpOptions {
  readonly transport?: 'stdio' | 'http';
  readonly profileName?: string;
  readonly sessionDeps?: SessionDeps;
  readonly resolve?: (profileName: string | undefined, deps: SessionDeps) => Promise<Session>;
}

/** Creates the MCP server without binding a transport, so protocol tests can use an in-memory pair. */
export async function createWorkspaceMcpServer(
  options: WorkspaceMcpOptions = {},
): Promise<McpServer> {
  const { McpServer } = await import('@modelcontextprotocol/sdk/server/mcp.js');
  const server = new McpServer({ name: 'nixctl', version: '0.7.0' });
  const resolver = options.resolve ?? resolveSession;
  const session = lazy(() => resolver(options.profileName, options.sessionDeps ?? {}));
  const deps = { session, options };
  // Tools that touch the MCP host's filesystem or saved profiles; removed again over HTTP.
  const hostOnly: RegisteredTool[] = [];

  registerTemplateDraftTools(server, deps);
  registerWorkspaceTools(server, deps);
  registerHabitAndCommentTools(server, deps);
  registerMemberTools(server, deps);
  hostOnly.push(...registerDocumentAndFileTools(server, deps));
  hostOnly.push(...registerTemplateTools(server, deps));
  registerPetTools(server, deps);
  registerStructureAndBlueprintTools(server, deps);
  registerNotificationAndReminderTools(server, deps);
  registerCalendarTools(server, deps);
  registerAutomationTools(server, deps);
  registerItemTools(server, deps);
  registerHistoryTools(server, deps);
  registerRecordTools(server, deps);
  registerActionTools(server, deps);
  if (options.transport === 'http') {
    // Core permissions cannot authorize access to the MCP host's filesystem or saved profiles.
    for (const tool of hostOnly) {
      tool.remove();
    }
  }
  registerConversationMcpTools(server, session, toolResult);
  return server;
}

/** Runs `nixctl mcp` on stdio. Protocol messages are the only bytes written to stdout. */
export async function runWorkspaceMcpServer(profileName: string | undefined): Promise<void> {
  const server = await createWorkspaceMcpServer(profileName === undefined ? {} : { profileName });
  const { StdioServerTransport } = await import('@modelcontextprotocol/sdk/server/stdio.js');
  await server.connect(new StdioServerTransport());
}

function lazy<T>(factory: () => Promise<T>): () => Promise<T> {
  let value: Promise<T> | undefined;
  return () => {
    value ??= factory();
    return value;
  };
}
