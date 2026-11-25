import { describe, expect, it, vi } from 'vitest';
import { writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { completed, harness, IDS, keyOf, request } from '../testing/testing.ts';
import type { SharingValidation } from '../shared/types.ts';

describe('cached provider context disclosure', () => {
  it.each(['interrupt', 'replacement'] as const)(
    'does not forward a held receipt after %s',
    async (stop) => {
      let hold = false;
      let entered = false;
      let release: (() => void) | undefined;
      const barrier = new Promise<void>((resolve) => {
        release = resolve;
      });
      const app = harness({
        validateSharing: async () => {
          if (hold) {
            entered = true;
            await barrier;
          }
          return {
            allowed: true,
            recipientRevision: 'recipient-one',
            sourceScope: { kind: 'workspace', itemIds: [] },
          };
        },
      });
      const start = request({ consentMode: 'plan', workspaceAccess: true });
      await app.account.handle(app.signal, start);
      app.transport.toolCall(1, 'read-one', 'nix_read_item', { itemId: IDS.item });
      const binding = {
        toolId: 'read-one',
        runId: IDS.item,
        planId: IDS.request,
        planVersion: 1,
        reviewDigest: 'saved-proof',
        stepId: IDS.other,
      };
      const rpc = (operation: string, payload: unknown) =>
        app.account.handlePlanTools({ ...start, operation, planPayload: JSON.stringify(payload) });
      await rpc('plan_tools_adopt', { bindings: [binding] });
      const original = app.account.conversations.get(keyOf(start));
      hold = true;
      const resolving = rpc('plan_tools_resolve', {
        binding,
        success: true,
        result: 'Trusted receipt',
        lockedContent: false,
        sourceItemIds: [IDS.item],
        unboundedSourceProvenance: false,
      });
      expect(entered).toBe(true);
      await app.account.handle(app.signal, { ...start, operation: 'interrupt' });
      if (stop === 'replacement') {
        app.notify('turn/completed', {
          threadId: 'provider-thread',
          turn: { status: 'interrupted' },
        });
        await app.account.handle(app.signal, { ...start, operation: 'reset' });
      }
      release?.();
      await expect(resolving).resolves.toEqual({ resolved: true });
      expect(app.transport.replies).toHaveLength(0);
      expect(original?.tools[0]).toMatchObject({ status: 'completed', result: 'Trusted receipt' });
    },
  );

  it.each(['refused', 'validator-failed'] as const)(
    'cleans up a %s final disclosure check before provider start',
    async (failure) => {
      let checks = 0;
      const app = harness({
        validateSharing: () => {
          checks += 1;
          if (checks > 1 && failure === 'validator-failed')
            return Promise.reject(new Error('Synthetic validator failure'));
          return Promise.resolve({
            allowed: checks === 1,
            recipientRevision: 'recipient-one',
            sourceScope: { kind: 'workspace', itemIds: [] },
          });
        },
      });
      const start = request({ turnToken: 'synthetic-read-token' });
      await expect(app.account.handle(app.signal, start)).rejects.toThrow();
      expect(app.account.snapshot(keyOf(start)).state).toBe('error');
      expect(app.account.snapshot(keyOf(start)).reason).toContain('new conversation');
      expect(app.account.conversations.get(keyOf(start))?.actor.turnToken).toBe('');
      expect(app.account.conversations.get(keyOf(start))?.turnId).toBe('');
      expect(app.transport.methods()).not.toContain('turn/start');
      expect((await app.account.handle(app.signal, start)).state).toBe('error');
      await expect(
        app.account.handle(app.signal, { ...start, requestId: IDS.other }),
      ).rejects.toThrow('new conversation');
    },
  );

  it('keeps a refused disclosure terminal and recoverable without forwarding its trusted receipt', async () => {
    let allowed = true;
    const app = harness({
      validateSharing: () =>
        Promise.resolve({
          allowed,
          recipientRevision: 'recipient-one',
          sourceScope: { kind: 'workspace', itemIds: [] },
        }),
    });
    const start = request({ consentMode: 'plan', workspaceAccess: true });
    await app.account.handle(app.signal, start);
    app.transport.toolCall(1, 'read-one', 'nix_read_item', { itemId: IDS.other });
    app.transport.toolCall(2, 'read-two', 'nix_read_note', { itemId: IDS.item });
    const binding = {
      toolId: 'read-one',
      runId: IDS.item,
      planId: IDS.request,
      planVersion: 1,
      reviewDigest: 'saved-proof',
      stepId: IDS.other,
    };
    const rpc = (operation: string, payload: unknown) =>
      app.account.handlePlanTools({ ...start, operation, planPayload: JSON.stringify(payload) });
    const secondBinding = { ...binding, toolId: 'read-two', stepId: IDS.item };
    await rpc('plan_tools_adopt', { bindings: [binding, secondBinding] });
    allowed = false;
    const receipt = {
      binding,
      success: true,
      result: 'Trusted private receipt',
      lockedContent: false,
      sourceItemIds: [IDS.other],
      unboundedSourceProvenance: false,
    };
    await expect(rpc('plan_tools_resolve', receipt)).resolves.toEqual({ resolved: true });
    await expect(
      rpc('plan_tools_resolve', {
        ...receipt,
        binding: secondBinding,
        result: 'Second saved receipt',
      }),
    ).resolves.toEqual({ resolved: true });
    await expect(rpc('plan_tools_resolve', receipt)).resolves.toEqual({ resolved: true });
    expect(app.transport.replies).toHaveLength(0);
    expect(app.transport.methods()).toContain('turn/interrupt');
    app.notify('turn/completed', { threadId: 'provider-thread', turn: { status: 'interrupted' } });
    expect(app.account.snapshot(keyOf(start))).toMatchObject({
      state: 'error',
      tools: [
        { status: 'completed', result: 'Trusted private receipt' },
        { status: 'completed', result: 'Second saved receipt' },
      ],
    });
    expect(app.account.snapshot(keyOf(start)).reason).toContain('new conversation');
    const restored = harness({ home: app.home });
    await expect(
      restored.account.handle(restored.signal, { ...start, requestId: IDS.other }),
    ).rejects.toThrow('new conversation');
    expect(restored.transport.calls).toEqual([]);
  });

  it('shows explicit recovery when the transport refuses a cached continuation', async () => {
    const app = harness();
    const start = request();
    await app.account.handle(app.signal, start);
    app.notify('turn/completed', {
      threadId: 'provider-thread',
      turn: {
        status: 'failed',
        error: { message: 'Private callback detail', nixProviderError: 'nix.sharing_blocked' },
      },
    });
    expect(app.account.snapshot(keyOf(start))).toMatchObject({
      state: 'error',
    });
    expect(app.account.snapshot(keyOf(start)).reason).toContain('new conversation');
    expect(app.account.snapshot(keyOf(start)).reason).not.toContain('Private callback detail');
  });

  it('continues a trusted plan read with verified sources, including after reload', async () => {
    for (const reload of [false, true]) {
      const validateSharing = vi.fn(() =>
        Promise.resolve({
          allowed: true,
          recipientRevision: 'recipient-one',
          sourceScope: { kind: 'workspace' as const, itemIds: [], readOnlyWorkspaceIds: [] },
        }),
      );
      const original = harness({ validateSharing });
      const start = request({
        consentMode: 'plan',
        workspaceAccess: true,
        readWithoutAsking: true,
      });
      await original.account.handle(original.signal, start);
      original.transport.toolCall(1, 'read-one', 'nix_read_item', { itemId: IDS.other });
      expect(original.account.snapshot(keyOf(start)).plannedBatch?.requiresReadDecision).toBe(
        false,
      );
      const binding = {
        toolId: 'read-one',
        runId: IDS.item,
        planId: IDS.request,
        planVersion: 1,
        reviewDigest: 'read-source-proof',
        stepId: IDS.other,
      };
      const rpc = (operation: string, payload: unknown) =>
        original.account.handlePlanTools({
          ...start,
          operation,
          planPayload: JSON.stringify(payload),
        });
      expect(await rpc('plan_tools_inspect', { toolIds: ['read-one'] })).toMatchObject({
        readWithoutAsking: true,
        tools: [{ status: 'planned' }],
      });
      await rpc('plan_tools_adopt', { bindings: [binding] });
      await rpc('plan_tools_resolve', {
        binding,
        success: true,
        result: 'Read content',
        lockedContent: false,
        sourceItemIds: [IDS.other],
        unboundedSourceProvenance: false,
      });
      original.transport.toolCall(2, 'write-after-read', 'nix_rename_item', {
        itemId: IDS.item,
        title: 'Reviewed title',
      });
      expect(await rpc('plan_tools_inspect', { toolIds: ['write-after-read'] })).toMatchObject({
        contextSourceItemIds: [IDS.other],
        contextProtected: false,
        contextUnbounded: false,
      });
      for (const [method, payload] of completed(undefined, 'Read confirmed'))
        original.notify(method, payload);
      const current = reload ? harness({ home: original.home, validateSharing }) : original;
      await current.account.handle(current.signal, {
        ...start,
        requestId: IDS.item,
        text: 'Follow up',
      });
      expect(current.transport.methods()).toContain('turn/start');
      expect(validateSharing).toHaveBeenLastCalledWith(
        expect.objectContaining({
          contextSourceItemIds: [IDS.other],
          contextUnbounded: false,
          priorRecipientRevision: 'recipient-one',
        }),
        expect.any(AbortSignal),
      );
    }
  });

  it('holds reads for a dedicated decision when the original preference is off and stops locally on decline', async () => {
    const app = harness();
    const start = request({ consentMode: 'plan', workspaceAccess: true, readWithoutAsking: false });
    await app.account.handle(app.signal, start);
    app.transport.toolCall(1, 'read-one', 'nix_read_item', { itemId: IDS.item });
    expect(app.account.snapshot(keyOf(start)).plannedBatch?.requiresReadDecision).toBe(true);
    await expect(
      app.account.handle(app.signal, { ...start, operation: 'tool_claim', toolId: 'read-one' }),
    ).rejects.toThrow('reviewed plan');
    await app.account.handle(app.signal, { ...start, operation: 'interrupt' });
    expect(app.account.snapshot(keyOf(start)).tools[0]?.status).toBe('interrupted');
    expect(app.transport.replies).toHaveLength(0);
    expect(app.transport.methods()).toContain('turn/interrupt');
  });

  it.each(['narrowed', 'withheld', 'recipient'] as const)(
    'refuses %s history before provider dispatch, including after reload',
    async (change) => {
      for (const reload of [false, true]) {
        for (const source of ['attached', 'workspace', 'note'] as const) {
          let changed = false;
          const validateSharing = vi.fn((input: SharingValidation) => {
            const previous = input.contextSourceItemIds ?? [];
            const priorRecipient = input.priorRecipientRevision;
            return Promise.resolve({
              allowed:
                !changed ||
                (change === 'recipient'
                  ? priorRecipient === undefined
                  : !previous.includes(IDS.other)),
              recipientRevision:
                changed && change === 'recipient' ? 'recipient-two' : 'recipient-one',
              sourceScope: {
                kind: 'selected' as const,
                itemIds: changed && change === 'narrowed' ? [IDS.item] : [IDS.item, IDS.other],
              },
            });
          });
          const original = harness({ validateSharing });
          const start = request({
            consentMode: 'plan',
            ...(source === 'workspace'
              ? {
                  workspaceAccess: true,
                  workspaceMap: [{ id: IDS.other, title: 'Private initial source', type: 'note' }],
                }
              : {
                  itemId: IDS.other,
                  itemTitle: 'Private initial source',
                  sharedText: 'Private initial source content',
                  items: [{ id: IDS.other, title: 'Private initial source' }],
                }),
            ...(source === 'note' ? { rootItemId: IDS.other } : {}),
          });
          await original.account.handle(original.signal, start);
          expect(JSON.stringify(original.transport.last('turn/start'))).toContain(
            'Private initial source',
          );
          for (const [method, payload] of completed(undefined, 'Private source content'))
            original.notify(method, payload);
          changed = true;
          const current = reload ? harness({ home: original.home, validateSharing }) : original;
          const before = current.transport.calls.length;
          await expect(
            current.account.handle(current.signal, {
              ...start,
              requestId: IDS.item,
              items: [],
              sharedText: '',
              itemTitle: '',
              workspaceMap: [],
            }),
          ).rejects.toThrow('new conversation');
          expect(
            current.transport.calls
              .slice(before)
              .filter((call) =>
                ['thread/start', 'thread/resume', 'turn/start'].includes(call.method),
              ),
          ).toEqual([]);
          expect(
            current.account
              .snapshot(keyOf(start))
              .messages.some((message) => message.text.includes('Private source content')),
          ).toBe(true);
        }
      }
    },
  );

  it('keeps owner-entered literal text usable without inventing item provenance', async () => {
    const validateSharing = vi.fn(() =>
      Promise.resolve({
        allowed: true,
        recipientRevision: 'recipient-one',
        sourceScope: { kind: 'selected' as const, itemIds: [] },
      }),
    );
    const app = harness({ validateSharing });
    const start = request({ text: 'Owner-entered literal {"private":true}' });
    await app.account.handle(app.signal, start);
    for (const [method, payload] of completed()) app.notify(method, payload);
    await app.account.handle(app.signal, { ...start, requestId: IDS.other, text: 'Follow up' });
    expect(validateSharing).toHaveBeenLastCalledWith(
      expect.objectContaining({ contextSourceItemIds: [], contextUnbounded: false }),
      expect.any(AbortSignal),
    );
  });

  it('refuses legacy cached history without provenance and preserves its visible transcript', async () => {
    const app = harness();
    const start = request();
    writeFileSync(
      join(app.home, `${keyOf(start)}.json`),
      JSON.stringify({
        threadId: 'legacy-provider-thread',
        requestId: IDS.other,
        messages: [{ id: IDS.other, role: 'assistant', text: 'Legacy source content' }],
      }),
    );
    await expect(app.account.handle(app.signal, start)).rejects.toThrow('new conversation');
    expect(app.transport.calls).toEqual([]);
    expect(app.account.snapshot(keyOf(start)).messages[0]?.text).toBe('Legacy source content');
  });

  it('marks unverified browser results unbounded instead of trusting caller provenance on a fresh turn', async () => {
    const validateSharing = vi.fn((input: SharingValidation) =>
      Promise.resolve({
        allowed: !(input.contextUnbounded && input.priorTurnId !== input.turnId),
        recipientRevision: 'recipient-one',
        sourceScope: { kind: 'workspace' as const, itemIds: [] },
      }),
    );
    const app = harness({ validateSharing });
    const start = request({ workspaceAccess: true });
    await app.account.handle(app.signal, start);
    app.transport.toolCall(1, 'legacy-read', 'nix_read_item', { itemId: IDS.other });
    await app.account.handle(app.signal, {
      ...start,
      operation: 'tool_claim',
      toolId: 'legacy-read',
    });
    await app.account.handle(app.signal, {
      ...start,
      operation: 'tool_result',
      toolId: 'legacy-read',
      toolSuccess: true,
      toolLockedContent: true,
      toolResult: 'Protected result',
    });
    for (const [method, payload] of completed()) app.notify(method, payload);
    const before = app.transport.calls.length;
    await expect(app.account.handle(app.signal, { ...start, requestId: IDS.item })).rejects.toThrow(
      'new conversation',
    );
    expect(app.transport.calls.slice(before)).toEqual([]);
    expect(validateSharing).toHaveBeenLastCalledWith(
      expect.objectContaining({
        contextUnbounded: true,
        contextProtected: true,
        priorTurnId: start.requestId,
      }),
      expect.any(AbortSignal),
    );
  });
});
