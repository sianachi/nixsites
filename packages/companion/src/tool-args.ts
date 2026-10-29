import { z } from 'zod';
import { READ_ONLY_OPERATION_NAMES, WORKSPACE_OPERATIONS } from '@nix/structure-spec';

const optionalId = z.union([z.literal(''), z.uuid()]);
export const workspaceToolSchema = z
  .object({
    // Sourced from @nix/structure-spec's WORKSPACE_OPERATIONS (packages/structure-spec/src/
    // catalog/tables.ts), which is also what the pet's typed nix_<operation> tools
    // (buildPetTools) and the Go worker's generated tools-chat.json are built from, so this flat enum cannot drift out of step with either.
    operation: z.enum(WORKSPACE_OPERATIONS),
    itemId: optionalId,
    parentId: optionalId,
    title: z.string().max(240),
    markdown: z.string().max(16000),
    query: z.string().max(240),
    propertiesJson: z.string().max(8000),
    specJson: z.string().max(24000).default(''),
  })
  .strict()
  .superRefine((args, context) => {
    const required = (
      field: 'itemId' | 'parentId' | 'title' | 'markdown' | 'query' | 'specJson',
    ) => {
      if (!args[field].trim())
        context.addIssue({
          code: 'custom',
          path: [field],
          message: `${field} is required for ${args.operation}.`,
        });
    };
    const NO_ITEM_ID_REQUIRED = [
      'create_note',
      'list_items',
      'search',
      'list_templates',
      'create_structured',
      'create_entries',
      'build_blueprint',
      'read_calendar',
      'remember',
    ];
    if (!NO_ITEM_ID_REQUIRED.includes(args.operation)) required('itemId');
    if (
      [
        'create_note',
        'rename_item',
        'apply_template',
        'create_structured',
        'save_as_template',
      ].includes(args.operation)
    )
      required('title');
    if (args.operation === 'append_note' || args.operation === 'remember') required('markdown');
    // Body edits: `query` carries the heading (replace_section) or the passage to find
    // (replace_passage); `markdown` carries the new section or the replacement text, which may be
    // empty for a passage (deleting a phrase) but never for a section.
    if (args.operation === 'replace_section' || args.operation === 'replace_passage')
      required('query');
    if (args.operation === 'replace_section') required('markdown');
    if (
      args.operation === 'search' ||
      args.operation === 'search_note' ||
      args.operation === 'read_view'
    )
      required('query');
    if (args.operation === 'create_entries') required('parentId');
    if (
      [
        'create_structured',
        'add_view',
        'create_entries',
        'add_fields',
        'edit_fields',
        'edit_form',
        'update_view',
        'set_recurrence',
      ].includes(args.operation)
    ) {
      if (!args.specJson.trim()) {
        required('specJson');
      } else {
        try {
          const parsed: unknown = JSON.parse(args.specJson);
          if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed))
            throw new Error('specJson must be a JSON object.');
        } catch {
          context.addIssue({
            code: 'custom',
            path: ['specJson'],
            message: 'Provide a JSON object in specJson.',
          });
        }
      }
    }
    if (args.operation === 'build_blueprint' || args.operation === 'save_as_template') {
      if (!args.specJson.trim() && args.operation !== 'save_as_template') required('specJson');
      else if (args.specJson.trim()) {
        try {
          const parsed: unknown = JSON.parse(args.specJson);
          if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed))
            throw new Error('specJson must be a JSON object.');
        } catch {
          context.addIssue({
            code: 'custom',
            path: ['specJson'],
            message: 'Provide a JSON object in specJson.',
          });
        }
      }
    }
    if (args.specJson.trim() && args.markdown.trim()) {
      context.addIssue({
        code: 'custom',
        path: ['markdown'],
        message: 'markdown must be empty when specJson is used.',
      });
    }
    if (args.operation === 'read_calendar') {
      const range = readSpecObject(args.specJson);
      if (!range || !isDay(range.from) || !isDay(range.to))
        context.addIssue({
          code: 'custom',
          path: ['specJson'],
          message: 'read_calendar needs from and to as yyyy-MM-dd days.',
        });
    }
    if (args.operation === 'complete_task') {
      const task = readSpecObject(args.specJson);
      if (typeof task?.completed !== 'boolean')
        context.addIssue({
          code: 'custom',
          path: ['specJson'],
          message: 'complete_task needs completed as true or false.',
        });
    }
    if (args.operation === 'set_properties') {
      try {
        z.record(z.string().max(160), z.unknown()).parse(JSON.parse(args.propertiesJson));
      } catch {
        context.addIssue({
          code: 'custom',
          path: ['propertiesJson'],
          message: 'Provide a JSON object of property values.',
        });
      }
    }
  });

export type WorkspaceToolArgs = z.infer<typeof workspaceToolSchema>;

/** The `specJson` object a scalar-parameter tool (`read_calendar`, `complete_task`) carries, or
 * undefined when it is missing, not JSON, or not an object. */
function readSpecObject(specJson: string): Record<string, unknown> | undefined {
  if (!specJson.trim()) return undefined;
  try {
    const parsed: unknown = JSON.parse(specJson);
    return typeof parsed === 'object' && parsed !== null && !Array.isArray(parsed)
      ? (parsed as Record<string, unknown>)
      : undefined;
  } catch {
    return undefined;
  }
}

const DAY = /^\d{4}-\d{2}-\d{2}$/;

/** A real `yyyy-MM-dd` calendar day: the shape, and a date that round-trips (no 2026-02-30). */
export function isDay(value: unknown): value is string {
  if (typeof value !== 'string' || !DAY.test(value)) return false;
  const instant = new Date(`${value}T00:00:00Z`);
  return !Number.isNaN(instant.getTime()) && instant.toISOString().slice(0, 10) === value;
}

/** A local preflight refusal with safe copy, before any mutation is attempted. `message` goes
 * back to the model and may name tools; `ownerMessage`, when given, is the plain sentence the
 * owner reads instead, with no tool names. */
export class WorkspaceToolRefusal extends Error {
  /** Whether `message` may quote text read from under a lock (a body edit's refusal lists the
   * note's headings). Reported with the tool result like a read's `lockedContent`. */
  lockedContent = false;

  constructor(
    message: string,
    readonly ownerMessage?: string,
  ) {
    super(message);
  }
}

/** The operations the executor never writes through. `runWorkspaceTool`'s
 * `WorkspaceToolOutcome.readOnly` is derived from this set. Sourced from @nix/structure-spec's
 * READ_ONLY_OPERATION_NAMES, the same list `buildPetTools`' tool descriptions read. */
export const READ_ONLY_OPERATIONS: ReadonlySet<WorkspaceToolArgs['operation']> = new Set(
  READ_ONLY_OPERATION_NAMES,
);
