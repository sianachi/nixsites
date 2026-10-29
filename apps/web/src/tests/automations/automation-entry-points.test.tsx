import { fireEvent, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { beforeEach, describe, expect, it } from 'vitest';

import { item, stubCoreApi, STUB_DEFAULT_PREFERENCES } from '@nix/web-foundation/testing/api-stub';
import { stubAutomations } from '@nix/web-foundation/testing/api-stub/automations';
import { renderAt, signedIn } from '@nix/web-editor/testing/render-with-router';
import { App } from '../../app';

const FOLDER = item({ id: 'f1111111-1111-4111-8111-111111111111', title: 'Projects' });

beforeEach(() => {
  signedIn();
});

function rightClick(title: string): void {
  fireEvent.contextMenu(screen.getByRole('button', { name: title }), { clientX: 30, clientY: 30 });
}

describe('reaching automations from an item', () => {
  it('opens a new automation scoped to the item from its menu', async () => {
    stubCoreApi({ items: [FOLDER] });
    stubAutomations();
    renderAt(<App />);

    const user = userEvent.setup();
    await screen.findByRole('button', { name: 'Projects' });
    rightClick('Projects');
    await user.click(await screen.findByRole('menuitem', { name: 'Automate…' }));

    expect(await screen.findByRole('heading', { name: 'New automation' })).toBeVisible();
    // The scope picker names the item it was prefilled with once its title resolves.
    const scope = await screen.findByLabelText('Scope');
    await waitFor(() => {
      expect(scope).toHaveValue(FOLDER.id);
    });
  });

  it('mutes reminders from the item at the saved revision, carrying the rest of the settings', async () => {
    const writes = stubCoreApi({
      items: [FOLDER],
      preferences: { ...STUB_DEFAULT_PREFERENCES, revision: 2, timeZone: 'Europe/London' },
    });
    renderAt(<App />);

    const user = userEvent.setup();
    await screen.findByRole('button', { name: 'Projects' });
    rightClick('Projects');
    await user.click(await screen.findByRole('menuitem', { name: 'Mute reminders' }));

    await waitFor(() => {
      expect(writes.preferencesWrites).toHaveLength(1);
    });
    expect(writes.preferencesWrites[0]?.expectedRevision).toBe(2);
    expect(writes.preferencesWrites[0]?.preferences).toMatchObject({
      timeZone: 'Europe/London',
      mutedContainerIds: [FOLDER.id],
    });
    // Shown and announced, so it appears twice.
    expect(
      await screen.findAllByText(/Reminders from Projects and everything inside it are muted/),
    ).not.toHaveLength(0);

    // The menu now offers the way back.
    rightClick('Projects');
    expect(await screen.findByRole('menuitem', { name: 'Unmute reminders' })).toBeVisible();
  });
});

describe('reaching automations from the command palette', () => {
  it('lists Automations and goes there', async () => {
    stubCoreApi({ items: [FOLDER] });
    stubAutomations();
    renderAt(<App />);

    const user = userEvent.setup();
    await screen.findByRole('button', { name: 'Projects' });
    await user.keyboard('{Control>}k{/Control}');
    const palette = screen.getByRole('dialog', { name: /search/i });
    await user.type(within(palette).getByRole('combobox'), 'automat');
    await user.click(within(palette).getByRole('option', { name: /^Automations/ }));

    expect(await screen.findByRole('heading', { level: 1, name: 'Automations' })).toBeVisible();
  });
});
