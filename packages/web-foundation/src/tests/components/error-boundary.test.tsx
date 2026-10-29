import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import type { ReactElement } from 'react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { AppErrorBoundary } from '../../components/error-boundary';

// React reports every caught render error to the console. That is wanted
// behaviour, so it is silenced for the duration of these suites rather than
// removed from the component.
beforeEach(() => {
  vi.spyOn(console, 'error').mockImplementation(() => undefined);
});

afterEach(() => {
  vi.restoreAllMocks();
});

function Exploding(): never {
  throw new Error('exploded on purpose');
}

function Recoverable({ boom }: { readonly boom: boolean }): ReactElement {
  if (boom) {
    throw new Error('exploded on purpose');
  }
  return <p>Recovered</p>;
}

describe('the application error boundary', () => {
  it('renders its children while nothing throws', () => {
    render(
      <AppErrorBoundary>
        <p>All well</p>
      </AppErrorBoundary>,
    );

    expect(screen.getByText('All well')).toBeVisible();
  });

  it('offers a recovery affordance when a child throws', () => {
    render(
      <AppErrorBoundary>
        <Exploding />
      </AppErrorBoundary>,
    );

    expect(screen.getByRole('alert')).toHaveTextContent(/this view failed to render/i);
    expect(screen.getByRole('button', { name: /try again/i })).toBeEnabled();
  });

  it('says what went wrong rather than showing a blank page', () => {
    render(
      <AppErrorBoundary>
        <Exploding />
      </AppErrorBoundary>,
    );

    expect(screen.getByRole('alert')).toHaveTextContent(/exploded on purpose/);
  });

  it('re-renders the subtree and calls back when the visitor retries', async () => {
    const user = userEvent.setup();
    const onReset = vi.fn();

    const { rerender } = render(
      <AppErrorBoundary onReset={onReset}>
        <Recoverable boom={true} />
      </AppErrorBoundary>,
    );

    // The underlying cause is gone, but a boundary stays latched until it is
    // reset - so the error is still on screen at this point.
    rerender(
      <AppErrorBoundary onReset={onReset}>
        <Recoverable boom={false} />
      </AppErrorBoundary>,
    );
    expect(screen.getByRole('alert')).toBeVisible();

    await user.click(screen.getByRole('button', { name: /try again/i }));

    expect(onReset).toHaveBeenCalledOnce();
    expect(screen.getByText('Recovered')).toBeVisible();
  });
});
