import { z } from 'zod';
import { pets, type NixClient, type PetToolCall } from '@nix/api-client';
import {
  createCompanionBodies,
  defaultClock,
  defaultIds,
  describeToolCall,
  loadPreviewContext,
  prepareNoteScopedTool,
  type NoteToolScope,
  runWorkspaceTool,
  workspaceToolSchema,
  WorkspaceToolRefusal,
  type PreviewContext,
  type PreviewModel,
} from '@nix/companion';
import { printResult, type OutputOptions } from '../output.ts';
import { openSession, type Session } from '../session.ts';
import { collabClientFor } from './templates.ts';
import { resolveSession, type SessionDeps } from './shared.ts';

const RUNTIME_OPERATIONS = [
  'status',
  'models',
  'read',
  'watch',
  'send',
  'interrupt',
  'reset',
  'settings',
  'tool_claim',
  'tool_result',
  'history',
  'read_history',
  'delete_history',
  'rename',
  'resume_history',
] as const;
type RuntimeOperation = (typeof RUNTIME_OPERATIONS)[number];

export interface PetOptions {
  readonly apiUrl?: string;
  readonly workspace?: string;
  readonly pet?: string;
  readonly message?: string;
  readonly model?: string;
  readonly workspaceTools?: boolean;
  readonly rootItem?: string;
  readonly allowEdits?: boolean;
  readonly historyId?: string;
  /** `rename` only: the new title, sent as the request's text. */
  readonly title?: string;
  readonly toolId?: string;
  readonly requestId?: string;
  readonly toolResult?: string;
  readonly toolSuccess?: boolean;
  /** Only used with `--operation watch`: the last known revision to wait past. */
  readonly after?: number;
}

export interface PetToolRunOptions extends PetOptions {
  readonly approve?: boolean;
  readonly decline?: boolean;
}

/** Matches `pet-work-tools.tsx:84-86`: what the web card says when a claimed write's
 * outcome cannot be trusted, so the pet never assumes success it did not observe. */
const UNCERTAIN_OUTCOME_RESULT =
  'The operation failed or its result is uncertain. Inspect Nix before retrying a write. Do not assume success.';

const DECLINED_RESULT = 'Declined by the user. Do not retry this change unless asked.';
const HELD_AUTO_APPROVAL_RESULT =
  "Earlier reads need the owner's review before changes. No action ran. Do not retry without approval.";

/**
 * Opens the named (or default) profile for a pet operation. Browser-approved profiles renew
 * short-lived access tokens automatically. A supplied `NIX_SESSION_TOKEN` paired with `apiUrl`
 * remains an explicit override with no stored profile; neither path expands PAT scopes.
 *
 * Shared by `petCommand`, `petToolRun` and their MCP mirrors, so all four reach Core (and, for
 * `petToolRun`, Collab) with the same session handling.
 */
export async function petSessionFor(
  apiUrl: string | undefined,
  profile: string | undefined,
  deps: SessionDeps = {},
  resolve: (
    profileName: string | undefined,
    sessionDeps: SessionDeps,
  ) => Promise<Session> = resolveSession,
): Promise<Session> {
  const env = deps.env ?? process.env;
  const token = env.NIX_SESSION_TOKEN;
  if (token && apiUrl) {
    return openSession({
      profile: { apiUrl, token: '' },
      bearerToken: token,
      ...(deps.fetchImpl ? { fetchImpl: deps.fetchImpl } : {}),
    });
  }
  return resolve(profile, deps);
}

/**
 * Validates and runs one `pets.runtime` (or `pets.settings`) call: the same operation allowlist,
 * required-field checks and request shape `petCommand` and the `pet_runtime` MCP tool both need,
 * kept in one place so the two surfaces cannot drift apart.
 *
 * @throws When `operation` is unknown, a required field for the operation is missing, or Core
 * refuses the call.
 */
