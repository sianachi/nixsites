import { createNixClient } from '@nix/api-client';
import { Button, Icon, Text } from '@nix/ui';
import { X } from 'lucide-react';
import { useState, type ReactNode } from 'react';
import { MemoryRouter } from 'react-router';

import { ApiClientOverrideProvider } from '@nix/web-platform/api/api-client-provider';
import { AppRoutes } from '../app';
import { AuthOverrideProvider, type AuthContextValue } from '@nix/web-platform/auth/auth-provider';
import { useSessionStore } from '@nix/web-foundation/lib/session-store';
import { AppErrorBoundary } from '@nix/web-foundation/components/error-boundary';
import {
  bodyCacheAccountEpoch,
  clearBodyCache,
  openBodyCache,
} from '@nix/web-foundation/lib/body-cache';
import { installDemoCollab } from './demo-collab';
import { createDemoFetch, DEMO_ENTRY, DEMO_NOTES, DEMO_PROFILE } from './demo-core';

const leave = (): Promise<void> => {
  globalThis.location.assign('/');
  return Promise.resolve();
};

const DEMO_AUTH: AuthContextValue = {
  signIn: leave,
  signOut: leave,
  getAccessToken: () => Promise.resolve('demo'),
  handleSessionRefusal: () => undefined,
  isConfigured: true,
  accountUrl: null,
};

/**
 * Starts each visit clean: drops note bodies a previous visit left in this browser, then opens the
 * body cache for the demo visitor as signing in would, without which the editor refuses to sync.
 */
export async function prepareDemo(): Promise<void> {
  const { subject } = DEMO_PROFILE;
  await clearBodyCache(subject, bodyCacheAccountEpoch(subject)).catch(() => undefined);
  await openBodyCache(subject, { reauthorized: true });
}

/**
 * The real application over a sample workspace held in this tab, for an install that turns the
 * demo on (`demo` in web-config.json). main.tsx mounts it outside <App />: the session is fixed
 * and the API client's fetch is the in-memory Core in demo-core.ts, so nothing reaches a server
 * and a reload starts over.
 */
export function DemoPage(): ReactNode {
  const [bannerVisible, setBannerVisible] = useState(true);
  const [client] = useState(() => {
    installDemoCollab(DEMO_NOTES);
    useSessionStore.setState({ status: 'authenticated', profile: DEMO_PROFILE, error: null });
    return createNixClient({
      baseUrl: globalThis.location.origin,
      tokens: {
        getAccessToken: () => Promise.resolve('demo'),
        refreshAccessToken: () => Promise.resolve('demo'),
      },
      fetch: createDemoFetch(),
    });
  });

  return (
    <div className="min-h-dvh bg-background font-body text-foreground">
      <AppErrorBoundary>
        <AuthOverrideProvider value={DEMO_AUTH}>
          <ApiClientOverrideProvider client={client}>
            <MemoryRouter initialEntries={[DEMO_ENTRY]}>
              <AppRoutes />
            </MemoryRouter>
            {bannerVisible ? (
              <aside
                aria-label="Demo"
                className="fixed bottom-[calc(var(--mobile-nav-height,0%)+var(--spacing)*2)] left-1/2 z-50 flex w-max max-w-[calc(100%-var(--spacing)*6)] -translate-x-1/2 items-center gap-2 rounded-lg border border-divider bg-background px-3 py-1"
              >
                <Text variant="note" as="p" tone="muted">
                  Demo · nothing is saved
                </Text>
                <a
                  href="/"
                  className="flex items-center text-sm font-bold whitespace-nowrap text-accent-text pointer-coarse:min-h-11"
                >
                  Back to Nix
                </a>
                <Button
                  variant="subtle"
                  aria-label="Dismiss demo banner"
                  title="Dismiss demo banner"
                  className="size-(--control-lg) shrink-0"
                  onClick={() => {
                    setBannerVisible(false);
                    document.getElementById('main')?.focus();
                  }}
                >
                  <Icon icon={X} size="sm" />
                </Button>
              </aside>
            ) : null}
          </ApiClientOverrideProvider>
        </AuthOverrideProvider>
      </AppErrorBoundary>
    </div>
  );
}
