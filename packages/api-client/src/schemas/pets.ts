import { z } from 'zod';
import { sourceScopeSchema } from './pet-plan-source-scope.js';

const petProfileFields = z.object({
  id: z.uuid(),
  name: z.string().trim().min(1).max(80),
  appearance: z.enum([
    'owl',
    'cat',
    'fox',
    'octopus',
    'axolotl',
    'moth',
    'pangolin',
    'phoenix-chick',
    'mushroom-sprite',
    'origami-crane',
    'jumping-spider',
    'lantern-spirit',
    'hermit-crab',
    'kirin-fawn',
    'gecko',
    'pocket-whale',
    'crystal-golem',
    'fruit-bat',
    'dust-bunny',
  ]),
  instructions: z.string().max(2000),
  /** Default for the conversation's "Apply without asking" switch; stored pets without it read as off. */
  applyWithoutAsking: z.boolean().default(false),
  /** Which model provider this pet speaks to; stored pets without one read as Claude. */
  provider: z.enum(['anthropic', 'openrouter']).default('anthropic'),
  /** The model chat uses; empty is the provider's default (Claude Haiku class for Anthropic). */
  model: z.string().max(160).default(''),
});

const petProfileSchema = z.preprocess((value) => {
  if (
    value &&
    typeof value === 'object' &&
    'appearance' in value &&
    (value.appearance === 'eye-of-ra' || value.appearance === 'demiurge')
  ) {
    // A retired design reads as Owl; a companion still carrying the design's own name takes Owl's.
    const retiredName = value.appearance === 'eye-of-ra' ? 'Eye of Ra' : 'Demiurge';
    return {
      ...value,
      appearance: 'owl',
      ...('name' in value && value.name === retiredName ? { name: 'Owl' } : {}),
    };
  }
  return value;
}, petProfileFields);

export const petProviderSchema = petProfileFields.shape.provider;

/** One stored provider key as the owner may see it: never the key, only its last characters. */
export const petProviderKeySchema = z.object({
  provider: z.enum(['anthropic', 'openrouter']),
  keyHint: z.string().max(8),
  savedAt: z.iso.datetime({ offset: true }),
});

export const petProvidersResponseSchema = z.object({ keys: z.array(petProviderKeySchema) });

export const petSettingsSchema = z
  .object({
    enabled: z.boolean(),
    activePetId: z.uuid().nullable(),
    profiles: z.array(petProfileSchema).max(1),
    inlineWriting: z.boolean().default(false),
    /** What the pet has learned about the owner, newest last; the owner edits them in Settings. */
    memories: z
      .array(
        z.object({
          id: z.uuid(),
          text: z.string().trim().min(1).max(280),
          createdAt: z.iso.datetime({ offset: true }),
        }),
      )
      .max(50)
      .nullish(),
    /** off: nothing reaches the model or is saved; ask: each new memory waits for a click;
     * always: saved without asking, with Undo. Settings saved before it read as ask. */
    memoryMode: z.enum(['off', 'ask', 'always']).nullish(),
    /** The most the pets may cost in a calendar month, in USD, whole cents; null is no limit. */
    monthlyBudgetUsd: z.number().positive().max(100_000).nullish(),
  })
  .refine((settings) => {
    return (
      (!settings.enabled || settings.activePetId !== null) &&
      (settings.activePetId === null || settings.profiles[0]?.id === settings.activePetId)
    );
  }, 'The active pet must be the saved companion.');

/** Totals for one key: a day (yyyy-MM-dd), pet id, model or source. Costs are estimates. */
export const petUsageGroupSchema = z.object({
  key: z.string(),
  turns: z.number().int().min(0),
  inputTokens: z.number().int().min(0),
  cacheReadTokens: z.number().int().min(0),
  cacheWriteTokens: z.number().int().min(0),
  outputTokens: z.number().int().min(0),
  costUsd: z.number().min(0),
});

export const petUsageResponseSchema = z.object({
  budget: z.object({
    limitUsd: z.number().nullable(),
    spentUsd: z.number().min(0),
    remainingUsd: z.number().min(0).nullable(),
    month: z.string(),
    timeZone: z.string(),
  }),
  total: petUsageGroupSchema,
  days: z.array(petUsageGroupSchema),
  byPet: z.array(petUsageGroupSchema),
  byModel: z.array(petUsageGroupSchema),
  bySource: z.array(petUsageGroupSchema),
});

