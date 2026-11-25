import { createNixClient, type NixClient } from '@nix/api-client';
import { requestUrl } from '@nix/web-foundation/testing/request-url';
import { item } from '@nix/web-foundation/testing/api-stub';
import { act, renderHook } from '@testing-library/react';
import { expect, it, vi } from 'vitest';
import { useMessageContext } from '../../../pets/conversation/state/use-message-context';

let client: NixClient;
vi.mock('@nix/web-platform/api/api-client-provider', () => ({ useApiClient: () => client }));

it.each([
  { locked: false, withheld: false, include: true },
  { locked: true, withheld: false, include: false },
  { locked: false, withheld: true, include: false },
])('only automatically attaches an unprotected page: %j', async ({ locked, withheld, include }) => {
  const page = item({
    id: '11111111-1111-4111-8111-111111111111',
    title: 'Open page',
    settings: {
      comments: false,
      suggesting: false,
      reviewStates: false,
      fullWidth: false,
      withholdFromPets: withheld,
    },
  });
  client = createNixClient({
    baseUrl: 'http://nix.invalid',
    tokens: { getAccessToken: () => null, refreshAccessToken: () => Promise.resolve(null) },
    fetch: (input) =>
      Promise.resolve(
        Response.json(
          requestUrl(input).endsWith('/lock')
            ? {
                locked,
                unlockedUntil: locked ? '2099-01-01T00:00:00Z' : null,
                lockItemId: locked ? page.id : null,
                selfLocked: locked,
              }
            : page,
        ),
      ),
  });
  const query = client.query.bind(client);
  const pending: Promise<unknown>[] = [];
  vi.spyOn(client, 'query').mockImplementation((...args) => {
    const response = query(...args);
    pending.push(response);
    return response;
  });
  const { result } = renderHook(() =>
    useMessageContext({ currentItem: page.id, noteScope: undefined, workspaceAccess: true }),
  );
  await act(async () => {
    await Promise.all(pending);
  });
  expect(result.current.contextFields()).toEqual(include ? { itemId: page.id } : {});
});
