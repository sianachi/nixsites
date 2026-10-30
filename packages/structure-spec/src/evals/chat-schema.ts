import { z } from 'zod';

/** A blueprint node id from the chat fixture (`evals/chat/fixture.json`), resolved to the item
 * the seed built for it. Cases never carry UUIDs: the fixture is rebuilt for every run. */
const nodeRef = z.string().regex(/^[a-z][a-z0-9-]*$/);
const pattern = z.string().min(1).max(400);
const jsonValue: z.ZodType = z.lazy(() =>
  z.union([
    z.string(),
    z.number(),
    z.boolean(),
    z.null(),
    z.array(jsonValue),
    z.record(z.string(), jsonValue),
  ]),
);

/** One tool operation, or several alternatives joined by `|` ("list_items|search"). */
const operationRef = z.string().regex(/^[a-z_]+(\|[a-z_]+)*$/);

export const chatToolExpectationsSchema = z
  .object({
    /** Each entry must be attempted at least once (any decision), in any order. */
    require: z.array(operationRef).default([]),
    /** Each entry must complete successfully; an attempted but failed read is not evidence. */
    requireSuccessful: z.array(operationRef).default([]),
    /** These must appear as a subsequence of the attempted operations. */
    inOrder: z.array(operationRef).optional(),
    /** None of these may be attempted. */
    forbid: z.array(operationRef).default([]),
    /** Attempted tool calls above this fail the case, and the run stops there. */
    max: z.number().int().positive().max(12).default(8),
  })
  .strict();

export const chatAssertionSchema = z.discriminatedUnion('kind', [
  /** A child of `parent` whose title matches `title` exists (or not), with these property values. */
  z
    .object({
      kind: z.literal('child'),
      parent: nodeRef,
      title: pattern,
      exists: z.boolean().default(true),
      count: z.number().int().nonnegative().max(30).optional(),
      values: z.record(z.string(), jsonValue).optional(),
      fields: z
        .array(
          z
            .object({ key: z.string().min(1), equals: z.record(z.string(), jsonValue).optional() })
            .strict(),
        )
        .max(24)
        .optional(),
      views: z
        .array(
          z
            .object({ name: z.string().min(1).max(60), equals: z.record(z.string(), jsonValue) })
            .strict(),
        )
        .max(12)
        .optional(),
      noteContains: pattern.optional(),
    })
    .strict(),
  /** A property of `item` equals `equals`, or is truthy when `truthy` is set. */
  z
    .object({
      kind: z.literal('value'),
      item: nodeRef,
      key: z.string().min(1),
      source: z.enum(['properties', 'computed']).default('properties'),
      equals: jsonValue.optional(),
      truthy: z.boolean().optional(),
    })
    .strict(),
  /** The note body of `item` matches (or must not match) `contains`. */
  z
    .object({
      kind: z.literal('note'),
      item: nodeRef,
      contains: pattern,
      absent: z.boolean().default(false),
    })
    .strict(),
  /** A field exists with the requested configuration, including computed expression/source. */
  z
    .object({
      kind: z.literal('field'),
      item: nodeRef,
      key: z.string().min(1),
      equals: z.record(z.string(), jsonValue).optional(),
    })
    .strict(),
  /** `item` still sits under `parent`. */
  z.object({ kind: z.literal('parent'), item: nodeRef, parent: nodeRef }).strict(),
  /** Exactly one named view must have these configuration values. Server ids/defaults are not
   * copied into fixtures; `{item:<node>}` resolves an identity inside equals. Object key order is
   * irrelevant, while array order remains meaningful. */
  z
    .object({
      kind: z.literal('view'),
      item: nodeRef,
      name: z.string().min(1).max(60),
      exists: z.boolean().default(true),
      equals: z.record(z.string(), jsonValue).default({}),
    })
    .strict(),
]);
export type ChatAssertion = z.infer<typeof chatAssertionSchema>;

