import { browserStorage } from './browser-storage';

/**
 * Writes one browser-local preference, or removes it when `value` is null (only the alternative
 * to the default is stored, so the default stays forward-compatible). Returns whether it reached
 * storage; blocked storage still lets the choice hold for this session.
 */
export function writeStored(key: string, value: string | null): boolean {
  try {
    const storage = browserStorage();
    if (value === null) storage?.removeItem(key);
    else storage?.setItem(key, value);
    return storage !== undefined;
  } catch {
    return false;
  }
}
