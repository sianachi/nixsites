import { NixApiError, NixErrorKind } from '@nix/api-client';
import { act, renderHook, waitFor } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';

import { useItemHasSite } from '../../sites/use-item-site';

type Listener = (prefix: readonly string[]) => void;
let listeners: Listener[] = [];
let exists = false;
const client = {
  query: vi.fn(() =>
    exists
      ? Promise.resolve({})
      : Promise.reject(
          new NixApiError({
            kind: NixErrorKind.Problem,
            code: 'sites.not_found',
            message: 'none',
            status: 404,
            detail: 'none',
          }),
        ),
  ),
  cache: {
    subscribeInvalidation: (listener: Listener) => {
      listeners.push(listener);
      return () => {
        listeners = listeners.filter((l) => l !== listener);
      };
    },
  },
};
vi.mock('@nix/web-platform/api/api-client-provider', () => ({ useApiClient: () => client }));

describe('useItemHasSite', () => {
  it('relabels when the item site key is invalidated', async () => {
    const { result } = renderHook(() => useItemHasSite('item-1'));
    await waitFor(() => {
      expect(result.current).toBe(false);
    });
    exists = true;
    act(() => {
      listeners.forEach((l) => {
        l(['items', 'other', 'site']);
      });
    });
    expect(client.query).toHaveBeenCalledTimes(1);
    act(() => {
      listeners.forEach((l) => {
        l(['items', 'item-1', 'site']);
      });
    });
    await waitFor(() => {
      expect(result.current).toBe(true);
    });
  });
});
