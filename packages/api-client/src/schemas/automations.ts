import { z } from 'zod';
import type { components } from '../generated/api.js';

/**
 * Automation rules (ADR-0051 section 6, Amendment 4). Core owns the trigger, condition and action
 * grammar and validates it on every write, so the client carries those documents as opaque JSON
 * rather than a second copy of the grammar that could drift. Run statuses and reasons are kept as
 * strings for the same reason: a code Core adds later must still parse.
 */
const jsonObjectSchema = z.record(z.string(), z.unknown());
const jsonArraySchema = z.array(z.unknown());

const automationRuleInputSchema = z.object({
  name: z.string().min(1).max(200),
  enabled: z.boolean(),
  scopeItemId: z.uuid().nullable(),
  trigger: jsonObjectSchema,
  conditions: jsonArraySchema.nullable(),
  actions: jsonArraySchema,
});

const petBriefSchema = z
  .string()
  .refine((brief) => /\P{White_Space}/u.test(brief) && !brief.includes('\0'), 'Enter a brief.');

const petRunBriefSchema = petBriefSchema
  .max(4_000)
  .refine((brief) => new TextEncoder().encode(brief).length <= 8_000, 'The brief is too long.');

const petAbilityIdSchema = z
  .string()
  .min(1)
  .max(100)
  .refine((id) => !/[^A-Za-z0-9._-]/.test(id), 'Enter a valid pet ability ID.');

const nonNilUuidSchema = z
  .uuid()
  .refine((id) => id !== '00000000-0000-0000-0000-000000000000', 'Choose a valid ID.');

const routineTitleSchema = z
  .string()
  .max(500)
  .refine(
    (title) => /\P{White_Space}/u.test(title) && !/\p{Cc}/u.test(title),
    'Enter a title without control characters.',
  );

// A pet routine has one scheduled action. Core still validates every rule and target.
const scheduledPetRuleInputSchema = automationRuleInputSchema.extend({
  scopeItemId: nonNilUuidSchema,
  trigger: z.looseObject({ type: z.literal('schedule') }),
  conditions: z.tuple([]).nullable(),
});

export const petRoutineRuleInputSchema = scheduledPetRuleInputSchema.extend({
  actions: z.tuple([
    z
      .strictObject({
        type: z.literal('start_pet_run'),
        brief: petRunBriefSchema,
        includeTargetText: z.boolean().optional(),
        sourceItemIds: z
          .array(nonNilUuidSchema)
          .max(24)
          .refine(
            (ids) => new Set(ids.map((id) => id.toLowerCase())).size === ids.length,
            'Select each source once.',
          )
          .optional(),
        abilities: z
          .array(petAbilityIdSchema)
          .max(32)
          .refine((ids) => new Set(ids).size === ids.length, 'Select each ability once.')
          .optional(),
        autoRename: z
          .strictObject({ from: routineTitleSchema, to: routineTitleSchema })
          .refine(({ from, to }) => from !== to, 'The new title must differ from the current one.')
          .optional(),
      })
      .refine(({ autoRename, abilities }) => !autoRename || abilities?.includes('task.rename'), {
        path: ['abilities'],
        message: 'Enable the task rename ability to use an automatic rename.',
      }),
  ]),
});

export const petMailboxRoutineRuleInputSchema = scheduledPetRuleInputSchema.extend({
  actions: z.tuple([
    z.strictObject({
      type: z.literal('poll_pet_mailbox'),
      provider: z.enum(['gmail', 'outlook-mail']),
      connectionId: nonNilUuidSchema,
      connectionRevision: nonNilUuidSchema,
      resourceId: z
        .string()
        .min(1)
        .max(512)
        .refine((id) => !/\p{Cc}/u.test(id), 'Choose a mailbox label or folder.'),
      brief: petBriefSchema.max(2_000),
      includeTargetText: z.boolean().optional(),
    }),
  ]),
});

export const automationRuleResponseSchema = z.object({
  id: z.uuid(),
  workspaceId: z.uuid(),
  name: z.string(),
  enabled: z.boolean(),
  scopeItemId: z.uuid().nullable(),
  trigger: jsonObjectSchema,
  conditions: jsonArraySchema,
  actions: jsonArraySchema,
  revision: z.int().min(0),
  consecutiveFailures: z.int().min(0),
  disabledReason: z.string().nullable(),
  lastRunAt: z.iso.datetime({ offset: true }).nullable(),
  createdAt: z.iso.datetime({ offset: true }),
  updatedAt: z.iso.datetime({ offset: true }),
});

export const automationListResponseSchema = z.object({
  items: z.array(automationRuleResponseSchema),
});

export const automationRunResponseSchema = z.object({
  id: z.uuid(),
  ruleId: z.uuid(),
  itemId: z.uuid().nullable(),
  origin: z.string(),
  depth: z.int().min(0),
  status: z.string(),
  reason: z.string().nullable(),
  createdAt: z.iso.datetime({ offset: true }),
});

export const automationRunsPageResponseSchema = z.object({
  items: z.array(automationRunResponseSchema),
  nextCursor: z.string().nullable(),
});

const automationActionPreviewSchema = z.object({
  index: z.int().min(0),
  type: z.string(),
  itemId: z.uuid().nullable(),
  key: z.string().nullable(),
  title: z.string().nullable(),
  body: z.string().nullable(),
});

export const automationTestResponseSchema = z.object({
  wouldRun: z.boolean(),
  reason: z.string().nullable(),
  actions: z.array(automationActionPreviewSchema),
});

export type AutomationRuleInput = z.infer<typeof automationRuleInputSchema>;
export type PetRoutineRuleInput = z.infer<typeof petRoutineRuleInputSchema>;
export type PetMailboxRoutineRuleInput = z.infer<typeof petMailboxRoutineRuleInputSchema>;
export type AutomationRuleResponse = z.infer<typeof automationRuleResponseSchema>;
export type AutomationListResponse = z.infer<typeof automationListResponseSchema>;
export type AutomationRunResponse = z.infer<typeof automationRunResponseSchema>;
export type AutomationRunsPageResponse = z.infer<typeof automationRunsPageResponseSchema>;
export type AutomationTestResponse = z.infer<typeof automationTestResponseSchema>;

// Keep boundary parsing tied to the explicitly generated Core contract.
const _ruleContract = automationRuleResponseSchema satisfies z.ZodType<
  components['schemas']['AutomationRuleResponse']
>;
const _runContract = automationRunResponseSchema satisfies z.ZodType<
  components['schemas']['AutomationRunResponse']
>;
const _testContract = automationTestResponseSchema satisfies z.ZodType<
  components['schemas']['AutomationTestResponse']
>;
const _inputContract = automationRuleInputSchema satisfies z.ZodType<
  components['schemas']['AutomationRuleInput']
>;
void _ruleContract;
void _runContract;
void _testContract;
void _inputContract;
