import { z } from 'zod';
import {
  defineCommand,
  defineQuery,
  type CommandEndpoint,
  type QueryEndpoint,
} from '../endpoints.js';

const identifier = z.uuid();
const questionSchema = z.object({
  id: identifier,
  text: z.string(),
  scope: z.enum(['source', 'ability']).nullish(),
  ability: z.string().nullish(),
});
const proposalSchema = z.object({
  id: identifier,
  capability: z.string(),
  description: z.string(),
  preview: z.json(),
  status: z.string(),
  decisionAt: z.string().nullish(),
  receipt: z.json().nullish(),
});
const resultSchema = z.object({ id: identifier, text: z.string(), reversible: z.boolean() });
const failureSchema = z.object({
  stage: z.enum(['planning', 'preview', 'apply']),
  code: z
    .string()
    .min(1)
    .max(80)
    .regex(/^[a-z0-9_.]+$/u),
  message: z.string().min(1).max(500),
});
const runSchema = z.object({
  id: identifier,
  itemId: identifier,
  workspaceId: identifier,
  brief: z.string(),
  sourceItemIds: z.array(identifier),
  workspaceScope: z.boolean(),
  abilities: z.array(z.string()),
  status: z.enum([
    'queued',
    'running',
    'waiting_for_input',
    'waiting_for_approval',
    'waiting_for_handoff',
    'review_required',
    'completed',
    'failed',
    'cancelled',
  ]),
  revision: z.number().int().nonnegative(),
  question: questionSchema.nullish(),
  proposals: z.array(proposalSchema),
  results: z.array(resultSchema),
  createdAt: z.string(),
  updatedAt: z.string(),
  includeTargetText: z.boolean().nullish(),
  afterMessageId: z.string().nullish(),
  failure: failureSchema.nullish(),
});
const abilitySchema = z.object({ id: z.string(), name: z.string(), description: z.string() });
const runListSchema = z.object({
  enabled: z.boolean().default(false),
  abilities: z.array(abilitySchema).default([]),
  runs: z.array(runSchema),
});

export type PetRunResponse = z.infer<typeof runSchema>;
export type PetRunList = z.infer<typeof runListSchema>;
export type PetRunAbility = z.infer<typeof abilitySchema>;
export type PetRunProposal = z.infer<typeof proposalSchema>;
export interface StartPetRun {
  readonly brief: string;
  readonly sourceItemIds: readonly string[];
  readonly workspaceScope: boolean;
  readonly abilities?: readonly string[];
  readonly includeTargetText?: boolean;
  readonly afterMessageId?: string;
}

const root = (itemId: string) => `/api/v1/items/${encodeURIComponent(itemId)}/pet-runs`;
const path = (itemId: string, runId: string) => `${root(itemId)}/${encodeURIComponent(runId)}`;
const cacheKey = ['pet-runs'] as const;

export const listForItem = (itemId: string): QueryEndpoint<PetRunList> =>
  defineQuery({
    operation: 'petRuns.list',
    path: root(itemId),
    schema: runListSchema,
    cacheKey: [...cacheKey, 'item', itemId],
    staleAfterMs: 0,
    retain: false,
  });

export const listForWorkspace = (workspaceId: string): QueryEndpoint<PetRunList> =>
  defineQuery({
    operation: 'petRuns.listWorkspace',
    path: `/api/v1/workspaces/${encodeURIComponent(workspaceId)}/pet-runs`,
    schema: runListSchema,
    cacheKey: [...cacheKey, 'workspace', workspaceId],
    staleAfterMs: 0,
    retain: false,
  });

export const start = (itemId: string, body: StartPetRun): CommandEndpoint<PetRunResponse> =>
  defineCommand({
    operation: 'petRuns.start',
    method: 'POST',
    path: root(itemId),
    schema: runSchema,
    body,
    invalidates: [cacheKey],
  });

export const getRun = (itemId: string, runId: string): QueryEndpoint<PetRunResponse> =>
  defineQuery({
    operation: 'petRuns.get',
    path: path(itemId, runId),
    schema: runSchema,
    cacheKey: [...cacheKey, 'item', itemId, runId],
    retain: false,
  });

export const watch = (
  itemId: string,
  runId: string,
  after: number,
): QueryEndpoint<PetRunResponse> =>
  defineQuery({
    operation: 'petRuns.watch',
    path: `${path(itemId, runId)}/watch`,
    query: { after },
    schema: runSchema,
    cacheKey: undefined,
    timeoutMs: 40_000,
    retain: false,
  });

export const answer = (
  itemId: string,
  runId: string,
  questionId: string,
  text: string,
): CommandEndpoint<PetRunResponse> =>
  defineCommand({
    operation: 'petRuns.answer',
    method: 'POST',
    path: `${path(itemId, runId)}/answer`,
    schema: runSchema,
    body: { questionId, answer: text },
    invalidates: [cacheKey],
  });

export const decide = (
  itemId: string,
  runId: string,
  proposalId: string,
  approve: boolean,
): CommandEndpoint<PetRunResponse> =>
  defineCommand({
    operation: 'petRuns.decide',
    method: 'POST',
    path: `${path(itemId, runId)}/proposals/${encodeURIComponent(proposalId)}/decision`,
    schema: runSchema,
    body: { approve },
    invalidates: [cacheKey],
  });

export const revise = (
  itemId: string,
  runId: string,
  proposalId: string,
  feedback?: string,
): CommandEndpoint<PetRunResponse> =>
  defineCommand({
    operation: 'petRuns.revise',
    method: 'POST',
    path: `${path(itemId, runId)}/proposals/${encodeURIComponent(proposalId)}/revise`,
    schema: runSchema,
    body: feedback === undefined ? {} : { feedback },
    invalidates: [cacheKey],
  });

export const decideScope = (
  itemId: string,
  runId: string,
  questionId: string,
  approve: boolean,
  sourceItemId?: string,
): CommandEndpoint<PetRunResponse> =>
  defineCommand({
    operation: 'petRuns.decideScope',
    method: 'POST',
    path: `${path(itemId, runId)}/scope`,
    schema: runSchema,
    body: { questionId, approve, ...(sourceItemId === undefined ? {} : { sourceItemId }) },
    invalidates: [cacheKey],
  });

export const cancel = (itemId: string, runId: string): CommandEndpoint<PetRunResponse> =>
  defineCommand({
    operation: 'petRuns.cancel',
    method: 'POST',
    path: `${path(itemId, runId)}/cancel`,
    schema: runSchema,
    invalidates: [cacheKey],
  });

export const retry = (itemId: string, runId: string): CommandEndpoint<PetRunResponse> =>
  defineCommand({
    operation: 'petRuns.retry',
    method: 'POST',
    path: `${path(itemId, runId)}/retry`,
    schema: runSchema,
    invalidates: [cacheKey],
  });

export const undo = (
  itemId: string,
  runId: string,
  stepId: string,
): CommandEndpoint<PetRunResponse> =>
  defineCommand({
    operation: 'petRuns.undo',
    method: 'POST',
    path: `${path(itemId, runId)}/steps/${encodeURIComponent(stepId)}/undo`,
    schema: runSchema,
    invalidates: [cacheKey],
  });
