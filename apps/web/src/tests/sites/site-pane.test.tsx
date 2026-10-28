import { NixApiError, NixErrorKind, type Site } from '@nix/api-client';
import { render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { beforeEach, describe, expect, it, vi } from 'vitest';

import { SitePane, SitePaneView } from '@nix/web-sites/sites/site-pane';
import type { ItemSiteActions, ItemSiteState } from '@nix/web-sites/sites/use-item-site';
import {
  OLD_BUILD_ID,
  ROOT_ID,
  WORKSPACE_ID,
  publishedSite,
  site,
  siteBuild,
} from './site-fixtures';

interface Endpoint {
  readonly operation: string;
  readonly body?: unknown;
}

const client = {
  query: vi.fn<(endpoint: Endpoint) => Promise<unknown>>(),
  execute: vi.fn<(endpoint: Endpoint) => Promise<unknown>>(),
  paginate: vi.fn(),
};
let canRename = true;

vi.mock('@nix/web-platform/api/api-client-provider', () => ({
  useApiClient: () => client,
  useOptionalApiClient: () => client,
}));
vi.mock('@nix/web-workspaces/workspaces/workspace-context', () => ({
  useWorkspace: () => ({ workspaceId: WORKSPACE_ID, workspace: { canRename } }),
}));

function refusal(code: string, status = 409): NixApiError {
  return new NixApiError({ kind: NixErrorKind.Problem, code, message: code, status, detail: code });
}

function serve(current: Site, builds = [siteBuild()]): void {
  client.query.mockImplementation((endpoint) => {
    switch (endpoint.operation) {
      case 'sites.getForItem':
      case 'sites.get':
        return Promise.resolve(current);
      case 'sites.builds.list':
        return Promise.resolve({ builds });
      default:
        return Promise.reject(new Error(`unexpected ${endpoint.operation}`));
    }
  });
}

const accept = (): Promise<string | null> => Promise.resolve(null);
const actions: ItemSiteActions = {
  retry: () => undefined,
  create: accept,
  update: accept,
  setHostnames: accept,
  publish: accept,
  rollback: accept,
  unpublish: accept,
  remove: accept,
  setPath: accept,
  listPages: () => Promise.resolve([]),
  listChildren: () => Promise.resolve([]),
  listProperties: () => Promise.resolve([]),
};

function ready(current: Site): Extract<ItemSiteState, { phase: 'ready' }> {
  return {
    phase: 'ready',
    site: current,
    builds: [],
    buildsError: null,
    rollingBackTo: null,
    rollbackStalled: false,
  };
}

beforeEach(() => {
  client.query.mockReset();
  client.execute.mockReset();
  canRename = true;
});

describe('the Site pane', () => {
  it('offers an owner to make the item a site, and says why an address was refused', async () => {
    const user = userEvent.setup();
    client.query.mockRejectedValue(refusal('sites.not_found', 404));
    client.execute.mockRejectedValue(refusal('sites.slug_reserved', 422));
    render(<SitePane itemId={ROOT_ID} title="Garden Notes" />);

    const address = await screen.findByRole('textbox', { name: /address/i });
    expect(address).toHaveValue('garden-notes');

    await user.click(screen.getByRole('button', { name: /make this a site/i }));

    expect(await screen.findByText(/that address is reserved/i)).toBeVisible();
  });

  it('tells somebody who cannot manage that the item is not a site, without offering to make one', async () => {
    canRename = false;
    client.query.mockRejectedValue(refusal('sites.not_found', 404));
    render(<SitePane itemId={ROOT_ID} title="Garden" />);

    expect(await screen.findByRole('status')).toHaveTextContent(/only a workspace owner/i);
    expect(screen.queryByRole('button', { name: /make this a site/i })).not.toBeInTheDocument();
  });

  it('shows a failed load with a retry', async () => {
    const user = userEvent.setup();
    client.query.mockRejectedValueOnce(refusal('server.unavailable', 503));
    render(<SitePane itemId={ROOT_ID} title="Garden" />);

    expect(await screen.findByRole('alert')).toHaveTextContent(/could not be loaded/i);
    serve(site());
    await user.click(screen.getByRole('button', { name: /retry/i }));
    expect(await screen.findByRole('heading', { name: 'Garden notes' })).toBeVisible();
  });

  it('publishes the first time only after the disclosure is acknowledged', async () => {
    const user = userEvent.setup();
    serve(site());
    client.execute.mockResolvedValue(siteBuild({ status: 'queued', activatedAt: null }));
    render(<SitePane itemId={ROOT_ID} title="Garden" />);

    await user.click(await screen.findByRole('button', { name: /^publish$/i }));
    const dialog = await screen.findByRole('dialog', { name: /publish this site/i });
    const confirm = within(dialog).getByRole('button', { name: /^publish$/i });
    expect(confirm).toBeDisabled();
    expect(dialog).toHaveTextContent(/cannot recall copies/i);

    await user.click(within(dialog).getByRole('checkbox', { name: /i understand/i }));
    await user.click(confirm);

    await waitFor(() => {
      expect(client.execute).toHaveBeenCalledWith(
        expect.objectContaining({
          operation: 'sites.publish',
          body: expect.objectContaining({ acknowledgeDisclosure: true }) as unknown,
        }),
      );
    });
    expect(await screen.findByText(/waiting for a worker/i)).toBeVisible();
  });

  it('shows a live site with its addresses and losses', async () => {
    serve(publishedSite());
    render(<SitePane itemId={ROOT_ID} title="Garden" />);

    expect(await screen.findByRole('link', { name: 'https://garden.nixsites.com/' })).toBeVisible();
    const addresses = screen.getByRole('list', { name: /addresses/i });
    expect(within(addresses).getByText('garden.example.com')).toBeVisible();
    expect(screen.getByText(/the diagram on \/plans\/ is shown as code/i)).toBeVisible();
    expect(screen.getByText(/live since .*12 pages/i)).toBeVisible();
  });

  it('warns that a rollback re-serves content as it was, then rolls back', async () => {
    const user = userEvent.setup();
    serve(publishedSite(), [siteBuild(), siteBuild({ id: OLD_BUILD_ID, status: 'superseded' })]);
    client.execute.mockResolvedValue(siteBuild({ id: OLD_BUILD_ID, status: 'superseded' }));
    render(<SitePane itemId={ROOT_ID} title="Garden" />);

    await user.click(await screen.findByRole('button', { name: /roll back to the build/i }));
    const dialog = await screen.findByRole('dialog', { name: /roll back/i });
    expect(dialog).toHaveTextContent(/since been locked, trashed or left out/i);
    await user.click(within(dialog).getByRole('button', { name: /^roll back$/i }));

    await waitFor(() => {
      expect(client.execute).toHaveBeenCalledWith(
        expect.objectContaining({ operation: 'sites.rollback', body: { buildId: OLD_BUILD_ID } }),
      );
    });
    expect(await screen.findByText(/rolling back/i)).toBeVisible();
  });

  it('says what a failed build means', async () => {
    const failed = siteBuild({
      status: 'failed',
      failureCode: 'site_body_withheld',
      activatedAt: null,
    });
    serve(site({ latestBuild: failed }), [failed]);
    render(<SitePane itemId={ROOT_ID} title="Garden" />);

    expect(await screen.findByText(/a page could not be read/i)).toBeVisible();
    expect(screen.getByText(/nothing was published\. publish again to retry/i)).toBeVisible();
    expect(screen.getByText('Build failed')).toBeVisible();
  });

  it('asks for the disclosure again before republishing an unpublished site', async () => {
    const user = userEvent.setup();
    serve(site({ status: 'unpublished' }), []);
    render(<SitePane itemId={ROOT_ID} title="Garden" />);

    await user.click(await screen.findByRole('button', { name: /publish again/i }));
    const dialog = await screen.findByRole('dialog', { name: /publish this site/i });
    expect(dialog).toHaveTextContent(/later edits are not public until you publish again/i);
    expect(client.execute).not.toHaveBeenCalled();
  });

  it('keeps unsaved settings while the site is re-read, and offers a reload when it changed', async () => {
    const user = userEvent.setup();
    const view = render(
      <SitePaneView state={ready(site())} actions={actions} rootTitle="Garden" canCreate />,
    );
    const name = screen.getByRole('textbox', { name: /site name/i });
    await user.clear(name);
    await user.type(name, 'Allotment');

    // A poll answers with the same settings and a newer timestamp.
    view.rerender(
      <SitePaneView
        state={ready(site({ updatedAt: '2026-10-11T08:05:00+00:00' }))}
        actions={actions}
        rootTitle="Garden"
        canCreate
      />,
    );
    expect(screen.getByRole('textbox', { name: /site name/i })).toHaveValue('Allotment');
    expect(screen.queryByText(/settings changed elsewhere/i)).not.toBeInTheDocument();

    const renamed = site();
    view.rerender(
      <SitePaneView
        state={ready({ ...renamed, settings: { ...renamed.settings, name: 'Orchard' } })}
        actions={actions}
        rootTitle="Garden"
        canCreate
      />,
    );
    expect(screen.getByRole('textbox', { name: /site name/i })).toHaveValue('Allotment');
    expect(screen.getByText(/settings changed elsewhere/i)).toBeVisible();
    await user.click(screen.getByRole('button', { name: /reload settings/i }));
    expect(screen.getByRole('textbox', { name: /site name/i })).toHaveValue('Orchard');
  });

  it('says when a rollback has not taken effect', () => {
    render(
      <SitePaneView
        state={{ ...ready(publishedSite()), rollbackStalled: true }}
        actions={actions}
        rootTitle="Garden"
        canCreate
      />,
    );
    expect(screen.getByRole('status')).toHaveTextContent(
      'The rollback has not taken effect yet. Refresh, or try again.',
    );
  });

  it('keeps the site on screen when its builds cannot be loaded', async () => {
    client.query.mockImplementation((endpoint) =>
      endpoint.operation === 'sites.builds.list'
        ? Promise.reject(refusal('server.unavailable', 503))
        : Promise.resolve(publishedSite()),
    );
    render(<SitePane itemId={ROOT_ID} title="Garden" />);

    expect(await screen.findByText(/previous builds could not be loaded/i)).toBeVisible();
    expect(screen.getByRole('heading', { name: 'Garden notes' })).toBeVisible();
  });

  it('shows a reader the site without the controls', async () => {
    serve(publishedSite({ canManage: false }));
    render(<SitePane itemId={ROOT_ID} title="Garden" />);

    expect(await screen.findByText(/only a workspace owner can change/i)).toBeVisible();
    expect(screen.queryByRole('button', { name: /unpublish/i })).not.toBeInTheDocument();
    expect(screen.queryByRole('form', { name: /site settings/i })).not.toBeInTheDocument();
  });
});
