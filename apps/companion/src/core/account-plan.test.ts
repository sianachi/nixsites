import { describe, expect, it, vi } from 'vitest';
import { randomUUID } from 'node:crypto';
import { eventually, harness, IDS, keyOf, request } from '../testing/testing.ts';

const binding = {
  toolId: 'call-one',
  runId: IDS.other,
  planId: IDS.request,
  planVersion: 1,
  reviewDigest: 'saved-review',
  stepId: IDS.item,
};

async function planned() {
  const app = harness();
  const start = request({
    consentMode: 'plan',
    workspaceAccess: true,
    sharingAttestation: 'private-proof',
  });
  await app.account.handle(app.signal, start);
  expect(
    app.transport.toolCall(1, 'call-one', 'nix_rename_item', {
      itemId: IDS.item,
      title: 'Release brief',
    }),
  ).toBe(true);
  const rpc = (operation: string, payload: unknown) =>
    app.account.handlePlanTools({ ...start, operation, planPayload: JSON.stringify(payload) });
  return { ...app, start, rpc };
}

describe('authoritative direct-chat plan adoption', () => {
  it('holds writes and denies legacy claims before and after an exact adoption', async () => {
    const app = await planned();
    expect(app.account.snapshot(keyOf(app.start)).tools[0]?.status).toBe('planned');
    await expect(
      app.account.handle(app.signal, { ...app.start, operation: 'tool_claim', toolId: 'call-one' }),
    ).rejects.toThrow('reviewed plan');
    const inspected = await app.rpc('plan_tools_inspect', { toolIds: ['call-one'] });
    expect(inspected).toMatchObject({
      turnId: app.start.requestId,
      lockedRead: false,
      tools: [{ id: 'call-one', status: 'planned' }],
    });
    expect(JSON.stringify(inspected)).toContain('Release brief');
    expect(JSON.stringify(inspected)).not.toContain('private-proof');
    await expect(app.rpc('plan_tools_adopt', { bindings: [binding] })).resolves.toEqual({
      adopted: true,
    });
    await expect(app.rpc('plan_tools_adopt', { bindings: [binding] })).resolves.toEqual({
      adopted: true,
    });
    await expect(
      app.account.handle(app.signal, { ...app.start, operation: 'tool_claim', toolId: 'call-one' }),
    ).rejects.toThrow('reviewed plan');
    expect(app.transport.replies).toHaveLength(0);
    await expect(
      app.rpc('plan_tools_adopt', { bindings: [{ ...binding, planVersion: 2 }] }),
    ).rejects.toThrow();
  });

  it('resolves an exact Core receipt once and refuses changed terminal results', async () => {
    const app = await planned();
    await app.rpc('plan_tools_adopt', { bindings: [binding] });
    const payload = {
      binding,
      success: true,
      result: 'Renamed Release brief.',
      lockedContent: true,
    };
    await expect(app.rpc('plan_tools_resolve', payload)).resolves.toEqual({ resolved: true });
    await expect(app.rpc('plan_tools_resolve', payload)).resolves.toEqual({ resolved: true });
    expect(app.transport.replies).toHaveLength(1);
    expect(app.account.snapshot(keyOf(app.start)).lockedRead).toBe(true);
    await expect(
      app.rpc('plan_tools_resolve', { ...payload, result: 'A different outcome' }),
    ).rejects.toThrow('receipt changed');
  });

  it.each([undefined, () => Promise.resolve(false), () => Promise.resolve(true)])(
    'fails closed before provider dispatch without an active validator %#',
    async (validateSharing) => {
      const app = harness({ validateSharing });
      await expect(
        app.account.handle(app.signal, request({ operation: 'send', consentMode: 'plan' })),
      ).rejects.toThrow('could not be verified for sending');
      expect(app.transport.methods()).not.toContain('turn/start');
      expect(app.transport.methods()).not.toContain('thread/start');
    },
  );

  it('validates later results using the original turn identity and proof', async () => {
    const validator = vi
      .fn()
      .mockResolvedValue({ allowed: true, recipientRevision: 'synthetic-recipient' });
    const app = harness({ validateSharing: validator });
    const start = request({ workspaceAccess: true, sharingAttestation: 'original-proof' });
    await app.account.handle(app.signal, start);
    app.transport.toolCall(1, 'read-one', 'nix_read_item', { itemId: IDS.item });
    await app.account.handle(app.signal, {
      ...start,
      operation: 'tool_claim',
      toolId: 'read-one',
      requestId: IDS.other,
    });
    await app.account.handle(app.signal, {
      ...start,
      operation: 'tool_result',
      toolId: 'read-one',
      requestId: IDS.other,
      sharingAttestation: 'replacement-proof',
      toolResult: 'Read result',
      toolSuccess: true,
    });
    expect(validator.mock.lastCall?.[0]).toMatchObject({
      turnId: start.requestId,
      attestation: 'original-proof',
    });
  });
});