export async function executePetRuntime(
  client: NixClient,
  operation: string,
  options: PetOptions,
): Promise<unknown> {
  validatePetRuntimeRequest(operation, options);
  if (operation === 'settings') return client.query(pets.settings());
  if (operation === 'watch') {
    // A GET long-poll, never the writes-limited POST path. validatePetRuntimeRequest already
    // required --workspace and --pet for watch; re-checking here narrows the type instead of
    // asserting it.
    const { workspace, pet } = options;
    if (!workspace || !pet) throw new Error('Provide --workspace and --pet.');
    return client.query(
      pets.watchRuntime({
        workspaceId: workspace,
        petId: pet,
        ...(options.rootItem ? { rootItemId: options.rootItem } : {}),
        after: options.after ?? 0,
      }),
    );
  }
  return client.execute(
    pets.runtime({
      operation: operation as Exclude<RuntimeOperation, 'settings' | 'watch'>,
      ...(options.workspace ? { workspaceId: options.workspace } : {}),
      ...(options.pet ? { petId: options.pet } : {}),
      text: options.message ?? options.title ?? '',
      model: options.model ?? '',
      workspaceAccess: options.rootItem !== undefined || (options.workspaceTools ?? false),
      ...(options.rootItem
        ? {
            rootItemId: options.rootItem,
            readOnly: !options.allowEdits,
            itemId: options.rootItem,
          }
        : {}),
      ...(options.historyId ? { historyId: options.historyId } : {}),
      ...(options.toolId ? { toolId: options.toolId } : {}),
      ...(options.toolResult !== undefined ? { toolResult: options.toolResult } : {}),
      ...(options.toolSuccess !== undefined ? { toolSuccess: options.toolSuccess } : {}),
      ...(options.requestId
        ? { requestId: options.requestId }
        : operation === 'send'
          ? { requestId: crypto.randomUUID() }
          : {}),
    }),
  );
}

function validatePetRuntimeRequest(operation: string, options: PetOptions): void {
  if (!RUNTIME_OPERATIONS.includes(operation as RuntimeOperation))
    throw new Error(`Choose a pet operation: ${RUNTIME_OPERATIONS.join(', ')}.`);
  if (options.rootItem !== undefined && !z.uuid().safeParse(options.rootItem).success)
    throw new Error('--root-item must be an item UUID.');
  if (options.allowEdits && !options.rootItem)
    throw new Error('--allow-edits requires --root-item.');
  if (
    ['read_history', 'delete_history', 'resume_history'].includes(operation) &&
    !options.historyId
  )
    throw new Error('Provide --history-id.');
  if (operation === 'rename' && !options.title?.trim()) throw new Error('Provide --title.');
  if (operation === 'send' && !options.message?.trim()) throw new Error('Provide --message.');
  if (
    [
      'read',
      'watch',
      'send',
      'interrupt',
      'reset',
      'tool_claim',
      'tool_result',
      'history',
      'read_history',
      'delete_history',
      'rename',
      'resume_history',
    ].includes(operation) &&
    (!options.workspace || !options.pet)
  )
    throw new Error('Provide --workspace and --pet.');
  if (operation === 'tool_claim' && !options.toolId) throw new Error('Provide --tool-id.');
  if (operation === 'tool_result' && (!options.toolId || options.toolResult === undefined))
    throw new Error('Provide --tool-id and --tool-result.');
}

/** Interactive account operations require a short-lived BFF token, never expanded PAT scopes. */
export async function petCommand(
  profile: string | undefined,
  operation: string,
  options: PetOptions,
  output: OutputOptions,
  deps: SessionDeps = {},
): Promise<void> {
  validatePetRuntimeRequest(operation, options);
  const session = await petSessionFor(options.apiUrl, profile, deps);
  printResult(await executePetRuntime(session.client, operation, options), output);
}

export type PetToolDecision = 'approve' | 'decline' | 'preview';

/**
 * Previews, and on request executes, one pending workspace tool call the same way the web
 * companion panel does: claim before any write, run the exact claimed request through
 * `@nix/companion`, and post its outcome back. Never retries after an uncertain outcome.
 *
 * Shared by the `pet tools run` CLI command and the `pet_tool_run` MCP tool, so both drive the
 * same claim-before-write rule from one place.
 *
 * @throws When the named tool is not pending, or its claim receipt does not match.
 */
