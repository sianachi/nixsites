import { renderHook } from '@testing-library/react';
import { expect, it } from 'vitest';

import { useLayoutKind, type LayoutKind } from '../../layout/viewport';
import { stubViewport } from '../../testing/stub-viewport';

const table: readonly [string, number, boolean, boolean, LayoutKind][] = [
  // [label, width, touch, portrait, expected]
  ['phone', 390, true, true, 'phone'],
  ['iPad mini portrait', 744, true, true, 'tablet-portrait'],
  ['iPad portrait', 820, true, true, 'tablet-portrait'],
  ['iPad Pro 11 portrait (1024 wide)', 1024, true, true, 'tablet-portrait'],
  ['iPad landscape', 1180, true, false, 'tablet-landscape'],
  ['iPad Pro 12.9 landscape', 1366, true, false, 'tablet-landscape'],
  ['narrow landscape touch window', 900, true, false, 'tablet-portrait'],
  ['mouse at 390', 390, false, true, 'phone'],
  ['mouse at 800', 800, false, false, 'desktop'],
  ['mouse at 1440', 1440, false, false, 'desktop'],
  ['mouse at 1024 portrait window', 1024, false, true, 'desktop'],
];

it.each(table)('%s decides %s -> %s', (_label, width, touch, portrait, expected) => {
  stubViewport(width, { touch, portrait });
  const { result } = renderHook(() => useLayoutKind());
  expect(result.current).toBe(expected);
});

it('re-evaluates on rotation', () => {
  stubViewport(820, { touch: true, portrait: true });
  const { result, rerender } = renderHook(() => useLayoutKind());
  expect(result.current).toBe('tablet-portrait');
  stubViewport(1180, { touch: true, portrait: false });
  rerender();
  expect(result.current).toBe('tablet-landscape');
});
