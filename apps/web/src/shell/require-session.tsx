import { Button, Text } from '@nix/ui';
import { type ReactNode } from 'react';
import { Outlet } from 'react-router';

import { useAuth } from '../auth/auth-provider';
import { useSessionStore, type Unreachable } from '../auth/session-store';
import { LoginPage } from '../pages/login-page';

/**
 * The session gate: everything below it renders only for a signed-in person.
 *
 * It renders the login screen in place rather than redirecting to `/login`, so the URL a visitor
 * arrived at survives the sign-in and they land where they were going. A redirect would need the
 * original path stashed somewhere and restored afterwards, which is a small state machine to get
 * wrong for no gain.
 *
 * **All four states are distinct and none of them lies.** `unknown` and `authenticating` show that
 * something is in flight rather than flashing the login screen at someone who is already signed in;
 * `failed` shows the login screen *with* the reason; `anonymous` shows it plainly, or with the
 * reason an expired session left behind (a deliberate sign-out leaves none).
 */
export function RequireSession(): ReactNode {
  const status = useSessionStore((state) => state.status);
  const error = useSessionStore((state) => state.error);
  const retry = useSessionStore((state) => state.sessionRetryRequested);
  const unreachable = useSessionStore((state) => state.unreachable);
  const { signIn, isConfigured } = useAuth();

  if (status === 'authenticated') {
    return <Outlet />;
  }

  // Before the restoring screen, and also while a retry is in flight: the unreachable screen
  // stays and says it is trying, rather than flashing "Restoring session…" and back.
  if (
    unreachable !== null &&
    (status === 'unreachable' || status === 'unknown' || status === 'authenticating')
  ) {
    return (
      <UnreachableScreen
        unreachable={unreachable}
        retrying={status !== 'unreachable'}
        onRetry={retry}
      />
    );
  }

  if (status === 'unknown' || status === 'authenticating') {
    // Core is resolving the HttpOnly session. Showing the login screen here would flash it in
    // front of someone whose session is about to be restored, which reads as being signed out.
    return (
      <main className="flex min-h-dvh items-center justify-center bg-background px-6">
        <Text variant="note" tone="muted">
          Restoring session…
        </Text>
      </main>
    );
  }

  const configurationHint = isConfigured
    ? null
    : 'Interactive sign-in is not configured on this Nix server.';

  return (
    <LoginPage
      onSignIn={() => {
        void signIn();
      }}
      error={error ?? configurationHint}
      host={globalThis.location.host}
    />
  );
}

/**
 * Core could not be reached. Says which of the two it is as far as the browser can tell - this
 * device has no network, or it has one and the server is not answering - because the two ask
 * different things of the person: reconnect, or wait. Either way Nix keeps trying by itself, and
 * the screen says when it last did.
 */
function UnreachableScreen(props: {
  readonly unreachable: Unreachable;
  readonly retrying: boolean;
  readonly onRetry: () => void;
}): ReactNode {
  const { unreachable, retrying, onRetry } = props;
  const offline = unreachable.cause === 'offline';
  const lastTried = new Date(unreachable.lastTriedAt).toLocaleTimeString([], {
    hour: 'numeric',
    minute: '2-digit',
  });
  return (
    <main className="flex min-h-dvh items-center justify-center bg-background px-6">
      <div className="flex max-w-md flex-col items-start gap-3">
        <Text as="h1" variant="h2">
          {offline ? 'Nix is offline' : 'Nix can’t reach its server'}
        </Text>
        <Text as="p" variant="body" tone="muted">
          {offline
            ? 'Reconnect to open your workspace. Nix will try again as soon as this device is back online.'
            : 'Your connection is working, but the Nix server is not answering. Nix will keep trying.'}
        </Text>
        <Text as="p" variant="note" tone="muted" role="status">
          {retrying ? 'Trying again…' : `Last tried at ${lastTried}.`}
        </Text>
        <Button variant="secondary" disabled={retrying} onClick={onRetry}>
          {retrying ? 'Trying…' : 'Try again'}
        </Button>
      </div>
    </main>
  );
}
