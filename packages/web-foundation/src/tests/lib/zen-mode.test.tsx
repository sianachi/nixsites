import { act, renderHook } from '@testing-library/react';
import { afterEach, expect, it } from 'vitest';
import { claimZenSurface, setZenMode, useZenActive, zenModeOn } from '../../lib/zen-mode';
afterEach(() => {
  setZenMode(false);
});
it('hides chrome only on a claimed surface and retains the preference between pages', () => {
  const hook = renderHook(useZenActive);
  act(() => {
    setZenMode(true);
  });
  expect(hook.result.current).toBe(false);
  let release!: () => void;
  act(() => {
    release = claimZenSurface();
  });
  expect(hook.result.current).toBe(true);
  act(() => {
    release();
    release();
  });
  expect(hook.result.current).toBe(false);
  expect(zenModeOn()).toBe(true);
});
