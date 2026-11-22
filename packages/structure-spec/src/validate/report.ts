import type { z } from 'zod';

import type { FieldRefResolution } from '../spec/refs.js';
import type { StructureProperty, StructureView } from '../types.js';

/**
 * One thing wrong with a spec, at a path a caller can point somebody at.
 *
 * `path` follows the shape a Zod issue already prints for an array index - `fields[2].options`,
 * `entries[1].values.rating` - so a problem raised inside this module and one that came straight
 * from a Zod parse read the same way in a preview or a CLI message.
 */
export interface Problem {
  path: string;
  code: string;
  message: string;
  /** What the model is sent instead of `message`, when the two differ: the model's text may
   * name tools, the owner's never does. */
  modelMessage?: string;
}

/**
 * What `validateSpec` (and, later, `validateBlueprint`) hands back: whether the spec is storable,
 * every reason it is not, non-blocking advice, and enough counts for a preview line ("3 fields, 2
 * views") without the caller re-deriving them from the spec itself.
 */
export interface ValidationReport {
  ok: boolean;
  problems: Problem[];
  warnings: Problem[];
  stats: { fields: number; views: number; entries: number };
}

/**
 * What a spec is checked against: the schema already in effect where it will land, and - for an
 * additive operation - the item's own declared properties and views, so a collision with either
 * can be told apart from a field the item simply does not have yet.
 */
export interface ValidationContext {
  inheritedFields: StructureProperty[];
  existing?: {
    declared: StructureProperty[];
    inherit?: boolean;
    views: StructureView[];
    defaultViewId?: string | null;
    hideDocument?: boolean;
  };
  /** The item's current property values, used to require a due date before setting recurrence. */
  itemValues?: Record<string, unknown>;
  today: string;
}

function formatPath(path: readonly PropertyKey[]): string {
  let result = '';
  for (const segment of path) {
    if (typeof segment === 'number') {
      result += `[${String(segment)}]`;
    } else {
      const text = String(segment);
      result += result.length === 0 ? text : `.${text}`;
    }
  }
  return result;
}

export function zodIssuesToProblems(error: z.ZodError): Problem[] {
  return error.issues.map((issue) => ({
    path: formatPath(issue.path),
    code: issue.code,
    message: issue.message,
  }));
}

export function refFailureMessage(
  ref: string,
  resolution: Extract<FieldRefResolution, { ok: false }>,
): string {
  return resolution.code === 'unknown'
    ? `'${ref}' does not name a field.`
    : `'${ref}' could mean ${resolution.candidates.join(' or ')}; say which.`;
}
