import { randomUUID } from 'node:crypto';
import { mkdir, open, readFile, unlink, lstat, opendir } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import type { Command } from 'commander';
import { z } from 'zod';
import { petPlans, type PetPlanResponse, type PetPlanReceiptView } from '@nix/api-client';
import { configDir } from '../config.ts';
import { printResult, printTable, type OutputOptions } from '../output.ts';
import type { Session } from '../session.ts';
import { parseUuid, resolveSession, type Act } from './shared.ts';

const privateContextSchema = z.object({
  apiOrigin: z.url(),
  contextId: z.uuid(),
  workspaceId: z.uuid(),
  runId: z.uuid(),
  planId: z.uuid(),
  planVersion: z.number().int().positive(),
  reviewDigest: z.string().min(1),
  approve: z.boolean(),
  requestId: z.uuid(),
  decisionContext: z.string().min(32).max(256),
  expiresAt: z.iso.datetime({ offset: true }),
});
type PrivateContext = z.infer<typeof privateContextSchema>;
export const decisionContextPath = (
  contextId: string,
  env: NodeJS.ProcessEnv = process.env,
): string => join(configDir(env), 'plan-decisions', `${z.uuid().parse(contextId)}.json`);

export async function saveDecisionContext(file: string, context: PrivateContext): Promise<void> {
  await mkdir(dirname(file), { recursive: true, mode: 0o700 });
  await cleanupDecisionContexts(dirname(file));
  const handle = await open(file, 'wx', 0o600);
  try {
    await handle.writeFile(JSON.stringify(context), 'utf8');
  } finally {
    await handle.close();
  }
}

async function cleanupDecisionContexts(directory: string): Promise<void> {
  const retained: { path: string; modified: number }[] = [];
  for await (const entry of await opendir(directory)) {
    if (
      !entry.isFile() ||
      !entry.name.endsWith('.json') ||
      !z.uuid().safeParse(entry.name.slice(0, -5)).success
    )
      continue;
    const path = join(directory, entry.name);
    const info = await lstat(path);
    if (Date.now() - info.mtimeMs > 310_000) await unlink(path);
    else {
      retained.push({ path, modified: info.mtimeMs });
      if (retained.length > 99) {
        retained.sort((left, right) => right.modified - left.modified);
        const oldest = retained.pop();
        if (oldest) await unlink(oldest.path);
      }
    }
  }
}

export async function readDecisionContext(file: string): Promise<PrivateContext> {
  const info = await lstat(file);
  if (!info.isFile() || (info.mode & 0o077) !== 0 || info.size > 4096)
    throw new Error('The decision context must be a private file with mode 0600.');
  let parsed: unknown;
  try {
    parsed = JSON.parse(await readFile(file, 'utf8'));
  } catch {
    throw new Error('The private decision context could not be read. Request a new handoff.');
  }
  const result = privateContextSchema.safeParse(parsed);
  if (!result.success || Date.parse(result.data.expiresAt) <= Date.now())
    throw new Error('The decision context expired or is invalid. Request a new handoff.');
  return result.data;
}

export async function executePlanDecisionHandoff(
  session: Session,
  workspaceId: string,
  runId: string,
  clientName: string,
  approve: boolean,
  env: NodeJS.ProcessEnv = process.env,
): Promise<{ contextId: string; browserPath: string; expiresAt: string; instruction: string }> {
  if (session.authKind === 'interactive')
    throw new Error(
      'Use a PAT profile for a named delegated handoff, or open the plan in your signed-in Nix browser to decide directly.',
    );
  const run = await session.client.query(petPlans.read(workspaceId, runId), { forceRefresh: true });
  if (run.plan?.status !== 'awaiting_review')
    throw new Error('This plan has no current review to authorize.');
  const handoff = await session.client.execute(
    petPlans.createDecisionHandoff(workspaceId, runId, {
      planId: run.plan.id,
      planVersion: run.plan.version,
      reviewDigest: run.plan.reviewDigest,
      clientName,
      approve,
    }),
  );
  const contextId = handoff.handoffId;
  const file = decisionContextPath(contextId, env);
  await saveDecisionContext(file, {
    apiOrigin: new URL(session.endpoints.apiUrl).origin,
    contextId,
    workspaceId,
    runId,
    planId: run.plan.id,
    planVersion: run.plan.version,
    reviewDigest: run.plan.reviewDigest,
    approve,
    requestId: randomUUID(),
    decisionContext: handoff.decisionContext,
    expiresAt: handoff.expiresAt,
  });
  return {
    contextId,
    browserPath: handoff.browserPath,
    expiresAt: handoff.expiresAt,
    instruction:
      'Open the browser path on your Nix site, review the exact plan and named client, then authorize the handoff.',
  };
}

