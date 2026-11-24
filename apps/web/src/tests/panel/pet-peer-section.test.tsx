import { createNixClient } from '@nix/api-client';
import { requestUrl } from '@nix/web-foundation/testing/request-url';
import { ApiClientOverrideProvider } from '@nix/web-platform/api/api-client-provider';
import { render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { expect, it } from 'vitest';
import { PetPeerSection } from '../../panel/pet-peer-section';
import { petRunStatusText } from '../../panel/pet-run-card';

it('registers a task runner and can still revoke it after the pilot is disabled', async () => {
  const itemId = '11fa1d13-ce45-47d4-bd7c-51a4dd47e4ab';
  const petId = '22fa1d13-ce45-47d4-bd7c-51a4dd47e4ab';
  const peer = {
    id: '33fa1d13-ce45-47d4-bd7c-51a4dd47e4ab',
    workspaceId: '44fa1d13-ce45-47d4-bd7c-51a4dd47e4ab',
    itemId,
    petId,
    name: 'QA Codex',
    kind: 'codex',
    expiresAt: '2099-01-01T00:00:00Z',
  };
  const path = `/api/v1/items/${itemId}/pet-peers`;
  const methods: string[] = [];
  let stored: (typeof peer & { revokedAt?: string }) | null = null;
  const client = createNixClient({
    baseUrl: 'https://nix.test',
    tokens: {
      getAccessToken: () => Promise.resolve('browser-fixture'),
      refreshAccessToken: () => Promise.resolve('browser-fixture'),
    },
    fetch: async (input, init) => {
      const requestedPath = new URL(requestUrl(input), 'https://nix.test').pathname;
      const method = init?.method ?? (input instanceof Request ? input.method : 'GET');
      if (requestedPath === `${path}/work`) return Response.json({ work: [] });
      if (requestedPath === path && method === 'GET') {
        return Response.json({ peers: stored === null ? [] : [stored] });
      }
      if (requestedPath === path && method === 'POST') {
        methods.push('register');
        const body: unknown =
          typeof init?.body === 'string'
            ? JSON.parse(init.body)
            : input instanceof Request
              ? await input.json()
              : undefined;
        expect(body).toEqual({ name: 'QA Codex', kind: 'codex', days: 30 });
        stored = peer;
        return Response.json(
          {
            peer,
            endpoint: `https://nix.test/mcp/pets/${petId}`,
            credential: 'nixpeer_test-credential',
          },
          { status: 201 },
        );
      }
      if (requestedPath === `${path}/${peer.id}` && method === 'DELETE') {
        methods.push('revoke');
        stored = { ...peer, revokedAt: '2026-11-17T00:00:00Z' };
        return new Response(null, { status: 204 });
      }
      return new Response(null, { status: 404 });
    },
  });
  const view = render(
    <ApiClientOverrideProvider client={client}>
      <PetPeerSection itemId={itemId} />
    </ApiClientOverrideProvider>,
  );

  const user = userEvent.setup();
  await user.type(await screen.findByRole('textbox', { name: 'Peer name' }), 'QA Codex');
  await user.selectOptions(screen.getByRole('combobox', { name: 'Peer type' }), 'codex');
  await user.click(screen.getByRole('button', { name: 'Register peer' }));
  expect(await screen.findByLabelText('Peer bearer credential')).toHaveValue(
    'nixpeer_test-credential',
  );
  expect(screen.getByLabelText('Pet MCP address')).toHaveValue(
    `https://nix.test/mcp/pets/${petId}`,
  );

  view.rerender(
    <ApiClientOverrideProvider client={client}>
      <PetPeerSection itemId={itemId} workEnabled={false} />
    </ApiClientOverrideProvider>,
  );
  await waitFor(() => {
    expect(screen.queryByRole('button', { name: 'Register peer' })).toBeNull();
    expect(screen.queryByLabelText('Peer bearer credential')).toBeNull();
  });
  await user.click(await screen.findByRole('button', { name: 'Revoke QA Codex' }));
  await waitFor(() => {
    expect(screen.queryByLabelText('Peer bearer credential')).toBeNull();
  });
  expect(await screen.findByText('Revoked')).toBeVisible();
  expect(methods).toEqual(['register', 'revoke']);
});

it('labels peer work with the same status words as a pet job', async () => {
  const itemId = '11fa1d13-ce45-47d4-bd7c-51a4dd47e4ab';
  const shared = ['running', 'completed', 'review_required'] as const;
  const work = shared.map((status, index) => ({
    id: `5${String(index)}fa1d13-ce45-47d4-bd7c-51a4dd47e4ab`,
    peerId: '33fa1d13-ce45-47d4-bd7c-51a4dd47e4ab',
    runId: '66fa1d13-ce45-47d4-bd7c-51a4dd47e4ab',
    direction: 'outbound',
    status,
    createdAt: '2026-11-17T00:00:00Z',
  }));
  const client = createNixClient({
    baseUrl: 'https://nix.test',
    tokens: {
      getAccessToken: () => Promise.resolve('browser-fixture'),
      refreshAccessToken: () => Promise.resolve('browser-fixture'),
    },
    fetch: (input) =>
      Promise.resolve(
        Response.json(
          new URL(requestUrl(input), 'https://nix.test').pathname.endsWith('/work')
            ? { work }
            : { peers: [] },
        ),
      ),
  });
  render(
    <ApiClientOverrideProvider client={client}>
      <PetPeerSection itemId={itemId} />
    </ApiClientOverrideProvider>,
  );

  const rows = await within(await screen.findByRole('list', { name: 'Peer work' })).findAllByRole(
    'listitem',
  );
  expect(rows.map((row) => row.textContent)).toEqual(
    shared.map((status) => `Registered peer · ${petRunStatusText(status)}`),
  );
});
