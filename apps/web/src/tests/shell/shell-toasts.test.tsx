import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { createRef } from 'react';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { ShellToasts, type ShellToast } from '../../shell/shell-toasts';

function reminder(n: number): ShellToast {
  return {
    key: `notification-${String(n)}`,
    message: `Reminder ${String(n)}`,
    persistent: true,
    autoFocus: false,
    action: { label: 'Open', onAction: vi.fn() },
  };
}

/** The undo bar's live region stays mounted while empty, so only count regions showing something. */
function visibleToasts(): readonly HTMLElement[] {
  return screen.getAllByRole('status').filter((region) => region.textContent !== '');
}

function setup(toasts: readonly ShellToast[], phone: boolean) {
  // No width query matches -> the narrow (phone) arrangement; all matching -> desktop.
  vi.stubGlobal('matchMedia', (query: string) => ({
    // Desktop is a mouse in a landscape window: only the width queries match.
    matches: !phone && !/pointer|orientation/.test(query),
    media: query,
    addEventListener: vi.fn(),
    removeEventListener: vi.fn(),
  }));
  const onDismiss = vi.fn<(key: string) => void>();
  const onViewReminders = vi.fn();
  const view = render(
    <ShellToasts
      toasts={toasts}
      treeRegionRef={createRef()}
      onDismiss={onDismiss}
      onViewReminders={onViewReminders}
    />,
  );
  return { ...view, onDismiss, onViewReminders };
}

afterEach(() => {
  vi.unstubAllGlobals();
});

describe('ShellToasts', () => {
  it('sits above the bottom nav, using the measured nav height', () => {
    setup([reminder(1)], true);
    expect(visibleToasts()[0]?.parentElement?.className).toContain(
      'bottom-[var(--mobile-nav-height,0%)]',
    );
  });

  it('collapses reminders into one summary on a phone, and View opens the list', async () => {
    const { onViewReminders, onDismiss } = setup([reminder(1), reminder(2), reminder(3)], true);

    expect(visibleToasts()).toHaveLength(1);
    expect(screen.getByText('3 reminders')).toBeInTheDocument();

    await userEvent.click(screen.getByRole('button', { name: 'View' }));
    expect(onViewReminders).toHaveBeenCalledTimes(1);
    expect(onDismiss).toHaveBeenCalledTimes(3);
  });

  it('dismissing the summary dismisses every reminder it stands for', async () => {
    const { onDismiss } = setup([reminder(1), reminder(2)], true);

    await userEvent.click(screen.getByRole('button', { name: 'Dismiss' }));
    expect(onDismiss.mock.calls.map(([key]) => key)).toEqual(['notification-1', 'notification-2']);
  });

  it('shows a single reminder in full, with Open and Dismiss', async () => {
    const toast = reminder(1);
    const { onDismiss } = setup([toast], true);

    expect(screen.getByText('Reminder 1')).toBeInTheDocument();
    await userEvent.click(screen.getByRole('button', { name: 'Open' }));
    expect(toast.action?.onAction).toHaveBeenCalledTimes(1);
    expect(onDismiss).toHaveBeenCalledWith('notification-1');
  });

  it('keeps two reminders on desktop and collapses at three', () => {
    const two = setup([reminder(1), reminder(2)], false);
    expect(visibleToasts()).toHaveLength(2);
    two.unmount();

    setup([reminder(1), reminder(2), reminder(3)], false);
    expect(visibleToasts()).toHaveLength(1);
    expect(screen.getByText('3 reminders')).toBeInTheDocument();
  });
});
