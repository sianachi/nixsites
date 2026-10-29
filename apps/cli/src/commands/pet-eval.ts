import { readFile } from 'node:fs/promises';
import { pets, type PetConnection, type PetToolCall } from '@nix/api-client';
import {
  blueprintSchema,
  designScenarioSchema,
  scoreBlueprint,
  validateBlueprint,
  type Blueprint,
  type DesignScenario,
  type EvalScore,
  type ValidationReport,
} from '@nix/structure-spec';
import { printResult, printTable, type OutputOptions } from '../output.ts';
import type { Session } from '../session.ts';
import { executePetToolRun, petSessionFor } from './pets.ts';
import type { SessionDeps } from './shared.ts';

const SCENARIOS = [
  'reading-log',
  'job-hunt',
  'weekly-meal-plan',
  'freelance-client-work',
  'home-maintenance',
  'language-study',
  'small-garden',
  'personal-finance-goals',
] as const;
const MAX_POLLS = 300;
const MAX_ANSWERS = 8;
const POLL_INTERVAL_MS = 3_000;
const BUILD_DECLINE = 'Evaluation run: not building.';
// The web panel's automatic decline of a design with problems (pet-work-tools.tsx).
const DECLINED_FOR_PROBLEMS_PREFIX = 'Declined: the design has problems.';

export interface PetEvalOptions {
  readonly suite: 'design';
  readonly scenario?: string;
  readonly model?: string;
  readonly apiUrl?: string;
  readonly workspace?: string;
  readonly pet?: string;
}

export interface PetEvalResult {
  readonly scenario: string;
  readonly model: string | null;
  readonly outcome: 'blueprint' | 'declined' | 'turn_limit' | 'timeout';
  readonly gate: boolean;
  readonly score: EvalScore;
  readonly report: ValidationReport;
  readonly rawToolBytes: number;
  readonly answersSent: number;
}

export interface EvalRuntime {
  readonly session: Session;
  readonly sleep: (milliseconds: number) => Promise<void>;
}

function noBlueprintResult(
  scenario: DesignScenario,
  model: string | null,
  outcome: PetEvalResult['outcome'],
  answersSent: number,
): PetEvalResult {
  const expectedDecline = scenario.expectations.mustHave.some((item) => item.kind === 'declines');
  const gate = outcome === 'declined' && expectedDecline;
  const report: ValidationReport = {
    ok: gate,
    problems: gate
      ? []
      : [
          {
            path: 'blueprint',
            code: 'eval.no_blueprint',
            message: `No blueprint was captured (${outcome}).`,
          },
        ],
    warnings: [],
    stats: { fields: 0, views: 0, entries: 0 },
  };
  const scored = scoreBlueprint(null, scenario.expectations, report);
  const score =
    expectedDecline && !gate
      ? {
          total: 0,
          criteria: scored.criteria.map((criterion) => ({
            ...criterion,
            score: 0,
            note: 'The companion did not decline the requested build.',
          })),
        }
      : scored;
  return {
    scenario: scenario.id,
    model,
    outcome,
    gate,
    score,
    report,
    rawToolBytes: 0,
    answersSent,
  };
}

function scoreTool(
  scenario: DesignScenario,
  model: string | null,
  tool: PetToolCall,
  answersSent: number,
): PetEvalResult {
  const rawToolBytes = Buffer.byteLength(tool.arguments, 'utf8');
  let spec: unknown = null;
  try {
    const argumentsObject: unknown = JSON.parse(tool.arguments);
    if (
      typeof argumentsObject === 'object' &&
      argumentsObject !== null &&
      'specJson' in argumentsObject
    ) {
      const specJson = argumentsObject.specJson;
      if (typeof specJson === 'string') spec = JSON.parse(specJson);
    }
  } catch {
    // The validator reports malformed or absent specs through the same gate as other failures.
  }
  const report = validateBlueprint(spec, { inheritedFields: [], today: '' });
  const parsed = blueprintSchema.safeParse(spec);
  const blueprint: Blueprint | null = parsed.success ? parsed.data : null;
  const expectedDecline = scenario.expectations.mustHave.some((item) => item.kind === 'declines');
  return {
    scenario: scenario.id,
    model,
    outcome: 'blueprint',
    gate: report.ok && !expectedDecline,
    score: scoreBlueprint(blueprint, scenario.expectations, report),
    report,
    rawToolBytes,
    answersSent,
  };
}

