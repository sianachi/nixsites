import { Text } from '@nix/ui';
import { type ReactElement } from 'react';
import { Link, useLocation } from 'react-router';

import { SettingsSection } from '../shared/settings-section';

/** Product documentation. The API guide in the repository is what that site publishes. */
const DOCS = 'https://nix.nixsites.com';

/**
 * Where API calls go from this page.
 *
 * A deployed origin forwards `/api` and `POST /public/v1/auth/token`. The local
 * web server on port 5173 forwards `/api` only, so the exchange has to reach Core.
 */
export function apiBase(origin: string): { readonly base: string; readonly localDev: boolean } {
  if (/^https?:\/\/(localhost|127\.0\.0\.1):5173\/?$/.test(origin)) {
    return { base: 'http://localhost:5014', localDev: true };
  }
  return { base: origin.replace(/\/$/, ''), localDev: false };
}

/**
 * How to call the HTTP API from this deployment: the same contract as the app, nixctl, and MCP.
 */
export function ApiSection(): ReactElement {
  const { pathname } = useLocation();
  const { base, localDev } = apiBase(globalThis.location.origin);
  const exchange = [
    `curl -sS '${base}/public/v1/auth/token' \\`,
    `  -A 'nix-api-example/1.0' \\`,
    `  -H 'Content-Type: application/json' \\`,
    `  -d '{"token":"<personal access token>"}'`,
  ].join('\n');

  return (
    <SettingsSection title="API" summary="Call Nix over HTTP with a personal access token">
      <Text variant="note">
        The web app, nixctl, and MCP use this API. Create a token under{' '}
        <Link to={`${pathname}?tab=access-tokens`} className="text-accent-text">
          Access tokens
        </Link>
        , exchange it, and send the bearer token that comes back. Scopes only narrow what you can
        already do.
      </Text>
      <Text variant="note" tone="muted">
        {localDev
          ? 'This page is the local web app. It forwards /api and does not forward the token exchange. Call Core at http://localhost:5014.'
          : 'Calls use this site. A deployed Nix forwards /api and POST /public/v1/auth/token.'}
      </Text>
      <Text variant="note">
        Send a User-Agent you choose on every request. The hosted edge blocks the default Python and
        urllib user agents.
      </Text>
      <pre className="overflow-x-auto rounded-md border border-divider bg-surface p-3 font-mono text-sm">
        {exchange}
      </pre>
      <Text variant="note" tone="muted">
        The response field accessToken is the bearer token for /api/v1. It lasts a few minutes.
        Exchange again before it runs out. Renaming an item does not edit a note body. The API has
        no route for that yet.
      </Text>
      <Text variant="note">
        Guides, error codes, and the generated reference are in the{' '}
        <a href={DOCS} className="text-accent-text">
          Nix documentation
        </a>
        .
      </Text>
    </SettingsSection>
  );
}
