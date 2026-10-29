import { createNixClient, type NixClient } from '@nix/api-client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import {
  disablePushOnThisDevice,
  enablePushOnThisDevice,
  pushSupported,
} from '../../pwa/push-subscription';

vi.mock('../../pwa/register-service-worker', () => ({
  getServiceWorkerRegistration: () => mockRegistration,
}));

let mockRegistration:
  | {
      pushManager: {
        subscribe: ReturnType<typeof vi.fn>;
        getSubscription: ReturnType<typeof vi.fn>;
      };
    }
  | undefined;

function client(): NixClient {
  return createNixClient({
    baseUrl: 'https://nix.test',
    tokens: {
      getAccessToken: () => Promise.resolve('token'),
      refreshAccessToken: () => Promise.resolve('token'),
    },
  });
}

describe('push support detection', () => {
  const originalNotification = (globalThis as { Notification?: unknown }).Notification;
  const originalPushManager = (globalThis as { PushManager?: unknown }).PushManager;
  const originalServiceWorker = navigator.serviceWorker as unknown;

  afterEach(() => {
    Object.defineProperty(globalThis, 'Notification', {
      value: originalNotification,
      configurable: true,
    });
    Object.defineProperty(globalThis, 'PushManager', {
      value: originalPushManager,
      configurable: true,
    });
    Object.defineProperty(navigator, 'serviceWorker', {
      value: originalServiceWorker,
      configurable: true,
    });
  });

  it('is false when the browser offers none of serviceWorker, PushManager or Notification', () => {
    Object.defineProperty(globalThis, 'PushManager', { value: undefined, configurable: true });
    expect(pushSupported()).toBe(false);
  });
});

describe('enabling push on this device', () => {
  let fetchMock: ReturnType<typeof vi.fn>;
  let requestPermission: ReturnType<typeof vi.fn>;

  beforeEach(() => {
    fetchMock = vi.fn();
    vi.stubGlobal('fetch', fetchMock);
    requestPermission = vi.fn(() => Promise.resolve('granted'));
    Object.defineProperty(globalThis, 'Notification', {
      value: { requestPermission, permission: 'default' },
      configurable: true,
    });
    // `pushSupported()` only checks `'PushManager' in window`; the value itself is never
    // constructed, so a plain marker object stands in for the constructor jsdom does not provide.
    Object.defineProperty(globalThis, 'PushManager', { value: {}, configurable: true });
    Object.defineProperty(navigator, 'serviceWorker', {
      value: { ready: Promise.resolve(mockRegistration) },
      configurable: true,
    });
    mockRegistration = {
      pushManager: {
        subscribe: vi.fn(() =>
          Promise.resolve({
            toJSON: () => ({
              endpoint: 'https://push.example/x',
              keys: { p256dh: 'p', auth: 'a' },
            }),
          }),
        ),
        getSubscription: vi.fn(() => Promise.resolve(null)),
      },
    };
  });

  afterEach(() => {
    vi.unstubAllGlobals();
    mockRegistration = undefined;
  });

  it('reports unavailable when Core has not configured a VAPID key', async () => {
    fetchMock.mockResolvedValueOnce(
      new Response(JSON.stringify({ code: 'push.unavailable', title: 'Push is unavailable' }), {
        status: 404,
        headers: { 'content-type': 'application/problem+json' },
      }),
    );

    const result = await enablePushOnThisDevice(client());
    expect(result).toEqual({ ok: false, reason: 'unavailable' });
    expect(requestPermission).not.toHaveBeenCalled();
  });

  it('asks for permission only after the public key is known, and reports denial', async () => {
    fetchMock.mockResolvedValueOnce(
      new Response(JSON.stringify({ publicKey: 'AAAA' }), { status: 200 }),
    );
    requestPermission.mockResolvedValueOnce('denied');

    const result = await enablePushOnThisDevice(client());
    expect(result).toEqual({ ok: false, reason: 'denied' });
    expect(requestPermission).toHaveBeenCalledOnce();
    expect(mockRegistration?.pushManager.subscribe).not.toHaveBeenCalled();
  });

  it('subscribes and registers the subscription once permission is granted', async () => {
    fetchMock
      .mockResolvedValueOnce(new Response(JSON.stringify({ publicKey: 'AAAA' }), { status: 200 }))
      .mockResolvedValueOnce(
        new Response(
          JSON.stringify({
            id: '99999999-9999-4999-8999-999999999999',
            endpoint: 'https://push.example/x',
            userAgent: 'test',
            createdAt: '2026-09-29T09:00:00.000Z',
            lastSuccessAt: null,
          }),
          { status: 200 },
        ),
      );

    const result = await enablePushOnThisDevice(client());
    expect(result).toEqual({ ok: true });
    expect(mockRegistration?.pushManager.subscribe).toHaveBeenCalledOnce();
  });
});

describe('disabling push on this device', () => {
  afterEach(() => {
    vi.unstubAllGlobals();
    mockRegistration = undefined;
  });

  it('is a no-op success when there is no registration', async () => {
    mockRegistration = undefined;
    await expect(disablePushOnThisDevice(client())).resolves.toBe(true);
  });

  it('unsubscribes locally and removes the row on the server', async () => {
    const unsubscribe = vi.fn(() => Promise.resolve(true));
    mockRegistration = {
      pushManager: {
        subscribe: vi.fn(),
        getSubscription: vi.fn(() =>
          Promise.resolve({ endpoint: 'https://push.example/x', unsubscribe }),
        ),
      },
    };
    const fetchMock = vi.fn(() => Promise.resolve(new Response(null, { status: 204 })));
    vi.stubGlobal('fetch', fetchMock);

    await expect(disablePushOnThisDevice(client())).resolves.toBe(true);
    expect(unsubscribe).toHaveBeenCalledOnce();
    expect(fetchMock).toHaveBeenCalledWith(
      expect.stringContaining('/api/v1/me/push-subscriptions'),
      expect.objectContaining({ method: 'DELETE' }),
    );
  });
});
