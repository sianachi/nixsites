import { screen, waitFor } from '@testing-library/react';
import type { UserEvent } from '@testing-library/user-event';
import { expect } from 'vitest';

/** The profile menu's trigger, last on the icon strip, which carries the workspace list. */
export function profileTrigger(): HTMLElement | null {
  return document.querySelector<HTMLElement>(
    'nav[aria-label="Destinations"] li:last-child button[aria-haspopup]',
  );
}

export async function openProfileMenu(user: UserEvent): Promise<void> {
  await waitFor(() => {
    expect(profileTrigger()).not.toBeNull();
  });
  const trigger = profileTrigger();
  if (trigger === null) throw new Error('No profile menu trigger.');
  await user.click(trigger);
}

/** Opens the full workspace panel (search, pins, groups, management) from the profile menu. */
export async function openWorkspacePanel(user: UserEvent): Promise<void> {
  await openProfileMenu(user);
  await user.click(screen.getByRole('button', { name: 'All workspaces…' }));
}
