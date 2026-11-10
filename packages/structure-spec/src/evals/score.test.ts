import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

import { blueprintSchema } from '../blueprint/schema.js';
import { validateBlueprint } from '../blueprint/validate.js';
import { designScenarioSchema, type DesignScenario } from './schema.js';
import { scoreBlueprint } from './score.js';

const names = [
  'reading-log',
  'job-hunt',
  'weekly-meal-plan',
  'freelance-client-work',
  'home-maintenance',
  'language-study',
  'small-garden',
];
const context = { inheritedFields: [], today: '2026-09-26' };
function readScenario(name: string): DesignScenario {
  const path = fileURLToPath(new URL(`../../evals/design/${name}.json`, import.meta.url));
  return designScenarioSchema.parse(JSON.parse(readFileSync(path, 'utf8')));
}

describe('design evaluation', () => {
  it('parses every named scenario and its interview patterns', () => {
    for (const name of names) expect(readScenario(name).id).toBe(name);
  });

  it('scores the reading-log blueprint above 70', () => {
    const fixture = fileURLToPath(
      new URL('../../fixtures/blueprints/reading-log.json', import.meta.url),
    );
    const bp = blueprintSchema.parse(JSON.parse(readFileSync(fixture, 'utf8')));
    const report = validateBlueprint(bp, context);
    const score = scoreBlueprint(bp, readScenario('reading-log').expectations, report);
    expect(report.ok).toBe(true);
    expect(score.total).toBeGreaterThan(70);
    expect(score.criteria.reduce((sum, criterion) => sum + criterion.score, 0)).toBe(score.total);
  });

  it('gates an invalid blueprint and cannot score above 80', () => {
    const bp = {
      version: 1,
      title: 'Broken',
      summary: '',
      root: { id: 'root', title: 'Root' },
    } as const;
    const report = {
      ok: false,
      problems: [{ path: 'root', code: 'invalid', message: 'Invalid.' }],
      warnings: [],
      stats: { fields: 0, views: 0, entries: 0 },
    };
    const score = scoreBlueprint(bp, readScenario('reading-log').expectations, report);
    expect(score.criteria.find((criterion) => criterion.id === 'validator')?.score).toBe(0);
    expect(score.total).toBeLessThanOrEqual(80);
  });

  it('awards full marks for declining a build', () => {
    const report = {
      ok: true,
      problems: [],
      warnings: [],
      stats: { fields: 0, views: 0, entries: 0 },
    };
    const score = scoreBlueprint(
      null,
      { mustHave: [{ kind: 'declines' }], mustNot: [], maxItems: 1, preferComputed: [] },
      report,
    );
    expect(score.total).toBe(100);
  });
});
