import { describe, expect, it } from 'vitest';

import {
  create,
  dryRun,
  get,
  list,
  petRoutineRuleInputSchema,
  remove,
  run,
  runs,
  update,
} from './automations.js';
import {
  automationRuleResponseSchema,
  automationRunResponseSchema,
  automationTestResponseSchema,
} from '../schemas/automations.js';

const WORKSPACE = '22222222-2222-4222-8222-222222222222';
const RULE = '33333333-3333-4333-8333-333333333333';
const ITEM = '11111111-1111-4111-8111-111111111111';

const input = {
  name: 'Morning review',
  enabled: true,
  scopeItemId: null,
  trigger: { type: 'schedule', freq: 'daily', interval: 1, time: '08:00' },
  conditions: [],
  actions: [{ type: 'notify', title: 'Review {date}' }],
};

const petAction = {
  type: 'start_pet_run',
  brief: 'Review the issue summary for the next meeting.',
  sourceItemIds: [RULE],
  abilities: ['nix.action'],
};

const petRoutine = {
  ...input,
  scopeItemId: ITEM,
  actions: [petAction],
};

describe('the automations resource', () => {
  it('list reads the caller own rules for one workspace', () => {
    expect(list(WORKSPACE)).toMatchObject({
      kind: 'query',
      path: `/api/v1/workspaces/${WORKSPACE}/automations`,
    });
  });

  it('create POSTs the rule document to the workspace collection', () => {
    expect(create(WORKSPACE, input)).toMatchObject({
      kind: 'command',
      method: 'POST',
      path: `/api/v1/workspaces/${WORKSPACE}/automations`,
      body: input,
    });
  });

  it('get and remove address one rule', () => {
    expect(get(RULE)).toMatchObject({ kind: 'query', path: `/api/v1/automations/${RULE}` });
    expect(remove(RULE)).toMatchObject({
      kind: 'command',
      method: 'DELETE',
      path: `/api/v1/automations/${RULE}`,
    });
  });

  it('update PUTs the whole rule behind the expected revision', () => {
    expect(update(RULE, 4, input)).toMatchObject({
      method: 'PUT',
      path: `/api/v1/automations/${RULE}`,
      body: { expectedRevision: 4, rule: input },
    });
  });

  it('runs pages with an opaque cursor only when one is given', () => {
    expect(runs(RULE).query).not.toHaveProperty('cursor');
    expect(runs(RULE, 'c1')).toMatchObject({
      path: `/api/v1/automations/${RULE}/runs`,
      query: { cursor: 'c1' },
    });
  });

  it('run and test POST the optional triggering item, null when absent', () => {
    expect(run(RULE)).toMatchObject({
      method: 'POST',
      path: `/api/v1/automations/${RULE}/run`,
      body: { itemId: null },
    });
    expect(dryRun(RULE, ITEM)).toMatchObject({
      method: 'POST',
      path: `/api/v1/automations/${RULE}/test`,
      body: { itemId: ITEM },
    });
  });
});

describe('the automation schemas', () => {
  it('authors a scheduled pet run with review by default and preserves an explicit title pair', () => {
    const rule = petRoutineRuleInputSchema.parse(petRoutine);
    expect(create(WORKSPACE, rule).body).toEqual(petRoutine);

    const autoRename = { from: ' Issue summary', to: 'Reviewed issue summary ' };
    const renameRoutine = {
      ...petRoutine,
      actions: [{ ...petAction, abilities: [...petAction.abilities, 'task.rename'], autoRename }],
    };
    expect(petRoutineRuleInputSchema.parse(renameRoutine)).toEqual(renameRoutine);
  });

  it.each([
    { ...petRoutine, scopeItemId: null },
    { ...petRoutine, trigger: { type: 'property_changed', key: 'status' } },
    { ...petRoutine, conditions: [{ key: 'status', operator: 'equals', value: 'ready' }] },
    { ...petRoutine, actions: [petAction, ...input.actions] },
    { ...petRoutine, actions: [{ ...petAction, sourceItemIds: Array(25).fill(RULE) }] },
    { ...petRoutine, actions: [{ ...petAction, abilities: Array(33).fill('nix.action') }] },
    { ...petRoutine, actions: [{ ...petAction, sourceItemIds: [RULE, RULE] }] },
    { ...petRoutine, actions: [{ ...petAction, abilities: ['nix.action', 'nix.action'] }] },
    { ...petRoutine, actions: [{ ...petAction, abilities: ['nix.action\n'] }] },
    { ...petRoutine, actions: [{ ...petAction, brief: '界'.repeat(2_667) }] },
    { ...petRoutine, actions: [{ ...petAction, autoRename: { to: 'Reviewed' } }] },
    { ...petRoutine, actions: [{ ...petAction, autoRename: { from: 'Title', to: 'Reviewed' } }] },
    {
      ...petRoutine,
      actions: [
        { ...petAction, abilities: ['task.rename'], autoRename: { from: 'Title', to: 'Title' } },
      ],
    },
  ])('rejects a malformed pet routine %#', (draft) => {
    expect(petRoutineRuleInputSchema.safeParse(draft).success).toBe(false);
  });

  it('accept an unknown run status and reason so new Core codes still parse', () => {
    const parsed = automationRunResponseSchema.parse({
      id: RULE,
      ruleId: RULE,
      itemId: null,
      origin: 'manual',
      depth: 0,
      status: 'some_future_status',
      reason: 'some_future_reason',
      createdAt: '2026-09-30T12:00:00Z',
    });
    expect(parsed.status).toBe('some_future_status');
  });

  it('parse a rule response with its JSON trigger, conditions and actions untouched', () => {
    const parsed = automationRuleResponseSchema.parse({
      id: RULE,
      workspaceId: WORKSPACE,
      name: 'Morning review',
      enabled: false,
      scopeItemId: null,
      trigger: input.trigger,
      conditions: [],
      actions: input.actions,
      revision: 2,
      consecutiveFailures: 5,
      disabledReason: 'repeated_failures',
      lastRunAt: null,
      createdAt: '2026-09-30T12:00:00Z',
      updatedAt: '2026-09-30T12:00:00Z',
    });
    expect(parsed.trigger).toEqual(input.trigger);
    expect(parsed.disabledReason).toBe('repeated_failures');
  });

  it('parse a dry run with its rendered action previews', () => {
    const parsed = automationTestResponseSchema.parse({
      wouldRun: true,
      reason: null,
      actions: [{ index: 0, type: 'notify', itemId: null, key: null, title: 'Review', body: '' }],
    });
    expect(parsed.actions[0]?.title).toBe('Review');
  });
});
