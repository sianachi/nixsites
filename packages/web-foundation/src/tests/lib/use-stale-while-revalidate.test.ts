import { act, renderHook } from '@testing-library/react';
import { describe, expect, it } from 'vitest';

import { useStaleWhileRevalidate } from '../../lib/use-stale-while-revalidate';

/**
 * The bookkeeping every stale-while-revalidate hook shared before it was extracted here: a first
 * load blanks the screen, a background reload keeps the previous data mounted and reports itself
 * through `refreshing`/`refreshError` instead.
 */
describe('useStaleWhileRevalidate', () => {
  it('starts in the loading status passed to the hook', () => {
    const { result } = renderHook(() =>
      useStaleWhileRevalidate<'loading' | 'ready' | 'error'>('loading'),
    );

    expect(result.current.status).toBe('loading');
    expect(result.current.error).toBeNull();
    expect(result.current.refreshing).toBe(false);
    expect(result.current.refreshError).toBeNull();
  });

  it('reports a first-load failure through status and error, not refreshError', () => {
    const { result } = renderHook(() =>
      useStaleWhileRevalidate<'loading' | 'ready' | 'error'>('loading'),
    );

    act(() => {
      result.current.beginLoad();
    });
    act(() => {
      result.current.reportFailed('Core could not be reached.', 'error');
    });

    expect(result.current.status).toBe('error');
    expect(result.current.error).toBe('Core could not be reached.');
    expect(result.current.refreshing).toBe(false);
    expect(result.current.refreshError).toBeNull();
  });

  it('keeps the ready status and data on a background refresh, reporting it as refreshing', () => {
    const { result } = renderHook(() =>
      useStaleWhileRevalidate<'loading' | 'ready' | 'error'>('loading'),
    );

    act(() => {
      result.current.beginLoad();
    });
    act(() => {
      result.current.reportLoaded('ready');
    });
    expect(result.current.status).toBe('ready');

    act(() => {
      result.current.beginLoad();
    });

    expect(result.current.status).toBe('ready');
    expect(result.current.refreshing).toBe(true);
    expect(result.current.refreshError).toBeNull();
  });

  it('keeps the previous status and data on a background failure, setting refreshError instead', () => {
    const { result } = renderHook(() =>
      useStaleWhileRevalidate<'loading' | 'ready' | 'error'>('loading'),
    );

    act(() => {
      result.current.beginLoad();
    });
    act(() => {
      result.current.reportLoaded('ready');
    });

    act(() => {
      result.current.beginLoad();
    });
    act(() => {
      result.current.reportFailed('The reload failed.', 'error');
    });

    expect(result.current.status).toBe('ready');
    expect(result.current.error).toBeNull();
    expect(result.current.refreshing).toBe(false);
    expect(result.current.refreshError).toBe('The reload failed.');
  });

  it('clears a previous refreshError once a refresh succeeds', () => {
    const { result } = renderHook(() =>
      useStaleWhileRevalidate<'loading' | 'ready' | 'error'>('loading'),
    );

    act(() => {
      result.current.beginLoad();
    });
    act(() => {
      result.current.reportLoaded('ready');
    });
    act(() => {
      result.current.beginLoad();
    });
    act(() => {
      result.current.reportFailed('The reload failed.', 'error');
    });
    expect(result.current.refreshError).toBe('The reload failed.');

    act(() => {
      result.current.beginLoad();
    });
    expect(result.current.refreshError).toBeNull();

    act(() => {
      result.current.reportLoaded('ready');
    });

    expect(result.current.status).toBe('ready');
    expect(result.current.refreshing).toBe(false);
    expect(result.current.refreshError).toBeNull();
  });
});
