import { describe, expect, it } from 'vitest';
import { createServerPlanFetch } from './plan-dispatch.ts';
import { IDS } from '../testing/testing.ts';

const envelope = {
  tenantId: IDS.tenant,
  principalId: IDS.principal,
  workspaceId: IDS.workspace,
  revisions: 'saved-revisions',
  binding: {
    runId: IDS.request,
    planId: IDS.other,
    planVersion: 2,
    reviewDigest: 'reviewed-values',
    stepId: IDS.item,
    claimId: IDS.request,
    executionId: IDS.other,
    frozenArgumentsHash: 'a'.repeat(64),
  },
};
const options = {
  apiUrl: 'http://core.invalid',
  collabUrl: 'http://collab.invalid',
  internalSecret: 'synthetic-service-secret',
};

describe('native plan exact request dispatch', () => {
  it('issues one exact child binding and overwrites credentials and revision headers before dispatch', async () => {
    const calls: { url: string; body: unknown; headers: Headers }[] = [];
    const send = createServerPlanFetch(options, envelope, async (url, init) => {
      await Promise.resolve();
      const target = typeof url === 'string' ? url : url instanceof URL ? url.href : url.url;
      calls.push({ url: target, body: init?.body, headers: new Headers(init?.headers) });
      if (target.includes('/requests/issue'))
        return Response.json({
          kind: 'server',
          token: 'exact-child-token',
          requestId: IDS.request,
          headers: { 'X-Nix-Pet-Item-Revisions': 'verified-continuation' },
        });
      return Response.json({ applied: true });
    });
    const body = '{"update":"exact-saved-bytes"}';
    await send('http://collab.invalid/items/one/updates', {
      method: 'POST',
      body,
      headers: { authorization: 'Bearer old-read-token' },
    });
    expect(calls).toHaveLength(2);
    expect(JSON.parse(String(calls[0]?.body))).toMatchObject({
      tenantId: envelope.tenantId,
      principalId: envelope.principalId,
      workspaceId: envelope.workspaceId,
      binding: envelope.binding,
      childId: 1,
      destination: 'collab',
      method: 'POST',
      target: '/items/one/updates',
      body,
      executor: 'server',
    });
    expect(JSON.stringify(JSON.parse(String(calls[0]?.body)))).not.toContain('old-read-token');
    expect(calls[1]?.headers.get('authorization')).toBe('Bearer exact-child-token');
    expect(calls[1]?.headers.get('x-nix-pet-plan-request')).toBe(IDS.request);
    expect(calls[1]?.headers.get('x-nix-pet-item-revisions')).toBe('verified-continuation');
    expect(calls[1]?.headers.has('x-nix-internal-secret')).toBe(false);
    expect(calls[1]?.body).toBe(body);
  });

  it('does not dispatch after Core refuses a cancelled or superseded plan', async () => {
    let effects = 0;
    const send = createServerPlanFetch(options, envelope, async (url) => {
      await Promise.resolve();
      if (
        (typeof url === 'string' ? url : url instanceof URL ? url.href : url.url).includes(
          '/requests/issue',
        )
      )
        return new Response('', { status: 409 });
      effects += 1;
      return Response.json({ applied: true });
    });
    await expect(
      send('http://collab.invalid/items/one/updates', { method: 'POST', body: '{}' }),
    ).rejects.toThrow('refused');
    expect(effects).toBe(0);
  });
});
