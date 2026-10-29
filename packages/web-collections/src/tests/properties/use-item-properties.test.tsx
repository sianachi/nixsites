import { createNixClient, NixApiError, NixErrorKind } from '@nix/api-client';
import { renderHook, waitFor } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';

import { useItemProperties } from '../../properties/use-item-properties';

/**
 * The failure path a schema-only `queryOrNull` used to erase.
 *
 * Before this, every load failure - the item's own request refused, not just its schema - turned
 * into `item = null`, which is indistinguishable from "still loading". The panel showed "Loading
 * this item's details…" forever about a request that had already come back refused. These tests
 * exercise the hook directly: the item request fails, and the hook has to say so and offer a way
 * back, rather than leaving the caller guessing why nothing ever arrived.
 */

const ITEM_ID = '5a5a5a5a-5555-4555-8555-5a5a5a5a5a5a';

const io = vi.hoisted(() => ({ query: vi.fn(), execute: vi.fn() }));
const client = {
  ...io,
  cache: createNixClient({
    baseUrl: 'http://localhost',
    tokens: {
      getAccessToken: () => Promise.resolve(null),
      refreshAccessToken: () => Promise.resolve(null),
    },
  }).cache,
};
vi.mock('@nix/web-platform/api/api-client-provider', () => ({ useApiClient: () => client }));

function emptySchema(): Record<string, unknown> {
  return { properties: [], declared: [], inherit: true };
}

function refusal(detail: string): NixApiError {
  return new NixApiError({
    kind: NixErrorKind.Problem,
    code: 'test.refused',
    message: detail,
    status: 500,
    detail,
  });
}

describe('the item load a properties panel depends on', () => {
  it('reports the failure rather than leaving the item null forever', async () => {
    client.query.mockImplementation((endpoint: { operation: string }) => {
      if (endpoint.operation === 'items.get') {
        return Promise.reject(refusal('The server refused the request.'));
      }
      return Promise.resolve(emptySchema());
    });

    const { result } = renderHook(() => useItemProperties(ITEM_ID));

    await waitFor(() => {
      expect(result.current.loading).toBe(false);
    });

    // Distinct from "still loading": the item is null either way, but only a real failure sets
    // `error`, which is exactly the field a caller needs to stop saying "Loading…" and start
    // saying what actually happened.
    expect(result.current.item).toBeNull();
    expect(result.current.error).toBe('The server refused the request.');
  });

  it('retries the same load, clearing the error the moment it is asked to', async () => {
    client.query.mockImplementation((endpoint: { operation: string }) => {
      if (endpoint.operation === 'items.get') {
        return Promise.reject(refusal('The server refused the request.'));
      }
      return Promise.resolve(emptySchema());
    });

    const { result } = renderHook(() => useItemProperties(ITEM_ID));

    await waitFor(() => {
      expect(result.current.error).not.toBeNull();
    });

    client.query.mockImplementation((endpoint: { operation: string }) => {
      if (endpoint.operation === 'items.get') {
        return Promise.resolve({
          id: ITEM_ID,
          workspaceId: '22222222-2222-4222-8222-222222222222',
          parentId: '33333333-3333-4333-8333-333333333333',
          type: 'note',
          title: 'Roadmap',
          hasChildren: false,
          seq: 1,
          lifecycleState: 'active',
          properties: {},
          createdAt: '2026-01-01T00:00:00Z',
          updatedAt: '2026-01-01T00:00:00Z',
        });
      }
      return Promise.resolve(emptySchema());
    });

    result.current.retry();

    await waitFor(() => {
      expect(result.current.item).not.toBeNull();
    });

    expect(result.current.error).toBeNull();
    expect(result.current.item?.title).toBe('Roadmap');
  });
});
