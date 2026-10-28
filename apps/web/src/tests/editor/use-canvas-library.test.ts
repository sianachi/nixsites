import { act, renderHook, waitFor } from '@testing-library/react';
import { createElement, type ReactNode } from 'react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { useCanvasLibrary } from '../../editor/use-canvas-library';
import { ApiClientProvider } from '@nix/web-platform/api/api-client-provider';
import { requestUrl } from '../request-url';

/**
 * A stable reference, not an inline arrow inside the factory: `useAuth()` is a dependency of the
 * hook's own effect, and a new function identity on every call would retrigger it on every render
 * the way an unstable prop retriggers any effect that depends on it.
 */
const getAccessToken = (): Promise<string> => Promise.resolve('token');

vi.mock('@nix/web-platform/auth/auth-provider', () => ({
  useAuth: () => ({ getAccessToken }),
}));

function Wrapper({ children }: { readonly children: ReactNode }): ReactNode {
  return createElement(ApiClientProvider, null, children);
}

/**
 * The library is per caller, not per canvas: one `GET`/`PUT` pair against
 * `/api/v1/me/canvas-library`, with no item or workspace in the URL. These tests are about the
 * hook's own contract with that endpoint, which is why nothing here renders
 * `CanvasEditor`.
 */
describe('the caller’s own canvas library', () => {
  let fetchMock: ReturnType<typeof vi.fn>;

  beforeEach(() => {
    fetchMock = vi.fn();
    vi.stubGlobal('fetch', fetchMock);
  });

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it('starts loading and then reports what Core has saved', async () => {
    fetchMock.mockResolvedValueOnce(
      new Response(JSON.stringify({ items: [{ id: 'shape-1' }] }), { status: 200 }),
    );

    const { result } = renderHook(() => useCanvasLibrary(), { wrapper: Wrapper });

    expect(result.current.status).toBe('loading');

    await waitFor(() => {
      expect(result.current.status).toBe('ready');
    });

    expect(result.current.items).toEqual([{ id: 'shape-1' }]);
    // Read off the recorded call rather than matched with a nested `expect.objectContaining`,
    // which returns `any` and makes the surrounding object literal an unsafe assignment. The
    // headers are a plain object here, so asserting them is both stricter and simpler.
    const [input, init] = fetchMock.mock.calls[0] as [RequestInfo | URL, RequestInit | undefined];
    const url = requestUrl(input);
    expect(url).toContain('/api/v1/me/canvas-library');
    const headers = new Headers(
      init?.headers ?? (input instanceof Request ? input.headers : undefined),
    );
    expect(headers.get('authorization')).toBe('Bearer token');
  });

  it('reports an empty library as an error rather than silently substituting one when the read fails', async () => {
    fetchMock.mockResolvedValueOnce(new Response(null, { status: 500 }));

    const { result } = renderHook(() => useCanvasLibrary(), { wrapper: Wrapper });

    await waitFor(() => {
      expect(result.current.status).toBe('error');
    });

    expect(result.current.items).toEqual([]);
  });

  it('saves the caller’s complete library, once loading has finished', async () => {
    fetchMock
      .mockResolvedValueOnce(new Response(JSON.stringify({ items: [] }), { status: 200 }))
      .mockResolvedValueOnce(
        new Response(JSON.stringify({ items: [{ id: 'shape-2' }] }), { status: 200 }),
      );

    const { result } = renderHook(() => useCanvasLibrary(), { wrapper: Wrapper });

    await waitFor(() => {
      expect(result.current.status).toBe('ready');
    });

    act(() => {
      result.current.save([{ id: 'shape-2' }]);
    });

    await waitFor(() => {
      expect(fetchMock).toHaveBeenCalledTimes(2);
    });

    const [input, init] = fetchMock.mock.calls[1] as [RequestInfo | URL, RequestInit | undefined];
    const path = requestUrl(input);
    expect(path).toContain('/api/v1/me/canvas-library');
    const request = input instanceof Request ? input : undefined;
    expect(init?.method ?? request?.method).toBe('PUT');
    const body =
      typeof init?.body === 'string'
        ? init.body
        : request === undefined
          ? undefined
          : await request.clone().text();
    expect(JSON.parse(body ?? '{}')).toEqual({ items: [{ id: 'shape-2' }] });
  });

  it('serializes rapid whole-library saves so the newest state reaches Core last', async () => {
    let finishFirstSave: ((response: Response) => void) | undefined;
    const firstSave = new Promise<Response>((resolve) => {
      finishFirstSave = resolve;
    });
    fetchMock
      .mockResolvedValueOnce(new Response(JSON.stringify({ items: [] }), { status: 200 }))
      .mockImplementationOnce(() => firstSave)
      .mockResolvedValueOnce(
        new Response(JSON.stringify({ items: [{ id: 'newest' }] }), { status: 200 }),
      );

    const { result } = renderHook(() => useCanvasLibrary(), { wrapper: Wrapper });
    await waitFor(() => {
      expect(result.current.status).toBe('ready');
    });

    act(() => {
      result.current.save([{ id: 'older' }]);
      result.current.save([{ id: 'newest' }]);
    });

    await waitFor(() => {
      expect(fetchMock).toHaveBeenCalledTimes(2);
    });
    if (finishFirstSave === undefined) throw new Error('Expected the first save to be pending.');
    finishFirstSave(new Response(JSON.stringify({ items: [{ id: 'older' }] }), { status: 200 }));

    await waitFor(() => {
      expect(fetchMock).toHaveBeenCalledTimes(3);
    });
    const [input, init] = fetchMock.mock.calls[2] as [RequestInfo | URL, RequestInit | undefined];
    const request = input instanceof Request ? input : undefined;
    const body =
      typeof init?.body === 'string'
        ? init.body
        : request === undefined
          ? undefined
          : await request.clone().text();
    expect(JSON.parse(body ?? '{}')).toEqual({ items: [{ id: 'newest' }] });
  });

  it('drops a save identical to what Core already holds instead of echoing it back', async () => {
    fetchMock.mockResolvedValueOnce(
      new Response(JSON.stringify({ items: [{ id: 'shape-1' }] }), { status: 200 }),
    );

    const { result } = renderHook(() => useCanvasLibrary(), { wrapper: Wrapper });

    await waitFor(() => {
      expect(result.current.status).toBe('ready');
    });

    // Seeding the editor with the loaded library makes it announce that same library back
    // through `onLibraryChange`. Saving that announcement was a feedback loop: an unbounded
    // stream of identical PUTs that hung the tab. The unchanged echo must die here.
    act(() => {
      result.current.save([{ id: 'shape-1' }]);
    });

    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it('does not save back to Core before the initial read has resolved', async () => {
    fetchMock.mockImplementation(() => new Promise(() => undefined));

    const { result } = renderHook(() => useCanvasLibrary(), { wrapper: Wrapper });

    await waitFor(() => {
      expect(fetchMock).toHaveBeenCalledTimes(1);
    });

    // The editor announces its initial library once on mount with whatever it booted with, before this
    // hook's own read has necessarily returned - saving that would overwrite Core's copy with an
    // empty one.
    act(() => {
      result.current.save([]);
    });

    expect(fetchMock).toHaveBeenCalledTimes(1);
  });
});
