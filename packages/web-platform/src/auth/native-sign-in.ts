interface SignInHandler {
  postMessage(message: unknown): Promise<unknown>;
}

const handler = (): SignInHandler | undefined =>
  (globalThis as { webkit?: { messageHandlers?: { nixSignIn?: SignInHandler } } }).webkit
    ?.messageHandlers?.nixSignIn;

/** True in the iOS shell, whose sign-in runs in the system's web authentication session. */
export const canSignInNatively = (): boolean => typeof handler()?.postMessage === 'function';

/** `returnTo` when it stays on this origin; anything else (for example `//evil.example/`) becomes `/`. */
export const sameOriginPath = (returnTo: string): string => {
  try {
    return new URL(returnTo, globalThis.location.origin).origin === globalThis.location.origin
      ? returnTo
      : '/';
  } catch {
    return '/';
  }
};

export type NativeSignInResult = 'signed-in' | 'cancelled';

/**
 * Signs in through the shell (passkeys need the system session, not the WebView), then trades the
 * one-time code for the session cookie. Throws an Error with a plain message on any failure.
 */
export async function nativeSignIn(returnTo: string): Promise<NativeSignInResult> {
  let handoff: unknown;
  try {
    // The shell takes the origin from the sending frame, never from this message.
    handoff = await handler()?.postMessage({ returnTo });
  } catch (error) {
    // WebKit rejects with the native reply string, not an Error.
    if (error === 'cancelled') return 'cancelled';
    throw new Error(
      typeof error === 'string' && error !== '' ? error : 'Sign-in could not be completed.',
    );
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
