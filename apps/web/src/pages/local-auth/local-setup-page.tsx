import { Button, Field, Input } from '@nix/ui';
import { useState, type ReactNode, type SyntheticEvent } from 'react';
import { Navigate, useSearchParams } from 'react-router';

import { useAuth } from '@nix/web-platform/auth/auth-provider';
import { localAuth } from '@nix/web-platform/auth/local-auth-client';
import { FormError, LocalAuthCard, describeError, finishSignIn } from './local-auth-card';

export const MIN_PASSWORD_LENGTH = 10;

export function LocalSetupPage(): ReactNode {
  const { mode, setupRequired } = useAuth();
  const [params] = useSearchParams();
  const [setupCode, setSetupCode] = useState('');
  const [name, setName] = useState('');
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  // Setup is only offered while no account exists; afterwards it is plain sign-in.
  if (mode === 'local' && !setupRequired)
    return <Navigate to={`/sign-in?${params.toString()}`} replace />;

  const submit = (event: SyntheticEvent): void => {
    event.preventDefault();
    if (password.length < MIN_PASSWORD_LENGTH) {
      setError(`Use a password of at least ${String(MIN_PASSWORD_LENGTH)} characters.`);
      return;
    }
    setBusy(true);
    setError(null);
    localAuth.setup({ setupCode, email: email.trim(), name: name.trim(), password }).then(
      (result) => {
        finishSignIn(result.redirectTo);
      },
      (cause: unknown) => {
        setError(describeError(cause));
        setBusy(false);
      },
    );
  };

  return (
    <LocalAuthCard title="Set up Nix">
      <form className="flex flex-col gap-4" onSubmit={submit}>
        <Field
          label="Setup code"
          hint="From NIX_AUTH_SETUP_CODE in this server's settings."
          required
        >
          {(field) => (
            <Input
              {...field}
              value={setupCode}
              onChange={(event) => {
                setSetupCode(event.target.value);
              }}
              autoComplete="off"
            />
          )}
        </Field>
        <Field label="Your name" required>
          {(field) => (
            <Input
              {...field}
              value={name}
              onChange={(event) => {
                setName(event.target.value);
              }}
              autoComplete="name"
            />
          )}
        </Field>
        <Field label="Email" required>
          {(field) => (
            <Input
              {...field}
              type="email"
              value={email}
              onChange={(event) => {
                setEmail(event.target.value);
              }}
              autoComplete="username"
            />
          )}
        </Field>
        <Field label="Password" hint="At least 10 characters." required>
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
        <Button
          type="submit"
          variant="primary"
          disabled={busy || setupCode === '' || name.trim() === '' || email === ''}
        >
          {busy ? 'Creating…' : 'Create admin account'}
        </Button>
        <FormError message={error} />
      </form>
    </LocalAuthCard>
  );
}