export async function executePetToolRun(
  session: Session,
  workspaceId: string,
  petId: string,
  toolId: string,
  decision: PetToolDecision,
  /** Eval auto-approval binds execution to the request and preview that passed its holds. */
  autoApproval?: { readonly arguments: string; readonly fingerprint?: string },
  scope?: NoteToolScope,
): Promise<unknown> {
  const client = session.client;
  const runtime = await client.execute(
    pets.runtime({
      operation: 'read',
      workspaceId,
      petId,
      ...(scope ? { rootItemId: scope.rootItemId } : {}),
    }),
  );
  const tool: PetToolCall | undefined = runtime.tools?.find((entry) => entry.id === toolId);
  if (tool?.status !== 'pending') throw new Error(`Tool ${toolId} is not pending.`);
  if (decision === 'approve' && autoApproval !== undefined) {
    if (tool.arguments !== autoApproval.arguments)
      throw new Error('Tool changed after evaluation preview.');
    if (runtime.lockedRead)
      throw new Error('The conversation read locked content after evaluation preview.');
  }

  // Matches `pet-work-tools.tsx:113-117`: malformed arguments must still resolve to a plain
  // "unsupported" preview, never an uncaught parse error - a corrupt call must stay declinable.
  let parsed: ReturnType<typeof workspaceToolSchema.safeParse>;
  try {
    parsed = workspaceToolSchema.safeParse(JSON.parse(tool.arguments));
  } catch {
    parsed = workspaceToolSchema.safeParse(null);
  }
  const signal = AbortSignal.timeout(90_000);
  const collab = collabClientFor(session);
  const ports = {
    core: session.client,
    collab,
    bodies: createCompanionBodies(collab),
    clock: defaultClock(),
    ids: defaultIds(),
  };
  let previewContext: PreviewContext | undefined;
  let preview: PreviewModel | string;
  if (!parsed.success) {
    preview =
      'This request is unsupported. Decline it so the companion can try a supported operation.';
  } else {
    try {
      const args = scope
        ? await prepareNoteScopedTool(ports, workspaceId, parsed.data, signal, scope)
        : parsed.data;
      previewContext = await loadPreviewContext(ports, workspaceId, args, signal, scope);
      preview = describeToolCall(args, previewContext);
    } catch (reason) {
      const message =
        reason instanceof WorkspaceToolRefusal
          ? reason.message
          : 'The workspace context could not be read. Refresh and inspect Nix before approving.';
      preview = contextFailurePreview(message);
    }
  }

  if (decision === 'preview') {
    return { toolId, status: tool.status, preview, arguments: tool.arguments };
  }

  const requestId = crypto.randomUUID();
  const claimed = await client.execute(
    pets.runtime({
      operation: 'tool_claim',
      workspaceId,
      petId,
      toolId,
      requestId,
      ...(scope ? { rootItemId: scope.rootItemId } : {}),
    }),
  );
  const receipt = claimed.tools?.find((entry) => entry.id === toolId);
  if (receipt?.status !== 'claimed' || receipt.claimId !== requestId)
    throw new Error('Tool was claimed elsewhere.');

  let toolResult = DECLINED_RESULT;
  let toolSuccess = false;
  // Reported with the result so the worker marks the conversation (a read from under a lock).
  let toolLockedContent = false;
  if (decision === 'approve' && autoApproval !== undefined && claimed.lockedRead) {
    // A protected read can settle while the preview loads. The claim receipt is the latest
    // conversation state; settle its hold before any automatic write starts.
    toolResult = HELD_AUTO_APPROVAL_RESULT;
  } else if (decision === 'approve') {
    try {
      const outcome = await runWorkspaceTool(
        {
          core: session.client,
          collab,
          bodies: createCompanionBodies(collab),
          clock: defaultClock(),
          ids: defaultIds(),
        },
        workspaceId,
        tool.arguments,
        AbortSignal.timeout(90000),
        {
          ...(scope ? { scope } : {}),
          toolId,
          claimId: requestId,
          ...(autoApproval?.fingerprint !== undefined
            ? { fence: autoApproval.fingerprint }
            : previewContext
              ? { fence: previewContext.fingerprint }
              : {}),
        },
      );
      toolResult = outcome.text;
      toolSuccess = true;
      toolLockedContent = outcome.lockedContent;
    } catch (reason) {
      toolResult =
        reason instanceof WorkspaceToolRefusal ? reason.message : UNCERTAIN_OUTCOME_RESULT;
      if (reason instanceof WorkspaceToolRefusal) toolLockedContent = reason.lockedContent;
      toolSuccess = false;
    }
  }

  try {
    return await client.execute(
      pets.runtime({
        operation: 'tool_result',
        workspaceId,
        petId,
        toolId,
        requestId,
        toolResult,
        toolSuccess,
        toolLockedContent,
        ...(scope ? { rootItemId: scope.rootItemId } : {}),
      }),
    );
  } catch (reason) {
    // The claimed write (if any) may already have happened; posting its outcome is what tells
    // the pet and clears the claim. A failure here must say that plainly, not surface a bare
    // transport error that leaves the caller unsure whether anything happened.
    const cause = reason instanceof Error ? reason.message : String(reason);
    throw new Error(
      `${toolSuccess ? 'The change was applied, but its' : 'Its'} outcome could not be recorded (${cause}). Refresh and inspect Nix before retrying.`,
    );
  }
}

