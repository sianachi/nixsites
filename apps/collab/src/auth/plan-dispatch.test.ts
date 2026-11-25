import Fastify from 'fastify';
import { describe, expect, it, vi } from 'vitest';
import {
  registerPlanDispatch,
  type PlanDispatchAuthorizer,
  type PlanDispatchSettler,
} from './plan-dispatch.ts';

const id = '11111111-1111-4111-8111-111111111111';
const token = `header.${Buffer.from(JSON.stringify({ nix_pet_plan_request: 'saved-request' })).toString('base64url')}.signature`;

function app(
  authorize?: PlanDispatchAuthorizer,
  settle: PlanDispatchSettler = () => Promise.resolve(true),
) {
  const server = Fastify();
  let effects = 0;
  registerPlanDispatch(server, authorize, settle);
  server.post('/items/one/updates', () => {
    effects += 1;
    return { applied: true };
  });
  return { server, effects: () => effects };
}

describe('exact Collab plan dispatch', () => {
  it('sends the exact opaque owner permit to consume and settle without changing the BFF bearer', async () => {
    const authorize = vi.fn<PlanDispatchAuthorizer>().mockResolvedValue(true);
    const settle = vi.fn<PlanDispatchSettler>().mockResolvedValue(true);
    const test = app(authorize, settle);
    const permit = `${'2'.repeat(32)}.${id.replaceAll('-', '')}`;
    try {
      const response = await test.server.inject({
        method: 'POST',
        url: '/items/one/updates',
        payload: '{"text":"Owner change"}',
        headers: {
          authorization: 'Bearer synthetic-owner-bff',
          'content-type': 'application/json',
          'x-nix-pet-plan-request': permit,
        },
      });
      expect(response.statusCode).toBe(200);
      expect(authorize).toHaveBeenCalledExactlyOnceWith({
        token: 'synthetic-owner-bff',
        requestId: id,
        dispatchPermit: permit,
        method: 'POST',
        target: '/items/one/updates',
        body: '{"text":"Owner change"}',
        headers: { 'content-type': 'application/json' },
      });
      expect(settle).toHaveBeenCalledExactlyOnceWith({
        token: 'synthetic-owner-bff',
        requestId: id,
        dispatchPermit: permit,
        status: 200,
        headers: { 'content-type': 'application/json; charset=utf-8' },
        body: '{"applied":true}',
      });
      expect(test.effects()).toBe(1);
    } finally {
      await test.server.close();
    }
  });
  it('sends the exact raw request to Core before its first effect', async () => {
    const authorize = vi.fn<PlanDispatchAuthorizer>().mockResolvedValue(true);
    const test = app(authorize);
    const body = '{ "text": "Literal <value>" }';
    try {
      const response = await test.server.inject({
        method: 'POST',
        url: '/items/one/updates?mode=one',
        payload: body,
        headers: {
          authorization: `Bearer ${token}`,
          'content-type': 'application/json',
          'x-nix-pet-plan-request': id,
          'x-nix-pet-item-revisions': 'saved-revisions',
        },
      });
      expect(response.statusCode).toBe(200);
      expect(authorize).toHaveBeenCalledExactlyOnceWith({
        token,
        requestId: id,
        method: 'POST',
        target: '/items/one/updates?mode=one',
        body,
        headers: {
          'content-type': 'application/json',
          'x-nix-pet-item-revisions': 'saved-revisions',
        },
      });
      expect(test.effects()).toBe(1);
    } finally {
      await test.server.close();
    }
  });

  it.each(['missing-header', 'missing-validator', 'refused'])(
    'refuses %s before any effect',
    async (kind) => {
      const authorize = vi.fn<PlanDispatchAuthorizer>().mockResolvedValue(false);
      const test = app(kind === 'missing-validator' ? undefined : authorize);
      try {
        const response = await test.server.inject({
          method: 'POST',
          url: '/items/one/updates',
          payload: '{}',
          headers: {
            authorization: `Bearer ${token}`,
            'content-type': 'application/json',
            ...(kind === 'missing-header' ? {} : { 'x-nix-pet-plan-request': id }),
          },
        });
        expect(response.statusCode).toBe(403);
        expect(test.effects()).toBe(0);
        if (kind === 'missing-header') expect(authorize).not.toHaveBeenCalled();
      } finally {
        await test.server.close();
      }
    },
  );

  it('keeps ordinary owner requests on their existing route', async () => {
    const authorize = vi.fn<PlanDispatchAuthorizer>().mockResolvedValue(false);
    const test = app(authorize);
    try {
      expect(
        (
          await test.server.inject({
            method: 'POST',
            url: '/items/one/updates',
            payload: {},
            headers: { 'content-type': 'application/json' },
          })
        ).statusCode,
      ).toBe(200);
      expect(authorize).not.toHaveBeenCalled();
      expect(test.effects()).toBe(1);
    } finally {
      await test.server.close();
    }
  });
});
