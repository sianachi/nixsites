import { z } from 'zod';
import { sourceScopeSchema } from '../schemas/pet-plan-source-scope.js';
export { sourceScopeSchema } from '../schemas/pet-plan-source-scope.js';
import {
  defineCommand,
  defineQuery,
  type CommandEndpoint,
  type QueryEndpoint,
} from '../endpoints.js';

const id = z.uuid();
const recipientSchema = z.object({
  provider: z.string(),
  destination: z.string(),
  routingPolicy: z.string(),
  connectionRevision: z.string(),
});
export const sharingQuestionSchema = z.object({
  scopeDigest: z.string(),
  recipientRevision: z.string(),
  sourceScope: sourceScopeSchema,
  recipient: recipientSchema,
  message: z.string(),
  decisionNonce: z.uuid().nullish(),
});
const fieldSchema = z.object({
  id: z.string(),
  label: z.string(),
  kind: z.string(),
  value: z.json(),
  help: z.string().nullish(),
  required: z.boolean(),
  choices: z.array(z.string()).nullish(),
  currentValue: z.json().optional(),
});
export const receiptViewSchema = z.object({
  summary: z.string(),
  details: z.json().nullish(),
  text: z.string().nullish(),
});
const stepSchema = z.object({
  id,
  capability: z.string(),
  arguments: z.json(),
  effect: z.object({ description: z.string(), parameters: z.json() }),
  executor: z.string(),
  status: z.string(),
  fields: z.array(fieldSchema),
  execution: z
    .object({
      claimId: id,
      executionId: id,
      requestId: id,
      runnerContextId: id,
      jobId: id.nullish(),
      claimedAt: z.string(),
      dispatchedAt: z.string().nullish(),
    })
    .nullish(),
  receipt: z.string().nullish(),
  receiptView: receiptViewSchema.nullish(),
  undoId: id.nullish(),
});
const decisionSchema = z.object({
  requestId: id,
  approve: z.boolean(),
  at: z.string(),
  credentialClass: z.string(),
  authorityId: z.string(),
  actorId: id,
});
const planSchema = z.object({
  id,
  version: z.number().int(),
  summary: z.string(),
  reviewDigest: z.string(),
  scopeDigest: z.string(),
  recipientRevision: z.string(),
  status: z.string(),
  steps: z.array(stepSchema),
  decision: decisionSchema.nullish(),
});
export const petPlanResponseSchema = z.object({
  id,
  workspaceId: id,
  anchorItemId: id.nullish(),
  petId: id,
  brief: z.string(),
  sourceScope: sourceScopeSchema,
  status: z.string(),
  revision: z.number().int(),
  sharingQuestion: sharingQuestionSchema.nullish(),
  question: z
    .object({ id, text: z.string(), scope: z.string().nullish(), ability: z.string().nullish() })
    .nullish(),
  plan: planSchema.nullish(),
  results: z.array(z.object({ id, text: z.string(), reversible: z.boolean() })),
  observations: z
    .array(
      z.object({
        id,
        capability: z.string(),
        description: z.string(),
        receiptView: receiptViewSchema.nullish(),
      }),
    )
    .nullish(),
  createdAt: z.string(),
  updatedAt: z.string(),
  afterMessageId: z.string().nullish(),
  failure: z.object({ stage: z.string(), code: z.string(), message: z.string() }).nullish(),
});
const listSchema = z.object({
  enabled: z.boolean(),
  abilities: z.array(z.object({ id: z.string(), name: z.string(), description: z.string() })),
  runs: z.array(petPlanResponseSchema),
});
const handoffStatusSchema = z.object({
  handoffId: id,
  granteeCredentialId: id,
  clientName: z.string(),
  planId: id,
  planVersion: z.number().int(),
  reviewDigest: z.string(),
  approve: z.boolean(),
  status: z.enum(['pending', 'authorized', 'consumed', 'revoked', 'expired']),
  expiresAt: z.string(),
});
const handoffSchema = z.object({
  handoffId: id,
  browserPath: z.string(),
  decisionContext: z.string(),
  expiresAt: z.string(),
});
export type PetPlanSourceScope = z.infer<typeof sourceScopeSchema>;
export type PetPlanSharingQuestion = z.infer<typeof sharingQuestionSchema>;
export type PetPlanResponse = z.infer<typeof petPlanResponseSchema>;
export type PetPlanPrepared = z.infer<typeof planSchema>;
export type PetPlanPreparedStep = z.infer<typeof stepSchema>;
export type PetPlanEditableField = z.infer<typeof fieldSchema>;
export type PetPlanReceiptView = z.infer<typeof receiptViewSchema>;
export type PetPlanList = z.infer<typeof listSchema>;
export type PetPlanDecisionHandoffStatus = z.infer<typeof handoffStatusSchema>;
const stepClaimSchema = z.object({
  run: petPlanResponseSchema,
  claimId: id,
  executionId: id,
  stepId: id,
  capability: z.string(),
  arguments: z.json(),
  preview: z.json(),
  executor: z.string(),
  dispatchContext: z.string(),
});
const clientIntentSchema = z.object({
  requestId: id,
  childId: z.number().int(),
  destination: z.enum(['core', 'collab']),
  method: z.string(),
  target: z.string(),
  body: z.string().nullish(),
  headers: z.record(z.string(), z.string()),
  dispatchPermit: z.string(),
});
export type PetPlanStepClaim = z.infer<typeof stepClaimSchema>;
export type PetPlanClientIntent = z.infer<typeof clientIntentSchema>;
export interface StartPetPlan {
  petId: string;
  brief?: string;
  anchorItemId?: string | null;
  sourceScope: PetPlanSourceScope;
  afterMessageId?: string;
  requestId: string;
  chatSource?: {
    conversationId: string;
    toolCallIds: readonly string[];
    turnId: string;
    mode?: string;
    rootItemId?: string;
  };
}
export interface PetPlanRevision {
  expectedRunRevision: number;
  planVersion?: number | null;
  fieldEdits?: readonly {
    stepId: string;
    fieldId: string;
    value: z.infer<ReturnType<typeof z.json>>;
  }[];
  feedback?: string;
  requestId: string;
}
export interface PetPlanDecision {
  expectedRunRevision: number;
  planVersion: number;
  reviewDigest: string;
  approve: boolean;
  requestId: string;
  decisionContext?: string;
}
export interface PetPlanSharingDecision {
  expectedRunRevision: number;
  recipientRevision: string;
  scopeDigest: string;
  approve: boolean;
  requestId: string;
  decisionNonce: string;
}
export interface PetPlanDecisionHandoffRequest {
  planId: string;
  planVersion: number;
  reviewDigest: string;
  clientName: string;
  approve: boolean;
}
export interface PetPlanDecisionContextRequest extends PetPlanDecisionHandoffRequest {
  handoffId: string;
  granteeCredentialId: string;
}
const cacheKey = ['pet-plans'] as const;
const root = (workspaceId: string) =>
  `/api/v1/workspaces/${encodeURIComponent(workspaceId)}/pet-plans`;