function contextFailurePreview(message: string): PreviewModel {
  return {
    headline: 'I cannot run this request as written.',
    destination: { title: 'Workspace root', path: [] },
    counts: { items: 0, fields: 0, views: 0, entries: 0, writes: 0 },
    tree: [],
    notes: [],
    warnings: [],
    problems: [{ path: 'workspace', code: 'context_unavailable', message }],
    neverDoes: [
      'Publish a public link',
      'Delete anything permanently',
      'Remove or retype a field',
      'Delete a view',
    ],
  };
}

/**
 * `nixctl pet tools run`: resolves the profile's session, then delegates to
 * {@link executePetToolRun} for the claim-before-write flow, printing its outcome.
 *
 * @throws When the named tool is not pending, or its claim receipt does not match.
 */
export async function petToolRun(
  profile: string | undefined,
  toolId: string,
  options: PetToolRunOptions,
  output: OutputOptions,
  deps: SessionDeps = {},
): Promise<void> {
  if (options.approve && options.decline)
    throw new Error('Choose either --approve or --decline, not both.');
  if (!options.workspace || !options.pet) throw new Error('Provide --workspace and --pet.');
  validatePetRuntimeRequest('read', options);
  const session = await petSessionFor(options.apiUrl, profile, deps);
  const decision: PetToolDecision = options.approve
    ? 'approve'
    : options.decline
      ? 'decline'
      : 'preview';
  const result = await executePetToolRun(
    session,
    options.workspace,
    options.pet,
    toolId,
    decision,
    undefined,
    options.rootItem
      ? {
          rootItemId: options.rootItem,
          readOnly: !options.allowEdits,
        }
      : undefined,
  );
  if (decision === 'preview' && hasPreviewModel(result)) {
    if (output.json) printResult(result.preview, output);
    else if (output.isTty) process.stdout.write(`${formatPreview(result.preview)}\n`);
    else printResult(result, output);
    return;
  }
  printResult(result, output);
}

function hasPreviewModel(value: unknown): value is { preview: PreviewModel } {
  if (typeof value !== 'object' || value === null || !('preview' in value)) return false;
  const preview = value.preview;
  return (
    typeof preview === 'object' &&
    preview !== null &&
    'headline' in preview &&
    'destination' in preview &&
    'counts' in preview &&
    'tree' in preview &&
    'warnings' in preview &&
    'problems' in preview
  );
}

export function formatPreview(model: PreviewModel): string {
  const destination = [...model.destination.path, model.destination.title]
    .filter((part, index, all) => index === 0 || part !== all[index - 1])
    .join(' / ');
  const lines = [
    model.headline,
    `Destination: ${destination}`,
    `Counts: ${String(model.counts.items)} items, ${String(model.counts.fields)} fields, ${String(model.counts.views)} views, ${String(model.counts.entries)} entries, ${String(model.counts.writes)} writes`,
  ];
  const appendNodes = (nodes: PreviewModel['tree'], depth: number): void => {
    for (const node of nodes) {
      lines.push(`${'  '.repeat(depth)}- ${node.label}`);
      for (const detail of node.detail) lines.push(`${'  '.repeat(depth + 1)}${detail}`);
      if (node.why) lines.push(`${'  '.repeat(depth + 1)}Why: ${node.why}`);
      appendNodes(node.children, depth + 1);
    }
  };
  appendNodes(model.tree, 0);
  for (const note of model.notes) lines.push(`Note: ${note}`);
  for (const warning of model.warnings) lines.push(`Warning: ${warning.path}: ${warning.message}`);
  for (const problem of model.problems) lines.push(`Problem: ${problem.path}: ${problem.message}`);
  if (model.neverDoes.length > 0) lines.push(`Never: ${model.neverDoes.join('; ')}`);
  return lines.join('\n');
}