it('pins recipient revision for one turn and refuses a changed revision before another disclosure', async () => {
  let revision = 'recipient-one';
  const app = harness({
    validateSharing: () => Promise.resolve({ allowed: true, recipientRevision: revision }),
  });
  const start = request({ sharingAttestation: 'private-proof' });
  expect(await app.account.canDisclose(start)).toBe(true);
  revision = 'recipient-two';
  expect(await app.account.canDisclose(start)).toBe(false);
  expect(await app.account.canDisclose({ ...start, requestId: IDS.other })).toBe(true);
  expect(JSON.stringify(app.account.snapshot(keyOf(start)))).not.toContain('recipient-one');
});

it('supersedes an adopted call only through an exact previous-to-next Core association', async () => {
  const app = await planned();
  await app.rpc('plan_tools_adopt', { bindings: [binding] });
  const originalArguments = app.account.snapshot(keyOf(app.start)).tools[0]?.arguments;
  const next = { ...binding, planVersion: 2, reviewDigest: 'new-review', stepId: IDS.other };
  const value = {
    bindings: [
      {
        previous: binding,
        next,
      },
    ],
  };
  await expect(app.rpc('plan_tools_supersede', value)).resolves.toEqual({ superseded: true });
  await expect(app.rpc('plan_tools_supersede', value)).resolves.toEqual({ superseded: true });
  expect(app.account.snapshot(keyOf(app.start)).tools[0]).toMatchObject({
    status: 'adopted',
    planBinding: next,
    arguments: originalArguments,
  });
  await expect(
    app.rpc('plan_tools_resolve', {
      binding,
      success: true,
      result: 'Old outcome',
      lockedContent: false,
    }),
  ).rejects.toThrow('does not match');
  expect(app.transport.replies).toHaveLength(0);
});

it('cancels an unadopted batch locally and interrupts without a disclosure decision', async () => {
  let allowed = true;
  const app = harness({
    validateSharing: () => Promise.resolve({ allowed, recipientRevision: 'synthetic-recipient' }),
  });
  const start = request({
    consentMode: 'plan',
    workspaceAccess: true,
    sharingAttestation: 'private-proof',
  });
  await app.account.handle(app.signal, start);
  app.transport.toolCall(1, 'call-one', 'nix_rename_item', {
    itemId: IDS.item,
    title: 'Release brief',
  });
  allowed = false;
  const cancel = {
    ...start,
    operation: 'plan_tools_cancel',
    planPayload: JSON.stringify({ toolIds: ['call-one'], runId: IDS.other }),
  };
  await expect(app.account.handlePlanTools(cancel)).resolves.toEqual({ cancelled: true });
  await expect(app.account.handlePlanTools(cancel)).resolves.toEqual({ cancelled: true });
  expect(app.account.snapshot(keyOf(start)).tools[0]?.status).toBe('failed');
  expect(app.transport.methods()).toContain('turn/interrupt');
  expect(app.transport.replies).toHaveLength(0);
});

it('rechecks the adopted version after asynchronous disclosure validation', async () => {
  let blocked = false;
  let entered = false;
  let release: (() => void) | undefined;
  const barrier = new Promise<void>((resolve) => {
    release = resolve;
  });
  const app = harness({
    validateSharing: async () => {
      if (blocked) {
        entered = true;
        await barrier;
      }
      return { allowed: true, recipientRevision: 'synthetic-recipient' };
    },
  });
  const start = request({ consentMode: 'plan', workspaceAccess: true });
  await app.account.handle(app.signal, start);
  app.transport.toolCall(1, 'call-one', 'nix_rename_item', {
    itemId: IDS.item,
    title: 'Release brief',
  });
  const rpc = (operation: string, payload: unknown) =>
    app.account.handlePlanTools({ ...start, operation, planPayload: JSON.stringify(payload) });
  await rpc('plan_tools_adopt', { bindings: [binding] });
  blocked = true;
  const resolving = rpc('plan_tools_resolve', {
    binding,
    success: true,
    result: 'Old receipt',
    lockedContent: false,
  });
  expect(entered).toBe(true);
  await rpc('plan_tools_supersede', {
    bindings: [
      { previous: binding, next: { ...binding, planVersion: 2, reviewDigest: 'new-digest' } },
    ],
  });
  release?.();
  await expect(resolving).rejects.toThrow('plan changed');
  expect(app.transport.replies).toHaveLength(0);
});

