import type { Ground } from '../theme/theme-store';

/**
 * Helpers for the iOS Capacitor shell. The shell injects `window.Capacitor` into the server's own
 * pages, so plugins are reached through it rather than bundled; every helper is a no-op (or falls
 * back to the web API) in a plain browser.
 */

type Call = (options?: Record<string, unknown>) => Promise<unknown>;

interface CapacitorGlobal {
  readonly isNativePlatform?: () => boolean;
  readonly Plugins?: Readonly<Record<string, Readonly<Record<string, Call>> | undefined>>;
}

function capacitor(): CapacitorGlobal | undefined {
  return (globalThis as { Capacitor?: CapacitorGlobal }).Capacitor;
}

export function isNativeShell(): boolean {
  return capacitor()?.isNativePlatform?.() === true;
}

function pluginCall(name: string, method: string): Call | undefined {
  return isNativeShell() ? capacitor()?.Plugins?.[name]?.[method] : undefined;
}

/** A missing plugin or a rejected call is never worth failing a tap over. */
function fire(name: string, method: string, options?: Record<string, unknown>): void {
  void pluginCall(name, method)?.(options).catch(() => undefined);
}

export type TapStyle = 'light' | 'medium' | 'selection';

export function tap(style: TapStyle = 'light'): void {
  if (style === 'selection') {
    fire('Haptics', 'selectionChanged');
  } else {
    fire('Haptics', 'impact', { style: style === 'medium' ? 'MEDIUM' : 'LIGHT' });
  }
}

/** The status bar's `DARK` style means light text, for a dark ground. */
export function syncStatusBar(ground: Ground): void {
  fire('StatusBar', 'setStyle', { style: ground === 'dark' ? 'DARK' : 'LIGHT' });
}

/** Returns false when nothing could share, or the person dismissed the sheet. */
export async function shareLink({ title, url }: { title: string; url: string }): Promise<boolean> {
  try {
    const native = pluginCall('Share', 'share');
    if (native) {
      await native({ title, url });
      return true;
    }
    if (typeof navigator !== 'undefined' && typeof navigator.share === 'function') {
      await navigator.share({ title, url });
      return true;
    }
  } catch {
    // Dismissing the sheet rejects; that is an answer, not an error.
  }
  return false;
}
