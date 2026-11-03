import { screen, waitFor } from '@testing-library/react';
import type { UserEvent } from '@testing-library/user-event';
import { expect } from 'vitest';

/** The profile menu's trigger, last in the title row, which carries the workspace list. */
export function profileTrigger(): HTMLElement | null {
  const triggers = document.querySelectorAll<HTMLElement>(
    'header[aria-label="Workspace controls"] button[aria-haspopup]',
  );
  return triggers[triggers.length - 1] ?? null;
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
