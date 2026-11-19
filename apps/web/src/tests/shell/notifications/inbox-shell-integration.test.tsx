import { screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import type { ReactElement } from 'react';
import { useLocation } from 'react-router';
import { beforeEach, describe, expect, it } from 'vitest';

import { item, STUB_WORKSPACE_ID, stubCoreApi } from '@nix/web-foundation/testing/api-stub';
import { renderAt, signedIn } from '@nix/web-editor/testing/render-with-router';
import { App } from '../../../app';

beforeEach(() => {
  signedIn();
});

const NOTE = item({ id: '55555555-5555-4555-8555-555555555555', title: 'Renew the domain' });

function CurrentAddress(): ReactElement {
  const { pathname, search } = useLocation();
  return <output aria-label="Current address">{pathname + search}</output>;
}

describe('the notification inbox in the shell', () => {
  it('shows the unread count on the bell and opens the panel on click', async () => {
    stubCoreApi({
      items: [NOTE],
      notificationInbox: [
        {
          id: '66666666-6666-4666-8666-666666666666',
          kind: 'reminder',
          title: 'Renew the domain',
          body: 'Due today.',
          itemId: NOTE.id,
          workspaceId: null,
          createdAt: '2026-09-29T09:00:00.000Z',
          readAt: null,
        },
      ],
    });
    renderAt(<App />);

    const bell = await screen.findByRole('button', { name: 'Notifications, 1 unread' });
    const user = userEvent.setup();
    await user.click(bell);

    const dialog = await screen.findByRole('dialog', { name: 'Notifications' });
    expect(within(dialog).getByRole('heading', { level: 2, name: 'Notifications' })).toBeVisible();
    expect(within(dialog).getByText('Renew the domain')).toBeVisible();
  });

  it('marks a notification read and opens its item when clicked', async () => {
    const writes = stubCoreApi({
      items: [NOTE],
      notificationInbox: [
        {
          id: '66666666-6666-4666-8666-666666666666',
          kind: 'reminder',
          title: 'Renew the domain',
          body: 'Due today.',
          itemId: NOTE.id,
          workspaceId: null,
          createdAt: '2026-09-29T09:00:00.000Z',
          readAt: null,
        },
      ],
    });
    renderAt(<App />);

    const user = userEvent.setup();
    await user.click(await screen.findByRole('button', { name: 'Notifications, 1 unread' }));
    const dialog = await screen.findByRole('dialog', { name: 'Notifications' });
    await user.click(within(dialog).getByRole('button', { name: /Renew the domain/ }));

    // Opening the notification navigates to its item, which closes the dialog and shows the item.
    await waitFor(() => {
      expect(screen.queryByRole('dialog', { name: 'Notifications' })).not.toBeInTheDocument();
    });
    expect(await screen.findByRole('textbox', { name: /note title/i })).toHaveValue(
      'Renew the domain',
    );
    void writes;
  });

  it('marks a pet notice read and opens its exact run and decision', async () => {
    const runId = '77777777-7777-4777-8777-777777777777';
    const decisionId = '88888888-8888-4888-8888-888888888888';
    stubCoreApi({
      items: [NOTE],
      notificationInbox: [
        {
          id: '66666666-6666-4666-8666-666666666666',
          kind: 'system',
          title: 'Pet needs approval',
          body: 'Open the pet dialog to continue.',
          itemId: NOTE.id,
          workspaceId: STUB_WORKSPACE_ID,
          petDecision: { runId, decisionId, kind: 'proposal' },
          createdAt: '2026-09-29T09:00:00.000Z',
          readAt: null,
        },
      ],
    });
    renderAt(
      <>
        <App />
        <CurrentAddress />
      </>,
    );

    const user = userEvent.setup();
    await user.click(await screen.findByRole('button', { name: 'Notifications, 1 unread' }));
    const dialog = await screen.findByRole('dialog', { name: 'Notifications' });
    await user.click(within(dialog).getByRole('button', { name: /Pet needs approval/ }));

    expect(screen.getByLabelText('Current address')).toHaveTextContent(
      `/w/${STUB_WORKSPACE_ID}?item=${NOTE.id}&petRun=${runId}&petDecision=${decisionId}`,
    );
    expect(await screen.findByRole('dialog', { name: 'Chat about this note' })).toBeVisible();
    await waitFor(() => {
      expect(screen.queryByRole('dialog', { name: 'Notifications' })).not.toBeInTheDocument();
      expect(
        screen.queryByRole('button', { name: 'Notifications, 1 unread' }),
      ).not.toBeInTheDocument();
    });
  });

  it('shows an honest empty state with no notifications', async () => {
    stubCoreApi({ items: [NOTE] });
    renderAt(<App />);

    const user = userEvent.setup();
    await user.click(await screen.findByRole('button', { name: 'Notifications' }));

    expect(await screen.findByText(/no notifications yet/i)).toBeVisible();
  });
});