export async function executePlanDecision(
  session: Session,
  file: string,
): Promise<PetPlanResponse> {
  const context = await readDecisionContext(file);
  if (new URL(session.endpoints.apiUrl).origin !== context.apiOrigin)
    throw new Error(
      'This decision context belongs to another Nix server. Use the original profile.',
    );
  const status = await session.client.query(
    petPlans.handoffStatus(context.workspaceId, context.runId, context.contextId),
    { forceRefresh: true },
  );
  const run = await session.client.query(petPlans.read(context.workspaceId, context.runId), {
    forceRefresh: true,
  });
  if (status.status === 'consumed' && run.plan?.decision?.requestId === context.requestId) {
    await unlink(file);
    return run;
  }
  if (status.status !== 'authorized')
    throw new Error(
      `The browser handoff is ${status.status}. Authorize it in your signed-in Nix browser first.`,
    );
  if (
    run.plan?.id !== context.planId ||
    run.plan.version !== context.planVersion ||
    run.plan.reviewDigest !== context.reviewDigest
  )
    throw new Error('The prepared plan changed. Request and review a new handoff.');
  const result = await session.client.execute(
    petPlans.decide(context.workspaceId, context.runId, context.planId, {
      expectedRunRevision: run.revision,
      planVersion: context.planVersion,
      reviewDigest: context.reviewDigest,
      approve: context.approve,
      requestId: context.requestId,
      decisionContext: context.decisionContext,
    }),
  );
  await unlink(file);
  return result;
}

export function printPlan(run: PetPlanResponse, output: OutputOptions): void {
  if (output.json) {
    printResult(run, output);
    return;
  }
  process.stdout.write(
    `${run.brief}\n${run.status}, revision ${String(run.revision)}\nRun ${run.id}\n`,
  );
  if (run.question) process.stdout.write(`${run.question.text}\n`);
  if (run.observations?.length)
    printTable(
      ['Read', 'Result'],
      run.observations.map((observation) => [
        observation.description,
        readableReceipt(observation.receiptView),
      ]),
    );
  if (run.plan) {
    process.stdout.write(`${run.plan.summary}\nPlan version ${String(run.plan.version)}\n`);
    printTable(
      ['Step', 'Action', 'Status', 'Receipt'],
      run.plan.steps.map((step, index) => [
        String(index + 1),
        step.effect.description,
        step.status,
        readableReceipt(step.receiptView, step.receipt),
      ]),
    );
    for (const step of run.plan.steps)
      for (const field of step.fields)
        process.stdout.write(`${field.label}: ${readableValue(field.value)}\n`);
  }
}

function readableValue(value: unknown): string {
  if (value === null) return 'Empty value';
  if (typeof value === 'string') return value.length === 0 ? 'Empty text' : value;
  if (Array.isArray(value))
    return value.length === 0
      ? 'Empty list'
      : value
          .map((entry, index) => `Item ${String(index + 1)}: ${readableValue(entry)}`)
          .join('; ');
  if (typeof value === 'object')
    return Object.keys(value).length === 0
      ? 'Empty group'
      : Object.entries(value)
          .map(([key, entry]) => `${key}: ${readableValue(entry)}`)
          .join('; ');
  if (typeof value === 'number' || typeof value === 'boolean' || typeof value === 'bigint')
    return String(value);
  return 'Unavailable';
}

function readableReceipt(
  view: PetPlanReceiptView | null | undefined,
  literal?: string | null,
): string {
  if (view == null) return literal ?? '';
  return [view.summary, view.details == null ? '' : readableValue(view.details), view.text ?? '']
    .filter((part) => part.length > 0)
    .join('; ');
}

