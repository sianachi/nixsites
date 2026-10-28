import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { useSessionStore } from '@nix/web-foundation/lib/session-store';
import { setZenMode } from '@nix/web-foundation/lib/zen-mode';
import { LoginPage } from '../../pages/login-page';

beforeEach(() => {
  setZenMode(false);
  useSessionStore.setState({ status: 'anonymous', profile: null, error: null });
});

afterEach(() => {
  setZenMode(false);
});

describe('sign-in Zen', () => {
  it('keeps sign-in and configuration errors available while focusing and exiting', async () => {
    const signIn = vi.fn();
    render(<LoginPage onSignIn={signIn} error="Interactive sign-in is not configured." />);

    await userEvent.click(screen.getByRole('button', { name: 'Enter Zen' }));
    expect(screen.queryByText('NX')).not.toBeInTheDocument();
    expect(screen.getByRole('heading', { name: 'Sign in' })).toBeVisible();
    expect(screen.getByRole('alert')).toHaveTextContent('Interactive sign-in is not configured.');
    await userEvent.click(screen.getByRole('button', { name: 'Continue with SSO' }));
    expect(signIn).toHaveBeenCalledOnce();

    await userEvent.click(screen.getByRole('button', { name: 'Exit Zen' }));
    expect(screen.getByText('NX')).toBeVisible();
    expect(screen.getByRole('button', { name: 'Enter Zen' })).toHaveAttribute(
      'aria-pressed',
      'false',
    );
  });

  it('retains the redirecting state in Zen', () => {
    setZenMode(true);
    useSessionStore.setState({ status: 'authenticating' });
    render(<LoginPage onSignIn={vi.fn()} />);

    expect(screen.getByRole('button', { name: 'Redirecting…' })).toBeDisabled();
    expect(screen.getByRole('button', { name: 'Exit Zen' })).toBeEnabled();
  });
});
