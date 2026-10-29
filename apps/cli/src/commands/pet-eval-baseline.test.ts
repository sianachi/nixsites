import { describe, expect, it } from 'vitest';
import { baselineOf, compareToBaseline, type ChatBaseline } from './pet-eval-baseline.ts';
import type { ChatCaseResult } from './pet-eval-chat.ts';

function result(id: string, run: number, pass: boolean): ChatCaseResult {
  return {
    id,
    run,
    model: 'm',
    outcome: 'done',
    pass,
    failures: [],
    tools: [],
    answer: null,
    answerLength: 0,
    citations: { valid: 0, invalid: 0 },
    feedback: [],
    durationMs: 0,
  } as unknown as ChatCaseResult;
}

const baseline: ChatBaseline = {
  model: 'm',
  runs: 2,
  recordedAt: '2026-10-29T00:00:00.000Z',
  cases: { steady: 2, flaky: 1, broken: 0 },
};

describe('chat eval baseline', () => {
  it('records pass counts per case', () => {
    const recorded = baselineOf(
      [result('b', 1, true), result('a', 1, false), result('b', 2, true), result('a', 2, true)],
      2,
      new Date('2026-10-29T00:00:00Z'),
    );
    expect(recorded.cases).toEqual({ a: 1, b: 2 });
    expect(recorded.model).toBe('m');
  });

  it('passes when results match the baseline, including its known failures', () => {
    const comparison = compareToBaseline(
      [result('steady', 1, true), result('flaky', 1, false), result('broken', 1, false)],
      1,
      baseline,
    );
    expect(comparison.regressions).toEqual([]);
    expect(comparison.regressed).toBe(false);
  });

  it('flags a case that always passed and now never does', () => {
    const comparison = compareToBaseline(
      [result('steady', 1, false), result('flaky', 1, true), result('broken', 1, true)],
      1,
      baseline,
    );
    expect(comparison.regressions).toEqual(['steady']);
    expect(comparison.regressed).toBe(true);
  });

  it('flags a drop in the shared pass rate beyond the tolerance', () => {
    const comparison = compareToBaseline(
      ['a', 'b', 'c'].flatMap((id) => [result(id, 1, true), result(id, 2, false)]),
      2,
      { ...baseline, cases: { a: 2, b: 2, c: 2 } },
    );
    expect(comparison.regressions).toEqual([]);
    expect(comparison.regressed).toBe(true);
  });

  it('reports cases missing from the baseline without gating on them', () => {
    const comparison = compareToBaseline(
      [result('steady', 1, true), result('new-case', 1, false)],
      1,
      baseline,
    );
    expect(comparison.unrecorded).toEqual(['new-case']);
    expect(comparison.regressed).toBe(false);
  });

  it('passes a run of only new cases only when they passed', () => {
    expect(compareToBaseline([result('new-case', 1, false)], 1, baseline).regressed).toBe(true);
    expect(compareToBaseline([result('new-case', 1, true)], 1, baseline).regressed).toBe(false);
  });
});
