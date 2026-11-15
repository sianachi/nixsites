import { isNixApiError, oauth } from '@nix/api-client';
import { Button, Text } from '@nix/ui';
import { useEffect, useState, type ReactNode } from 'react';
import { useSearchParams } from 'react-router';

import { useApiClient } from '@nix/web-platform/api/api-client-provider';
import { AccessScopesField } from '@nix/web-settings/settings/access-tokens/access-token-create-dialog';
import { LocalAuthCard } from './local-auth/local-auth-card';

type Preview = { readonly kind: 'loading' } | { readonly kind: 'failed' } | ConsentPreviewState;
type ConsentPreviewState = { readonly kind: 'ok' } & oauth.ConsentPreview;

/**
 * Where a connector's authorization request lands (the contract's `/oauth/authorize`). It sits under
 * the session gate, so a signed-out visitor signs in and returns here with the query intact.
 *
 * Nothing leaves this page until Core's preview has accepted the client and redirect address, and
 * the only address followed is the one Core returns.
 */
export function OAuthAuthorizePage(): ReactNode {
  const client = useApiClient();
  const [params] = useSearchParams();
  const request = {
    clientId: params.get('client_id') ?? '',
    redirectUri: params.get('redirect_uri') ?? '',
    codeChallenge: params.get('code_challenge') ?? '',
    codeChallengeMethod: params.get('code_challenge_method') ?? '',
    state: params.get('state') ?? undefined,
    resource: params.get('resource') ?? undefined,
  };
  const key = JSON.stringify(request);
  const responseType = params.get('response_type');

  const [preview, setPreview] = useState<Preview>({ kind: 'loading' });
  const [scopes, setScopes] = useState<ReadonlySet<string>>(new Set());
  const [scopesError, setScopesError] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    if (responseType !== 'code') return;
    let live = true;
    const previewRequest = { ...(JSON.parse(key) as typeof request), state: undefined };
    client.execute(oauth.previewConsent(previewRequest)).then(
      (result) => {
        if (live) setPreview({ kind: 'ok', ...result });
      },
      () => {
        if (live) setPreview({ kind: 'failed' });
      },
    );
    return () => {
      live = false;
    };
  }, [client, key, responseType]);

  if (responseType === 'code' && preview.kind === 'loading')
    return (
      <LocalAuthCard title="Connect an app">
        <Text variant="note" tone="muted" role="status">
          Checking the request…
        </Text>
      </LocalAuthCard>
    );
  if (preview.kind !== 'ok')
    return (
      <LocalAuthCard title="Request not valid">
        <Text variant="body" as="p" role="alert">
          This connection request is not valid, or this organisation has turned MCP off. Go back to
          the app and start again.
        </Text>
      </LocalAuthCard>
    );

  const decide = (decision: 'approve' | 'deny'): void => {
    if (decision === 'approve' && scopes.size === 0) {
      setScopesError('Choose at least one scope.');
      return;
    }
    setScopesError(null);
    setError(null);
    setBusy(true);
    client
      .execute(
        oauth.decideConsent({
          ...request,
          decision,
          ...(decision === 'approve'
            ? { token: { scopes: ['read', 'write', 'admin'].filter((s) => scopes.has(s)) } }
            : {}),
        }),
      )
      .then(
        (result) => {
          globalThis.location.assign(result.redirectTo);
        },
        (cause: unknown) => {
          setError(
            isNixApiError(cause) && cause.detail !== undefined
              ? cause.detail
              : 'The request could not be completed. Try again.',
          );
          setBusy(false);
        },
      );
  };

  return (
    <LocalAuthCard title={`Connect ${preview.clientName}`}>
      <Text variant="body" as="p">
        {preview.clientName} (returning to {preview.redirectHost}) will be able to act in Nix as
        you, within the access you choose below.
      </Text>
      <AccessScopesField
        scopes={scopes}
        onToggle={(scope) => {
          setScopes((current) => {
            const next = new Set(current);
            if (!next.delete(scope)) next.add(scope);
            return next;
          });
        }}
        error={scopesError}
      />
      {error === null ? null : (
        <Text variant="note" role="alert">
          {error}
        </Text>
      )}
      <div className="flex flex-wrap items-center justify-end gap-2">
        <Button
          variant="secondary"
          disabled={busy}
          onClick={() => {
            decide('deny');
          }}
        >
          Deny
        </Button>
        <Button
          disabled={busy}
          onClick={() => {
            decide('approve');
          }}
        >
          Approve
        </Button>
      </div>
    </LocalAuthCard>
  );
}