export const chatCaseSchema = z
  .object({
    id: z.string().regex(/^[a-z][a-z0-9-]*$/),
    /** Sent as the owner's message. `{node:<id>}` is replaced by that fixture item's title. */
    prompt: z.string().min(1),
    /** The note the owner has open: sent as `itemId` with the message, which is what the web does
     * with the "This page" chip. Nothing in the prompt names it, so passing needs context use. */
    currentItem: nodeRef.optional(),
    /** Builds `evals/chat/fixture-<name>.json` instead of the main fixture, which is at the
     * blueprint size limits. */
    fixture: nodeRef.optional(),
    /** Captures this deterministic synthetic fixture leaf before template cases. */
    templateSource: nodeRef.optional(),
    tools: chatToolExpectationsSchema.default({
      require: [],
      requireSuccessful: [],
      forbid: [],
      max: 8,
    }),
    asserts: z.array(chatAssertionSchema).default([]),
    /** The final reply must match this. */
    answer: pattern.optional(),
    /** The final reply must not match this. */
    answerNot: pattern.optional(),
    /** Bounded retrieval/answer signals, not a substitute for judging recommendation quality. */
    answerChecks: z
      .object({
        all: z.array(pattern).max(8).default([]),
        any: z.array(pattern).max(8).default([]),
        absent: z.array(pattern).max(8).default([]),
        /** The reply names or links these known fixture items as supporting evidence. */
        references: z.array(nodeRef).max(8).default([]),
        /** The reply carries a Nix link, `/w/<workspace>?item=<id>`, to each of these fixture items. */
        cites: z.array(nodeRef).max(8).default([]),
        /** Generated UI in the reply: it parses against the web's library and uses these names. */
        openui: z
          .object({
            absent: z.boolean().optional(),
            patch: z.boolean().optional(),
            components: z
              .array(z.string().regex(/^[A-Z][A-Za-z]+$/))
              .max(8)
              .optional(),
            mutations: z
              .array(z.string().regex(/^[a-z_]+$/))
              .max(4)
              .optional(),
            functions: z
              .array(z.string().regex(/^[A-Z][A-Za-z]+$/))
              .max(4)
              .optional(),
          })
          .strict()
          .optional(),
      })
      .strict()
      .optional(),
    /** Reviews must not attempt any mutation, including operations added after this suite. */
    noWrites: z.boolean().default(false),
    workspaceAccess: z.boolean().default(true),
    /** An explicit fixture-only approval, honoured only together with --allow-writes. */
    approvedOperations: z
      .array(z.enum(['update_view', 'move_item', 'trash_item', 'save_as_template', 'run_action']))
      .max(4)
      .default([]),
    /** With `run_action` approved: the only action ids it may run, on fixture items only. */
    approvedActions: z
      .array(z.string().regex(/^[A-Za-z]{1,80}$/))
      .max(4)
      .default([]),
    /** Known capability gaps to count in the report. Only the code is retained, never an excerpt. */
    feedbackChecks: z
      .array(z.object({ code: nodeRef, matches: pattern }).strict())
      .max(8)
      .default([]),
  })
  .strict()
  .superRefine((item, context) => {
    if (item.templateSource && !item.workspaceAccess)
      context.addIssue({
        code: 'custom',
        path: ['templateSource'],
        message: 'Template cases require workspace access.',
      });
    if (item.approvedOperations.includes('save_as_template') && !item.templateSource)
      context.addIssue({
        code: 'custom',
        path: ['approvedOperations'],
        message: 'Template captures require a synthetic fixture source.',
      });
    if (item.approvedOperations.includes('run_action') !== item.approvedActions.length > 0)
      context.addIssue({
        code: 'custom',
        path: ['approvedActions'],
        message: 'Approving run_action needs the action ids it may run, and only then.',
      });
    if (item.noWrites && item.approvedOperations.length > 0)
      context.addIssue({
        code: 'custom',
        path: ['approvedOperations'],
        message: 'A review cannot approve writes.',
      });
    if (!item.workspaceAccess && item.approvedOperations.length > 0)
      context.addIssue({
        code: 'custom',
        path: ['approvedOperations'],
        message: 'Workspace access is required to approve writes.',
      });
    const expressions: [PropertyKey[], string | undefined][] = [
      [['answer'], item.answer],
      [['answerNot'], item.answerNot],
      ...(['all', 'any', 'absent'] as const).flatMap((key) =>
        (item.answerChecks?.[key] ?? []).map((value, index): [PropertyKey[], string] => [
          ['answerChecks', key, index],
          value,
        ]),
      ),
      ...item.feedbackChecks.map((check, index): [PropertyKey[], string] => [
        ['feedbackChecks', index, 'matches'],
        check.matches,
      ]),
      ...item.asserts.flatMap((assertion, index): [PropertyKey[], string | undefined][] =>
        assertion.kind === 'child'
          ? [
              [['asserts', index, 'title'], assertion.title],
              [['asserts', index, 'noteContains'], assertion.noteContains],
            ]
          : assertion.kind === 'note'
            ? [[['asserts', index, 'contains'], assertion.contains]]
            : [],
      ),
    ];
    for (const [path, value] of expressions) {
      if (value === undefined) continue;
      try {
        new RegExp(value, 'i');
      } catch {
        context.addIssue({ code: 'custom', path, message: 'Invalid regular expression.' });
      }
    }
  });
export type ChatCase = z.infer<typeof chatCaseSchema>;
export const chatSuiteSchema = z.array(chatCaseSchema).min(1);
