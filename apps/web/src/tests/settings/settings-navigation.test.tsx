import { screen, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { useNavigationType } from 'react-router';
import { beforeEach, describe, expect, it } from 'vitest';

import { stubCoreApi } from '../api-stub';
import { renderAt, signedIn } from '../render-with-router';
import { App } from '../../app';
import { SettingsPage } from '../../pages/settings-page';
import {
  CapabilitiesProvider,
  NO_CAPABILITIES,
} from '@nix/web-platform/session/capabilities-context';
import { stubViewport } from '../stub-viewport';

/**
 * How the settings screen is reached: by address, from the persistent rail, and through the
 * profile menu. The rail makes workspace administration findable; the account menu keeps the
 * personal-token path available where somebody already expects it.
 */

beforeEach(() => {
  signedIn();
  stubCoreApi();
});

function NavigationType() {
  return <output aria-label="navigation type">{useNavigationType()}</output>;
}

describe('reaching the settings screen', () => {
  it('lists sections as navigation links at its own address, under a single main landmark', async () => {
    renderAt(<App />, '/settings');

    expect(await screen.findByRole('heading', { level: 1, name: 'Settings' })).toBeVisible();
    const workspaceNav = screen.getByRole('navigation', { name: 'Workspace settings' });
    expect(within(workspaceNav).getByRole('link', { name: 'Workspace' })).toHaveAttribute(
      'aria-current',
      'page',
    );
    expect(screen.getByRole('heading', { level: 2, name: /workspace/i })).toBeVisible();
    expect(screen.getAllByRole('main')).toHaveLength(1);

    const user = userEvent.setup();
    const yourNav = screen.getByRole('navigation', { name: 'Your settings' });
    await user.click(within(yourNav).getByRole('link', { name: 'Editor' }));
    expect(await screen.findByRole('heading', { level: 2, name: 'Editor' })).toBeVisible();
    expect(within(yourNav).getByRole('link', { name: 'Editor' })).toHaveAttribute(
      'aria-current',
      'page',
    );
    expect(
      screen.queryByRole('heading', { level: 2, name: 'Access tokens' }),
    ).not.toBeInTheDocument();
  });

  it('keeps an old tab address on the section it always named', async () => {
    renderAt(<App />, '/settings?tab=integrations');

    expect(await screen.findByRole('link', { name: 'Calendars' })).toHaveAttribute(
      'aria-current',
      'page',
    );
    expect(await screen.findByRole('heading', { level: 2, name: 'Calendars' })).toBeVisible();
  });

  it('lists the sections in group order without the gated ones for an ordinary account', async () => {
    // No sites on this install, so General has nothing to show and is left out.
    renderAt(<App />, '/settings');

    await screen.findByRole('navigation', { name: 'Your settings' });
    const navs = screen.getAllByRole('navigation', {
      name: /^(Your|Workspace|Administration) settings$/,
    });
    expect(navs.map((nav) => nav.getAttribute('aria-label'))).toEqual([
      'Your settings',
      'Workspace settings',
    ]);
    expect(
      navs.flatMap((nav) =>
        within(nav)
          .getAllByRole('link')
          .map((link) => link.textContent),
      ),
    ).toEqual([
      'Editor',
      'Daily notes',
      'Notifications',
      'Calendars',
      'Pets',
      'Workspace',
      'Access tokens',
      'MCP',
      'API',
    ]);
  });

  it('adds an Administration group when the account may operate the install', () => {
    renderAt(
      <CapabilitiesProvider
        value={{ ...NO_CAPABILITIES, operator: true, siteApprover: true, sites: true }}
      >
        <SettingsPage />
      </CapabilitiesProvider>,
      '/settings?tab=preferences',
    );

    const nav = screen.getByRole('navigation', { name: 'Administration settings' });
    expect(
      within(nav)
        .getAllByRole('link')
        .map((link) => link.textContent),
    ).toEqual(['Site approvals', 'Administrators', 'Backups']);
  });

  it('sends the old publishing address to the General toggle', () => {
    renderAt(
      <CapabilitiesProvider value={{ ...NO_CAPABILITIES, sites: true }}>
        <SettingsPage />
      </CapabilitiesProvider>,
      '/settings?tab=publishing',
    );

    expect(screen.getByRole('link', { name: 'General' })).toHaveAttribute('aria-current', 'page');
    expect(screen.getByRole('checkbox', { name: 'Show publishing on pages' })).toBeVisible();
  });

  it('falls back to the default section for a gated one the account cannot see', async () => {
    renderAt(<App />, '/settings?tab=backups');

    expect(await screen.findByRole('link', { name: 'Workspace' })).toHaveAttribute(
      'aria-current',
      'page',
    );
    expect(screen.queryByRole('link', { name: 'Backups' })).not.toBeInTheDocument();
  });

  describe('on a phone', () => {
    beforeEach(() => {
      stubViewport(false);
    });

    it('shows the list, drills into a section, and returns focus to its row', async () => {
      const user = userEvent.setup();
      renderAt(<App />, '/settings');

      expect(await screen.findByRole('heading', { level: 1, name: 'Settings' })).toBeVisible();
      expect(screen.queryByRole('heading', { level: 2 })).not.toBeInTheDocument();
      await user.click(await screen.findByRole('link', { name: 'Calendars' }));

      const heading = await screen.findByRole('heading', { level: 2, name: 'Calendars' });
      expect(heading.closest('[tabindex="-1"]')).toHaveFocus();

      await user.click(screen.getByRole('link', { name: 'Settings' }));
      expect(await screen.findByRole('link', { name: 'Calendars' })).toHaveFocus();
      expect(screen.queryByRole('heading', { level: 2 })).not.toBeInTheDocument();
    });
  });

  it('goes back to the section list by undoing the push, not adding another entry', async () => {
    stubViewport(false);
    const user = userEvent.setup();
    renderAt(
      <>
        <App />
        <NavigationType />
      </>,
      '/settings',
    );

    await user.click(await screen.findByRole('link', { name: 'Calendars' }));
    await screen.findByRole('heading', { level: 2, name: 'Calendars' });
    await user.click(screen.getByRole('link', { name: 'Settings' }));

    expect(await screen.findByRole('link', { name: 'Calendars' })).toHaveFocus();
    expect(screen.getByLabelText('navigation type')).toHaveTextContent('POP');
  });

  it('is reachable from the profile menu as a real link', async () => {
    const user = userEvent.setup();
    renderAt(<App />, '/');

    // The menu button is named by the profile it shows once /me has answered.
    await user.click(await screen.findByRole('button', { name: /test person/i }));
    await user.click(
      within(screen.getByRole('dialog', { name: /account/i })).getByRole('link', {
        name: /settings/i,
      }),
    );

    expect(await screen.findByRole('heading', { level: 1, name: 'Settings' })).toBeVisible();
  });

  it('is reachable from the left rail and becomes its current destination', async () => {
    const user = userEvent.setup();
    renderAt(<App />, '/');

    const rail = await screen.findByRole('navigation', { name: /destinations/i });
    await user.click(within(rail).getByRole('link', { name: 'Settings' }));

    expect(await screen.findByRole('heading', { level: 1, name: 'Settings' })).toBeVisible();
    expect(within(rail).getByRole('link', { name: 'Settings' })).toHaveAttribute(
      'aria-current',
      'page',
    );
  });
});
