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
