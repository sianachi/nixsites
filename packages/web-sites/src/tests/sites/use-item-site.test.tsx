import type { Site } from '@nix/api-client';
import { act, renderHook } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { useItemSite } from '../../sites/use-item-site';
import { BUILD_ID, ROOT_ID, WORKSPACE_ID, site, siteBuild } from './site-fixtures';

const client = { query: vi.fn<(endpoint: { operation: string }) => Promise<unknown>>() };
vi.mock('@nix/web-platform/api/api-client-provider', () => ({ useApiClient: () => client }));

beforeEach(() => vi.useFakeTimers());
afterEach(() => vi.useRealTimers());

describe('the builds history', () => {
  it('is read when a build appears and when it ends, not at each pending step', async () => {
    const at = (status: 'queued' | 'building' | 'live'): Site => {
      const build = siteBuild({ id: BUILD_ID, status });
      return site({ latestBuild: build, liveBuild: status === 'live' ? build : null });
    };
    let current = at('queued');
    client.query.mockImplementation((endpoint) =>
      Promise.resolve(endpoint.operation === 'sites.builds.list' ? { builds: [] } : current),
    );
    const histories = (): number =>
      client.query.mock.calls.filter(([endpoint]) => endpoint.operation === 'sites.builds.list')
        .length;

    const pass = (ms: number): Promise<void> =>
      act(async () => {
        await vi.advanceTimersByTimeAsync(ms);
      });

    renderHook(() => useItemSite(ROOT_ID, WORKSPACE_ID));
    await pass(10);
    expect(histories()).toBe(1);

    current = at('building');
    await pass(1000);
    expect(histories()).toBe(1);

    current = at('live');
    await pass(3000);
    expect(histories()).toBe(2);
  });
});
