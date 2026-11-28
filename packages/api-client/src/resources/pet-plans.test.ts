import { describe, expect, it } from 'vitest';
import * as plans from './pet-plans.js';

describe('whole-plan operator contracts', () => {
  const identifier = '11111111-1111-4111-8111-111111111111';
  const responseWithStep = (receiptView?: unknown) => ({
    id: identifier,
    workspaceId: identifier,
    petId: identifier,
    brief: 'Read the result',
    sourceScope: { kind: 'selected', itemIds: [] },
    status: 'review_required',
    revision: 4,
    results: [],
    createdAt: '2026-11-25T10:00:00Z',
    updatedAt: '2026-11-25T10:00:00Z',
    plan: {
      id: identifier,
      version: 1,
      summary: 'Read',
      reviewDigest: 'review',
      scopeDigest: 'scope',
      recipientRevision: 'recipient',
      status: 'review_required',
      steps: [
        {
          id: identifier,
          capability: 'workspace.read_note',
          arguments: {},
          effect: { description: 'Read the note', parameters: {} },
          executor: 'server',
          status: 'partial',
          fields: [],
          receipt: '{"legacy":"literal text"}',
          ...(receiptView === undefined ? {} : { receiptView }),
        },
      ],
    },
  });

  it('preserves typed receipt details and complete literal text without renderer inference', () => {
    const text = '{"literal":"JSON remains text"}\n' + 'Full text. '.repeat(500);
    const receiptView = {
      summary: 'Read part of the note',
      details: { empty: [], group: {}, value: null, zero: 0, no: false, text: '' },
      text,
    };
    const parsed = plans.petPlanResponseSchema.parse(
      responseWithStep({ ...receiptView, renderer: 'untrusted-program' }),
    );
    expect(parsed.plan?.steps[0]).toMatchObject({ status: 'partial', receiptView });
    expect(parsed.plan?.steps[0]).not.toHaveProperty('receiptView.renderer');
  });

  it('keeps legacy receipt text unchanged and never derives a typed view by parsing it', () => {
    const parsed = plans.petPlanResponseSchema.parse(responseWithStep());
    expect(parsed.plan?.steps[0]?.receipt).toBe('{"legacy":"literal text"}');
    expect(parsed.plan?.steps[0]).not.toHaveProperty('receiptView');
  });

  it('preserves complete read-only discovery observations without execution controls', () => {
    const observation = {
      id: identifier,
      capability: 'workspace.read_note',
      description: 'Read the project brief',
      receiptView: {
        summary: 'Read the complete note',
        details: {
          title: 'Project brief',
          body: 'Full content. '.repeat(500),
          ready: false,
          missing: null,
        },
        text: null,
      },
    };
    const parsed = plans.petPlanResponseSchema.parse({
      ...responseWithStep(),
      observations: [{ ...observation, execute: 'untrusted-action' }],
    });
    expect(parsed).toMatchObject({ observations: [observation] });
    expect(parsed).not.toHaveProperty('observations.0.execute');
  });

  it.each([null, { summary: 'No extra detail', details: null, text: null }])(
    'preserves a nullable receipt view and nullable detail fields',
    (receiptView) => {
      const parsed = plans.petPlanResponseSchema.parse(responseWithStep(receiptView));
      expect(parsed.plan?.steps[0]?.receiptView).toEqual(receiptView);
    },
  );

  it('binds a decision to the exact review and keeps it out of query caching', () => {
    const decision = {
      expectedRunRevision: 4,
      planVersion: 2,
      reviewDigest: 'digest',
      approve: true,
      requestId: 'request',
      decisionContext: 'private',
    };
    expect(plans.decide('workspace', 'run', 'plan', decision)).toMatchObject({
      kind: 'command',
      method: 'POST',
      path: '/api/v1/workspaces/workspace/pet-plans/run/plans/plan/decision',
      body: decision,
    });
    expect(plans.read('workspace', 'run').retain).toBe(false);
    expect(plans.handoffStatus('workspace', 'run', 'handoff').retain).toBe(false);
  });

  it('revokes a handoff with DELETE', () => {
    expect(plans.revokeHandoff('workspace', 'run', 'handoff').method).toBe('DELETE');
  });
});
