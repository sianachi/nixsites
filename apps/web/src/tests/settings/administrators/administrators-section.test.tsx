import { screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { beforeEach, describe, expect, it } from 'vitest';

import { App } from '../../../app';
import { stubCoreApi } from '@nix/web-foundation/testing/api-stub';
import { renderAt, signedIn } from '@nix/web-editor/testing/render-with-router';
import { layerRoutes, reply } from '../site-approvals/fake-routes';

const ADA = 'a1a1a1a1-1111-4111-8111-a1a1a1a1a1a1';
const BEN = 'b2b2b2b2-2222-4222-8222-b2b2b2b2b2b2';
const CAL = 'c3c3c3c3-3333-4333-8333-c3c3c3c3c3c3';
const people = [
  { principalId: ADA, displayName: 'Ada Admin', kind: 'user' },
  { principalId: BEN, displayName: 'Ben Builder', kind: 'user' },
  { principalId: CAL, displayName: 'Cal Candidate', kind: 'user' },
];

beforeEach(() => {
  signedIn();
});

function serve(refuse?: { path: string; code: string }) {
  let admins = [ADA];
  let operators = [
    {
      principalId: ADA,
      displayName: 'Ada Admin',
      source: 'configured',
      grantedAt: null,
      grantedBy: null,
    },
    {
      principalId: BEN,
      displayName: 'Ben Builder',
      source: 'granted',
      grantedAt: '2026-10-01T09:00:00.000Z',
      grantedBy: ADA,
    },
  ];
  return layerRoutes((call) => {
    if (call.method !== 'GET' && call.path === refuse?.path) {
      return reply({ code: refuse.code, detail: 'raw server detail' }, 409);
    }
    if (call.path === '/api/v1/tenant/roles') {
      return reply({
        items: admins.map((id) => ({
          subjectType: 'principal',
          subjectId: id,
          subjectDisplayName: people.find((p) => p.principalId === id)?.displayName ?? '',
          role: 'tenant_admin',
          grantedAt: '2026-10-01T09:00:00.000Z',
        })),
        nextCursor: null,
      });
    }
    if (call.path.startsWith('/api/v1/tenant/admins/')) {
      const id = call.path.split('/').pop() ?? '';
      admins = call.method === 'PUT' ? [...admins, id] : admins.filter((a) => a !== id);
      return reply(null, 204);
    }
    if (call.path === '/api/v1/sites/operators') return reply({ operators });
    if (call.path.startsWith('/api/v1/sites/operators/')) {
      const id = call.path.split('/').pop() ?? '';
      operators =
        call.method === 'PUT'
          ? [
              ...operators,
              {
                principalId: id,
                displayName: 'Cal Candidate',
                source: 'granted',
                grantedAt: null,
                grantedBy: null,
              },
            ]
          : operators.filter((o) => o.principalId !== id);
      return reply(null, 204);
    }
    return undefined;
  });
}

describe('Settings > Administrators', () => {
  it('is hidden from anyone who is neither an administrator nor an approver', async () => {
    stubCoreApi({});
    renderAt(<App />, '/settings?tab=administrators');
    expect(await screen.findByRole('link', { name: 'MCP' })).toBeVisible();
    expect(screen.queryByRole('link', { name: 'Administrators' })).not.toBeInTheDocument();
  });

  it('shows only the block the caller may use', async () => {
    stubCoreApi({ isTenantAdministrator: false, siteApprover: true, workspacePrincipals: people });
    serve();
    renderAt(<App />, '/settings?tab=administrators');
    expect(await screen.findByRole('region', { name: 'Site approvers' })).toBeVisible();
    expect(screen.queryByRole('region', { name: 'Tenant administrators' })).not.toBeInTheDocument();
  });

  it('adds and removes a tenant administrator, offering only people not yet listed', async () => {
    stubCoreApi({ isTenantAdministrator: true, workspacePrincipals: people });
    const calls = serve();
    renderAt(<App />, '/settings?tab=administrators');
    const user = userEvent.setup();

    const block = await screen.findByRole('region', { name: 'Tenant administrators' });
    expect(await within(block).findByText('Ada Admin')).toBeVisible();
    const picker = await within(block).findByRole('combobox', {
      name: 'Add to Tenant administrators',
    });
    await waitFor(() => {
      expect(within(picker).getByRole('option', { name: 'Ben Builder' })).toBeVisible();
    });
    expect(within(picker).queryByRole('option', { name: 'Ada Admin' })).not.toBeInTheDocument();

    await user.selectOptions(picker, 'Ben Builder');
    await user.click(within(block).getByRole('button', { name: 'Add to Tenant administrators' }));
    await waitFor(() => {
      expect(calls).toContainEqual({
        method: 'PUT',
        path: `/api/v1/tenant/admins/${BEN}`,
        body: null,
      });
    });
    await user.click(
      await within(block).findByRole('button', {
        name: 'Remove Ben Builder from Tenant administrators',
      }),
    );
    await waitFor(() => {
      expect(calls).toContainEqual({
        method: 'DELETE',
        path: `/api/v1/tenant/admins/${BEN}`,
        body: null,
      });
    });
  });

  it('says plainly that the last administrator cannot be removed', async () => {
    stubCoreApi({ isTenantAdministrator: true, workspacePrincipals: people });
    serve({ path: `/api/v1/tenant/admins/${ADA}`, code: 'roles.last_administrator' });
    renderAt(<App />, '/settings?tab=administrators');
    const user = userEvent.setup();

    await user.click(
      await screen.findByRole('button', { name: 'Remove Ada Admin from Tenant administrators' }),
    );
    expect(await screen.findByRole('alert')).toHaveTextContent(/last tenant administrator/);
  });

  it('lists site approvers by source, offers no Remove for configured ones, and adds and removes', async () => {
    stubCoreApi({ siteApprover: true, workspacePrincipals: people });
    const calls = serve();
    renderAt(<App />, '/settings?tab=administrators');
    const user = userEvent.setup();

    const block = await screen.findByRole('region', { name: 'Site approvers' });
    expect(await within(block).findByText('Configured')).toBeVisible();
    expect(within(block).getByText('Granted')).toBeVisible();
    expect(
      within(block).queryByRole('button', { name: /Remove Ada Admin/ }),
    ).not.toBeInTheDocument();

    const picker = within(block).getByRole('combobox', { name: 'Add to Site approvers' });
    await waitFor(() => {
      expect(within(picker).getByRole('option', { name: 'Cal Candidate' })).toBeVisible();
    });
    await user.selectOptions(picker, 'Cal Candidate');
    await user.click(within(block).getByRole('button', { name: 'Add to Site approvers' }));
    await waitFor(() => {
      expect(calls).toContainEqual({
        method: 'PUT',
        path: `/api/v1/sites/operators/${CAL}`,
        body: null,
      });
    });

    await user.click(
      within(block).getByRole('button', { name: 'Remove Ben Builder from Site approvers' }),
    );
    await waitFor(() => {
      expect(calls).toContainEqual({
        method: 'DELETE',
        path: `/api/v1/sites/operators/${BEN}`,
        body: null,
      });
    });
  });

  it('explains a refused removal of a configured approver', async () => {
    stubCoreApi({ siteApprover: true, workspacePrincipals: people });
    serve({ path: `/api/v1/sites/operators/${BEN}`, code: 'sites.operator_configured' });
    renderAt(<App />, '/settings?tab=administrators');
    const user = userEvent.setup();

    await user.click(
      await screen.findByRole('button', { name: 'Remove Ben Builder from Site approvers' }),
    );
    expect(await screen.findByRole('alert')).toHaveTextContent(/set in the deployment/);
  });
});