const path = (workspaceId: string, runId: string) =>
  `${root(workspaceId)}/${encodeURIComponent(runId)}`;
const command = <T>(operation: string, route: string, schema: z.ZodType<T>, body?: unknown) =>
  defineCommand({
    operation: `petPlans.${operation}`,
    method: 'POST',
    path: route,
    schema,
    body,
    invalidates: [cacheKey],
  });
export const list = (workspaceId: string): QueryEndpoint<PetPlanList> =>
  defineQuery({
    operation: 'petPlans.list',
    path: root(workspaceId),
    schema: listSchema,
    cacheKey: [...cacheKey, workspaceId],
    staleAfterMs: 0,
    retain: false,
  });
export const listForWorkspace = list;
export const start = (workspaceId: string, body: StartPetPlan): CommandEndpoint<PetPlanResponse> =>
  command('start', root(workspaceId), petPlanResponseSchema, body);
export const read = (workspaceId: string, runId: string): QueryEndpoint<PetPlanResponse> =>
  defineQuery({
    operation: 'petPlans.get',
    path: path(workspaceId, runId),
    schema: petPlanResponseSchema,
    retain: false,
  });
export const getRun = read;
export const watch = (
  workspaceId: string,
  runId: string,
  after: number,
): QueryEndpoint<PetPlanResponse> =>
  defineQuery({
    operation: 'petPlans.watch',
    path: `${path(workspaceId, runId)}/watch`,
    query: { after },
    schema: petPlanResponseSchema,
    timeoutMs: 40_000,
    retain: false,
  });
export const answer = (
  workspaceId: string,
  runId: string,
  body: { expectedRunRevision: number; questionId: string; answer: string; requestId: string },
): CommandEndpoint<PetPlanResponse> =>
  command('answer', `${path(workspaceId, runId)}/answer`, petPlanResponseSchema, body);
export const revise = (
  workspaceId: string,
  runId: string,
  body: PetPlanRevision,
): CommandEndpoint<PetPlanResponse> =>
  command('revise', `${path(workspaceId, runId)}/drafts`, petPlanResponseSchema, body);
export const decide = (
  workspaceId: string,
  runId: string,
  planId: string,
  body: PetPlanDecision,
): CommandEndpoint<PetPlanResponse> =>
  command(
    'decide',
    `${path(workspaceId, runId)}/plans/${encodeURIComponent(planId)}/decision`,
    petPlanResponseSchema,
    body,
  );
export const decideSharing = (
  workspaceId: string,
  runId: string,
  body: PetPlanSharingDecision,
): CommandEndpoint<PetPlanResponse> =>
  command(
    'decideSharing',
    `${path(workspaceId, runId)}/sharing/decision`,
    petPlanResponseSchema,
    body,
  );
export const cancel = (
  workspaceId: string,
  runId: string,
  body: { expectedRunRevision: number; requestId: string },
): CommandEndpoint<PetPlanResponse> =>
  command('cancel', `${path(workspaceId, runId)}/cancel`, petPlanResponseSchema, body);
