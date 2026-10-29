import { screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { beforeEach, describe, expect, it } from 'vitest';

import { App } from '../../../app';
import { stubCoreApi } from '@nix/web-foundation/testing/api-stub';
import { renderAt, signedIn } from '@nix/web-editor/testing/render-with-router';
import { layerRoutes, reply } from './fake-routes';

const SITE = '5a5a5a5a-1111-4111-8111-5a5a5a5a5a5a';
const entry = {
  siteId: SITE,
  workspaceId: '00000000-0000-4000-8000-000000000001',
  slug: 'garden',
  name: 'Garden notes',
  hostnames: ['garden.nixsites.com'],
  requestedBy: '9b9b9b9b-1111-4111-8111-9b9b9b9b9b9b',
  approval: {
    state: 'pending',
    requestedAt: '2026-10-16T09:00:00.000Z',
    decidedAt: null,
    note: null,
  },
  build: null,
};

beforeEach(() => {
  signedIn();
});

function serve(options: { approvals?: unknown[]; refuse?: boolean } = {}) {
  let pending = options.approvals ?? [entry];
  return layerRoutes((call) => {
    if (call.path === '/api/v1/sites/approvals') {
      return options.refuse === true
        ? reply({ code: 'sites.operator_required', detail: 'Not an approver.' }, 403)
        : reply({ approvals: pending });
    }
    if (call.method === 'POST' && call.path.startsWith(`/api/v1/sites/${SITE}/approval/`)) {
      pending = [];
      return reply({ ...entry, approval: { ...entry.approval, state: 'approved' } });
    }
    return undefined;
  });
}

describe('Settings > Site approvals', () => {
  it('is hidden from anyone who is not an approver', async () => {
    stubCoreApi({ siteApprover: false });
    renderAt(<App />, '/settings?tab=site-approvals');
    expect(await screen.findByRole('link', { name: 'MCP' })).toBeVisible();
    expect(screen.queryByRole('link', { name: 'Site approvals' })).not.toBeInTheDocument();
  });

  it('lists waiting sites and approves one after confirmation, then refreshes', async () => {
    stubCoreApi({ siteApprover: true });
    const calls = serve();
    renderAt(<App />, '/settings?tab=site-approvals');
    const user = userEvent.setup();

    const table = await screen.findByRole('table');
    expect(await within(table).findByText('Garden notes (garden)')).toBeVisible();
    expect(within(table).getByText('garden.nixsites.com')).toBeVisible();

    await user.click(screen.getByRole('button', { name: 'Approve Garden notes' }));
    const dialog = await screen.findByRole('dialog');
    expect(calls.some((call) => call.method === 'POST')).toBe(false);
    await user.click(within(dialog).getByRole('button', { name: 'Approve and publish' }));

    await waitFor(() => {
      expect(calls.some((call) => call.path === `/api/v1/sites/${SITE}/approval/approve`)).toBe(
        true,
      );
    });
    expect(await screen.findByText(/No site is waiting for approval/)).toBeVisible();
  });

  it('rejects with an optional note', async () => {
    stubCoreApi({ siteApprover: true });
    const calls = serve();
    renderAt(<App />, '/settings?tab=site-approvals');
    const user = userEvent.setup();

    await user.click(await screen.findByRole('button', { name: 'Reject Garden notes' }));
    const dialog = await screen.findByRole('dialog');
    await user.type(within(dialog).getByLabelText('Note (optional)'), 'Not yet');
    await user.click(within(dialog).getByRole('button', { name: 'Reject' }));

    await waitFor(() => {
      expect(calls).toContainEqual({
        method: 'POST',
        path: `/api/v1/sites/${SITE}/approval/reject`,
        body: { note: 'Not yet' },
      });
    });
    expect(await screen.findByText(/No site is waiting for approval/)).toBeVisible();
  });

  it('shows the error panel with a retry when the list is refused', async () => {
    stubCoreApi({ siteApprover: true });
    serve({ refuse: true });
    renderAt(<App />, '/settings?tab=site-approvals');
    expect(await screen.findByText('Site approvals could not be loaded')).toBeVisible();
    expect(screen.getByText('Not an approver.')).toBeVisible();
    expect(screen.getByRole('button', { name: 'Try again' })).toBeVisible();
  });
});