it('does not replay a cached receipt after its turn ends during sharing validation', async () => {
  let blocked = false;
  let release: (() => void) | undefined;
  const barrier = new Promise<void>((resolve) => {
    release = resolve;
  });
  const app = harness({
    validateSharing: async () => {
      if (blocked) await barrier;
      return { allowed: true, recipientRevision: 'synthetic-recipient' };
    },
  });
  const start = request({ workspaceAccess: true });
  await app.account.handle(app.signal, start);
  app.transport.toolCall(1, 'read-one', 'nix_read_item', { itemId: IDS.item });
  await app.account.handle(app.signal, { ...start, operation: 'tool_claim', toolId: 'read-one' });
  await app.account.handle(app.signal, {
    ...start,
    operation: 'tool_result',
    toolId: 'read-one',
    toolSuccess: true,
    toolResult: 'Private receipt',
  });
  blocked = true;
  app.transport.toolCall(2, 'read-two', 'nix_read_item', { itemId: IDS.item });
  app.notify('turn/completed', { threadId: 'provider-thread', turn: { status: 'completed' } });
  release?.();
  await eventually(() => app.transport.replies.length === 2);
  expect(JSON.stringify(app.transport.replies[1])).not.toContain('Private receipt');
});

it('exposes the original note scope with a planned batch', async () => {
  const app = harness();
  const start = request({ consentMode: 'plan', workspaceAccess: true, rootItemId: IDS.item });
  await app.account.handle(app.signal, start);
  app.transport.toolCall(1, 'call-one', 'nix_rename_item', {
    itemId: IDS.item,
    title: 'Release brief',
  });
  expect(app.account.snapshot(keyOf(start)).plannedBatch).toMatchObject({
    scope: { rootItemId: IDS.item, readOnly: false },
  });
});

it('makes a complete deduplicated read batch ready without registering or executing it twice', async () => {
  const app = harness();
  const start = request({ consentMode: 'plan', workspaceAccess: true, readWithoutAsking: true });
  await app.account.handle(app.signal, start);
  const params = {
    threadId: 'provider-thread',
    tool: 'nix_read_item',
    callId: 'read-one',
    arguments: { itemId: IDS.item },
    planBatchId: 'batch-one',
    planBatchSize: 2,
  };
  expect(app.account.toolRequest(1, 'item/tool/call', params, 100)).toBe(true);
  expect(app.account.snapshot(keyOf(start)).plannedBatch?.ready).toBe(false);
  expect(app.account.toolRequest(2, 'item/tool/call', { ...params, callId: 'read-two' }, 100)).toBe(
    true,
  );
  expect(app.account.snapshot(keyOf(start)).plannedBatch).toMatchObject({
    ready: true,
    toolIds: ['read-one'],
  });
  expect(app.transport.replies).toHaveLength(0);
});

it.each([{ itemIds: [IDS.item] }, { itemIds: [] }])(
  'inspects the original validated selected scope even after transient metadata eviction: %j',
  async ({ itemIds }) => {
    const app = harness({
      validateSharing: () =>
        Promise.resolve({
          allowed: true,
          recipientRevision: 'synthetic-recipient',
          sourceScope: { kind: 'selected', itemIds },
        }),
    });
    const start = request({ consentMode: 'plan', workspaceAccess: true });
    await app.account.handle(app.signal, start);
    app.transport.toolCall(1, 'read-one', 'nix_list_items', {});
    for (let index = 0; index < 130; index++)
      await app.account.canDisclose({ ...start, requestId: randomUUID() });
    await expect(
      app.account.handlePlanTools({
        ...start,
        workspaceAccess: true,
        operation: 'plan_tools_inspect',
        planPayload: JSON.stringify({ toolIds: ['read-one'] }),
      }),
    ).resolves.toMatchObject({ sourceScope: { kind: 'selected', itemIds }, rootItemId: '' });
  },
);
