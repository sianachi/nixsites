import { Blueprint, Text } from '@nix/ui';
import { type ReactNode } from 'react';

import { LocalAuthError, PasskeyUnsupportedError } from '@nix/web-platform/auth/local-auth-client';

/** The card every local sign-in page sits in, matching the OIDC login screen. */
export function LocalAuthCard(props: {
  readonly title: string;
  readonly children: ReactNode;
}): ReactNode {
  return (
    <main className="flex min-h-dvh flex-col bg-background">
      <div className="flex min-w-0 flex-1 items-center justify-center px-3 py-6 sm:px-6 sm:py-12">
        <div
          className="w-full max-w-[400px] border border-divider bg-background shadow-md" // design-token-exempt: the card width is this screen's proportion, as on the login page
        >
          <section className="flex min-w-0 flex-col gap-4 p-5 sm:p-8">
            <Blueprint className="inline-flex size-15.5 items-center justify-center">
              {/* text-primitive-exempt: the wordmark, as on the login page. */}
              <span className="font-heading text-2xl font-semibold tracking-slight">NX</span>
            </Blueprint>
            <Text variant="h2" as="h1">
              {props.title}
            </Text>
            {props.children}
          </section>
        </div>
      </div>
    </main>
  );
}

/** Always mounted so a screen reader hears the message when it appears. */
export function FormError({ message }: { readonly message: string | null }): ReactNode {
  return (
    <div role="alert" className="min-h-5 break-words">
      {message === null ? null : (
        <Text variant="caption" as="p" tone="accent">
          {message}
        </Text>
      )}
    </div>
  );
}

/** Plain words for a failed local-auth call. Never says whether an email exists. */
export function describeError(error: unknown): string {
  if (error instanceof PasskeyUnsupportedError) return error.message;
  if (
    error instanceof DOMException &&
    (error.name === 'NotAllowedError' || error.name === 'AbortError')
  )
    return 'The passkey prompt was cancelled or timed out. Try again.';
  // The browser refused the passkey's address for this site (its related-origins check failed).
  if (error instanceof DOMException && error.name === 'SecurityError')
    return 'Passkeys are not available for this address yet. Use your password.';
  if (error instanceof LocalAuthError) {
    if (error.code === 'paused') {
      const minutes = Math.max(1, Math.ceil((error.retryAfterSeconds ?? 300) / 60));
      return `Too many attempts. Try again in ${String(minutes)} ${minutes === 1 ? 'minute' : 'minutes'}.`;
    }
    if (error.status === 401) return 'The details did not match. Check them and try again.';
    if (error.status === 404)
      return 'This link is invalid or has expired. Ask your admin for a new one.';
    if (error.status === 429) return 'Too many requests. Wait a moment and try again.';
    if (error.status === 400) return 'Those details were not accepted. Check them and try again.';
  }
  return 'Nix could not reach the server. Try again.';
}

/** A full load, so the session cookie Core just set restores the session (and the native handoff runs). */
export function finishSignIn(redirectTo: string): void {
  globalThis.location.assign(redirectTo);
}