function pendingTool(
  connection: PetConnection,
  handled: ReadonlySet<string>,
): PetToolCall | undefined {
  return connection.tools?.find((tool) => tool.status === 'pending' && !handled.has(tool.id));
}

function latestAssistant(connection: PetConnection, seen: ReadonlySet<string>) {
  return connection.messages?.findLast(
    (message) => message.role === 'assistant' && !seen.has(message.id),
  );
}

export async function runtime(
  session: Session,
  workspaceId: string,
  petId: string,
  operation:
    | 'reset'
    | 'send'
    | 'read'
    | 'interrupt'
    | 'tool_claim'
    | 'tool_result'
    | 'history'
    | 'delete_history',
  extra: Partial<Parameters<typeof pets.runtime>[0]> = {},
): Promise<PetConnection> {
  return session.client.execute(pets.runtime({ operation, workspaceId, petId, ...extra }));
}

export async function postLocalToolResult(
  session: Session,
  workspaceId: string,
  petId: string,
  tool: PetToolCall,
  result: string,
  success: boolean,
): Promise<void> {
  const requestId = crypto.randomUUID();
  const claimed = await runtime(session, workspaceId, petId, 'tool_claim', {
    toolId: tool.id,
    requestId,
  });
  const receipt = claimed.tools?.find((entry) => entry.id === tool.id);
  if (receipt?.status !== 'claimed' || receipt.claimId !== requestId)
    throw new Error(`Tool ${tool.id} was claimed elsewhere.`);
  await runtime(session, workspaceId, petId, 'tool_result', {
    toolId: tool.id,
    requestId,
    toolResult: result,
    toolSuccess: success,
  });
}

function localValidation(tool: PetToolCall): ValidationReport {
  try {
    const args: unknown = JSON.parse(tool.arguments);
    if (typeof args !== 'object' || args === null || !('specJson' in args))
      return validateBlueprint(null, { inheritedFields: [], today: '' });
    const specJson = args.specJson;
    return validateBlueprint(typeof specJson === 'string' ? JSON.parse(specJson) : null, {
      inheritedFields: [],
      today: '',
    });
  } catch {
    return validateBlueprint(null, { inheritedFields: [], today: '' });
  }
}

/** Runs one scripted design conversation without executing a proposed blueprint build. A
 * build with problems is declined with them listed once, as the web panel does, and the next
 * build is scored. */
