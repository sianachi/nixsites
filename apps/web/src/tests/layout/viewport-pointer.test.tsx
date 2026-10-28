import { renderHook } from '@testing-library/react';
import { afterEach, describe, expect, it } from 'vitest';

import {
  useCanHover,
  useCoarsePointer,
  useNarrowViewport,
} from '@nix/web-foundation/layout/viewport';
import { stubViewport } from '../stub-viewport';

function stubPointer(coarse: boolean): void {
  globalThis.matchMedia = (query: string): MediaQueryList =>
    ({
      matches: query.includes('coarse') ? coarse : query.includes('hover') ? !coarse : true,
      media: query,
      onchange: null,
      addEventListener: () => undefined,
      removeEventListener: () => undefined,
      addListener: () => undefined,
      removeListener: () => undefined,
      dispatchEvent: () => false,
    }) as MediaQueryList;
}

describe('pointer facts, asked apart from width', () => {
  afterEach(() => {
    stubViewport(true);
  });

  it('reports a mouse as fine and able to hover', () => {
    stubViewport(true);

    expect(renderHook(() => useCoarsePointer()).result.current).toBe(false);
    expect(renderHook(() => useCanHover()).result.current).toBe(true);
  });

  it('reports a touch screen as coarse and unable to hover, whatever its width', () => {
    stubPointer(true);

    expect(renderHook(() => useCoarsePointer()).result.current).toBe(true);
    expect(renderHook(() => useCanHover()).result.current).toBe(false);
  });

  it('keeps a landscape phone compact without changing a mouse layout of the same width', () => {
    const atWidth = (width: number, coarse: boolean) => {
      stubViewport(width);
      const widthMedia = globalThis.matchMedia;
      globalThis.matchMedia = (query) => {
        if (!query.includes('pointer')) return widthMedia(query);
        return {
          matches: query.includes('coarse') ? coarse : !coarse,
          media: query,
          onchange: null,
          addEventListener: () => undefined,
          removeEventListener: () => undefined,
          addListener: () => undefined,
          removeListener: () => undefined,
          dispatchEvent: () => false,
        };
      };
    };
    atWidth(844, true);
    expect(renderHook(() => useNarrowViewport()).result.current).toBe(true);
    atWidth(844, false);
    expect(renderHook(() => useNarrowViewport()).result.current).toBe(false);
    atWidth(1280, true);
    expect(renderHook(() => useNarrowViewport()).result.current).toBe(false);
  });
});
