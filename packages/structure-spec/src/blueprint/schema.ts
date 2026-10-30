import { z } from 'zod';

import { HABIT, INIT_RULE_KINDS, RECURRENCE, TEMPLATE_INPUT_TYPES } from '../catalog/tables.js';
import { fieldSpecSchema, type FieldSpec } from '../spec/field.js';
import { jsonValueSchema, type JsonValue } from '../spec/operations.js';
import { viewSpecSchema, type ViewSpec } from '../spec/view.js';

/** A blueprint node's own id: local to the blueprint, never a server-assigned one. */
export const NODE_ID_PATTERN = /^[a-z][a-z0-9-]{0,31}$/;

/**
 * A value the pet asks the owner to fill in when a template built from a blueprint is applied
 * (architecture 2.3's `TemplateInputSpec`). `member` and `item` inputs are excluded on purpose -
 * member resolution and external references stay owner-only in the studio (architecture 2.3's
 * closing note) - so this is a narrower enum than `templateInputSchema`'s own four types
 * (`packages/api-client/src/schemas/templates.ts`), not the same schema reused: that one also
 * carries a server-assigned `defaultValue` shape this spec does not need yet.
 */
export const templateInputSpecSchema = z
  .object({
    key: z
      .string()
      .min(1)
      .max(64)
      .regex(/^[a-z][a-z0-9_-]*$/),
    label: z.string().min(1).max(80),
    type: z.enum(TEMPLATE_INPUT_TYPES),
    required: z.boolean().optional(),
    default: z.string().optional(),
  })
  .strict();
export type TemplateInputSpec = z.infer<typeof templateInputSpecSchema>;

/**
 * One instruction for what happens to a node's field when a template built from this blueprint is
 * applied (architecture 2.3's `InitRuleSpec`). Shaped like a narrower
 * `templateInitializationRuleSchema` (`packages/api-client/src/schemas/templates.ts`) - the same
 * five kinds, but naming a blueprint node and a `FieldRef` rather than a captured item's UUID and a
 * stored property key, because a blueprint rule is written before any of that exists. The semantic
 * constraints `templateInitializationSchema` enforces at the same layer - unique input keys, a rule
 * naming a real node and field, `relativeDate` needing a date input, one rule per node and field,
 * and an `input` rule naming an input of the matching type - are `validateBlueprint`'s job
 * (architecture 4 check 12): a rule can only be checked against the blueprint it lives in, which
 * this schema alone does not have in view.
 */
export const initRuleSpecSchema = z
  .object({
    node: z.string().regex(NODE_ID_PATTERN),
    field: z.string().min(1),
    kind: z.enum(INIT_RULE_KINDS),
    value: jsonValueSchema.optional(),
    input: z.string().min(1).max(64).optional(),
    offsetDays: z.number().int().min(-36_500).max(36_500).optional(),
  })
  .strict()
  .superRefine((rule, context) => {
    if (rule.kind === 'set' && rule.value === undefined) {
      context.addIssue({ code: 'custom', path: ['value'], message: "A 'set' rule needs a value." });
    }
    if (rule.kind !== 'set' && rule.value !== undefined) {
      context.addIssue({
        code: 'custom',
        path: ['value'],
        message: "Only a 'set' rule takes a value.",
      });
    }

    const takesInput = rule.kind === 'input' || rule.kind === 'relativeDate';
    if (takesInput && rule.input === undefined) {
      context.addIssue({
        code: 'custom',
        path: ['input'],
        message: `A '${rule.kind}' rule needs an input.`,
      });
    }
    if (!takesInput && rule.input !== undefined) {
      context.addIssue({
        code: 'custom',
        path: ['input'],
        message: "Only 'input' and 'relativeDate' rules take an input.",
      });
    }

    if (rule.kind === 'relativeDate' && rule.offsetDays === undefined) {
      context.addIssue({
        code: 'custom',
        path: ['offsetDays'],
        message: "A 'relativeDate' rule needs an offset in days.",
      });
    }
    if (rule.kind !== 'relativeDate' && rule.offsetDays !== undefined) {
      context.addIssue({
        code: 'custom',
        path: ['offsetDays'],
        message: "Only a 'relativeDate' rule takes an offset.",
      });
    }
  });
export type InitRuleSpec = z.infer<typeof initRuleSpecSchema>;

