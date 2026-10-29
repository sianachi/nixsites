import { act, renderHook } from '@testing-library/react';
import { describe, expect, it } from 'vitest';

import { isSelectGesture, useItemSelection } from '../../../collections/core/use-item-selection';

const order = ['a', 'b', 'c', 'd'];

describe('useItemSelection', () => {
  it('toggles, extends with shift across the given order, prunes and clears', () => {
    const { result } = renderHook(() => useItemSelection());
    act(() => {
      result.current.toggle('b', order);
    });
    act(() => {
      result.current.toggle('d', order, true);
    });
    expect([...result.current.selected]).toEqual(['b', 'c', 'd']);
    act(() => {
      result.current.toggle('c', order);
    });
    expect(result.current.selected.has('c')).toBe(false);
    act(() => {
      result.current.prune(['a', 'b']);
    });
    expect([...result.current.selected]).toEqual(['b']);
    act(() => {
      result.current.clear();
    });
    expect(result.current.selected.size).toBe(0);
  });

  it('recognises a select gesture by its modifier keys', () => {
    expect(isSelectGesture({ metaKey: true, ctrlKey: false, shiftKey: false })).toBe(true);
    expect(isSelectGesture({ metaKey: false, ctrlKey: false, shiftKey: false })).toBe(false);
  });
});
