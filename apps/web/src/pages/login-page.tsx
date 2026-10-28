import { Blueprint, Button, Icon, Text } from '@nix/ui';
import { ArrowRight } from 'lucide-react';
import { useLayoutEffect, type ReactNode } from 'react';

import { selectIsBusy, useSessionStore } from '@nix/web-foundation/lib/session-store';
import { claimZenSurface, toggleZenMode, useZenActive } from '@nix/web-foundation/lib/zen-mode';

export interface LoginPageProps {
  /** Starts the redirect to the identity provider. */
  readonly onSignIn: () => void;
  /** Whether the API answered its liveness probe. */
  readonly serverReachable?: boolean;
  /** The host the client is configured against. */
  readonly host?: string;
  /** Why the last attempt failed, when one did. */
  readonly error?: string | null;
}

const GRAPH_PAPER =
  'bg-[linear-gradient(to_right,var(--grid-rule)_1px,transparent_1px),linear-gradient(to_bottom,var(--grid-rule)_1px,transparent_1px)] [--grid-rule:color-mix(in_srgb,var(--color-accent)_5%,transparent)] bg-[length:34px_34px]'; // design-token-exempt: a 1px hairline and the design file's own 34px tile, neither of which is a spacing step - see above.

export function LoginPage({ onSignIn, error = null }: LoginPageProps): ReactNode {
  useLayoutEffect(claimZenSurface, []);
  const zen = useZenActive();
  const isBusy = useSessionStore(selectIsBusy);

  return (
    <main className="flex min-h-dvh flex-col bg-background">
      <div
        className={`relative flex min-w-0 flex-1 items-center justify-center ${zen ? '' : GRAPH_PAPER} px-3 py-6 sm:px-6 sm:py-12`}
      >
        <div
          className="w-full max-w-[400px] border border-divider bg-background shadow-md" // design-token-exempt: the card width is this one screen's proportion, the same kind of value as the panel widths the rule already leaves alone
        >
          <section className="flex min-w-0 flex-col p-5 sm:p-8">
            {zen ? null : (
              <Blueprint className="mb-6.5 inline-flex size-15.5 items-center justify-center">
                {/* text-primitive-exempt: the wordmark. Two capitals at the h2 step, opened to
                  `tracking-slight` because a pair of caps set at the heading's own `tracking-tight`
                  reads as one glyph. `<Text variant="h2">` is the right size and the wrong
                  tracking, and tracking is not a prop - see Text.tsx's note on why. */}
                <span className="font-heading text-2xl font-semibold tracking-slight">NX</span>
              </Blueprint>
            )}

            <Text variant="h2" as="h1" className="mb-4">
              Sign in
            </Text>

            <Button
              variant="primary"
              onClick={onSignIn}
              disabled={isBusy}
              className="min-h-10 w-full justify-center text-sm"
            >
              {isBusy ? 'Redirecting…' : 'Continue with SSO'}
              <Icon icon={ArrowRight} size="sm" />
            </Button>

            {error !== null && (
              <Text
                variant="caption"
                as="p"
                tone="accent"
                role="alert"
                className="mt-3 break-words"
              >
                {error}
              </Text>
            )}
            <Button
              variant="ghost"
              onClick={toggleZenMode}
              aria-pressed={zen}
              className="mt-4 self-start"
            >
              {zen ? 'Exit Zen' : 'Enter Zen'}
            </Button>
          </section>
        </div>
      </div>
    </main>
  );
}
