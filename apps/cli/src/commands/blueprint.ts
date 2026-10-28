import { readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { items, templates } from '@nix/api-client';
import {
  createCompanionBodies,
  defaultClock,
  defaultIds,
  executeBuild,
  loadPreviewContext,
  planBuild,
  saveAsTemplate,
  type CompanionPorts,
} from '@nix/companion';
import {
  blueprintSchema,
  describeBlueprint,
  saveSpecSchema,
  validateBlueprint,
  type Blueprint,
  type PreviewModel,
  type SaveSpec,
  type ValidationReport,
} from '@nix/structure-spec';
import type { BuildResult } from '@nix/companion';
import { workspaceToolSchema } from '@nix/companion';
import { printResult, type OutputOptions } from '../output.ts';
import type { Session } from '../session.ts';
import { formatPreview } from './pets.ts';
import { resolveSession, type SessionDeps } from './shared.ts';
import { collabClientFor } from './templates.ts';

export interface BlueprintOptions {
  readonly parent?: string | undefined;
  readonly workspace?: string | undefined;
  readonly yes?: boolean;
}

export interface BlueprintSaveOptions {
  readonly yes?: boolean;
  readonly idempotencyKey?: string;
}

export function portsFor(session: Session): CompanionPorts {
  const collab = collabClientFor(session);
  return {
    core: session.client,
    collab,
    bodies: createCompanionBodies(collab),
    clock: defaultClock(),
    ids: defaultIds(),
  };
}

function parseBlueprint(text: string): unknown {
  try {
    return JSON.parse(text);
  } catch {
    throw new Error('The blueprint file is not valid JSON.');
  }
}

async function destination(
  session: Session,
  parentId: string | undefined,
  workspaceId: string | undefined,
): Promise<string> {
  if (parentId) {
    const parent = await session.client.query(items.itemById(parentId), { forceRefresh: true });
    if (workspaceId && parent.workspaceId !== workspaceId)
      throw new Error('The parent is outside the selected workspace.');
    return parent.workspaceId;
  }
  if (!workspaceId) throw new Error('Provide --workspace when building without --parent.');
  return workspaceId;
}

export interface BlueprintEvaluation {
  blueprint: Blueprint | null;
  report: ValidationReport;
  preview: PreviewModel | null;
  workspaceId: string | null;
  ports: CompanionPorts | null;
  sandboxExists: boolean;
  inheritedFields: NonNullable<Parameters<typeof validateBlueprint>[1]>['inheritedFields'];
}

/** Shares the parent-aware validation and preview path between CLI and MCP. */
export async function evaluateBlueprint(
  raw: unknown,
  options: BlueprintOptions,
  session?: Session,
): Promise<BlueprintEvaluation> {
  const clock = defaultClock();
  if (options.parent || options.workspace) {
    if (!session) throw new Error('An authenticated session is required for this destination.');
    const workspaceId = await destination(session, options.parent, options.workspace);
    const ports = portsFor(session);
    const context = await loadPreviewContext(
      ports,
      workspaceId,
      workspaceToolSchema.parse({
        operation: 'build_blueprint',
        itemId: '',
        parentId: options.parent ?? '',
        title: '',
        markdown: '',
        query: '',
        propertiesJson: '',
        specJson: JSON.stringify(raw),
      }),
      AbortSignal.timeout(90_000),
    );
    const report =
      context.blueprintReport ??
      validateBlueprint(raw, { inheritedFields: context.inheritedFields, today: clock.today() });
    const parsed = blueprintSchema.safeParse(raw);
    return {
      blueprint: parsed.success ? parsed.data : null,
      report,
      preview: parsed.success ? describeBlueprint(parsed.data, report, context) : null,
      workspaceId,
      ports,
      sandboxExists: context.sandboxExists ?? false,
      inheritedFields: context.inheritedFields,
    };
  }
  const report = validateBlueprint(raw, { inheritedFields: [], today: clock.today() });
  const parsed = blueprintSchema.safeParse(raw);
  return {
    blueprint: parsed.success ? parsed.data : null,
    report,
    preview: parsed.success
      ? describeBlueprint(parsed.data, report, { destination: { title: 'Pet drafts', path: [] } })
      : null,
    workspaceId: null,
    ports: null,
    sandboxExists: false,
    inheritedFields: [],
  };
}

export async function blueprintCatalog(text: boolean, output: OutputOptions): Promise<void> {
  const path = text
    ? '../../../../apps/go-workers/internal/companion/catalog/chat.txt'
    : '../../../../packages/structure-spec/src/generated/catalog.json';
  const contents = await readFile(fileURLToPath(new URL(path, import.meta.url)), 'utf8');
  if (text) process.stdout.write(contents);
  else printResult(JSON.parse(contents), output);
}

export async function blueprintValidate(
  profile: string | undefined,
  file: string,
  options: BlueprintOptions,
  output: OutputOptions,
  deps: SessionDeps = {},
): Promise<void> {
  const raw = parseBlueprint(await readFile(file, 'utf8'));
  const session = options.parent ? await resolveSession(profile, deps) : undefined;
  const result = await evaluateBlueprint(raw, options, session);
  printResult(result.report, output);
  if (!result.report.ok) process.exitCode = 1;
}

export async function blueprintDescribe(
  profile: string | undefined,
  file: string,
  options: BlueprintOptions,
  output: OutputOptions,
  deps: SessionDeps = {},
): Promise<void> {
  const raw = parseBlueprint(await readFile(file, 'utf8'));
  const session = options.parent ? await resolveSession(profile, deps) : undefined;
  const result = await evaluateBlueprint(raw, options, session);
  if (!result.preview)
    throw new Error(
      result.report.problems.map((problem) => `${problem.path}: ${problem.message}`).join('\n'),
    );
  if (output.json || !output.isTty) printResult(result.preview, output);
  else process.stdout.write(`${formatPreview(result.preview)}\n`);
  if (!result.report.ok) process.exitCode = 1;
}

export async function executeBlueprintBuild(
  raw: unknown,
  options: BlueprintOptions,
  session: Session,
): Promise<BuildResult> {
  if (!options.yes) throw new Error('Blueprint builds write items. Pass --yes to confirm.');
  const result = await evaluateBlueprint(raw, options, session);
  if (!result.report.ok || !result.blueprint || !result.workspaceId || !result.ports)
    throw new Error(
      result.report.problems.map((problem) => `${problem.path}: ${problem.message}`).join('\n') ||
        'A destination workspace is required.',
    );
  const plan = planBuild(result.blueprint, {
    parentId: options.parent ?? null,
    sandboxExists: result.sandboxExists,
    clock: result.ports.clock,
    inheritedFields: result.inheritedFields,
  });
  return executeBuild(result.ports, result.workspaceId, plan, AbortSignal.timeout(90_000));
}

export async function blueprintBuild(
  profile: string | undefined,
  file: string,
  options: BlueprintOptions,
  output: OutputOptions,
  deps: SessionDeps = {},
): Promise<void> {
  if (!options.yes) throw new Error('Blueprint builds write items. Pass --yes to confirm.');
  const raw = parseBlueprint(await readFile(file, 'utf8'));
  const result = await executeBlueprintBuild(raw, options, await resolveSession(profile, deps));
  printResult(result, output);
  if (!result.complete) process.exitCode = 1;
}

export async function blueprintSave(
  profile: string | undefined,
  rootId: string,
  specFile: string,
  options: BlueprintSaveOptions,
  output: OutputOptions,
  deps: SessionDeps = {},
): Promise<void> {
  if (!options.yes) throw new Error('Saving a blueprint writes a template. Pass --yes to confirm.');
  if (!options.idempotencyKey)
    throw new Error('Pass --idempotency-key with a stable value to make retries safe.');
  if (!/^[A-Za-z0-9._:-]{1,120}$/.test(options.idempotencyKey))
    throw new Error(
      '--idempotency-key must be 1–120 letters, digits, dots, colons, underscores or hyphens.',
    );
  const spec = saveSpecSchema.parse(parseBlueprint(await readFile(specFile, 'utf8')));
  const session = await resolveSession(profile, deps);
  const approval = await prepareBlueprintSave(session, rootId, spec);
  const result = await saveAsTemplate(
    portsFor(session),
    approval.workspaceId,
    { itemId: rootId, title: approval.title, spec },
    {
      toolId: 'nixctl-blueprint-save',
      claimId: options.idempotencyKey,
      approvedFingerprint: approval.fingerprint,
      captureFingerprint: approval.captureFingerprint,
    },
    AbortSignal.timeout(90_000),
  );
  printResult(result, output);
}

/** Pins the exact authorized source just before the explicitly confirmed CLI save. */
export async function prepareBlueprintSave(
  session: Session,
  rootId: string,
  spec: SaveSpec,
): Promise<{
  workspaceId: string;
  title: string;
  fingerprint: string;
  captureFingerprint: string;
}> {
  const root = await session.client.query(items.itemById(rootId), { forceRefresh: true });
  const preview = await session.client.query(
    templates.previewTemplateCapture(root.workspaceId, rootId, true, !spec.includeSamples),
    { forceRefresh: true },
  );
  return {
    workspaceId: root.workspaceId,
    title: preview.sourceTitle,
    fingerprint: preview.fingerprint,
    captureFingerprint: preview.captureFingerprint,
  };
}
