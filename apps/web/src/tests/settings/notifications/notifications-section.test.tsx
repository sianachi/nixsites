import { screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { beforeEach, describe, expect, it } from 'vitest';

import { item, stubCoreApi, STUB_DEFAULT_PREFERENCES } from '@nix/web-foundation/testing/api-stub';
import { renderAt, signedIn } from '@nix/web-editor/testing/render-with-router';
import { App } from '../../../app';

beforeEach(() => {
  signedIn();
});

describe('the notifications settings tab', () => {
  it('is reachable at its own address and lists a heading', async () => {
    stubCoreApi();
    renderAt(<App />, '/settings?tab=notifications');

    expect(await screen.findByRole('link', { name: 'Notifications' })).toHaveAttribute(
      'aria-current',
      'page',
    );
    expect(await screen.findByRole('heading', { level: 2, name: 'Notifications' })).toBeVisible();
  });

  it('auto-fills the browser time zone only on a never-saved, still-UTC default', async () => {
    stubCoreApi({ preferences: STUB_DEFAULT_PREFERENCES });
    renderAt(<App />, '/settings?tab=notifications');

    const zoneInput = await screen.findByLabelText('Time zone');
    expect(zoneInput).toHaveValue(Intl.DateTimeFormat().resolvedOptions().timeZone);
  });

  it('leaves an already-chosen time zone alone even if it happens to be UTC', async () => {
    stubCoreApi({
      preferences: { ...STUB_DEFAULT_PREFERENCES, revision: 3, timeZone: 'Etc/UTC' },
    });
    renderAt(<App />, '/settings?tab=notifications');

    const zoneInput = await screen.findByLabelText('Time zone');
    expect(zoneInput).toHaveValue('Etc/UTC');
  });

  it('saves changes with the expected revision and reports the save', async () => {
    const writes = stubCoreApi({ preferences: STUB_DEFAULT_PREFERENCES });
    renderAt(<App />, '/settings?tab=notifications');

    const user = userEvent.setup();
    const zoneInput = await screen.findByLabelText('Time zone');
    await user.clear(zoneInput);
    await user.type(zoneInput, 'America/Chicago');
    await user.click(screen.getByRole('button', { name: 'Save' }));

    await waitFor(() => {
      expect(writes.preferencesWrites).toHaveLength(1);
    });
    expect(writes.preferencesWrites[0]?.expectedRevision).toBe(0);
    expect(writes.preferencesWrites[0]?.preferences).toMatchObject({
      timeZone: 'America/Chicago',
    });
    expect(await screen.findByRole('status')).toHaveTextContent('Notification settings saved.');
  });

  it('reloads and tells the user about a revision conflict', async () => {
    stubCoreApi({ preferences: STUB_DEFAULT_PREFERENCES, preferencesConflict: true });
    renderAt(<App />, '/settings?tab=notifications');

    const user = userEvent.setup();
    await screen.findByLabelText('Time zone');
    await user.click(screen.getByRole('button', { name: 'Save' }));

    expect(await screen.findByRole('alert')).toHaveTextContent(/changed on another device/i);
  });

  it('lists muted container titles and removes one on request', async () => {
    const mutedItem = item({ id: '11111111-1111-4111-8111-111111111111', title: 'Archive' });
    const writes = stubCoreApi({
      items: [mutedItem],
      preferences: {
        ...STUB_DEFAULT_PREFERENCES,
        revision: 1,
        mutedContainerIds: [mutedItem.id],
      },
    });
    renderAt(<App />, '/settings?tab=notifications');

    const mutedSection = (await screen.findByText('Muted containers')).closest(
      'div',
    ) as HTMLElement;
    // The title resolves through its own async item read, after the section itself renders, so
    // this waits for it rather than asserting on the "Unknown item" placeholder that precedes it.
    expect(await within(mutedSection).findByText('Archive')).toBeVisible();

    const user = userEvent.setup();
    await user.click(within(mutedSection).getByRole('button', { name: 'Remove' }));

    await waitFor(() => {
      expect(writes.preferencesWrites).toHaveLength(1);
    });
    expect(writes.preferencesWrites[0]?.preferences).toMatchObject({ mutedContainerIds: [] });
    expect(within(mutedSection).queryByText('Archive')).not.toBeInTheDocument();
  });

  it('shows push as unsupported in this browser without breaking the rest of the tab', async () => {
    // jsdom offers neither `PushManager` nor `Notification`, so this exercises the same "keep the
    // inbox working" honesty the real unavailable-push case needs, from the other cause.
    stubCoreApi({ preferences: STUB_DEFAULT_PREFERENCES });
    renderAt(<App />, '/settings?tab=notifications');

    expect(await screen.findByText(/does not support push notifications/i)).toBeVisible();
    expect(screen.getByLabelText('Time zone')).toBeVisible();
  });
});
