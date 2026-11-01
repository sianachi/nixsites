import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { z } from 'zod';
import { items, search, structure } from '@nix/api-client';
import { requireAccessToken } from './commands/shared.ts';
import { readBodyMarkdown, writeBodyMarkdown } from './body.ts';
import { identifier, jsonObjectInput, toolResult } from './mcp-support.ts';
import type { McpToolDeps } from './mcp-support.ts';

export function registerItemTools(server: McpServer, { session }: McpToolDeps): void {
  // Notes and items (requirement 9): the general read/write surface a remote client needs, through
  // the same Core and Collab paths the CLI's `item` and `note` commands use. Core authorizes each
  // call; a locked or invisible note is refused with Core's words, never read around.
  server.registerTool(
    'list_items',
    {
      description:
        'List the children of an item, or the roots of a workspace when no parent is given, up to `limit` (default 200); `truncated` says when there were more.',
      inputSchema: {
        workspaceId: identifier,
        parentId: identifier.optional(),
        limit: z.number().int().min(1).max(500).optional(),
      },
    },
    ({ workspaceId, parentId, limit }) =>
      toolResult(async () => {
        const current = await session();
        const ceiling = limit ?? 200;
        const rows: unknown[] = [];
        let truncated = false;
        for await (const item of current.client.paginate(
          items.listItems(workspaceId, {
            ...(parentId === undefined ? {} : { parentId }),
            pageSize: Math.min(ceiling, 100),
          }),
        )) {
          if (rows.length >= ceiling) {
            truncated = true;
            break;
          }
          rows.push(item);
        }
        return { items: rows, count: rows.length, truncated };
      }),
  );
  server.registerTool(
    'get_item',
    {
      description: 'Read one item: title, type, parent, properties and protections.',
      inputSchema: { itemId: identifier },
    },
    ({ itemId }) => toolResult(async () => (await session()).client.query(items.itemById(itemId))),
  );
  server.registerTool(
    'create_item',
    {
      description:
        'Create an item (a note by default) under a parent, or at the workspace root. An empty title is kept as given.',
      inputSchema: {
        workspaceId: identifier,
        title: z.string().max(500),
        type: z.string().min(1).max(40).optional(),
        parentId: identifier.optional(),
      },
    },
    ({ workspaceId, title, type, parentId }) =>
      toolResult(async () =>
        (await session()).client.execute(
          items.createItem(workspaceId, {
            type: type ?? 'note',
            title,
            parentId: parentId ?? null,
          }),
        ),
      ),
  );
  server.registerTool(
    'search_items',
    {
      description: 'Full-text search over the items you may read.',
      inputSchema: {
        query: z.string().min(1).max(500),
        limit: z.number().int().min(1).max(100).optional(),
      },
    },
    ({ query, limit }) =>
      toolResult(async () => (await session()).client.query(search.searchItems(query, limit))),
  );
  server.registerTool(
    'read_note',
    {
      description: 'Read a note body as Markdown, with the list of what Markdown could not carry.',
      inputSchema: { itemId: identifier },
    },
    ({ itemId }) =>
      toolResult(async () => {
        const current = await session();
        const token = await requireAccessToken(current);
        return readBodyMarkdown({ collabUrl: current.endpoints.collabUrl, itemId, token });
      }),
  );
  server.registerTool(
    'write_note',
    {
      description:
        'Replace a note body with Markdown (up to 200,000 characters). The Markdown must parse into a valid note.',
      inputSchema: { itemId: identifier, markdown: z.string().max(200_000) },
    },
    ({ itemId, markdown }) =>
      toolResult(async () => {
        const current = await session();
        const token = await requireAccessToken(current);
        return writeBodyMarkdown({
          collabUrl: current.endpoints.collabUrl,
          itemId,
          token,
          markdown,
        });
      }),
  );

  server.registerTool(
    'move_item',
    {
      description:
        'Move an item under a new parent (omit parentId for the workspace root), after a sibling if afterId is given. ' +
        'Pass destinationWorkspaceId to move it into another workspace.',
      inputSchema: {
        workspaceId: identifier,
        itemId: identifier,
        parentId: identifier.nullable().optional(),
        afterId: identifier.nullable().optional(),
        destinationWorkspaceId: identifier.optional(),
      },
    },
    ({ workspaceId, itemId, parentId, afterId, destinationWorkspaceId }) =>
      toolResult(async () =>
        (await session()).client.execute(
          items.moveItem(workspaceId, itemId, {
            parentId: parentId ?? null,
            afterId,
            workspaceId: destinationWorkspaceId,
          }),
        ),
      ),
  );
  server.registerTool(
    'rename_item',
    {
      description: "Change an item's title.",
      inputSchema: {
        workspaceId: identifier,
        itemId: identifier,
        title: z.string().min(1).max(500),
      },
    },
    ({ workspaceId, itemId, title }) =>
      toolResult(async () =>
        (await session()).client.execute(items.renameItem(workspaceId, itemId, title)),
      ),
  );
  server.registerTool(
    'trash_item',
    {
      description: 'Move an item to the trash. It can be restored with restore_item until purged.',
      inputSchema: { workspaceId: identifier, itemId: identifier },
    },
    ({ workspaceId, itemId }) =>
      toolResult(async () => {
        await (await session()).client.execute(items.deleteItem(workspaceId, itemId));
        return { id: itemId, deleted: true };
      }),
  );
  server.registerTool(
    'restore_item',
    {
      description: 'Restore an item from the trash.',
      inputSchema: { workspaceId: identifier, itemId: identifier },
    },
    ({ workspaceId, itemId }) =>
      toolResult(async () =>
        (await session()).client.execute(items.restoreItem(workspaceId, itemId)),
      ),
  );
  server.registerTool(
    'list_trash',
    {
      description: "List a workspace's trashed items.",
      inputSchema: { workspaceId: identifier, limit: z.number().int().min(1).max(200).optional() },
    },
    ({ workspaceId, limit }) =>
      toolResult(async () => {
        const ceiling = limit ?? 100;
        const rows: unknown[] = [];
        for await (const item of (await session()).client.paginate(
          items.listTrash(workspaceId, Math.min(ceiling, 100)),
        )) {
          rows.push(item);
          if (rows.length >= ceiling) break;
        }
        return { items: rows, count: rows.length };
      }),
  );
  server.registerTool(
    'set_item_properties',
    {
      description: 'Merge property values onto an item by key; a null value clears that key.',
      inputSchema: { itemId: identifier, properties: jsonObjectInput },
    },
    ({ itemId, properties }) =>
      toolResult(async () =>
        (await session()).client.execute(structure.setItemProperties(itemId, properties)),
      ),
  );
}
