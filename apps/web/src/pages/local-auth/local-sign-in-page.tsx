import { Button, Field, Input, Text } from '@nix/ui';
import { useState, type ReactNode, type SyntheticEvent } from 'react';
import { Navigate, useSearchParams } from 'react-router';

import { useAuth } from '@nix/web-platform/auth/auth-provider';
import {
  getAssertion,
  localAuth,
  webAuthnAvailable,
  type SecondStep,
  type SignedIn,
} from '@nix/web-platform/auth/local-auth-client';
import { FormError, LocalAuthCard, describeError, finishSignIn } from './local-auth-card';

type Step = { readonly kind: 'credentials' } | ({ readonly kind: 'second' } & SecondStep);

export function LocalSignInPage(): ReactNode {
  const { setupRequired } = useAuth();
  const [params] = useSearchParams();
  const returnTo = params.get('returnTo') ?? undefined;
  // The app's handoff challenge, passed to Core unchanged.
  const native = params.get('native') ?? undefined;
  const extras = {
    ...(returnTo === undefined ? {} : { returnTo }),
    ...(native === undefined ? {} : { native }),
  };

  const [step, setStep] = useState<Step>({ kind: 'credentials' });
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [code, setCode] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  // First run: no account exists, so the setup page comes before any sign-in.
  if (setupRequired) return <Navigate to={`/setup?${params.toString()}`} replace />;

  async function run(action: () => Promise<SignedIn | SecondStep>): Promise<void> {
    setBusy(true);
    setError(null);
    try {
      const result = await action();
      if (result.status === 'signed_in') finishSignIn(result.redirectTo);
      else setStep({ kind: 'second', ...result });
    } catch (cause) {
      setError(describeError(cause));
    } finally {
      setBusy(false);
    }
  }

  const submitCredentials = (event: SyntheticEvent): void => {
    event.preventDefault();
    void run(() => localAuth.signIn({ email: email.trim(), password, ...extras }));
  };

  const usePasskey = (): void => {
    void run(async () => {
      const { challengeId, options } = await localAuth.passkeyOptions(extras);
      return localAuth.passkeyVerify(challengeId, await getAssertion(options));
    });
  };

  if (step.kind === 'second') {
    const { challengeId, methods } = step;
    return (
      <LocalAuthCard title="Second step">
        {methods.includes('totp') ? (
          <form
            className="flex flex-col gap-4"
            onSubmit={(event) => {
              event.preventDefault();
              void run(() => localAuth.totp(challengeId, code.trim()));
            }}
          >
            <Field label="Authenticator code" hint="The 6 digits from your authenticator app.">
              {(field) => (
                <Input
                  {...field}
                  value={code}
                  onChange={(event) => {
                    setCode(event.target.value);
                  }}
                  inputMode="numeric"
                  autoComplete="one-time-code"
                  pattern="[0-9 ]*"
                  autoFocus
                />
              )}
            </Field>
            <Button type="submit" variant="primary" disabled={busy || code.trim() === ''}>
              Verify
            </Button>
          </form>
        ) : null}
        {methods.includes('security_key') && webAuthnAvailable() ? (
          <Button
            variant="secondary"
            disabled={busy}
            onClick={() => {
              void run(async () => {
                const options = await localAuth.securityKeyOptions(challengeId);
                return localAuth.securityKeyVerify(challengeId, await getAssertion(options));
              });
            }}
          >
            Use a security key
          </Button>
        ) : null}
        <FormError message={error} />
        <Button
          variant="ghost"
          onClick={() => {
            setStep({ kind: 'credentials' });
            setCode('');
            setError(null);
          }}
        >
          Start over
        </Button>
      </LocalAuthCard>
    );
  }

  return (
    <LocalAuthCard title="Sign in">
      <form className="flex flex-col gap-4" onSubmit={submitCredentials}>
        <Field label="Email" required>
          {(field) => (
            <Input
              {...field}
              type="email"
              value={email}
              onChange={(event) => {
                setEmail(event.target.value);
              }}
              autoComplete="username webauthn"
              autoFocus
            />
          )}
        </Field>
        <Field label="Password" required>
          {(field) => (
            <Input
              {...field}
              type="password"
              value={password}
              onChange={(event) => {
                setPassword(event.target.value);
              }}
              autoComplete="current-password"
            />
          )}
        </Field>
        <Button type="submit" variant="primary" disabled={busy || email === '' || password === ''}>
          {busy ? 'Signing in…' : 'Sign in'}
        </Button>
      </form>
      {webAuthnAvailable() ? (
        <Button variant="secondary" disabled={busy} onClick={usePasskey}>
          Sign in with a passkey
        </Button>
      ) : null}
      <FormError message={error} />
      <Text variant="caption" as="p" tone="muted">
        Lost access? Ask an admin of this Nix for a reset link.
      </Text>
    </LocalAuthCard>
  );
}
