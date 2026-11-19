import { createNixClient } from '@nix/api-client';
import { json } from '@nix/web-foundation/testing/json-response';
import { requestUrl } from '@nix/web-foundation/testing/request-url';
import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { expect, it } from 'vitest';
import { LinearLinkSection } from '../../panel/linear-link-section';

const TASK = { id: '8d83ad48-2963-465e-8ad9-1342556b09ce' };
const REVISION = 'da47fc39-fd14-40c9-89cb-1e5a7b78f836';
const CONNECTION = '274887d2-b8d9-46d1-9aa4-25693270c936';
const TEAM = 'c0b6e140-5bce-4b13-af45-284b29191dbf';

async function readBody(input: RequestInfo | URL, init?: RequestInit): Promise<unknown> {
  if (typeof init?.body === 'string') return JSON.parse(init.body);
  return input instanceof Request ? input.clone().json() : undefined;
}

it('links one Linear issue and refuses to copy status after both sides change', async () => {
  const linkRoute = `/api/v1/items/${TASK.id}/linear-link`;
  const issueUrl = 'https://linear.app/demo/issue/PAY-24';
  const connections = [{ id: CONNECTION, teamId: TEAM }];
  const linked = {
    revision: REVISION,
    connected: true,
    identifier: 'PAY-24',
    url: issueUrl,
    localStatus: 'Open',
    remoteStatus: 'In progress',
    checkedAt: '2026-11-17T12:00:00Z',
    change: 'none',
    canCopyStatus: true,
  };
  const sent: unknown[] = [];
  const copies: unknown[] = [];
  const fetcher: typeof fetch = async (input, init) => {
    const { pathname } = new URL(requestUrl(input), 'https://nix.test');
    const method = init?.method ?? (input instanceof Request ? input.method : 'GET');
    if (pathname === linkRoute && method === 'GET') return json({ link: null, connections });
    if (pathname === linkRoute && method === 'PUT') {
      sent.push(await readBody(input, init));
      return json({ link: linked, connections });
    }
    if (pathname === `${linkRoute}/copy-status` && method === 'POST') {
      copies.push(await readBody(input, init));
      return json({
        link: { ...linked, localStatus: 'In progress', canCopyStatus: false },
        connections,
      });
    }
    if (pathname === `${linkRoute}/refresh` && method === 'POST') {
      return json({
        link: {
          ...linked,
          localStatus: 'Blocked',
          remoteStatus: 'Done',
          change: 'conflict',
          canCopyStatus: false,
        },
        connections,
      });
    }
    throw new Error('Unexpected request ' + method + ' ' + pathname);
  };
  const client = createNixClient({
    baseUrl: 'https://nix.test',
    tokens: { getAccessToken: () => 'test-token', refreshAccessToken: () => Promise.resolve(null) },
    fetch: fetcher,
  });
  render(<LinearLinkSection itemId={TASK.id} client={client} />);
  const user = userEvent.setup();
  const issue = await screen.findByRole('textbox', { name: 'Linear issue link or ID' });
  await user.type(issue, issueUrl);
  await user.click(screen.getByRole('button', { name: 'Link Linear issue' }));
  expect(await screen.findByRole('link', { name: 'PAY-24' })).toHaveAttribute('href', issueUrl);
  expect(sent).toEqual([{ connectionId: CONNECTION, issue: issueUrl }]);
  await user.click(screen.getByRole('button', { name: /Copy .In progress. to Nix status/ }));
  await waitFor(() => {
    expect(copies).toEqual([{ revision: REVISION, localStatus: 'Open' }]);
  });
  await waitFor(() => {
    expect(screen.getByRole('button', { name: 'Refresh Linear status' })).toBeEnabled();
  });
  await user.click(screen.getByRole('button', { name: 'Refresh Linear status' }));
  expect(await screen.findByText(/Both statuses changed/)).toBeVisible();
  expect(screen.queryByRole('button', { name: /Copy .* to Nix status/ })).not.toBeInTheDocument();
});
