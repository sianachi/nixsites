import { act, render, screen } from '@testing-library/react';
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

    expect(screen.getByRole('button', { name: 'Signing in…' })).toBeDisabled();
    expect(screen.getByRole('button', { name: 'Exit Zen' })).toBeEnabled();
  });

  it('says so when sign-in is slow, and offers Try again after a failure', () => {
    vi.useFakeTimers();
    useSessionStore.setState({ status: 'authenticating' });
    const { unmount } = render(<LoginPage onSignIn={vi.fn()} />);
    expect(screen.getByRole('button', { name: 'Signing in…' })).toHaveAttribute(
      'aria-busy',
      'true',
    );
    expect(screen.queryByText(/Still working/)).not.toBeInTheDocument();
    act(() => {
      vi.advanceTimersByTime(3000);
    });
    expect(screen.getByRole('status')).toHaveTextContent('Still working');
    unmount();
    vi.useRealTimers();

    useSessionStore.setState({ status: 'anonymous' });
    render(<LoginPage onSignIn={vi.fn()} error="The provider did not answer." />);
    expect(screen.getByRole('alert')).toHaveTextContent('Sign-in failed');
    expect(screen.getByRole('alert')).toHaveTextContent('Try again');
    expect(screen.getByRole('button', { name: 'Continue with SSO' })).toBeEnabled();
  });
});
