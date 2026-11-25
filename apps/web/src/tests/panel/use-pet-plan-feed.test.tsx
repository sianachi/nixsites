import { createNixClient } from '@nix/api-client';
import { ApiClientOverrideProvider } from '@nix/web-platform/api/api-client-provider';
import { requestUrl } from '@nix/web-foundation/testing/request-url';
import { renderHook, waitFor } from '@testing-library/react';
import { expect, it } from 'vitest';
import type { ReactNode } from 'react';
import { usePetPlanFeed } from '../../panel/use-pet-plan-feed';
import { preparedPlanFixture } from '../../pages/pet-plan-card.stories';

it('keeps a successful plan list when an optional legacy active run is not in the plan API', async () => {
  const client = createNixClient({
    baseUrl: 'http://nix.invalid',
    tokens: {
      getAccessToken: () => Promise.resolve(null),
      refreshAccessToken: () => Promise.resolve(null),
    },
    fetch: (input) =>
      Promise.resolve(
        new URL(requestUrl(input)).pathname.endsWith('/pet-plans')
          ? Response.json({ enabled: true, abilities: [], runs: [preparedPlanFixture] })
          : Response.json(
              { code: 'pet_plans.unavailable', title: 'This legacy run is not a plan' },
              { status: 404, headers: { 'content-type': 'application/problem+json' } },
            ),
      ),
  });
  const { result } = renderHook(
    () =>
      usePetPlanFeed(preparedPlanFixture.workspaceId, true, 'deadd6a1-e91a-4be5-b3c4-a37d341b6d51'),
    {
      wrapper: ({ children }: { readonly children: ReactNode }) => (
        <ApiClientOverrideProvider client={client}>{children}</ApiClientOverrideProvider>
      ),
    },
  );
  await waitFor(() => {
    expect(result.current.feed.status).toBe('ready');
  });
  if (result.current.feed.status !== 'ready') throw new Error('Expected a successful list');
  expect(result.current.feed.data.runs.map((run) => run.id)).toEqual([preparedPlanFixture.id]);
});
