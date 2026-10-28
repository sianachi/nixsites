import { render, type RenderResult } from '@testing-library/react';
import type { ReactElement } from 'react';
import { MemoryRouter } from 'react-router';

import { useSessionStore } from '@nix/web-foundation/lib/session-store';
import { bodyCacheAccountEpoch, openBodyCache } from '@nix/web-foundation/lib/body-cache';
import { browserStorage } from '@nix/web-foundation/lib/browser-storage';
import { vi } from 'vitest';
import { memoryStorage } from './memory-storage';
import { stubHealthyCollaboration } from './healthy-collaboration';

/**
 * Renders a tree under a MemoryRouter at a given URL.
 *
 * Tests drive the app the way a user does - through the address - so the URL-state convention is
 * exercised rather than mocked.
 * Collaboration uses a healthy test transport by default so unrelated UI tests do not open real
 * sockets. Pass collaboration: 'provided' when a test supplies its own transport or failures.
 */
export function renderAt(
  ui: ReactElement,
  url = '/',
  { collaboration = 'healthy' }: { readonly collaboration?: 'healthy' | 'provided' } = {},
): RenderResult {
  if (collaboration === 'healthy') {
    void prepareHealthyAdmission();
    stubHealthyCollaboration();
  }
  // A query naming workspace resources is already a workspace-scoped deep link. Older behavior
  // tests predate routed workspaces and spell that link as `/?item=...`; resolve that shorthand
  // here so those tests exercise the resource route instead of the deliberately lossy legacy
  // redirect. Tests about legacy routing pass destination paths explicitly and remain untouched.
  const resolvedUrl = url.startsWith('/?')
    ? `/w/00000000-0000-4000-8000-000000000001${url.slice(1)}`
    : url;
  return render(<MemoryRouter initialEntries={[resolvedUrl]}>{ui}</MemoryRouter>);
}

/** Models the cache admission skipped by signedIn, bounded to this fixture lifecycle. */
export function prepareHealthyAdmission(): Promise<void> {
  const session = useSessionStore.getState();
  const profile = session.profile;
  if (session.status !== 'authenticated' || profile === null) return Promise.resolve();
  if (browserStorage() === undefined) vi.stubGlobal('localStorage', memoryStorage());
  const storage = browserStorage();
  const opening = openBodyCache(profile.subject, { reauthorized: true });
  const epoch = bodyCacheAccountEpoch(profile.subject);
  return opening.catch((error: unknown) => {
    const current = useSessionStore.getState();
    if (
      current.status !== 'authenticated' ||
      current.profile !== profile ||
      browserStorage() !== storage ||
      bodyCacheAccountEpoch(profile.subject) !== epoch
    )
      return;
    throw error;
  });
}

/**
 * A signed-in session, for tests about what the application does once someone is past the gate.
 *
 * The store is seeded directly rather than by driving a real sign-in: an OIDC redirect cannot
 * happen in jsdom, and a test about the workspace switcher should not depend on an identity
 * provider being reachable. Tests that are *about* signing in drive the gate itself instead.
 *
 * Call before rendering. `resetSession` runs from the global test setup, so no test inherits
 * another's session.
 */
export function signedIn(): void {
  useSessionStore.setState({
    status: 'authenticated',
    profile: { subject: 'test-subject', name: 'Test Person', email: 'test@example.test' },
    error: null,
  });
}

/** Returns the session store to its initial, nobody-signed-in state. */
export function resetSession(): void {
  useSessionStore.setState({
    status: 'anonymous',
    profile: null,
    error: null,
    restoreAttempt: 0,
    unreachable: null,
  });
}
