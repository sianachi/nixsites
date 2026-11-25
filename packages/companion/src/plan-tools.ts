import { z } from 'zod';
import { items, type Item } from '@nix/api-client';
import { APP_ONLY_OPERATIONS } from './auto-apply.js';
import { loadPreviewContext } from './context.js';
import { checkItem } from './guards.js';
import type { CompanionPorts } from './ports.js';
import { describeToolCall } from './preview.js';
import { anyUnderLock } from './read/locks.js';
import { runWorkspaceTool, type RunOptions, type WorkspaceToolOutcome } from './run.js';
import type { NoteToolScope } from './scope.js';
import { workspaceToolSchema, WorkspaceToolRefusal, READ_ONLY_OPERATIONS } from './tool-args.js';

const json = z.json();
const field = z.strictObject({
  id: z.enum(['title', 'markdown', 'query']),
  label: z.string(),
  kind: z.literal('text'),
  value: z.string(),
  required: z.boolean(),
});
export const preparedWorkspacePlanToolSchema = z.strictObject({
  operation: workspaceToolSchema.shape.operation,
  revisions: z.string().max(4000).default(''),
  arguments: z.string().max(40_000),
  argumentFingerprint: z.string().max(40_000),
  freshnessFingerprint: z.string().max(262_144),
  preview: z.record(z.string(), json),
  execution: z.enum(['server', 'client']),
  lockedRead: z.boolean(),
  fields: z.array(field).max(3),
  targetIds: z.array(z.uuid()).max(2),
});
export type PreparedWorkspacePlanTool = z.infer<typeof preparedWorkspacePlanToolSchema>;

export const workspacePlanExecutionContextSchema = z.strictObject({
  runId: z.uuid(),
  planId: z.uuid(),
  planVersion: z.int().positive(),
  reviewDigest: z.string().min(1).max(128),
  stepId: z.uuid(),
  claimId: z.uuid(),
  executionId: z.uuid(),
  dispatchContext: z.string().min(1).max(16_384),
});
export type WorkspacePlanExecutionContext = z.infer<typeof workspacePlanExecutionContextSchema>;

function stable(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(stable);
  if (value !== null && typeof value === 'object')
    return Object.fromEntries(
      Object.entries(value)
        .sort(([left], [right]) => (left < right ? -1 : left > right ? 1 : 0))
        .map(([key, entry]) => [key, stable(entry)]),
    );
  return value;
}
const canonical = (value: unknown) => JSON.stringify(stable(value));

/** Preparation receives query ports. A preview cannot accidentally dispatch a mutation. */
function readPorts(ports: CompanionPorts): CompanionPorts {
  const refuse = (): never => {
    throw new WorkspaceToolRefusal('Preparing a plan cannot change the workspace.');
  };
  return {
    ...ports,
    core: {
      ...ports.core,
      execute: (endpoint, options) => {
        if (
          ![
            'templates.preflight',
            'workspaceQuery.run',
            'workspaceQuery.aggregate',
            'chart.run',
          ].includes(endpoint.operation)
        )
          return refuse();
        return ports.core.execute(endpoint, options);
      },
      stream: refuse,
    },
    collab: { ...ports.collab, execute: refuse, stream: refuse },
    bodies: { ...ports.bodies, append: refuse, applyEdit: refuse },
  };
}

