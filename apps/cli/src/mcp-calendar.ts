import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { z } from 'zod';
import {
  executeLinkLog,
  executeListLinks,
  executeSyncLink,
  executeUnlink,
} from './commands/calendar-sync.ts';
import { identifier, toolResult } from './mcp-support.ts';
import type { McpToolDeps } from './mcp-support.ts';

export function registerCalendarTools(server: McpServer, { session }: McpToolDeps): void {
  server.registerTool(
    'list_calendar_links',
    {
      description: 'List the Google and Outlook calendars linked into your workspaces.',
      inputSchema: {},
    },
    () => toolResult(async () => executeListLinks(await session())),
  );

  server.registerTool(
    'sync_calendar_link',
    {
      description: 'Ask for a sync round of a calendar link now.',
      inputSchema: { linkId: identifier },
    },
    ({ linkId }) => toolResult(async () => executeSyncLink(await session(), linkId)),
  );

  server.registerTool(
    'calendar_link_log',
    {
      description: "Read the newest entries of a calendar link's sync log.",
      inputSchema: { linkId: identifier },
    },
    ({ linkId }) => toolResult(async () => executeLinkLog(await session(), linkId)),
  );

  server.registerTool(
    'unlink_calendar',
    {
      description:
        "Unlink a calendar. Nothing is removed from the external calendar. 'keep' leaves the notes " +
        "it created as ordinary items; 'trash' moves them to the trash.",
      inputSchema: { linkId: identifier, items: z.enum(['keep', 'trash']) },
    },
    ({ linkId, items }) => toolResult(async () => executeUnlink(await session(), linkId, items)),
  );
}
