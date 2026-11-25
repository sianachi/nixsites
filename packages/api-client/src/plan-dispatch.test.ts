import { describe, expect, it, vi } from 'vitest';
import { createDirectCollabClient, createNixClient } from './client.js';
import type { PetPlanClientIntent } from './resources/pet-plans.js';

const intent: PetPlanClientIntent = {
  requestId: '11111111-1111-4111-8111-111111111111',
  childId: 1,
  destination: 'core',
  method: 'PATCH',
  target: '/api/v1/items/22222222-2222-4222-8222-222222222222?mode=exact',
  body: '{\n  "title": "Exact text"\n}',
  headers: { 'Content-Type': 'application/json', 'X-Nix-Pet-Item-Revisions': 'fixture-revision' },
  dispatchPermit: 'fixture-one-use-permit',
};
const tokens = () => ({
  getAccessToken: () => 'owner-token',
  refreshAccessToken: vi.fn(() => Promise.resolve('refreshed-owner-token')),
});

describe('prepared plan intent dispatch', () => {
  it('preserves the exact raw target/body and attaches the owner credential and server permit once', async () => {
    const fetch = vi.fn<typeof globalThis.fetch>((url, options) => {
      expect(url).toBe(`https://core.test${intent.target}`);
      expect(options?.body).toBe(intent.body);
      expect(options?.redirect).toBe('error');
      const headers = new Headers(options?.headers);
      expect(headers.get('Authorization')).toBe('Bearer owner-token');
      expect(headers.get('X-Nix-Pet-Plan-Request')).toBe(intent.dispatchPermit);
      expect(headers.get('X-Nix-Pet-Item-Revisions')).toBe('fixture-revision');
      return Promise.resolve(
        new Response(' {"receipt":"exact"}\n', {
          status: 201,
          headers: {
            'Content-Type': 'application/json',
            ETag: 'fixture-tag',
            'Set-Cookie': 'private-cookie',
          },
        }),
      );
    });
    const client = createNixClient({ baseUrl: 'https://core.test', tokens: tokens(), fetch });
    const result = await client.dispatchPlanIntent(intent);
    expect(result).toEqual({
      requestId: intent.requestId,
      status: 201,
      body: ' {"receipt":"exact"}\n',
      headers: { 'content-type': 'application/json', etag: 'fixture-tag' },
    });
    expect(fetch).toHaveBeenCalledTimes(1);
  });

  it.each([
    'https://foreign.test/api/v1/items',
    '//foreign.test/api/v1/items',
    '/api/v1/../auth/session',
    '/api/v1/items#fragment',
  ])('rejects a foreign or changed target %s before sending', async (target) => {
    const fetch = vi.fn<typeof globalThis.fetch>();
    const client = createNixClient({ baseUrl: 'https://core.test', tokens: tokens(), fetch });
    await expect(client.dispatchPlanIntent({ ...intent, target })).rejects.toThrow();
    expect(fetch).not.toHaveBeenCalled();
  });

  it.each([
    'Authorization',
    'Cookie',
    'X-Nix-Internal-Secret',
    'X-Api-Key',
    'X-Nix-Pet-Plan-Request',
  ])('refuses supplied credential header %s', async (header) => {
    const fetch = vi.fn<typeof globalThis.fetch>();
    const client = createNixClient({ baseUrl: 'https://core.test', tokens: tokens(), fetch });
    await expect(
      client.dispatchPlanIntent({ ...intent, headers: { [header]: 'not-forwarded' } }),
    ).rejects.toThrow('forbidden header');
    expect(fetch).not.toHaveBeenCalled();
  });

  it('dispatches Collab only through its configured direct client without changing the permit target', async () => {
    const fetch = vi.fn<typeof globalThis.fetch>((url) => {
      expect(url).toBe('https://collab.test/documents/fixture/updates');
      return Promise.resolve(new Response(null, { status: 204 }));
    });
    const client = createDirectCollabClient({
      baseUrl: 'https://collab.test',
      tokens: tokens(),
      fetch,
    });
    await client.dispatchPlanIntent({
      ...intent,
      destination: 'collab',
      target: '/documents/fixture/updates',
    });
    await expect(client.dispatchPlanIntent(intent)).rejects.toThrow('configured service');
    expect(fetch).toHaveBeenCalledTimes(1);
  });

  it('uses the fixed browser Collab ingress prefix while preserving the issued direct-service target', async () => {
    const target = '/documents/fixture/updates?format=json';
    const fetch = vi.fn<typeof globalThis.fetch>((url, options) => {
      expect(url).toBe(`https://app.test/collab${target}`);
      expect(new Headers(options?.headers).get('X-Nix-Pet-Plan-Request')).toBe(
        intent.dispatchPermit,
      );
      expect(options?.body).toBe(intent.body);
      return Promise.resolve(new Response(null, { status: 204 }));
    });
    const client = createDirectCollabClient({
      baseUrl: 'https://app.test/collab',
      tokens: tokens(),
      fetch,
    });
    await client.dispatchPlanIntent({ ...intent, destination: 'collab', target });
    expect(fetch).toHaveBeenCalledTimes(1);
  });

  it('refreshes after 401 without replaying a possible spent mutation', async () => {
    const credentials = tokens();
    const fetch = vi.fn<typeof globalThis.fetch>(() =>
      Promise.resolve(new Response('', { status: 401 })),
    );
    const client = createNixClient({ baseUrl: 'https://core.test', tokens: credentials, fetch });
    expect((await client.dispatchPlanIntent(intent)).status).toBe(401);
    expect(credentials.refreshAccessToken).toHaveBeenCalledTimes(1);
    expect(fetch).toHaveBeenCalledTimes(1);
  });

  it('does not replay a request after an uncertain network outcome', async () => {
    const fetch = vi.fn<typeof globalThis.fetch>(() =>
      Promise.reject(new Error('fixture network loss')),
    );
    const client = createNixClient({ baseUrl: 'https://core.test', tokens: tokens(), fetch });
    await expect(client.dispatchPlanIntent(intent)).rejects.toMatchObject({
      code: 'pet_plans.dispatch_uncertain',
    });
    expect(fetch).toHaveBeenCalledTimes(1);
  });

  it('never sends a prepared effect without an owner credential', async () => {
    const fetch = vi.fn<typeof globalThis.fetch>();
    const client = createNixClient({
      baseUrl: 'https://core.test',
      tokens: { getAccessToken: () => null, refreshAccessToken: () => Promise.resolve(null) },
      fetch,
    });
    await expect(client.dispatchPlanIntent(intent)).rejects.toMatchObject({ status: 401 });
    expect(fetch).not.toHaveBeenCalled();
  });

  it('reports an interrupted receipt as uncertain without retrying the effect', async () => {
    const fetch = vi.fn<typeof globalThis.fetch>(() =>
      Promise.resolve(
        new Response(
          new ReadableStream<Uint8Array>({
            start(controller) {
              controller.error(new Error('fixture lost receipt'));
            },
          }),
        ),
      ),
    );
    const client = createNixClient({ baseUrl: 'https://core.test', tokens: tokens(), fetch });
    await expect(client.dispatchPlanIntent(intent)).rejects.toMatchObject({
      code: 'pet_plans.dispatch_uncertain',
    });
    expect(fetch).toHaveBeenCalledTimes(1);
  });

  it('cancels an oversized streamed receipt at the byte limit', async () => {
    const cancel = vi.fn();
    let count = 0;
    const body = new ReadableStream<Uint8Array>({
      pull(controller) {
        count++;
        controller.enqueue(new Uint8Array(40_000));
      },
      cancel,
    });
    const client = createNixClient({
      baseUrl: 'https://core.test',
      tokens: tokens(),
      fetch: () => Promise.resolve(new Response(body)),
    });
    await expect(client.dispatchPlanIntent(intent)).rejects.toMatchObject({
      code: 'pet_plans.response_too_large',
    });
    expect(cancel).toHaveBeenCalledTimes(1);
    expect(count).toBeLessThanOrEqual(3);
  });
});
