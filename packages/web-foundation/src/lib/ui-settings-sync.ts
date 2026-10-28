import { browserStorage } from './browser-storage';
import { uiSettings, type NixClient, type UiSettings, type UiSettingsPatch } from '@nix/api-client';

/**
 * Keeps the synced interface settings in step with `GET/PATCH /api/v1/me/ui-settings`.
 *
 * Browser storage stays the source the UI reads, so a change is instant and works offline. The
 * server copy follows it: a change is PATCHed per key after a short pause (last writer wins per
 * key), and once after sign-in the server's values are applied to the local stores. A key the
 * server has never seen is uploaded from this device if it holds a non-default value, so the
 * first device to sign in seeds the account. Nothing here blocks the UI or throws; a failed
 * request is a warning and the local value stands.
 *
 * Browser storage belongs to the browser, not the account, so the id of the person who last
 * hydrated is remembered. When somebody else signs in, their server values still apply but this
 * browser's leftover values are never uploaded into their account.
 */

const OWNER_KEY = 'nix.ui-settings-owner';

type Key = keyof UiSettings;
type Value = NonNullable<UiSettings[Key]>;

interface Registration<K extends Key> {
  /** The local value in the server's representation. */
  readonly get: () => NonNullable<UiSettings[K]>;
  /** Applies a value through the store's public setter, which also writes browser storage. */
  readonly set: (value: NonNullable<UiSettings[K]>) => void;
  readonly defaultValue: NonNullable<UiSettings[K]>;
}

const DEBOUNCE_MS = 500;
const registry = new Map<Key, Registration<Key>>();
const timers = new Map<Key, ReturnType<typeof setTimeout>>();
const changedSinceHydrate = new Set<Key>();
let client: NixClient | null = null;
let applying = false;

export function registerSyncedSetting<K extends Key>(key: K, registration: Registration<K>): void {
  registry.set(key, registration as unknown as Registration<Key>);
}

function readOwner(): string | null {
  try {
    return browserStorage()?.getItem(OWNER_KEY) ?? null;
  } catch {
    return null;
  }
}

function writeOwner(principalId: string): void {
  try {
    browserStorage()?.setItem(OWNER_KEY, principalId);
  } catch {
    // Without storage there is no leftover to protect against either.
  }
}

function send(patch: UiSettingsPatch): void {
  if (client === null) return;
  client.execute(uiSettings.patchSettings(patch)).catch((error: unknown) => {
    console.warn('Could not sync a setting to your account; it stays on this device.', error);
  });
}

/** Called by a store after it has written its own value; sends that one key, debounced. */
export function settingChanged(key: Key, value: Value): void {
  if (applying) return;
  changedSinceHydrate.add(key);
  clearTimeout(timers.get(key));
  timers.set(
    key,
    setTimeout(() => {
      timers.delete(key);
      send({ [key]: value });
    }, DEBOUNCE_MS),
  );
}

/** Reads the server's values once and reconciles each registered store with them. */
export async function hydrateUiSettings(next: NixClient, principalId: string): Promise<void> {
  client = next;
  changedSinceHydrate.clear();
  try {
    const { settings } = await next.query(uiSettings.settings());
    const upload: Record<string, Value> = {};
    const owner = readOwner();
    const mayUpload = owner === null || owner === principalId;
    writeOwner(principalId);
    applying = true;
    try {
      for (const [key, registration] of registry) {
        // A change made while the request was in flight is newer than what came back.
        if (changedSinceHydrate.has(key)) continue;
        const remote = settings[key];
        if (remote !== undefined) registration.set(remote);
        else if (mayUpload && registration.get() !== registration.defaultValue)
          upload[key] = registration.get();
      }
    } finally {
      applying = false;
    }
    if (Object.keys(upload).length > 0) send(upload);
  } catch (error: unknown) {
    console.warn('Could not load your synced settings; this device keeps its own.', error);
  }
}

/** Test seam: forgets timers and the client so one test cannot leak into the next. */
export function resetUiSettingsSync(): void {
  timers.forEach(clearTimeout);
  timers.clear();
  changedSinceHydrate.clear();
  client = null;
  applying = false;
}
