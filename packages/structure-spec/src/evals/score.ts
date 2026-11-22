import type { Blueprint, Node } from '../blueprint/schema.js';
import { TASK_SEMANTIC_FIELD_TYPES } from '../spec/field.js';
import { keyFor } from '../spec/keys.js';
import { isComputedType } from '../vocabulary/property-types.js';
import type { ValidationReport } from '../validate/report.js';
import type { EvalExpectations, Predicate } from './schema.js';

export interface EvalCriterion {
  id: string;
  score: number;
  max: number;
  note: string;
}
export interface EvalScore {
  total: number;
  criteria: EvalCriterion[];
}

const clamp = (value: number, max: number): number => Math.max(0, Math.min(max, Math.round(value)));

function collect(root: Node): { nodes: Node[]; depths: number[] } {
  const nodes: Node[] = [];
  const depths: number[] = [];
  function visit(node: Node, depth: number): void {
    nodes.push(node);
    depths.push(depth);
    for (const child of node.children ?? []) visit(child, depth + 1);
  }
  visit(root, 1);
  return { nodes, depths };
}

function matches(predicate: Predicate, bp: Blueprint, nodes: Node[], depths: number[]): boolean {
  switch (predicate.kind) {
    case 'view':
      return nodes.some((node) => node.views?.some((view) => view.kind === predicate.viewKind));
    case 'fieldType':
      return nodes.some((node) => node.fields?.some((field) => field.type === predicate.type));
    case 'fieldKey':
      return nodes.some((node) => node.fields?.some((field) => keyFor(field) === predicate.key));
    case 'recurrence':
      return nodes.some((node) => node.recurrence !== undefined);
    case 'habit':
      return nodes.some((node) => node.habit !== undefined);
    case 'inputs':
      return (bp.inputs?.length ?? 0) > 0;
    case 'maxDepth':
      return Math.max(...depths) <= predicate.value;
    case 'declines':
      return false;
  }
}

const FIXED_CRITERIA = [
  ['validator', 20],
  ['itemCount', 10],
  ['computed', 10],
  ['views', 10],
  ['inheritance', 10],
  ['taskKeys', 10],
  ['recurrenceOrHabit', 10],
  ['duplicateContainers', 5],
  ['why', 5],
  ['predicates', 10],
] as const;

/** A reproducible quality score for a proposed design blueprint. The validator gate is independent. */
export function scoreBlueprint(
  bp: Blueprint | null,
  expectations: EvalExpectations,
  report: ValidationReport,
): EvalScore {
  const criteria: EvalCriterion[] = [];
  const add = (id: string, score: number, max: number, note: string): void => {
    criteria.push({ id, score: clamp(score, max), max, note });
  };
  const declineExpected = expectations.mustHave.some((predicate) => predicate.kind === 'declines');
  if (declineExpected) {
    const correct = bp === null;
    for (const [id, max] of FIXED_CRITERIA) {
      add(
        id,
        correct ? max : 0,
        max,
        correct ? 'Declined the requested build.' : 'Expected the pet to decline.',
      );
    }
    return { total: criteria.reduce((sum, criterion) => sum + criterion.score, 0), criteria };
  }
  if (bp === null) {
    for (const [id, max] of FIXED_CRITERIA) {
      add(id, 0, max, 'No blueprint was proposed.');
    }
    return { total: 0, criteria };
  }

  const { nodes, depths } = collect(bp.root);
  const fields = nodes.flatMap((node) => node.fields ?? []);
  const containers = nodes.filter((node) => (node.views?.length ?? 0) > 0);
  const computed = new Set(fields.filter((field) => isComputedType(field.type)).map(keyFor));
  const preferred = expectations.preferComputed;
  const semantic = fields.filter((field) =>
    TASK_SEMANTIC_FIELD_TYPES.some((type) => type === field.type),
  );
  const expectsRecurring = expectations.mustHave.some(
    (predicate) => predicate.kind === 'recurrence' || predicate.kind === 'habit',
  );
  const hasRecurring = nodes.some(
    (node) => node.recurrence !== undefined || node.habit !== undefined,
  );
  const duplicateWarnings = report.warnings.filter(
    (warning) => warning.code === 'warn.sibling_containers_same_fields',
  );
  const passed =
    expectations.mustHave.filter((predicate) => matches(predicate, bp, nodes, depths)).length +
    expectations.mustNot.filter((predicate) => !matches(predicate, bp, nodes, depths)).length;
  const predicateCount = expectations.mustHave.length + expectations.mustNot.length;

  add(
    'validator',
    report.ok ? 20 : 0,
    20,
    report.ok ? 'Blueprint validates.' : `${String(report.problems.length)} validation problem(s).`,
  );
  add(
    'itemCount',
    nodes.length <= expectations.maxItems ? 10 : (10 * expectations.maxItems) / nodes.length,
    10,
    `${String(nodes.length)} of ${String(expectations.maxItems)} allowed items.`,
  );
  add(
    'computed',
    preferred.length === 0
      ? 10
      : (10 * preferred.filter((key) => computed.has(key)).length) / preferred.length,
    10,
    `${String(preferred.filter((key) => computed.has(key)).length)} of ${String(preferred.length)} preferred computed fields.`,
  );
  add(
    'views',
    containers.length === 0
      ? 0
      : (10 * containers.reduce((sum, node) => sum + Math.min(node.views?.length ?? 0, 2) / 2, 0)) /
          containers.length,
    10,
    'Two useful views per container receive full credit.',
  );
  add(
    'inheritance',
    nodes.length === 1 || nodes.slice(1).some((node) => node.inherit !== false) ? 10 : 0,
    10,
    'Child nodes can reuse inherited fields.',
  );
  add(
    'taskKeys',
    semantic.length === 0
      ? 10
      : (10 * semantic.filter((field) => keyFor(field) === field.type).length) / semantic.length,
    10,
    'Task fields retain their semantic keys.',
  );
  add(
    'recurrenceOrHabit',
    !expectsRecurring || hasRecurring ? 10 : 0,
    10,
    expectsRecurring
      ? 'Expected recurring behavior is present.'
      : 'No recurring behavior required.',
  );
  add(
    'duplicateContainers',
    duplicateWarnings.length === 0 ? 5 : 0,
    5,
    `${String(duplicateWarnings.length)} duplicate-container warning(s).`,
  );
  add(
    'why',
    (5 * nodes.filter((node) => Boolean(node.why?.trim())).length) / nodes.length,
    5,
    'Share of items with a reason.',
  );
  add(
    'predicates',
    predicateCount === 0 ? 10 : (10 * passed) / predicateCount,
    10,
    `${String(passed)} of ${String(predicateCount)} expectations met.`,
  );
  return { total: criteria.reduce((sum, criterion) => sum + criterion.score, 0), criteria };
}