export const petSettingsResponseSchema = z.object({
  revision: z.number().int().min(0).max(Number.MAX_SAFE_INTEGER),
  settings: petSettingsSchema,
});

/** One conversation message. A change the pet proposes is a tool call (`tools` below) with its
 * own approval card, never something a message carries. */
export const petMessageSchema = z.object({
  id: z.string().min(1).max(80),
  role: z.enum(['user', 'assistant', 'system']),
  text: z.string().max(32000),
});

export const petConnectionSchema = z.object({
  provider: z.enum(['anthropic', 'openrouter']).default('anthropic'),
  status: z.enum(['unavailable', 'disconnected', 'connecting', 'connected', 'error']),
  reason: z.string(),
  canConnect: z.boolean(),
  state: z.enum(['idle', 'thinking', 'success', 'error']).default('idle'),
  messages: z.array(petMessageSchema).max(41).nullable().default([]),
  history: z
    .array(z.object({ id: z.uuid(), title: z.string().max(240), createdAt: z.iso.datetime() }))
    .max(32)
    .nullable()
    .default([]),
  models: z
    .array(
      z.object({
        id: z.string().max(160),
        name: z.string().max(200),
        default: z.boolean(),
        /** False only for a provider model that cannot call tools; absent reads as true. */
        supportsTools: z.boolean().default(true),
      }),
    )
    .max(100)
    .nullable()
    .default([]),
  tools: z
    .array(
      z.object({
        id: z.string().max(200),
        arguments: z.string().max(40000),
        status: z.enum([
          'pending',
          'claimed',
          'completed',
          'failed',
          'interrupted',
          'planned',
          'adopted',
        ]),
        planBinding: z
          .object({
            toolId: z.string(),
            runId: z.uuid(),
            planId: z.uuid(),
            planVersion: z.number().int(),
            reviewDigest: z.string(),
            stepId: z.uuid(),
          })
          .nullish(),
        result: z.string().max(32000),
        claimId: z.string().max(80),
      }),
    )
    .max(20)
    .nullable()
    .default([]),
  revision: z.number().int().min(0).max(Number.MAX_SAFE_INTEGER).default(0),
  /**
   * The conversation's model thread holds a tool result read from under a lock. Every write waits
   * for the owner while it is set, in any tab and any later turn; only a new thread clears it.
   * Defaulted, so a server from before the field parses as unmarked.
   */
  lockedRead: z.boolean().default(false),
  /** The companion runs approved writes itself (`tool_approve`); false from a server without it. */
  serverWrites: z.boolean().default(false),
  /** The live conversation's name: the owner's rename, else its first message. */
  title: z.string().default(''),
  turnId: z.string().default(''),
  conversationId: z.string().default(''),
  plannedBatch: z
    .object({
      turnId: z.string(),
      conversationId: z.string(),
      toolIds: z.array(z.string()).max(12),
      ready: z.boolean(),
      requiresReadDecision: z.boolean().optional(),
      sourceScope: sourceScopeSchema.nullish(),
      scope: z.object({ rootItemId: z.uuid().nullable(), readOnly: z.boolean() }).nullish(),
    })
    .nullish(),
});

export type PetProfile = z.infer<typeof petProfileSchema>;
export type PetSettings = z.infer<typeof petSettingsSchema>;
export type PetUsageGroup = z.infer<typeof petUsageGroupSchema>;
export type PetUsageResponse = z.infer<typeof petUsageResponseSchema>;
export type PetSettingsResponse = z.infer<typeof petSettingsResponseSchema>;
export type PetConnection = z.infer<typeof petConnectionSchema>;
export type PetMessage = z.infer<typeof petMessageSchema>;
export type PetToolCall = NonNullable<z.infer<typeof petConnectionSchema>['tools']>[number];

export type PetProviderKey = z.infer<typeof petProviderKeySchema>;
export type PetProvidersResponse = z.infer<typeof petProvidersResponseSchema>;
