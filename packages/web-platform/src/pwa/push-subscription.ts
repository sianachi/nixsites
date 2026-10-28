import { isNixApiError, notifications, type NixClient } from '@nix/api-client';
import { getServiceWorkerRegistration } from './register-service-worker';

/** Cache Storage name the applicationServerKey is remembered under, so the service worker's own
 * `pushsubscriptionchange` handler can re-subscribe without any page open. Cache Storage, not
 * IndexedDB, because the service worker already speaks it (see `public/service-worker.js`) and a
 * small JSON blob does not need a database. */
const PUSH_KEY_CACHE = 'nix-push-key';
const PUSH_KEY_REQUEST = '/__push-key';

/** Why push is not on, when it is not - the states `NotificationsSection` renders distinctly. */
export type PushUnavailableReason = 'unsupported' | 'unavailable' | 'denied' | 'error';

export interface EnablePushResult {
  readonly ok: boolean;
  readonly reason?: PushUnavailableReason;
}

function urlBase64ToUint8Array(base64String: string): BufferSource {
  const padding = '='.repeat((4 - (base64String.length % 4)) % 4);
  const base64 = (base64String + padding).replace(/-/g, '+').replace(/_/g, '/');
  const rawData = atob(base64);
  const output = new Uint8Array(new ArrayBuffer(rawData.length));
  for (let index = 0; index < rawData.length; index += 1) {
    output[index] = rawData.charCodeAt(index);
  }
  return output;
}

/** Whether this browser can support Web Push at all - distinct from whether Core has configured
 * it (`unavailable`, from `push.unavailable`) or the person has refused permission (`denied`). */
export function pushSupported(): boolean {
  return (
    typeof window !== 'undefined' &&
    'serviceWorker' in navigator &&
    'PushManager' in window &&
    'Notification' in window
  );
}

async function rememberApplicationServerKey(base64Key: string): Promise<void> {
  if (!('caches' in window)) return;
  try {
    const cache = await caches.open(PUSH_KEY_CACHE);
    await cache.put(
      PUSH_KEY_REQUEST,
      new Response(JSON.stringify({ applicationServerKey: base64Key })),
    );
  } catch {
    // Best-effort: the subscription itself already succeeded. Only a future key rotation's
    // automatic re-subscribe would be unavailable, and that fails closed on its own.
  }
}

async function forgetApplicationServerKey(): Promise<void> {
  if (!('caches' in window)) return;
  try {
    const cache = await caches.open(PUSH_KEY_CACHE);
    await cache.delete(PUSH_KEY_REQUEST);
  } catch {
    // Best-effort, as above.
  }
}

/** The device's current subscription, read without prompting for permission. Null when there is
 * none, push is unsupported, or the service worker has not registered yet. */
export async function currentPushSubscription(): Promise<PushSubscription | null> {
  const registration = getServiceWorkerRegistration();
  if (!registration || !pushSupported()) return null;
  try {
    return await registration.pushManager.getSubscription();
  } catch {
    return null;
  }
}

/**
 * Enables push on this device. Asks for notification permission only here, on the caller's click -
 * never on page load - then subscribes with the VAPID public key Core hands back and registers the
 * subscription.
 */
export async function enablePushOnThisDevice(client: NixClient): Promise<EnablePushResult> {
  if (!pushSupported()) return { ok: false, reason: 'unsupported' };

  let publicKey: string;
  try {
    const response = await client.query(notifications.pushPublicKey(), { forceRefresh: true });
    publicKey = response.publicKey;
  } catch (cause) {
    if (isNixApiError(cause) && cause.code === 'push.unavailable') {
      return { ok: false, reason: 'unavailable' };
    }
    return { ok: false, reason: 'error' };
  }

  const permission = await Notification.requestPermission();
  if (permission !== 'granted') return { ok: false, reason: 'denied' };

  const registration = getServiceWorkerRegistration() ?? (await navigator.serviceWorker.ready);

  try {
    const subscription = await registration.pushManager.subscribe({
      userVisibleOnly: true,
      applicationServerKey: urlBase64ToUint8Array(publicKey),
    });
    const json = subscription.toJSON();
    if (
      json.endpoint === undefined ||
      json.keys?.p256dh === undefined ||
      json.keys.auth === undefined
    ) {
      return { ok: false, reason: 'error' };
    }
    await client.execute(
      notifications.addPushSubscription(json.endpoint, json.keys.p256dh, json.keys.auth),
    );
    await rememberApplicationServerKey(publicKey);
    return { ok: true };
  } catch {
    return { ok: false, reason: 'error' };
  }
}

/** Disables push on this device: unsubscribes locally, then removes the row on the server. */
export async function disablePushOnThisDevice(client: NixClient): Promise<boolean> {
  const registration = getServiceWorkerRegistration();
  if (!registration) return true;
  try {
    const subscription = await registration.pushManager.getSubscription();
    if (!subscription) return true;
    const endpoint = subscription.endpoint;
    await subscription.unsubscribe();
    await client.execute(notifications.removePushSubscription(endpoint));
    await forgetApplicationServerKey();
    return true;
  } catch {
    return false;
  }
}
