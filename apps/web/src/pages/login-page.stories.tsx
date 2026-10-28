import { useEffect, type ReactElement } from 'react';

import { useSessionStore } from '@nix/web-foundation/lib/session-store';
import { setZenMode } from '@nix/web-foundation/lib/zen-mode';
import { LoginPage } from './login-page';

export default { title: 'Nix/Pages/Sign in', parameters: { layout: 'fullscreen' } };

function Example({
  focused = false,
  error = null,
}: {
  readonly focused?: boolean;
  readonly error?: string | null;
}): ReactElement {
  useEffect(() => {
    useSessionStore.setState({ status: 'anonymous', profile: null, error: null });
    setZenMode(focused);
    return () => {
      setZenMode(false);
    };
  }, [focused]);
  return <LoginPage onSignIn={() => undefined} error={error} />;
}

export const SignIn = { render: (): ReactElement => <Example /> };
export const Focused = { render: (): ReactElement => <Example focused /> };
export const ConfigurationError = {
  render: (): ReactElement => (
    <Example focused error="Interactive sign-in is not configured on this Nix server." />
  ),
};
export const DarkFocused = { ...Focused, globals: { ground: 'dark' } };