/**
 * A node's recurrence, shaped exactly as architecture 2.3's `RecurrenceSpec` - the same fields
 * `packages/api-client/src/resources/recurrence.ts`'s `SetRecurrenceInput` eventually takes
 * (`weekdays` only when weekly, `until` when given). Phase B's `add_fields`/`edit_form`/
 * `set_recurrence` task (B.2, a later wave) is where a standalone, exported `RecurrenceSpec` for
 * the flat `nix_workspace` operations will land; this blueprint task runs before it, so the shape
 * is declared locally here rather than imported from a module that does not exist yet on this
 * base. If B.2 lands a `RecurrenceSpec` with a different shape, the two must be reconciled by hand -
 * nothing here enforces that they stay identical.
 */
const recurrenceSpecSchema = z
  .object({
    frequency: z.enum(RECURRENCE.frequencies),
    interval: z.number().int().min(RECURRENCE.intervalMin).max(RECURRENCE.intervalMax),
    weekdays: z.array(z.number().int().min(1).max(7)).optional(),
    until: z
      .string()
      .regex(/^\d{4}-\d{2}-\d{2}$/)
      .optional(),
  })
  .strict();

/**
 * A node's habit settings, shaped exactly as architecture 2.3's `Node.habit`. See
 * `recurrenceSpecSchema`'s doc comment for why this is declared locally rather than imported: no
 * task before this one exports a habit spec either.
 */
const habitSpecSchema = z
  .object({
    frequency: z.enum(HABIT.frequencies),
    weekdays: z.array(z.number().int().min(1).max(7)).optional(),
    target: z.number().positive(),
    unit: z.string().min(1).max(20),
  })
  .strict();

/**
 * One node of a blueprint tree (architecture 2.3). Recursive, so it is declared with `z.lazy` and
 * the TS type is written out by hand, the same way `jsonValueSchema`'s recursive type is
 * (`../spec/operations.ts`) - Zod cannot infer a recursive type through `z.infer` without one.
 *
 * `fields`, `views` and `markdown` reuse `fieldSpecSchema` and `viewSpecSchema` from A.1a rather
 * than declaring node-local copies, so a node's schema and a flat `create_structured`'s schema stay
 * one vocabulary; likewise `values` reuses `jsonValueSchema`. A node with `views` is a container
 * (`effective.ts`'s `containerNodes`); a node with `recurrence` needs a `due_date` property in
 * effect and a `due_date` value (`validate.ts` check 11); a node with `habit` must be a child of a
 * container whose views include a `habit_tracker` (same check).
 */
export interface Node {
  id: string;
  title: string;
  why?: string | undefined;
  fields?: FieldSpec[] | undefined;
  inherit?: boolean | undefined;
  views?: ViewSpec[] | undefined;
  markdown?: string | undefined;
  recurrence?: z.infer<typeof recurrenceSpecSchema> | undefined;
  habit?: z.infer<typeof habitSpecSchema> | undefined;
  values?: Record<string, JsonValue> | undefined;
  sample?: boolean | undefined;
  children?: Node[] | undefined;
}

export const nodeSchema: z.ZodType<Node> = z.lazy(() =>
  z
    .object({
      id: z.string().regex(NODE_ID_PATTERN),
      // Empty is allowed: Core keeps an empty title, and the plan must not invent one.
      title: z.string().max(240),
      why: z.string().max(200).optional(),
      fields: z.array(fieldSpecSchema).max(30).optional(),
      inherit: z.boolean().optional(),
      views: z.array(viewSpecSchema).max(6).optional(),
      markdown: z.string().max(4000).optional(),
      recurrence: recurrenceSpecSchema.optional(),
      habit: habitSpecSchema.optional(),
      values: z.record(z.string(), jsonValueSchema).optional(),
      sample: z.boolean().optional(),
      children: z.array(nodeSchema).optional(),
    })
    .strict(),
);

/**
 * A whole blueprint (architecture 2.3): a design a pet proposes, an owner
 * approves, and the build planner (task C.3a) turns into `Step[]`. Tree-wide limits (node count,
 * depth, fields, views, samples, planned writes) are cross-cutting and cannot be expressed as a
 * `.max()` on any one field here - `validateBlueprint` (`validate.ts`) walks the parsed tree to
 * enforce them, the same division `@nix/structure-spec/validate`'s flat specs already keep between
 * Zod shape and semantic checks.
 */
export const blueprintSchema = z
  .object({
    version: z.literal(1),
    title: z.string().min(1).max(120),
    summary: z.string().max(400),
    root: nodeSchema,
    inputs: z.array(templateInputSpecSchema).max(10).optional(),
    rules: z.array(initRuleSpecSchema).max(100).optional(),
  })
  .strict();
export type Blueprint = z.infer<typeof blueprintSchema>;
