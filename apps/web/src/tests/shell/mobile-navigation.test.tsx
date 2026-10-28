import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { MemoryRouter } from 'react-router';
import { expect, it, vi } from 'vitest';
import { MobileNavigation } from '../../shell/mobile-navigation';
it('offers reachable workspace, search, calendar, inbox and note creation controls', async () => {
  const tree = vi.fn();
  const search = vi.fn();
  const create = vi.fn();
  const openInbox = vi.fn();
  render(
    <MemoryRouter>
      <MobileNavigation
        workspaceId="workspace"
        treeOpen={false}
        creating={false}
        unreadNotifications={0}
        pet={null}
        onTree={tree}
        onSearch={search}
        onCreate={create}
        onOpenInbox={openInbox}
      />
    </MemoryRouter>,
  );
  const user = userEvent.setup();
  await user.click(screen.getByRole('button', { name: 'Explorer' }));
  await user.click(screen.getByRole('button', { name: 'Find' }));
  await user.click(screen.getByRole('button', { name: 'Inbox' }));
  await user.click(screen.getByRole('button', { name: 'New note' }));
  expect(tree).toHaveBeenCalledOnce();
  expect(search).toHaveBeenCalledOnce();
  expect(openInbox).toHaveBeenCalledOnce();
  expect(create).toHaveBeenCalledOnce();
  expect(screen.getByRole('link', { name: 'Calendar' })).toHaveAttribute(
    'href',
    '/w/workspace/calendar',
  );
});

it('announces the unread count as part of the inbox control name', () => {
  render(
    <MemoryRouter>
      <MobileNavigation
        workspaceId="workspace"
        treeOpen={false}
        creating={false}
        unreadNotifications={3}
        pet={null}
        onTree={() => undefined}
        onSearch={() => undefined}
        onCreate={() => undefined}
        onOpenInbox={() => undefined}
      />
    </MemoryRouter>,
  );
  expect(screen.getByRole('button', { name: 'Inbox, 3 unread' })).toBeVisible();
});

it('offers the pet as its own entry, named, with what it is waiting on', () => {
  render(
    <MemoryRouter>
      <MobileNavigation
        workspaceId="workspace"
        treeOpen={false}
        creating={false}
        unreadNotifications={0}
        pet={{ label: 'Cat', attention: 'needs approval' }}
        onTree={vi.fn()}
        onSearch={vi.fn()}
        onCreate={vi.fn()}
        onOpenInbox={vi.fn()}
      />
    </MemoryRouter>,
  );
  expect(screen.getByRole('link', { name: 'Cat, needs approval' })).toHaveAttribute(
    'href',
    '/w/workspace/pet',
  );
  expect(screen.getByRole('button', { name: 'Explorer' })).toBeVisible();
});

it('has no pet entry while the pet page is not offered', () => {
  render(
    <MemoryRouter>
      <MobileNavigation
        workspaceId="workspace"
        treeOpen={false}
        creating={false}
        unreadNotifications={0}
        pet={null}
        onTree={vi.fn()}
        onSearch={vi.fn()}
        onCreate={vi.fn()}
        onOpenInbox={vi.fn()}
      />
    </MemoryRouter>,
  );
  expect(screen.queryByRole('link', { name: /Cat/ })).not.toBeInTheDocument();
  expect(screen.getAllByRole('link')).toHaveLength(1);
});
