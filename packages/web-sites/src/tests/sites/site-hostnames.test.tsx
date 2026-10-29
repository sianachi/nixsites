import type { CommandEndpoint, Site } from '@nix/api-client';
import { render, screen, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { describe, expect, it, vi } from 'vitest';

import { SiteApprovalView } from '../../sites/site-approval';
import { SiteHostnamesView, checkErrorCopy } from '../../sites/site-hostnames';
import { publishedSite, site } from './site-fixtures';

function hostnames(): Site {
  return publishedSite();
}

describe('the hostnames section', () => {
  it('shows the records a pending hostname needs, with copy buttons, and the default as primary', () => {
    render(<SiteHostnamesView site={hostnames()} run={() => Promise.resolve(null)} />);

    const records = screen.getByRole('list', { name: 'DNS records for garden.example.com' });
    expect(within(records).getByText('TXT _nix-site.garden.example.com')).toBeVisible();
    expect(
      within(records).getByText('nix-site-verification=0123456789abcdef0123456789abcdef'),
    ).toBeVisible();
    expect(within(records).getByText('CNAME garden.example.com')).toBeVisible();
    expect(
      screen.getByRole('button', { name: 'Copy the TXT value for garden.example.com' }),
    ).toBeEnabled();
    expect(screen.getByText('Waiting for DNS records')).toBeVisible();
    expect(screen.getByText('The TXT record was not found.')).toBeVisible();
    expect(screen.getByText('Primary')).toBeVisible();
  });

  it('adds a hostname with its serve mode, makes one primary, and checks one now', async () => {
    const user = userEvent.setup();
    const run = vi.fn<(endpoint: CommandEndpoint<Site>) => Promise<string | null>>(() =>
      Promise.resolve(null),
    );
    render(<SiteHostnamesView site={hostnames()} run={run} />);

    await user.type(screen.getByRole('textbox', { name: /add a hostname/i }), 'Docs.Example.org');
    await user.selectOptions(
      screen.getByRole('combobox', { name: /while it is not the primary/i }),
      'redirect',
    );
    await user.click(screen.getByRole('button', { name: 'Add hostname' }));
    await user.click(screen.getByRole('button', { name: 'Make primary' }));
    await user.click(screen.getByRole('button', { name: 'Check now' }));

    const [added, primary, checked] = run.mock.calls.map(([endpoint]) => endpoint);
    expect(added?.body).toEqual({ hostname: 'docs.example.org', serveMode: 'redirect' });
    expect(primary?.path).toMatch(/\/hostnames\/garden\.example\.com$/);
    expect(primary?.body).toEqual({ serveMode: null, primary: true });
    expect(checked?.path).toMatch(/\/hostnames\/garden\.example\.com\/verify$/);
    expect(screen.getByRole('textbox', { name: /add a hostname/i })).toHaveValue('');
  });

  it('says why Core refused, and offers no controls to a reader', async () => {
    const user = userEvent.setup();
    const { unmount } = render(
      <SiteHostnamesView
        site={hostnames()}
        run={() => Promise.resolve('Another site already serves this hostname.')}
      />,
    );
    await user.click(screen.getByRole('button', { name: 'Check now' }));
    expect(await screen.findByRole('alert')).toHaveTextContent(/already serves/);
    unmount();

    render(
      <SiteHostnamesView
        site={{ ...hostnames(), canManage: false }}
        run={() => Promise.resolve(null)}
      />,
    );
    expect(
      screen.queryByRole('button', { name: /make primary|check now|remove|add hostname/i }),
    ).toBeNull();
    expect(screen.queryByRole('form', { name: 'Add a hostname' })).toBeNull();
  });

  it('names a Cloudflare failure by its code', () => {
    expect(checkErrorCopy('cloudflare_403:10000')).toBe('Setup failed (cloudflare_403:10000).');
    expect(checkErrorCopy(null)).toBeNull();
  });
});

describe('the approval notice', () => {
  it('asks for approval, then says it is waiting', async () => {
    const user = userEvent.setup();
    const asking = site({ approvalRequired: true });
    const request = vi.fn(() =>
      Promise.resolve({
        site: {
          ...asking,
          approval: {
            state: 'pending' as const,
            requestedAt: '2026-10-11T09:00:00+00:00',
            decidedAt: null,
            note: null,
          },
        },
        error: null,
      }),
    );
    render(<SiteApprovalView site={asking} request={request} />);

    await user.click(screen.getByRole('button', { name: 'Ask for approval' }));

    expect(request).toHaveBeenCalledOnce();
    expect(await screen.findByText(/waiting for approval/i)).toBeVisible();
    expect(screen.queryByRole('button', { name: 'Ask for approval' })).toBeNull();
  });

  it('shows the operator note on a rejection, and nothing where no approval is needed', () => {
    const { unmount } = render(
      <SiteApprovalView
        site={site({
          approvalRequired: true,
          approval: {
            state: 'rejected',
            requestedAt: '2026-10-11T09:00:00+00:00',
            decidedAt: '2026-10-11T10:00:00+00:00',
            note: 'Add an about page first.',
          },
        })}
        request={() => Promise.resolve({ site: null, error: null })}
      />,
    );
    expect(screen.getByText(/did not approve publishing: Add an about page first\./)).toBeVisible();
    unmount();

    const { container } = render(
      <SiteApprovalView
        site={site()}
        request={() => Promise.resolve({ site: null, error: null })}
      />,
    );
    expect(container).toBeEmptyDOMElement();
  });
});