export const undo = (
  workspaceId: string,
  runId: string,
  planId: string,
  stepId: string,
  body: { expectedRunRevision: number; requestId: string },
): CommandEndpoint<PetPlanResponse> =>
  command(
    'undo',
    `${path(workspaceId, runId)}/plans/${encodeURIComponent(planId)}/steps/${encodeURIComponent(stepId)}/undo`,
    petPlanResponseSchema,
    body,
  );
export const createDecisionHandoff = (
  workspaceId: string,
  runId: string,
  body: PetPlanDecisionHandoffRequest,
): CommandEndpoint<z.infer<typeof handoffSchema>> =>
  command(
    'createDecisionHandoff',
    `${path(workspaceId, runId)}/decision-handoffs`,
    handoffSchema,
    body,
  );
export const handoffStatus = (
  workspaceId: string,
  runId: string,
  handoffId: string,
): QueryEndpoint<PetPlanDecisionHandoffStatus> =>
  defineQuery({
    operation: 'petPlans.handoffStatus',
    path: `${path(workspaceId, runId)}/decision-handoffs/${encodeURIComponent(handoffId)}`,
    schema: handoffStatusSchema,
    retain: false,
  });
export const getDecisionHandoff = handoffStatus;
export const createDecisionContext = (
  workspaceId: string,
  runId: string,
  body: PetPlanDecisionContextRequest,
): CommandEndpoint<PetPlanDecisionHandoffStatus> =>
  command(
    'createDecisionContext',
    `${path(workspaceId, runId)}/decision-contexts`,
    handoffStatusSchema,
    body,
  );
export const revokeHandoff = (
  workspaceId: string,
  runId: string,
  handoffId: string,
): CommandEndpoint<PetPlanDecisionHandoffStatus> =>
  defineCommand({
    operation: 'petPlans.revokeHandoff',
    method: 'DELETE',
    path: `${path(workspaceId, runId)}/decision-handoffs/${encodeURIComponent(handoffId)}`,
    schema: handoffStatusSchema,
    invalidates: [cacheKey],
  });
export const sharingQuestion = (
  workspaceId: string,
  body: { petId: string; sourceScope: PetPlanSourceScope; forDecision?: boolean },
): CommandEndpoint<{ question: PetPlanSharingQuestion | null }> =>
  command(
    'sharingQuestion',
    `/api/v1/workspaces/${encodeURIComponent(workspaceId)}/pet-sharing/question`,
    z.object({ question: sharingQuestionSchema.nullable() }),
    body,
  );
export const sharingDecision = (
  workspaceId: string,
  body: {
    petId: string;
    sourceScope: PetPlanSourceScope;
    recipientRevision: string;
    scopeDigest: string;
    approve: boolean;
    requestId: string;
    decisionNonce: string;
  },
): CommandEndpoint<{ question: PetPlanSharingQuestion | null }> =>
  command(
    'sharingDecision',
    `/api/v1/workspaces/${encodeURIComponent(workspaceId)}/pet-sharing/decision`,
    z.object({ question: sharingQuestionSchema.nullable() }),
    body,
  );

export const claim = (
  workspaceId: string,
  runId: string,
  planId: string,
  stepId: string,
  body: {
    expectedRunRevision: number;
    planVersion: number;
    reviewDigest: string;
    requestId: string;
    runnerContextId: string;
  },
): CommandEndpoint<PetPlanStepClaim> =>
  command(
    'claim',
    `${path(workspaceId, runId)}/plans/${encodeURIComponent(planId)}/steps/${encodeURIComponent(stepId)}/claim`,
    stepClaimSchema,
    body,
  );
export const nextClientIntent = (
  workspaceId: string,
  runId: string,
): QueryEndpoint<PetPlanClientIntent | null> =>
  defineQuery({
    operation: 'petPlans.nextClientIntent',
    path: `${path(workspaceId, runId)}/io`,
    schema: clientIntentSchema.nullable(),
    retain: false,
  });
export const recordClientIoResult = (
  workspaceId: string,
  runId: string,
  body: {
    requestId: string;
    status: number;
    headers: Readonly<Record<string, string>>;
    body: string;
  },
): CommandEndpoint<{ recorded: boolean }> =>
  command(
    'recordClientIoResult',
    `${path(workspaceId, runId)}/io/result`,
    z.object({ recorded: z.boolean() }),
    body,
  );
export const recordStepResult = (
  workspaceId: string,
  runId: string,
  planId: string,
  stepId: string,
  body: {
    planVersion: number;
    reviewDigest: string;
    claimId: string;
    executionId: string;
    status: string;
    receipt?: string;
  },
): CommandEndpoint<PetPlanResponse> =>
  command(
    'recordStepResult',
    `${path(workspaceId, runId)}/plans/${encodeURIComponent(planId)}/steps/${encodeURIComponent(stepId)}/result`,
    petPlanResponseSchema,
    body,
  );
