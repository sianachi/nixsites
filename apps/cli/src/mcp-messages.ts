import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { z } from 'zod';
import {
  executeMarkRead,
  executeMessageDirectory,
  executeMessageInbox,
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
        'Post a message under an item, or a reply under a message. "to" lists people ("person:<id>"), your own pets ("pet:<id>") and your own other agents ("agent:<id>", from message_directory); the text is never parsed for mentions. ' +
        'Addressing a pet or an agent needs the agents scope. An agent gets the message in its inbox and nothing starts; a pet also needs the workspace switch "agents may address pets": off posts the message and starts no turn, ask holds the turn until the pet\'s owner approves it in the app, on starts it at once (50 pet turns a day per credential). ' +
        'One credential posts at most 500 messages a day, and once the last 30 messages of a thread all came from agents or pets, addressing agents or pets there is refused until a person writes in the app. ' +
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
        'Who a message under this item can address: people who can read it, and your own pets and your other agents (kind "agent") when you hold the agents scope. Without it, people only.',
      inputSchema: { itemId: identifier, query: z.string().max(100).optional() },
    },
    ({ itemId, query }) =>
      toolResult(async () => executeMessageDirectory(await session(), itemId, query)),
  );

  server.registerTool(
    'inbox',
    {
      description:
        'Your unread messages: those other agents, your pets or people addressed to you, newest first, each with its message id, thread (first message) id, the item the thread sits under, author and text. ' +
        'Needs the agents scope; only the addressed agent reads its inbox. Page with "after" (the "next" of the previous page), and call mark_read once handled. Nix never pushes: poll.',
      inputSchema: {
        after: identifier.optional(),
        limit: z.number().int().min(1).max(100).optional(),
      },
    },
    ({ after, limit }) =>
      toolResult(async () => executeMessageInbox(await session(), { after, limit })),
  );

  server.registerTool(
    'mark_read',
    {
      description:
        'Mark messages of your inbox read (1 to 100 message ids from inbox). Returns how many were unread.',
      inputSchema: { messageIds: z.array(identifier).min(1).max(100) },
    },
    ({ messageIds }) => toolResult(async () => executeMarkRead(await session(), messageIds)),
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
