import { screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { useLocation, useNavigationType } from 'react-router';
import { beforeEach, describe, expect, it, vi } from 'vitest';

import { STUB_WORKSPACE_ID, stubCoreApi } from '@nix/web-foundation/testing/api-stub';
import { renderAt, signedIn } from '@nix/web-editor/testing/render-with-router';
import { App } from '../../app';
import { SettingsPage } from '../../pages/settings-page';
import {
  CapabilitiesProvider,
  NO_CAPABILITIES,
} from '@nix/web-platform/session/capabilities-context';
import { stubViewport } from '@nix/web-foundation/testing/stub-viewport';
import { json } from '@nix/web-foundation/testing/json-response';
import { requestUrl } from '@nix/web-foundation/testing/request-url';

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

    // Desktop shows the screen as a dialog over the work; the dialog's title names it.
    expect(await screen.findByRole('dialog', { name: 'Settings' })).toBeVisible();
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

  it('says so in Connections when the workspace has none available', async () => {
    renderAt(<App />, `/w/${STUB_WORKSPACE_ID}/settings?tab=connections`);

    const connections = within(await screen.findByRole('region', { name: 'Connections' }));
    expect(
      await connections.findByText('Connections are not available in this workspace.'),
    ).toBeVisible();
  });

  it('lets the owner disconnect an existing resource while pet connections are paused', async () => {
    const route = `/api/v1/workspaces/${STUB_WORKSPACE_ID}/pet-connections`;
    const connection = {
      id: '6a16da3f-d587-47c0-be4d-a125ca5a3961',
      revision: 'c6fb32a2-d9bc-41df-aeb9-8403e24b2b58',
      provider: 'mcp',
      resourceKind: 'tool',
      resourceId: 'https://mcp.test/mcp#lookup',
      actions: ['remote.invoke'],
    };
    const inner = globalThis.fetch;
    let disconnected = false;
    vi.stubGlobal('fetch', (input: RequestInfo | URL, init?: RequestInit) => {
      const path = new URL(requestUrl(input), globalThis.location.origin).pathname;
      if (path === route) {
        return Promise.resolve(
          json({ enabled: false, connections: disconnected ? [] : [connection] }),
        );
      }
      const method = init?.method ?? (input instanceof Request ? input.method : 'GET');
      if (path === `${route}/${connection.id}` && method === 'DELETE') {
        disconnected = true;
        return Promise.resolve(new Response(null, { status: 204 }));
      }
      return inner(input, init);
    });
    renderAt(<App />, `/w/${STUB_WORKSPACE_ID}/settings?tab=connections`);

    const area = within(await screen.findByRole('region', { name: 'Pet connections' }));
    expect(area.getByText(/mcp\.test/)).toBeVisible();
    await userEvent.setup().click(area.getByRole('button', { name: 'Disconnect' }));
    await waitFor(() => {
      expect(screen.queryByText(/mcp\.test/)).not.toBeInTheDocument();
    });
    expect(disconnected).toBe(true);
  });

  it('lists the sections in group order without the gated ones for an ordinary account', async () => {
    // General (appearance) is always there; its publishing switch needs sites on the install.
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
      'General',
      'Editor',
      'Daily notes',
      'Notifications',
      'Calendars',
      'Companion',
      'About',
      'Workspace',
      'Connections',
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

  it('explains an unavailable settings link without showing a different section', async () => {
    renderAt(<App />, '/settings?tab=backups');

    expect(
      await screen.findByRole('heading', { name: 'This setting is unavailable' }),
    ).toBeVisible();
    expect(screen.queryByRole('link', { name: 'Backups' })).not.toBeInTheDocument();
  });

  it.each([true, false])('finds the theme by keyword in Settings (wide: %s)', async (wide) => {
    stubViewport(wide);
    const user = userEvent.setup();
    renderAt(<App />, '/settings');

    await user.type(await screen.findByRole('searchbox', { name: 'Search settings' }), 'theme');
    expect(screen.queryByRole('link', { name: 'Editor' })).not.toBeInTheDocument();
    await user.click(screen.getByRole('link', { name: 'General' }));
    await user.click(await screen.findByRole('button', { name: 'Theme' }));
    expect(await screen.findByRole('dialog', { name: 'Theme' })).toBeVisible();
  });

  it('opens the layout and sidebar preferences directly from General', async () => {
    stubViewport(true);
    const user = userEvent.setup();
    renderAt(<App />, '/settings?tab=preferences');

    await user.click(await screen.findByRole('button', { name: 'Layout and sidebar' }));
    const preferences = await screen.findByRole('dialog', { name: 'Preferences' });
    expect(within(preferences).getByRole('group', { name: 'Layout presets' })).toBeVisible();
    expect(screen.queryByRole('dialog', { name: 'Settings' })).not.toBeInTheDocument();
  });

  it('returns to the exact work address when closing Settings on a landscape tablet', async () => {
    stubViewport(1024, { touch: true, portrait: false });
    const user = userEvent.setup();
    const work = `/w/${STUB_WORKSPACE_ID}/calendar?grain=week#agenda`;

    function Address() {
      const { pathname, search, hash } = useLocation();
      return (
        <output aria-label="current address">
          {pathname}
          {search}
          {hash}
        </output>
      );
    }

    renderAt(
      <>
        <App />
        <Address />
      </>,
      work,
    );
    const rail = await screen.findByRole('navigation', { name: 'Destinations' });
    await user.click(within(rail).getByRole('link', { name: 'Settings' }));
    await user.click(await screen.findByRole('button', { name: 'Close settings' }));
    expect(screen.getByLabelText('current address')).toHaveTextContent(work);
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
    await user.click(await screen.findByRole('button', { name: /^test person(?!'s workspace)/i }));
    await user.click(
      within(screen.getByRole('dialog', { name: /account/i })).getByRole('link', {
        name: /settings/i,
      }),
    );

    expect(await screen.findByRole('dialog', { name: 'Settings' })).toBeVisible();
  });

  it('is reachable from the left rail, opening over the page the person was on', async () => {
    const user = userEvent.setup();
    renderAt(<App />, '/');

    const rail = await screen.findByRole('navigation', { name: /destinations/i });
    await user.click(within(rail).getByRole('link', { name: 'Settings' }));

    expect(await screen.findByRole('dialog', { name: 'Settings' })).toBeVisible();
    expect(within(rail).getByRole('link', { name: 'Homebase' })).toHaveAttribute(
      'aria-current',
      'page',
    );
  });
});
