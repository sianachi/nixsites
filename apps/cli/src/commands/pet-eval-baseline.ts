import { readFile, writeFile } from 'node:fs/promises';
import { z } from 'zod';
import type { ChatCaseResult } from './pet-eval-chat.ts';

/** Per-case pass counts from a recorded chat suite run; the regression gate compares against it. */
export const chatBaselineSchema = z
  .object({
    model: z.string().nullable(),
    runs: z.number().int().min(1),
    recordedAt: z.string(),
    cases: z.record(z.string(), z.number().int().min(0)),
  })
  .refine(
    (baseline) => Object.values(baseline.cases).every((passes) => passes <= baseline.runs),
    'A case cannot pass more often than the baseline ran.',
  );
export type ChatBaseline = z.infer<typeof chatBaselineSchema>;

export interface BaselineComparison {
  /** Cases that passed every baseline run and now pass none. */
  readonly regressions: string[];
  /** Cases run now that the baseline has no record of: reported, never gated. */
  readonly unrecorded: string[];
  /** Mean pass rate over the cases both runs share. */
  readonly rate: number;
  readonly baselineRate: number;
  readonly regressed: boolean;
}

/** A model reply varies from run to run, so the shared cases may lose this share of their expected
 * passes (and always at least one case's worth) before the drop counts as a regression. */
export const RATE_TOLERANCE = 0.05;

function passCounts(results: readonly ChatCaseResult[]): Map<string, number> {
  const counts = new Map<string, number>();
  for (const result of results)
    counts.set(result.id, (counts.get(result.id) ?? 0) + (result.pass ? 1 : 0));
  return counts;
}

export function baselineOf(
  results: readonly ChatCaseResult[],
  runs: number,
  recordedAt: Date,
): ChatBaseline {
  return {
    model: results[0]?.model ?? null,
    runs,
    recordedAt: recordedAt.toISOString(),
    cases: Object.fromEntries([...passCounts(results)].sort(([a], [b]) => a.localeCompare(b))),
  };
}

/** Compares a run (possibly a subset of cases) with the baseline, as pass rates so the two may use
 * different run counts. */
export function compareToBaseline(
  results: readonly ChatCaseResult[],
  runs: number,
  baseline: ChatBaseline,
): BaselineComparison {
  const regressions: string[] = [];
  const unrecorded: string[] = [];
  let rate = 0;
  let baselineRate = 0;
  let shared = 0;
  for (const [id, passes] of passCounts(results)) {
    const recorded = baseline.cases[id];
    if (recorded === undefined) {
      unrecorded.push(id);
      continue;
    }
    shared += 1;
    rate += passes / runs;
    baselineRate += recorded / baseline.runs;
    if (recorded === baseline.runs && passes === 0) regressions.push(id);
  }
  const drop = baselineRate - rate;
  return {
    regressions,
    unrecorded,
    rate: shared === 0 ? 1 : rate / shared,
    baselineRate: shared === 0 ? 1 : baselineRate / shared,
    // A run that shares no case with the baseline proves nothing, so it passes only if it passed.
    regressed:
      shared === 0
        ? results.some((result) => !result.pass)
        : regressions.length > 0 || drop > Math.max(1, RATE_TOLERANCE * shared),
  };
}

export async function readBaseline(path: string): Promise<ChatBaseline> {
  return chatBaselineSchema.parse(JSON.parse(await readFile(path, 'utf8')));
}

export async function writeBaseline(path: string, baseline: ChatBaseline): Promise<void> {
  await writeFile(path, `${JSON.stringify(baseline, null, 2)}\n`);
}
