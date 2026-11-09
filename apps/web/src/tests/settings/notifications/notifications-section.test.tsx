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
    expect(await screen.findByText('Notification settings saved to your account.')).toBeVisible();
    // Undo reverts only the fields the save changed, as a second write.
    await user.click(await screen.findByRole('button', { name: 'Undo' }));
    await waitFor(() => {
      expect(writes.preferencesWrites).toHaveLength(2);
    });
  });

  it('reloads and tells the user about a revision conflict', async () => {
    stubCoreApi({ preferences: STUB_DEFAULT_PREFERENCES, preferencesConflict: true });
    renderAt(<App />, '/settings?tab=notifications');

    const user = userEvent.setup();
    const zone = await screen.findByLabelText('Time zone');
    await user.clear(zone);
    await user.type(zone, 'America/Chicago');
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

    await user.click(await screen.findByRole('button', { name: 'Undo' }));
    await waitFor(() => {
      expect(writes.preferencesWrites).toHaveLength(2);
    });
    expect(writes.preferencesWrites[1]?.preferences).toMatchObject({
      mutedContainerIds: [mutedItem.id],
    });
  });

  it('shows push as unsupported in this browser without breaking the rest of the tab', async () => {
    // jsdom offers neither `PushManager` nor `Notification`, so this exercises the same "keep the
    // inbox working" honesty the real unavailable-push case needs, from the other cause.
    stubCoreApi({ preferences: STUB_DEFAULT_PREFERENCES });
    renderAt(<App />, '/settings?tab=notifications');

    expect(await screen.findByText(/does not support push notifications/i)).toBeVisible();
    expect(screen.getByLabelText('Time zone')).toBeVisible();
  });

  it('shows the local time of a valid zone and refuses to save a name that is not a zone', async () => {
    const writes = stubCoreApi({ preferences: STUB_DEFAULT_PREFERENCES });
    renderAt(<App />, '/settings?tab=notifications');

    const user = userEvent.setup();
    const zoneInput = await screen.findByLabelText('Time zone');
    // A zone other than the one on screen, so the edit counts as a change whatever this machine's zone is.
    const other =
      (zoneInput as HTMLInputElement).value === 'Europe/London' ? 'Asia/Tokyo' : 'Europe/London';
    await user.clear(zoneInput);
    await user.type(zoneInput, 'Mars/Nowhere');

    expect(screen.getByText(/Not a time zone Nix knows/)).toBeVisible();
    expect(screen.getByRole('button', { name: 'Save' })).toBeDisabled();

    await user.clear(zoneInput);
    await user.type(zoneInput, other);
    expect(screen.getByText(/It is .+ there now/)).toBeVisible();
    expect(screen.getByRole('button', { name: 'Save' })).toBeEnabled();
    expect(writes.preferencesWrites).toHaveLength(0);
  });

  it('marks unsaved edits, and Discard puts the saved values back', async () => {
    stubCoreApi({ preferences: STUB_DEFAULT_PREFERENCES });
    renderAt(<App />, '/settings?tab=notifications');

    const user = userEvent.setup();
    expect(await screen.findByText('No unsaved changes')).toBeVisible();
    const saved = await screen.findByLabelText<HTMLInputElement>('Time zone');
    const before = saved.value;
    await user.clear(saved);
    await user.type(saved, 'Asia/Tokyo');
    expect(screen.getByText(/Unsaved changes, not applied yet/)).toBeVisible();

    await user.click(screen.getByRole('button', { name: 'Discard changes' }));
    expect(screen.getByLabelText('Time zone')).toHaveValue(before);
    expect(screen.getByText('Unsaved changes discarded.')).toBeVisible();
  });
});
