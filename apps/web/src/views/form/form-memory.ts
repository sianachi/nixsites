import { frecencyScores, recordPick } from '@nix/web-foundation/lib/frecency';
import type { PropertyDefinition, PropertyValue } from '@nix/web-collections/core/container-model';

/**
 * What this person usually puts in a form's fields, remembered from their own submissions.
 *
 * **"Their own" is this browser's record, because the server has no other.** An item carries no
 * author - `ItemResponse` has timestamps but no creator - so "the person's previous submissions to
 * this form" cannot be read back from the children; the children are everybody's submissions. What
 * can be known honestly is what was submitted from here, by whoever is signed in, which the
 * frecency store already scopes and clears at sign-out. So a successful submit records its values,
 * and the next blank form offers the usual one as a suggestion beside the field - never as a value
 * already filled in, which would be one unnoticed Enter away from a submission nobody chose.
 *
 * **Only choice fields are remembered.** Frecency keeps no document text (see `lib/frecency.ts`):
 * a select's option, a priority step, an assignee's principal id are all values the schema or the
 * workspace already names. An option label is still workspace content, which is why the store is
 * cleared whenever the signed-in subject changes. A text field's value is something a person wrote
 * into an item, and remembering it in browser storage is what that store promises not to do.
 *
 * Namespaced `form:<workspace>:<view>:<property>`, so two forms over one container keep separate
 * habits and nothing crosses workspaces.
 */

/** The property types a form remembers. */
const REMEMBERED_TYPES: ReadonlySet<string> = new Set([
  'select',
  'multi_select',
  'assignee',
  'priority',
]);

/**
 * The least decayed score before a value is offered: two submissions within one frecency half-life
 * (two weeks) clear it, one submission never does, and two a month apart no longer do.
 */
const MINIMUM_HABIT = 1.5;

/** The share of all remembered picks the usual value must hold, so a split habit offers nothing. */
const MINIMUM_HABIT_SHARE = 0.5;

function formMemoryNamespace(workspaceId: string, viewId: string, key: string): string {
  return `form:${workspaceId}:${viewId}:${key}`;
}

function isRemembered(property: PropertyDefinition): boolean {
  return !property.choiceSource && REMEMBERED_TYPES.has(property.type);
}

/** The keys one submitted value is remembered under: each option of a multi-select, else one. */
function keysOf(property: PropertyDefinition, value: PropertyValue | undefined): readonly string[] {
  if (value === undefined || value === null) {
    return [];
  }
  if (Array.isArray(value)) {
    return value.filter((entry): entry is string => typeof entry === 'string');
  }
  if (property.type === 'priority') {
    return typeof value === 'number' ? [String(value)] : [];
  }
  return typeof value === 'string' && value.length > 0 ? [value] : [];
}

/** Records a successful submission's remembered fields. */
export function rememberSubmission(
  workspaceId: string,
  viewId: string,
  fields: readonly PropertyDefinition[],
  sent: Readonly<Record<string, PropertyValue>>,
  now?: number,
): void {
  for (const property of fields) {
    if (!isRemembered(property)) {
      continue;
    }
    const namespace = formMemoryNamespace(workspaceId, viewId, property.key);
    for (const key of keysOf(property, sent[property.key])) {
      recordPick(namespace, key, now);
    }
  }
}

/** A value offered for an empty field, and what to send to fill it. */
export interface UsualValue {
  /** The value as stored in the memory: an option, a principal id, a priority step as text. */
  readonly key: string;
  readonly stored: PropertyValue;
}

/**
 * The usual value for one field, when the habit is strong and still valid, or null.
 *
 * A select's remembered option must still be declared, and a priority must still be a step on the
 * scale - a habit formed before an option was renamed offers nothing rather than a value the server
 * would refuse.
 */
export function usualValue(
  scores: ReadonlyMap<string, number>,
  property: PropertyDefinition,
): UsualValue | null {
  let total = 0;
  let best: { key: string; score: number } | null = null;
  for (const [key, score] of scores) {
    total += score;
    if (best === null || score > best.score) {
      best = { key, score };
    }
  }
  if (best === null || best.score < MINIMUM_HABIT || best.score / total < MINIMUM_HABIT_SHARE) {
    return null;
  }

  switch (property.type) {
    case 'select':
      return property.options.includes(best.key) ? { key: best.key, stored: best.key } : null;
    case 'multi_select':
      return property.options.includes(best.key) ? { key: best.key, stored: [best.key] } : null;
    case 'priority': {
      const step = Number(best.key);
      return Number.isInteger(step) && step >= 1 && step <= 4
        ? { key: best.key, stored: step }
        : null;
    }
    case 'assignee':
      return { key: best.key, stored: best.key };
    default:
      return null;
  }
}

/** Reads the usual value for each remembered field of a form, keyed by property. */
export function usualValues(
  workspaceId: string,
  viewId: string,
  fields: readonly PropertyDefinition[],
  now?: number,
): ReadonlyMap<string, UsualValue> {
  const usual = new Map<string, UsualValue>();
  for (const property of fields) {
    if (!isRemembered(property)) {
      continue;
    }
    const value = usualValue(
      frecencyScores(formMemoryNamespace(workspaceId, viewId, property.key), now),
      property,
    );
    if (value !== null) {
      usual.set(property.key, value);
    }
  }
  return usual;
}
