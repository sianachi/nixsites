interface ShellBridge {
  isNativePlatform?: () => boolean;
  nativePromise?: (plugin: string, method: string, options?: object) => Promise<unknown>;
}

const bridge = (): ShellBridge | undefined => (globalThis as { Capacitor?: ShellBridge }).Capacitor;

/** True in the iOS shell, whose sign-in runs in the system's web authentication session. */
export const canSignInNatively = (): boolean =>
  bridge()?.isNativePlatform?.() === true && typeof bridge()?.nativePromise === 'function';

export type NativeSignInResult = 'signed-in' | 'cancelled';

/**
 * Signs in through the shell (passkeys need the system session, not the WebView), then trades the
 * one-time code for the session cookie. Throws an Error with a plain message on any failure.
 */
export async function nativeSignIn(returnTo: string): Promise<NativeSignInResult> {
  let handoff: unknown;
  try {
    handoff = await bridge()?.nativePromise?.('NixShell', 'signIn', {
      origin: globalThis.location.origin,
      returnTo,
    });
  } catch (error) {
    if ((error as { code?: unknown } | null)?.code === 'cancelled') return 'cancelled';
    throw new Error(error instanceof Error ? error.message : 'Sign-in could not be completed.');
  }
  const { code, verifier } = (handoff ?? {}) as { code?: unknown; verifier?: unknown };
  if (typeof code !== 'string' || typeof verifier !== 'string')
    throw new Error('Sign-in could not be completed.');
  const response = await fetch('/auth/native/redeem', {
    method: 'POST',
    credentials: 'same-origin',
    cache: 'no-store',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ code, verifier }),
  });
  if (response.status !== 204) throw new Error('Sign-in could not be completed. Try again.');
  return 'signed-in';
}