async function runDesignScenario(
  scenario: DesignScenario,
  options: PetEvalOptions & { workspace: string; pet: string },
  runner: EvalRuntime,
): Promise<PetEvalResult> {
  const { session, sleep } = runner;
  const model = options.model ?? null;
  const seen = new Set<string>();
  const handledTools = new Set<string>();
  let answersSent = 0;
  let problemDeclines = 0;
  const deadline = Date.now() + 15 * 60 * 1_000;
  const cleared = await runtime(session, options.workspace, options.pet, 'reset');
  for (const message of cleared.messages ?? []) seen.add(message.id);
  try {
    await runtime(session, options.workspace, options.pet, 'send', {
      text: scenario.problem,
      workspaceAccess: true,
      requestId: crypto.randomUUID(),
      ...(options.model === undefined ? {} : { model: options.model }),
    });
    for (let poll = 0; poll < MAX_POLLS && Date.now() < deadline; poll += 1) {
      const connection = await runtime(session, options.workspace, options.pet, 'read');
      const tool = pendingTool(connection, handledTools);
      if (tool) {
        let operation: unknown;
        try {
          const args: unknown = JSON.parse(tool.arguments);
          operation =
            typeof args === 'object' && args !== null && 'operation' in args
              ? args.operation
              : undefined;
        } catch {
          operation = undefined;
        }
        if (operation === 'build_blueprint') {
          const report = localValidation(tool);
          if (!report.ok && problemDeclines === 0) {
            problemDeclines += 1;
            await postLocalToolResult(
              session,
              options.workspace,
              options.pet,
              tool,
              `${DECLINED_FOR_PROBLEMS_PREFIX}\n${report.problems
                .map((problem) => `${problem.path}: ${problem.modelMessage ?? problem.message}`)
                .join('\n')}`.slice(0, 16000),
              false,
            );
            handledTools.add(tool.id);
            continue;
          }
          try {
            return scoreTool(scenario, model, tool, answersSent);
          } finally {
            await postLocalToolResult(
              session,
              options.workspace,
              options.pet,
              tool,
              BUILD_DECLINE,
              false,
            );
          }
        }
        if (operation === 'list_templates' || operation === 'read_template') {
          await executePetToolRun(session, options.workspace, options.pet, tool.id, 'approve');
          handledTools.add(tool.id);
          continue;
        }
        await postLocalToolResult(
          session,
          options.workspace,
          options.pet,
          tool,
          BUILD_DECLINE,
          false,
        );
        handledTools.add(tool.id);
        continue;
      }

      const assistant = latestAssistant(connection, seen);
      if (assistant) {
        seen.add(assistant.id);
        if (assistant.text.includes('?')) {
          if (answersSent >= MAX_ANSWERS)
            return noBlueprintResult(scenario, model, 'turn_limit', answersSent);
          const scripted = scenario.answers.find((answer) =>
            new RegExp(answer.pattern, 'i').test(assistant.text),
          );
          await runtime(session, options.workspace, options.pet, 'send', {
            text: scripted?.reply ?? scenario.fallbackReply,
            workspaceAccess: true,
            requestId: crypto.randomUUID(),
            ...(options.model === undefined ? {} : { model: options.model }),
          });
          answersSent += 1;
          continue;
        }
        if (
          scenario.expectations.mustHave.some((item) => item.kind === 'declines') &&
          /finances\s+view/i.test(assistant.text) &&
          /use|suggest|existing|instead|recommend|already/i.test(assistant.text)
        )
          return noBlueprintResult(scenario, model, 'declined', answersSent);
      }
      if (poll < MAX_POLLS - 1) await sleep(POLL_INTERVAL_MS);
    }
    return noBlueprintResult(scenario, model, 'timeout', answersSent);
  } finally {
    await runtime(session, options.workspace, options.pet, 'reset');
  }
}

async function readScenarios(id: string | undefined): Promise<DesignScenario[]> {
  if (id && !SCENARIOS.some((name) => name === id))
    throw new Error(`Unknown design scenario '${id}'. Choose: ${SCENARIOS.join(', ')}.`);
  const selected = id ? [id] : SCENARIOS;
  return Promise.all(
    selected.map(async (name) => {
      const file = new URL(
        `../../../../packages/structure-spec/evals/design/${name}.json`,
        import.meta.url,
      );
      return designScenarioSchema.parse(JSON.parse(await readFile(file, 'utf8')));
    }),
  );
}

export async function petEval(
  profile: string | undefined,
  options: PetEvalOptions,
  output: OutputOptions,
  deps: SessionDeps & { sleep?: (milliseconds: number) => Promise<void> } = {},
): Promise<void> {
  if (!options.workspace || !options.pet) throw new Error('Provide --workspace and --pet.');
  const scenarios = await readScenarios(options.scenario);
  const session = await petSessionFor(options.apiUrl, profile, deps);
  const runner: EvalRuntime = {
    session,
    sleep:
      deps.sleep ?? ((milliseconds) => new Promise((resolve) => setTimeout(resolve, milliseconds))),
  };
  const results: PetEvalResult[] = [];
  for (const scenario of scenarios) {
    results.push(
      await runDesignScenario(
        scenario,
        { ...options, workspace: options.workspace, pet: options.pet },
        runner,
      ),
    );
  }
  if (output.json || !output.isTty) printResult(results, output);
  else {
    printTable(
      ['Scenario', 'Model', 'Outcome', 'Gate', 'Score', 'Tool bytes'],
      results.map((result) => [
        result.scenario,
        result.model ?? '(provider default)',
        result.outcome,
        result.gate ? 'pass' : 'fail',
        String(result.score.total),
        String(result.rawToolBytes),
      ]),
    );
    for (const result of results) {
      process.stdout.write(`\n${result.scenario}\n`);
      printTable(
        ['Criterion', 'Score', 'Max', 'Note'],
        result.score.criteria.map((criterion) => [
          criterion.id,
          String(criterion.score),
          String(criterion.max),
          criterion.note,
        ]),
      );
    }
  }
  if (results.some((result) => !result.gate)) process.exitCode = 1;
}
