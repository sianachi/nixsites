import type { StructureFingerprint, WorkspaceToolOutcome } from '@nix/companion';
import {
  READ_ONLY_OPERATIONS,
  workspaceToolSchema,
  type WorkspaceToolArgs,
} from '@nix/companion/tool-args';
import { flattenToolCall, WORKSPACE_OPERATIONS } from '@nix/structure-spec';

import type { WriteDecision } from '../pets/approval/approval-card';

/**
 * The `Query()` tools an `openui-lang` program may call, resolved in the viewer's own session
 * through the same `runWorkspaceTool` reads the pet uses, so Core's permissions and the lock
 * checks apply unchanged. Writes are a separate list (`createMutationTools`), and every one of
 * them waits for the owner's decision on an approval card.
 */
export const QUERY_TOOLS = [
  'search',
  'list_items',
  'read_item',
  'read_view',
  'read_calendar',
] as const;
export type QueryTool = (typeof QUERY_TOOLS)[number];

/** What a query returns instead of data when any of it sits under a lock. */
export const LOCKED_RESULT = { locked: true, results: [], items: [] } as const;

/** `runWorkspaceTool` with its ports and signal already bound. */
export type RunRead = (workspaceId: string, raw: string) => Promise<WorkspaceToolOutcome>;

function text(value: unknown): string {
  return typeof value === 'string' ? value : '';
}

/** The workspace a call names, or the block's first; anything outside the block's scope throws. */
function scopedWorkspace(args: Record<string, unknown>, workspaceIds: readonly string[]): string {
  const requested = text(args.workspaceId);
  const workspaceId = requested === '' ? (workspaceIds[0] ?? '') : requested;
  if (!workspaceIds.includes(workspaceId)) throw new Error('That workspace is not available here.');
  return workspaceId;
}

export function createQueryTools(
  workspaceIds: readonly string[],
  run: RunRead,
): Record<QueryTool, (args: Record<string, unknown>) => Promise<unknown>> {
  const tool = (operation: QueryTool) => async (args: Record<string, unknown>) => {
    // Belt and braces: the list above is read-only today, and must stay so.
    if (!READ_ONLY_OPERATIONS.has(operation)) throw new Error(`${operation} is not a read.`);
    const workspaceId = scopedWorkspace(args, workspaceIds);
    const raw = JSON.stringify({
      operation,
      itemId: text(args.itemId),
      parentId: text(args.parentId),
      title: '',
      markdown: '',
      // read_view takes its {viewId, pageSize} as JSON text; a program writes it as an object.
      query:
        typeof args.query === 'object' && args.query !== null
          ? JSON.stringify(args.query)
          : text(args.query),
      propertiesJson: '',
      specJson:
        operation === 'read_calendar' ? JSON.stringify({ from: args.from, to: args.to }) : '',
    });
    const outcome = await run(workspaceId, raw);
    if (outcome.lockedContent) return LOCKED_RESULT;
    const result = JSON.parse(outcome.text) as {
      entries?: { itemId?: unknown; title?: unknown }[];
    };
    // Calendar rows name their item `itemId` and may lack a title; ItemList wants `id` and text.
    if (operation === 'read_calendar' && Array.isArray(result.entries))
      result.entries = result.entries.map((entry) => ({
        ...entry,
        id: entry.itemId,
        title: entry.title ?? '',
      }));
    return result;
  };
  return {
    search: tool('search'),
    list_items: tool('list_items'),
    read_item: tool('read_item'),
    read_view: tool('read_view'),
    read_calendar: tool('read_calendar'),
  };
}

/** Every operation a `Mutation()` may name: each of the pet's write tools. */
export const MUTATION_TOOLS = WORKSPACE_OPERATIONS.filter(
  (operation) => !READ_ONLY_OPERATIONS.has(operation),
);

/** One write a component asks for, already parsed exactly as the pet's tool calls are. */
export interface WriteRequest {
  readonly workspaceId: string;
  readonly args: WorkspaceToolArgs;
}

/** Runs an approved write, fenced by the preview the owner approved. */
export type RunWrite = (
  workspaceId: string,
  args: WorkspaceToolArgs,
  fence: StructureFingerprint,
) => Promise<WorkspaceToolOutcome>;

/**
 * The `Mutation()` tools: `Mutation("complete_task", {itemId, completed: true})` takes the same
 * typed parameters as the pet's `nix_complete_task`, flattened by the same translation the worker
 * applies (`flattenToolCall`) and parsed by the same schema. Nothing runs until `approve` settles
 * with the owner's yes; a decline, or a request that does not parse, is the Mutation's error.
 */
export function createMutationTools(
  workspaceIds: readonly string[],
  approve: (request: WriteRequest) => Promise<WriteDecision>,
  run: RunWrite,
): Record<string, (args: Record<string, unknown>) => Promise<unknown>> {
  const tool =
    (operation: (typeof MUTATION_TOOLS)[number]) => async (args: Record<string, unknown>) => {
      const workspaceId = scopedWorkspace(args, workspaceIds);
      const typed = Object.fromEntries(
        Object.entries(args).filter(([key]) => key !== 'workspaceId'),
      );
      const parsed = workspaceToolSchema.safeParse(flattenToolCall(operation, typed));
      if (!parsed.success)
        throw new Error(
          `This ${operation} request is invalid: ${parsed.error.issues.map((issue) => issue.message).join('; ')}`,
        );
      const decision = await approve({ workspaceId, args: parsed.data });
      if (!decision.approved) throw new Error('Declined by the owner.');
      const outcome = await run(workspaceId, decision.args, decision.fence);
      return JSON.parse(outcome.text) as unknown;
    };
  return Object.fromEntries(MUTATION_TOOLS.map((operation) => [operation, tool(operation)]));
}
