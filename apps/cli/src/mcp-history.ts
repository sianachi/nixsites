import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { z } from 'zod';
import { requireAccessToken } from './commands/shared.ts';
import { listNamedVersions, listRevisions, nameVersion, restoreRevision } from './history.ts';
import { identifier, toolResult } from './mcp-support.ts';
import type { McpToolDeps } from './mcp-support.ts';

export function registerHistoryTools(server: McpServer, { session }: McpToolDeps): void {
  // History lives in the collaboration service, so these reach it the way read_note does.
  const history = async (itemId: string) => {
    const current = await session();
    return {
      collabUrl: current.endpoints.collabUrl,
      itemId,
      token: await requireAccessToken(current),
    };
  };
  server.registerTool(
    'list_note_history',
    {
      description:
        "List a note's revisions, newest first (page back with before), and its named versions.",
      inputSchema: {
        itemId: identifier,
        limit: z.number().int().min(1).max(100).optional(),
        before: z.number().int().min(0).optional(),
      },
    },
    ({ itemId, limit, before }) =>
      toolResult(async () => {
        const target = await history(itemId);
        const [revisions, named] = await Promise.all([
          listRevisions({
            ...target,
            limit: limit ?? 50,
            ...(before === undefined ? {} : { before }),
          }),
          listNamedVersions(target),
        ]);
        return { revisions, namedVersions: named.versions };
      }),
  );
  server.registerTool(
    'restore_note_version',
    {
      description:
        'Replace the note with its state at a revision (seq), as one new revision; history is kept. ' +
        'Everyone sees the restored text, so confirm with the user first.',
      inputSchema: { itemId: identifier, seq: z.number().int().min(0), confirm: z.boolean() },
    },
    ({ itemId, seq, confirm }) =>
      toolResult(async () => {
        if (!confirm) throw new Error('Set confirm: true to restore this version.');
        return restoreRevision({ ...(await history(itemId)), seq });
      }),
  );
  server.registerTool(
    'name_note_version',
    {
      description: 'Name a revision (seq) so retention never removes it.',
      inputSchema: {
        itemId: identifier,
        seq: z.number().int().min(0),
        name: z.string().min(1).max(200),
      },
    },
    ({ itemId, seq, name }) =>
      toolResult(async () => nameVersion({ ...(await history(itemId)), seq, name })),
  );
}