export async function prepareWorkspacePlanTool(input: {
  ports: CompanionPorts;
  workspaceId: string;
  arguments: string;
  signal: AbortSignal;
  scope?: NoteToolScope;
  lockedRead: boolean;
}): Promise<PreparedWorkspacePlanTool> {
  z.uuid().parse(input.workspaceId);
  if (input.arguments.length > 40_000)
    throw new WorkspaceToolRefusal('The plan arguments are too large.');
  const args = workspaceToolSchema.parse(JSON.parse(input.arguments));
  if (args.operation === 'remember' && input.lockedRead)
    throw new WorkspaceToolRefusal('Protected content cannot be saved as companion memory.');
  if (args.operation === 'move_item' && args.specJson.trim())
    throw new WorkspaceToolRefusal(
      'A plan changes one workspace. Review a move to another workspace separately.',
    );
  const ports = readPorts(input.ports);
  const context = await loadPreviewContext(
    ports,
    input.workspaceId,
    args,
    input.signal,
    input.scope,
  );
  const preview = describeToolCall(args, context);
  if (preview.problems.length > 0)
    throw new WorkspaceToolRefusal(preview.problems.map((problem) => problem.message).join('\n'));
  const itemTarget = ['read_template', 'apply_template'].includes(args.operation)
    ? ''
    : args.itemId;
  const targetIds = [...new Set([itemTarget, args.parentId].filter((id) => id !== ''))];
  const targets = await Promise.all(
    targetIds.map(async (id) => {
      let item: Item | undefined;
      if (args.operation === 'restore_item') {
        let count = 0;
        for await (const trashed of ports.core.paginate(items.listTrash(input.workspaceId, 50), {
          signal: input.signal,
          forceRefresh: true,
        })) {
          if (++count > 500) break;
          if (trashed.id === id) {
            item = trashed;
            break;
          }
        }
        if (item === undefined)
          throw new WorkspaceToolRefusal(
            'The restore target is unavailable in this workspace trash.',
          );
      } else item = await checkItem(ports, input.workspaceId, id, input.signal);
      if (item.workspaceId !== input.workspaceId || item.settings.withholdFromPets)
        throw new WorkspaceToolRefusal('The plan target is unavailable to this companion.');
      return item;
    }),
  );
  const lockedRead =
    input.lockedRead ||
    context.refusalQuotesLockedContent === true ||
    (await anyUnderLock(ports, targetIds, input.signal));
  if (args.operation === 'remember' && lockedRead)
    throw new WorkspaceToolRefusal('Protected content cannot be saved as companion memory.');
  const fields: z.infer<typeof field>[] = [];
  if (args.title !== '')
    fields.push({ id: 'title', label: 'Title', kind: 'text', value: args.title, required: true });
  if (
    args.markdown !== '' ||
    ['replace_passage', 'replace_section', 'create_note'].includes(args.operation)
  )
    fields.push({
      id: 'markdown',
      label: args.operation === 'remember' ? 'Memory' : 'Text',
      kind: 'text',
      value: args.markdown,
      required: args.operation !== 'replace_passage' && args.operation !== 'create_note',
    });
  if (args.query !== '' && ['replace_passage', 'replace_section'].includes(args.operation))
    fields.push({
      id: 'query',
      label: args.operation === 'replace_section' ? 'Heading' : 'Find text',
      kind: 'text',
      value: args.query,
      required: true,
    });
  return preparedWorkspacePlanToolSchema.parse({
    operation: args.operation,
    arguments: canonical(args),
    argumentFingerprint: canonical(args),
    freshnessFingerprint: canonical({
      context,
      targets,
      ...(['build_blueprint', 'set_recurrence', 'create_structured', 'create_entries'].includes(
        args.operation,
      )
        ? { clock: { today: ports.clock.today(), timeZone: ports.clock.timeZone() } }
        : {}),
    }),
    preview,
    execution: APP_ONLY_OPERATIONS.has(args.operation) ? 'client' : 'server',
    lockedRead,
    fields,
    targetIds,
  });
}

/** Dispatch supplies ports carrying the exact Core step fence. Raw owner ports cannot execute a plan. */
export async function runPreparedWorkspacePlanTool(input: {
  ports: CompanionPorts;
  workspaceId: string;
  prepared: PreparedWorkspacePlanTool;
  signal: AbortSignal;
  executionContext: WorkspacePlanExecutionContext;
  dispatch: (
    context: WorkspacePlanExecutionContext,
    prepared: PreparedWorkspacePlanTool,
  ) => Promise<CompanionPorts>;
  scope?: NoteToolScope;
  buildLedger?: RunOptions['buildLedger'];
}): Promise<WorkspaceToolOutcome> {
  const prepared = preparedWorkspacePlanToolSchema.parse(input.prepared);
  const execution = workspacePlanExecutionContextSchema.parse(input.executionContext);
  const current = await prepareWorkspacePlanTool({
    ports: input.ports,
    workspaceId: input.workspaceId,
    arguments: prepared.arguments,
    signal: input.signal,
    lockedRead: prepared.lockedRead,
    ...(input.scope === undefined ? {} : { scope: input.scope }),
  });
  if (
    current.argumentFingerprint !== prepared.argumentFingerprint ||
    current.freshnessFingerprint !== prepared.freshnessFingerprint
  )
    throw new WorkspaceToolRefusal(
      'The workspace changed after this plan was reviewed. Prepare a fresh plan.',
    );
  const ports = await input.dispatch(execution, prepared);
  const args = workspaceToolSchema.parse(JSON.parse(prepared.arguments));
  const context = await loadPreviewContext(
    readPorts(ports),
    input.workspaceId,
    args,
    input.signal,
    input.scope,
  );
  return runWorkspaceTool(ports, input.workspaceId, prepared.arguments, input.signal, {
    toolId: execution.stepId,
    claimId: execution.claimId,
    fence: context.fingerprint,
    ...(input.scope === undefined ? {} : { scope: input.scope }),
    ...(input.buildLedger === undefined ? {} : { buildLedger: input.buildLedger }),
  });
}

/** Discovery uses the existing read executor with query-only ports, never an execution grant. */
export async function runWorkspacePlanDiscovery(input: {
  ports: CompanionPorts;
  workspaceId: string;
  prepared: PreparedWorkspacePlanTool;
  signal: AbortSignal;
  scope?: NoteToolScope;
}): Promise<WorkspaceToolOutcome> {
  const prepared = preparedWorkspacePlanToolSchema.parse(input.prepared);
  const args = workspaceToolSchema.parse(JSON.parse(prepared.arguments));
  if (
    !READ_ONLY_OPERATIONS.has(args.operation) ||
    args.operation !== prepared.operation ||
    canonical(args) !== prepared.argumentFingerprint
  )
    throw new WorkspaceToolRefusal('Discovery can only run a prepared read operation.');
  return runWorkspaceTool(
    readPorts(input.ports),
    input.workspaceId,
    prepared.arguments,
    input.signal,
    input.scope === undefined ? {} : { scope: input.scope },
  );
}
