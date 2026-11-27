import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { z } from 'zod';
import {
  executeMessageDirectory,
  executeMessageStatus,
  executePostMessage,
} from './commands/messages.ts';
import { identifier, toolResult } from './mcp-support.ts';
import type { McpToolDeps } from './mcp-support.ts';

export function registerMessageTools(server: McpServer, { session }: McpToolDeps): void {
  server.registerTool(
    'post_message',
    {
      description:
        'Post a message under an item, or a reply under a message. "to" lists people ("person:<id>") and your own pets ("pet:<id>"); the text is never parsed for mentions. ' +
        'Addressing a pet needs the pets:send scope and the workspace switch "agents may address pets": off posts the message and starts no turn, ask holds the turn until the pet\'s owner approves it in the app, on starts it at once (50 pet turns a day per credential). ' +
        "The answer says where each addressed pet stands (pending, working, answered, failed, declined, expired) and your monthly pet budget; read the pet's reply as a child message, or check message_status.",
      inputSchema: {
        itemId: identifier,
        text: z.string().min(1).max(16_000),
        to: z.array(z.string().max(60)).max(20).optional(),
      },
    },
    ({ itemId, text, to }) =>
      toolResult(async () => executePostMessage(await session(), itemId, { text, to })),
  );

  server.registerTool(
    'message_directory',
    {
      description:
        'Who a message under this item can address: people who can read it, and (with the pets:send scope) your own pets.',
      inputSchema: { itemId: identifier, query: z.string().max(100).optional() },
    },
    ({ itemId, query }) =>
      toolResult(async () => executeMessageDirectory(await session(), itemId, query)),
  );

  server.registerTool(
    'message_status',
    {
      description:
        'Where each pet a message you posted addressed stands: pending (waiting for its owner), working, answered, failed (with a reason), declined or expired.',
      inputSchema: { messageId: identifier },
    },
    ({ messageId }) => toolResult(async () => executeMessageStatus(await session(), messageId)),
  );
}
