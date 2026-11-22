import type { PropertyValue } from '@nix/web-collections/core/container-model';

interface Condition {
  readonly fieldBlockId: string;
  readonly operator: string;
  readonly value: string | null;
}

interface Visible {
  readonly visibleWhen: readonly Condition[];
}

type Answers = Readonly<Record<string, PropertyValue>>;

function conditionMatches(condition: Condition, answers: Answers): boolean {
  const answer = answers[condition.fieldBlockId];
  const expected = condition.value ?? '';
  if (condition.operator === 'checked') return answer === true;
  if (condition.operator === 'not_checked') return answer !== true;
  if (condition.operator === 'not_equals') return String(answer ?? '') !== expected;
  if (condition.operator === 'contains') {
    return Array.isArray(answer)
      ? answer.includes(expected)
      : String(answer ?? '').includes(expected);
  }
  return String(answer ?? '') === expected;
}

export function isVisible(subject: Visible, answers: Answers): boolean {
  return subject.visibleWhen.every((condition) => conditionMatches(condition, answers));
}

export function isEmpty(value: PropertyValue | undefined): boolean {
  return (
    value === undefined ||
    value === null ||
    value === '' ||
    (Array.isArray(value) && value.length === 0)
  );
}

/** The pages and blocks a respondent sees, and the answers that still count, given what they answered. */
export function resolveFlow<
  P extends Visible & {
    readonly blocks: readonly (Visible & { readonly id: string; readonly kind: string })[];
  },
>(pages: readonly P[], answers: Answers): { pages: P[]; answers: Record<string, PropertyValue> } {
  const effective: Record<string, PropertyValue> = {};
  const shown: P[] = [];
  for (const page of pages) {
    if (!isVisible(page, effective)) continue;
    const blocks = page.blocks.filter((block) => {
      if (!isVisible(block, effective)) return false;
      if (block.kind === 'field' && answers[block.id] !== undefined) {
        effective[block.id] = answers[block.id] ?? null;
      }
      return true;
    });
    shown.push({ ...page, blocks });
  }
  return { pages: shown, answers: effective };
}
