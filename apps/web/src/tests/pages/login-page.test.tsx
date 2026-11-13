import { act, render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { beforeEach, describe, expect, it, vi } from 'vitest';

import { useSessionStore } from '@nix/web-foundation/lib/session-store';
import { LoginPage } from '../../pages/login-page';

beforeEach(() => {
  useSessionStore.setState({ status: 'anonymous', profile: null, error: null });
});

describe('sign-in', () => {
  it('offers a sign-in action and keeps configuration errors visible', async () => {
    const signIn = vi.fn();
    render(<LoginPage onSignIn={signIn} error="Interactive sign-in is not configured." />);

    expect(screen.getByRole('heading', { name: 'Sign in' })).toBeVisible();
    expect(screen.getByRole('alert')).toHaveTextContent('Interactive sign-in is not configured.');
    expect(screen.queryByRole('button', { name: /Zen/i })).not.toBeInTheDocument();
    await userEvent.click(screen.getByRole('button', { name: 'Sign in' }));
    expect(signIn).toHaveBeenCalledOnce();
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
    expect(screen.getByRole('button', { name: 'Sign in' })).toBeEnabled();
  });
});
