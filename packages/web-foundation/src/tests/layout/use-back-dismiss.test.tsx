import { act, render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { describe, expect, it } from 'vitest';
import { useState } from 'react';
import { useBackDismiss } from '../../layout/use-back-dismiss';

/** Waits for a real `popstate` to have actually run, rather than asserting immediately: the
 * `history.back()` a hook's own cleanup runs (to remove its entry once it closes by its own
 * control) fires its `popstate` asynchronously, and an assertion made before it lands would pass
 * whether or not that event went on to do anything - proving nothing about what the listener did
 * with it. */
function waitForPopstate(): Promise<void> {
  return new Promise((resolve) => {
    window.addEventListener(
      'popstate',
      () => {
        resolve();
      },
      { once: true },
    );
  });
}

/** Three independently controlled, nestable overlays, the way the shell drawer and the pet
 * dialog stack in `app-shell.tsx` and `pet-companion.tsx` - plus one more, to exercise the stack
 * at a depth neither of today's two callers reaches on its own. Each keeps its own history entry
 * while open, and each can close either from its own control or from the browser Back gesture. */
function Harness() {
  const [drawerOpen, setDrawerOpen] = useState(true);
  const [petOpen, setPetOpen] = useState(false);
  const [toastOpen, setToastOpen] = useState(false);
  useBackDismiss(drawerOpen, () => {
    setDrawerOpen(false);
  });
  useBackDismiss(petOpen, () => {
    setPetOpen(false);
  });
  useBackDismiss(toastOpen, () => {
    setToastOpen(false);
  });
  return (
    <>
      <output aria-label="Drawer">{String(drawerOpen)}</output>
      <output aria-label="Pet">{String(petOpen)}</output>
      <output aria-label="Toast">{String(toastOpen)}</output>
      <button
        type="button"
        onClick={() => {
          setPetOpen(true);
        }}
      >
        Open pet
      </button>
      <button
        type="button"
        onClick={() => {
          setPetOpen(false);
        }}
      >
        Close pet
      </button>
      <button
        type="button"
        onClick={() => {
          setToastOpen(true);
        }}
      >
        Open toast
      </button>
    </>
  );
}

describe('useBackDismiss', () => {
  it('dismisses only the topmost overlay per Back press', async () => {
    render(<Harness />);
    const user = userEvent.setup();
    await user.click(screen.getByRole('button', { name: 'Open pet' }));
    expect(screen.getByLabelText('Pet')).toHaveTextContent('true');
    expect(screen.getByLabelText('Drawer')).toHaveTextContent('true');

    // A real step back, not a bare `popstate` dispatch: the hook tells a genuine Back press
    // apart from a sibling overlay's own programmatic close by checking whether `history.state`
    // actually moved past its own marker.
    act(() => {
      window.history.back();
    });
    await waitFor(() => {
      expect(screen.getByLabelText('Pet')).toHaveTextContent('false');
    });
    expect(screen.getByLabelText('Drawer')).toHaveTextContent('true');

    act(() => {
      window.history.back();
    });
    await waitFor(() => {
      expect(screen.getByLabelText('Drawer')).toHaveTextContent('false');
    });
  });

  it('does not let closing the top overlay by its own control dismiss the overlay underneath', async () => {
    render(<Harness />);
    const user = userEvent.setup();
    await user.click(screen.getByRole('button', { name: 'Open pet' }));
    expect(screen.getByLabelText('Pet')).toHaveTextContent('true');

    // The pet's own Close button, not the Back gesture: this pops the pet's own history entry
    // (in the hook's cleanup) without ever touching the drawer's.
    const popped = waitForPopstate();
    await user.click(screen.getByRole('button', { name: 'Close pet' }));
    expect(screen.getByLabelText('Pet')).toHaveTextContent('false');

    // The `history.back()` the pet's cleanup ran to remove its own entry fires that `popstate`
    // asynchronously; waited for explicitly, rather than asserted on immediately, so a wrongly
    // dismissed drawer would actually be caught instead of the assertion just passing early.
    await popped;
    expect(screen.getByLabelText('Drawer')).toHaveTextContent('true');
  });

  it('dismisses three stacked overlays one Back press at a time, topmost first', async () => {
    render(<Harness />);
    const user = userEvent.setup();
    await user.click(screen.getByRole('button', { name: 'Open pet' }));
    await user.click(screen.getByRole('button', { name: 'Open toast' }));
    expect(screen.getByLabelText('Toast')).toHaveTextContent('true');
    expect(screen.getByLabelText('Pet')).toHaveTextContent('true');
    expect(screen.getByLabelText('Drawer')).toHaveTextContent('true');

    act(() => {
      window.history.back();
    });
    await waitFor(() => {
      expect(screen.getByLabelText('Toast')).toHaveTextContent('false');
    });
    expect(screen.getByLabelText('Pet')).toHaveTextContent('true');
    expect(screen.getByLabelText('Drawer')).toHaveTextContent('true');

    act(() => {
      window.history.back();
    });
    await waitFor(() => {
      expect(screen.getByLabelText('Pet')).toHaveTextContent('false');
    });
    expect(screen.getByLabelText('Drawer')).toHaveTextContent('true');

    act(() => {
      window.history.back();
    });
    await waitFor(() => {
      expect(screen.getByLabelText('Drawer')).toHaveTextContent('false');
    });
  });
});
