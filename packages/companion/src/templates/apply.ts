import { items, templates, type TemplatePreflight } from '@nix/api-client';
import type { CompanionPorts } from '../ports.js';
import { WorkspaceToolRefusal } from '../tool-args.js';

export interface ApplyTemplateInput {
  templateId: string;
  parentId: string | null;
  title: string;
  inputs?: Record<string, string>;
}

export interface ApplyTemplateClaim {
  toolId: string | undefined;
  claimId: string | undefined;
}

export interface ApplyTemplateResult {
  rootId: string;
  createdCount: number;
  alreadyApplied: boolean;
}

/** Bounded, collision-safe idempotency key for one claimed apply. Core rejects keys
 * over 160 characters (`TemplateStore.Guards.cs`), and a tool id can run to 200; hashing
 * both inputs together keeps the key well under that limit and removes any ambiguity
 * from concatenating two variable-length strings with a fixed separator. */
async function idempotencyKeyFor(toolId: string, claimId: string): Promise<string> {
  const bytes = new TextEncoder().encode(`${toolId}\n${claimId}`);
  const digest = await crypto.subtle.digest('SHA-256', bytes);
  const hex = Array.from(new Uint8Array(digest), (byte) => byte.toString(16).padStart(2, '0')).join(
    '',
  );
  return `pet:${hex}`;
}

/** Preflights, then applies, a template under a claimed tool call. One execution per
 * approval is enforced upstream by the worker's claim-once state machine (a tool call
 * moves `pending` -> `claimed` exactly once); the idempotency key here only protects a
 * transport retry or the file-transfer resume replay within that one claim. */
export async function applyTemplate(
  ports: CompanionPorts,
  workspaceId: string,
  input: ApplyTemplateInput,
  claim: ApplyTemplateClaim,
  signal: AbortSignal,
  knownPreflight?: TemplatePreflight,
): Promise<ApplyTemplateResult> {
  if (!claim.toolId || !claim.claimId) throw new Error('A claimed tool id is required.');
  const requestOptions = { signal, forceRefresh: true };
  const catalog = await ports.core.query(templates.listTemplates(workspaceId), requestOptions);
  if (!catalog.templates.some((template) => template.id === input.templateId))
    throw new WorkspaceToolRefusal('The template is outside this workspace. No action was run.');
  if (input.parentId) {
    const parent = await ports.core.query(items.itemById(input.parentId), requestOptions);
    if (parent.workspaceId !== workspaceId)
      throw new WorkspaceToolRefusal(
        'The destination is outside this workspace. No action was run.',
      );
  }
  const preflight =
    knownPreflight ??
    (await ports.core.execute(
      templates.preflightTemplate(input.templateId, {
        mode: 'create',
        parentItemId: input.parentId,
        title: input.title,
        inputs: input.inputs,
      }),
      requestOptions,
    ));
  if (!preflight.canApply) {
    throw new WorkspaceToolRefusal(
      `This template cannot be applied here: ${preflight.conflicts.join('; ')}. No action was run.`,
    );
  }
  const idempotencyKey = await idempotencyKeyFor(claim.toolId, claim.claimId);
  const request = {
    templateId: input.templateId,
    mode: 'create' as const,
    parentItemId: input.parentId,
    title: input.title,
    inputs: input.inputs,
    idempotencyKey,
    expectedRevision: preflight.expectedRevision ?? preflight.templateRevision,
  };
  const initial = await ports.collab.execute(templates.applyTemplate(request), requestOptions);
  const applied = await templates.resumeTemplateFileTransfer(
    ports.collab,
    initial,
    () => ports.collab.execute(templates.applyTemplate(request), requestOptions),
    signal,
  );
  return {
    rootId: applied.targetItemId,
    createdCount: applied.createdItems.length,
    alreadyApplied: applied.alreadyApplied,
  };
}