export function registerPetPlanCommands(program: Command, act: Act): void {
  const plans = program
    .command('pet-plans')
    .description('Inspect prepared companion plans and request exact browser decisions.');
  const show = (command: Command, action: (session: Session) => Promise<PetPlanResponse>) =>
    act(command, async (profile, output) => {
      printPlan(await action(await resolveSession(profile)), output);
    });
  plans
    .command('list <workspaceId>')
    .description('List your plans in this workspace.')
    .action((workspaceId: string, _options: unknown, command: Command) =>
      act(command, async (profile, output) => {
        const result = await (
          await resolveSession(profile)
        ).client.query(petPlans.list(parseUuid(workspaceId, 'workspace ID')), {
          forceRefresh: true,
        });
        if (output.json) printResult(result, output);
        else
          printTable(
            ['Run', 'Task', 'Status'],
            result.runs.map((run) => [run.id, run.brief, run.status]),
          );
      }),
    );
  for (const operation of ['read', 'inspect', 'receipts'])
    plans
      .command(`${operation} <workspaceId> <runId>`)
      .description('Read the complete prepared plan, progress and receipts.')
      .action((workspaceId: string, runId: string, _options: unknown, command: Command) =>
        show(command, (session) =>
          session.client.query(
            petPlans.read(parseUuid(workspaceId, 'workspace ID'), parseUuid(runId, 'run ID')),
            {
              forceRefresh: true,
            },
          ),
        ),
      );
  plans
    .command('decision-handoff <workspaceId> <runId>')
    .requiredOption('--client-name <name>', 'name the client receiving this exact decision')
    .option('--decline', 'delegate refusal of this exact plan', false)
    .description('Save a private context and request browser authorization.')
    .action(
      (
        workspaceId: string,
        runId: string,
        options: { clientName: string; decline: boolean },
        command: Command,
      ) =>
        act(command, async (profile, output) => {
          const result = await executePlanDecisionHandoff(
            await resolveSession(profile),
            parseUuid(workspaceId, 'workspace ID'),
            parseUuid(runId, 'run ID'),
            options.clientName,
            !options.decline,
          );
          if (output.json) printResult(result, output);
          else
            process.stdout.write(
              `${result.instruction}\n${result.browserPath}\nContext ${result.contextId}\nExpires ${result.expiresAt}\n`,
            );
        }),
    );
  plans
    .command('decide <contextId>')
    .description('Submit the exact decision after browser authorization.')
    .action((contextId: string, _options: unknown, command: Command) =>
      show(command, (session) => executePlanDecision(session, decisionContextPath(contextId))),
    );
  plans
    .command('cancel <workspaceId> <runId>')
    .description('Stop work that has not been dispatched.')
    .action((workspaceId: string, runId: string, _options: unknown, command: Command) =>
      show(command, async (session) => {
        const run = await session.client.query(
          petPlans.read(parseUuid(workspaceId, 'workspace ID'), parseUuid(runId, 'run ID')),
          { forceRefresh: true },
        );
        return session.client.execute(
          petPlans.cancel(workspaceId, runId, {
            expectedRunRevision: run.revision,
            requestId: randomUUID(),
          }),
        );
      }),
    );
  plans
    .command('undo-handoff <workspaceId> <runId> <stepId>')
    .description('Open the exact supported receipt for an owner browser undo.')
    .action(
      (workspaceId: string, runId: string, stepId: string, _options: unknown, command: Command) =>
        act(command, async (profile, output) => {
          const session = await resolveSession(profile);
          const run = await session.client.query(
            petPlans.read(parseUuid(workspaceId, 'workspace ID'), parseUuid(runId, 'run ID')),
            { forceRefresh: true },
          );
          const step = run.plan?.steps.find((value) => value.id === parseUuid(stepId, 'step ID'));
          if (!step?.undoId) throw new Error('This step has no supported undo receipt.');
          const browserPath = `/w/${workspaceId}/pet/plans/${runId}/review?stepId=${stepId}`;
          if (output.json)
            printResult(
              {
                browserPath,
                stepId,
                instruction: 'Review this receipt and choose Undo in your signed-in Nix browser.',
              },
              output,
            );
          else
            process.stdout.write(
              `Review the receipt and choose Undo in your signed-in Nix browser:\n${browserPath}\n`,
            );
        }),
    );
}
