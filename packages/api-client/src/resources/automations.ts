import {
  defineCommand,
  defineQuery,
  type CommandEndpoint,
  type QueryEndpoint,
} from '../endpoints.js';
import type { components } from '../generated/api.js';
import { noContentSchema } from '../schemas/index.js';
import {
  automationListResponseSchema,
  automationRuleResponseSchema,
  automationRunResponseSchema,
  automationRunsPageResponseSchema,
  automationTestResponseSchema,
  type AutomationListResponse,
  type AutomationRuleInput,
  type AutomationRuleResponse,
  type AutomationRunResponse,
  type AutomationRunsPageResponse,
  type AutomationTestResponse,
} from '../schemas/automations.js';

export { petRoutineRuleInputSchema, type PetRoutineRuleInput } from '../schemas/automations.js';

const workspaceRulesPath = (workspaceId: string) =>
  `/api/v1/workspaces/${encodeURIComponent(workspaceId)}/automations`;
const rulePath = (ruleId: string) => `/api/v1/automations/${encodeURIComponent(ruleId)}`;
const automationsKey = ['automations'] as const;
const workspaceKey = (workspaceId: string) =>
  [...automationsKey, 'workspace', workspaceId] as const;
const ruleKey = (ruleId: string) => [...automationsKey, 'rule', ruleId] as const;

/** The caller's own rules in one workspace; other members' rules are never visible. */
export const list = (workspaceId: string): QueryEndpoint<AutomationListResponse> =>
  defineQuery({
    operation: 'automations.list',
    path: workspaceRulesPath(workspaceId),
    schema: automationListResponseSchema,
    cacheKey: workspaceKey(workspaceId),
  });

export const get = (ruleId: string): QueryEndpoint<AutomationRuleResponse> =>
  defineQuery({
    operation: 'automations.get',
    path: rulePath(ruleId),
    schema: automationRuleResponseSchema,
    cacheKey: ruleKey(ruleId),
  });

export const create = (
  workspaceId: string,
  rule: AutomationRuleInput,
): CommandEndpoint<AutomationRuleResponse> =>
  defineCommand({
    operation: 'automations.create',
    method: 'POST',
    path: workspaceRulesPath(workspaceId),
    schema: automationRuleResponseSchema,
    body: rule satisfies components['schemas']['AutomationRuleInput'],
    invalidates: [automationsKey],
  });

/** Replaces the whole rule; Core refuses a stale `expectedRevision` with `automation.conflict`. */
export const update = (
  ruleId: string,
  expectedRevision: number,
  rule: AutomationRuleInput,
): CommandEndpoint<AutomationRuleResponse> =>
  defineCommand({
    operation: 'automations.update',
    method: 'PUT',
    path: rulePath(ruleId),
    schema: automationRuleResponseSchema,
    body: { expectedRevision, rule } satisfies components['schemas']['UpdateAutomationRequest'],
    invalidates: [automationsKey],
  });

export const remove = (ruleId: string): CommandEndpoint<undefined> =>
  defineCommand({
    operation: 'automations.remove',
    method: 'DELETE',
    path: rulePath(ruleId),
    schema: noContentSchema,
    invalidates: [automationsKey],
  });

/** One page of the rule's run log, newest first. */
export const runs = (ruleId: string, cursor?: string): QueryEndpoint<AutomationRunsPageResponse> =>
  defineQuery({
    operation: 'automations.runs',
    path: `${rulePath(ruleId)}/runs`,
    schema: automationRunsPageResponseSchema,
    query: cursor ? { cursor } : {},
    cacheKey: [...ruleKey(ruleId), 'runs', cursor ?? ''],
  });

/** Runs the rule now as its owner; the result is the recorded run. */
export const run = (
  ruleId: string,
  itemId?: string | null,
): CommandEndpoint<AutomationRunResponse> =>
  defineCommand({
    operation: 'automations.run',
    method: 'POST',
    path: `${rulePath(ruleId)}/run`,
    schema: automationRunResponseSchema,
    body: { itemId: itemId ?? null } satisfies components['schemas']['AutomationItemRequest'],
    invalidates: [ruleKey(ruleId)],
  });

/** A dry run: what the rule would do now, with rendered previews; writes nothing. */
export const dryRun = (
  ruleId: string,
  itemId?: string | null,
): CommandEndpoint<AutomationTestResponse> =>
  defineCommand({
    operation: 'automations.dryRun',
    method: 'POST',
    path: `${rulePath(ruleId)}/test`,
    schema: automationTestResponseSchema,
    body: { itemId: itemId ?? null } satisfies components['schemas']['AutomationItemRequest'],
  });
