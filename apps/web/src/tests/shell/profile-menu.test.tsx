import { act, render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { MemoryRouter } from 'react-router';
import { beforeEach, describe, expect, it, vi } from 'vitest';

import type { CurrentPrincipalState } from '@nix/web-platform/session/use-current-principal';
import { ProfileMenu } from '../../shell/profile-menu';
import { useSessionStore } from '@nix/web-foundation/lib/session-store';
import * as bodies from '@nix/web-foundation/lib/body-cache';
import * as collaboration from '../../editor/collab-sync';
import * as drafts from '@nix/web-foundation/lib/draft-journal';

const WORKSPACE_ID = '00000000-0000-4000-8000-000000000001';
const profile = { subject: 'menu-person', name: 'Ada Person', email: 'ada@example.test' };

const auth = vi.hoisted(() => ({
  accountUrl: null as string | null,
  signOut: vi.fn(() => Promise.resolve()),
}));

// The menu reads only these two seams; stubbing them keeps the test off the provider stack.
vi.mock('@nix/web-platform/auth/auth-provider', () => ({
  useAuth: () => ({
    accountUrl: auth.accountUrl,
    signOut: auth.signOut,
    signIn: () => Promise.resolve(),
    getAccessToken: () => Promise.resolve(null),
    isConfigured: true,
  }),
}));

vi.mock('@nix/web-workspaces/workspaces/workspace-context', () => ({
  useWorkspace: () => ({ workspaceId: WORKSPACE_ID }),
}));

const principal: CurrentPrincipalState = {
  status: 'ready',
  principal: {
    id: '00000000-0000-4000-8000-000000000002',
    tenantId: '00000000-0000-4000-8000-000000000003',
    displayName: 'Ada Person',
    email: 'ada@example.test',
    isTenantAdministrator: false,
    features: { sites: false, mcpUrl: null, operator: false, siteApprover: false },
  },
  error: null,
  reload: () => Promise.resolve(),
};

async function openMenu(): Promise<void> {
  render(
    <MemoryRouter>
      <ProfileMenu principal={principal} />
    </MemoryRouter>,
  );
  await userEvent.setup().click(screen.getByRole('button', { name: /Ada Person/ }));
}

beforeEach(() => {
  auth.accountUrl = null;
  auth.signOut.mockReset().mockResolvedValue(undefined);
  useSessionStore.setState({ status: 'authenticated', profile, error: null });
  vi.spyOn(bodies, 'bodyCacheAccountEpoch').mockReturnValue('menu-epoch');
  vi.spyOn(collaboration, 'flushLocalDraftsForAccount').mockResolvedValue(undefined);
  vi.spyOn(drafts, 'listDraftScopes').mockResolvedValue([]);
});

describe('ProfileMenu', () => {
  it('offers Install Nix, with the steps when the browser gives no prompt', async () => {
    vi.stubGlobal('matchMedia', (query: string) => ({
      matches: false,
      media: query,
      addEventListener: vi.fn(),
      removeEventListener: vi.fn(),
    }));
    await openMenu();
    await userEvent.setup().click(screen.getByRole('button', { name: 'Install Nix' }));
    expect(await screen.findByRole('dialog', { name: 'Install Nix' })).toBeVisible();
    vi.unstubAllGlobals();
  });

  it('does not offer Install Nix once running as an installed app', async () => {
    vi.stubGlobal('matchMedia', (query: string) => ({
      matches: query === '(display-mode: standalone)',
      media: query,
      addEventListener: vi.fn(),
      removeEventListener: vi.fn(),
    }));
    await openMenu();
    expect(screen.queryByRole('button', { name: 'Install Nix' })).not.toBeInTheDocument();
    vi.unstubAllGlobals();
  });

  it('lets the keyboard reach and change appearance without dismissing the menu', async () => {
    const user = userEvent.setup();
    await openMenu();
    expect(screen.getByRole('link', { name: 'Settings' })).toHaveFocus();
    await user.tab({ shift: true });
    expect(screen.getByRole('radio', { name: 'System' })).toHaveFocus();
    await user.keyboard('{ArrowRight}');
    expect(screen.getByRole('dialog', { name: 'Account' })).toBeInTheDocument();
    expect(screen.getByRole('radio', { name: 'Light' })).toHaveFocus();
    expect(screen.getByRole('radio', { name: 'Light' })).toBeChecked();
    await user.keyboard('{Escape}');
    expect(screen.queryByRole('dialog', { name: 'Account' })).not.toBeInTheDocument();
    expect(screen.getByRole('button', { name: /Ada Person/ })).toHaveFocus();
  });

  it('links to the identity provider account page in a new tab when Core names one', async () => {
    auth.accountUrl = 'https://sso.example.test/ui/console/users/me?id=security';

    await openMenu();

    const link = screen.getByRole('link', { name: /Password and security/ });
    expect(link).toHaveAttribute(
      'href',
      'https://sso.example.test/ui/console/users/me?id=security',
    );
    expect(link).toHaveAttribute('target', '_blank');
    expect(link).toHaveAttribute('rel', 'noopener noreferrer');
    expect(link).toHaveAccessibleName('Password and security (opens in a new tab)');
  });

  it('offers no account link when the deployment names no account page', async () => {
    await openMenu();

    expect(screen.getByRole('link', { name: 'Settings' })).toHaveAttribute(
      'href',
      `/w/${WORKSPACE_ID}/settings`,
    );
    expect(screen.getByRole('link', { name: 'Settings' })).not.toHaveAttribute('target');
    expect(screen.queryByRole('link', { name: /Password and security/ })).toBeNull();
  });

  it('blocks editing while saving and confirms journaled changes before removing them', async () => {
    let finishSave: (() => void) | undefined;
    vi.mocked(collaboration.flushLocalDraftsForAccount).mockReturnValue(
      new Promise<void>((resolve) => {
        finishSave = resolve;
      }),
    );
    vi.mocked(drafts.listDraftScopes).mockResolvedValue(['pending-scope']);
    await openMenu();
    const user = userEvent.setup();
    await user.click(screen.getByRole('button', { name: 'Sign out' }));
    expect(screen.getByRole('dialog', { name: 'Checking saved edits' })).toBeVisible();
    await user.keyboard('{Escape}');
    expect(screen.getByRole('dialog', { name: 'Checking saved edits' })).toBeVisible();
    expect(drafts.listDraftScopes).not.toHaveBeenCalled();
    expect(auth.signOut).not.toHaveBeenCalled();
    await act(() => {
      finishSave?.();
      return Promise.resolve();
    });
    expect(
      await screen.findByRole('dialog', { name: 'Sign out with pending changes?' }),
    ).toBeVisible();
    expect(collaboration.flushLocalDraftsForAccount).toHaveBeenCalledWith(profile.subject);
    await user.click(screen.getByRole('button', { name: 'Sign out and remove local notes' }));
    expect(auth.signOut).toHaveBeenCalledOnce();
  });

  it.each(['local save', 'pending inventory'])(
    'keeps the current session when %s fails',
    async (failure) => {
      if (failure === 'local save')
        vi.mocked(collaboration.flushLocalDraftsForAccount).mockRejectedValue(
          new Error('Local save failed.'),
        );
      else
        vi.mocked(drafts.listDraftScopes).mockRejectedValue(new Error('Pending inventory failed.'));
      await openMenu();
      await userEvent.setup().click(screen.getByRole('button', { name: 'Sign out' }));
      expect(await screen.findByRole('alert')).toHaveTextContent('failed.');
      expect(auth.signOut).not.toHaveBeenCalled();
      expect(screen.queryByRole('dialog')).not.toBeInTheDocument();
      expect(useSessionStore.getState().profile).toEqual(profile);
    },
  );

  it.each(['another account', 'a fresh session for the same account'])(
    'cancels a pending save check when %s starts',
    async (changed) => {
      let finishSave: (() => void) | undefined;
      vi.mocked(collaboration.flushLocalDraftsForAccount).mockReturnValue(
        new Promise<void>((resolve) => {
          finishSave = resolve;
        }),
      );
      await openMenu();
      await userEvent.setup().click(screen.getByRole('button', { name: 'Sign out' }));
      expect(screen.getByRole('dialog', { name: 'Checking saved edits' })).toBeVisible();
      vi.mocked(bodies.bodyCacheAccountEpoch).mockReturnValue('replacement-epoch');
      if (changed === 'another account')
        useSessionStore.setState({ profile: { ...profile, subject: 'another-person' } });
      await act(() => {
        finishSave?.();
        return Promise.resolve();
      });
      expect(await screen.findByRole('alert')).toHaveTextContent('account changed');
      expect(drafts.listDraftScopes).not.toHaveBeenCalled();
      expect(auth.signOut).not.toHaveBeenCalled();
      expect(screen.queryByRole('dialog')).not.toBeInTheDocument();
    },
  );

  it.each(['another account', 'a fresh session for the same account'])(
    'rejects a confirmation from the old session after %s starts',
    async (changed) => {
      vi.mocked(drafts.listDraftScopes).mockResolvedValue(['pending-scope']);
      await openMenu();
      await userEvent.setup().click(screen.getByRole('button', { name: 'Sign out' }));
      expect(
        await screen.findByRole('dialog', { name: 'Sign out with pending changes?' }),
      ).toBeVisible();
      vi.mocked(bodies.bodyCacheAccountEpoch).mockReturnValue('replacement-epoch');
      if (changed === 'another account')
        useSessionStore.setState({ profile: { ...profile, subject: 'another-person' } });
      await userEvent
        .setup()
        .click(screen.getByRole('button', { name: 'Sign out and remove local notes' }));
      expect(await screen.findByRole('alert')).toHaveTextContent('account changed');
      expect(auth.signOut).not.toHaveBeenCalled();
    },
  );

  it('confirms device-wide removal even when this tab found no pending edits', async () => {
    await openMenu();
    const user = userEvent.setup();
    await user.click(screen.getByRole('button', { name: 'Sign out' }));
    expect(
      await screen.findByRole('dialog', { name: 'Sign out and remove local notes?' }),
    ).toHaveTextContent('including changes in other tabs');
    expect(auth.signOut).not.toHaveBeenCalled();
    await user.click(screen.getByRole('button', { name: 'Sign out and remove local notes' }));
    expect(auth.signOut).toHaveBeenCalledOnce();
  });
});
