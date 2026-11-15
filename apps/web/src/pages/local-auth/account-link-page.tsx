import { Button, Field, Input, Text } from '@nix/ui';
import { useEffect, useState, type ReactNode, type SyntheticEvent } from 'react';
import { useParams } from 'react-router';

import {
  createCredential,
  localAuth,
  webAuthnAvailable,
  type LinkInfo,
} from '@nix/web-platform/auth/local-auth-client';
import { FormError, LocalAuthCard, describeError, finishSignIn } from './local-auth-card';
import { MIN_PASSWORD_LENGTH } from './local-setup-page';

type Loaded =
  | { readonly kind: 'loading' }
  | { readonly kind: 'invalid' }
  | ({ readonly kind: 'ok' } & LinkInfo);

export function AccountLinkPage(): ReactNode {
  const { token = '' } = useParams();
  const [link, setLink] = useState<Loaded>({ kind: 'loading' });
  const [password, setPassword] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    let live = true;
    localAuth.getLink(token).then(
      (info) => {
        if (live) setLink({ kind: 'ok', ...info });
      },
      () => {
        // Unknown, used and expired links look the same on purpose.
        if (live) setLink({ kind: 'invalid' });
      },
    );
    return () => {
      live = false;
    };
  }, [token]);

  if (link.kind === 'loading')
    return (
      <LocalAuthCard title="Account link">
        <Text variant="note" tone="muted" role="status">
          Checking the link…
        </Text>
      </LocalAuthCard>
    );
  if (link.kind === 'invalid')
    return (
      <LocalAuthCard title="Link not valid">
        <Text variant="body" as="p" role="alert">
          This link is invalid, already used or expired. Ask an admin for a new one.
        </Text>
      </LocalAuthCard>
    );

  const run = (action: () => Promise<{ redirectTo: string }>): void => {
    setBusy(true);
    setError(null);
    action().then(
      (result) => {
        finishSignIn(result.redirectTo);
      },
      (cause: unknown) => {
        setError(describeError(cause));
        setBusy(false);
      },
    );
  };

  const submitPassword = (event: SyntheticEvent): void => {
    event.preventDefault();
    if (password.length < MIN_PASSWORD_LENGTH) {
      setError(`Use a password of at least ${String(MIN_PASSWORD_LENGTH)} characters.`);
      return;
    }
    run(() => localAuth.linkPassword(token, password));
  };

  const createPasskey = (): void => {
    run(async () => {
      const credential = await createCredential(await localAuth.linkPasskeyOptions(token));
      return localAuth.linkPasskeyVerify(token, credential, 'Passkey');
    });
  };

  return (
    <LocalAuthCard title={link.purpose === 'setup' ? 'Welcome to Nix' : 'Reset your sign-in'}>
      <Text variant="body" as="p">
        This link is for {link.name === '' ? link.email : `${link.name} (${link.email})`}.
      </Text>
      <form className="flex flex-col gap-4" onSubmit={submitPassword}>
        <Field label="New password" hint="At least 10 characters." required>
          {(field) => (
            <Input
              {...field}
              type="password"
              value={password}
              onChange={(event) => {
                setPassword(event.target.value);
              }}
              autoComplete="new-password"
            />
          )}
        </Field>
        <Button type="submit" variant="primary" disabled={busy || password === ''}>
          {busy ? 'Saving…' : 'Set password and sign in'}
        </Button>
      </form>
      {webAuthnAvailable() ? (
        <Button variant="secondary" disabled={busy} onClick={createPasskey}>
          Create a passkey instead
        </Button>
      ) : null}
      <FormError message={error} />
    </LocalAuthCard>
  );
}
