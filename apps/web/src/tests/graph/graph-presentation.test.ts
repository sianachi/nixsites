import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import {
  DEFAULT_PRESENTATION,
  readGraphPresentation,
  writeGraphPresentation,
} from '../../graph/graph-presentation';
import { memoryStorage } from '../memory-storage';
let storage: Storage;
beforeEach(() => {
  storage = memoryStorage();
  vi.stubGlobal('localStorage', storage);
});
afterEach(() => {
  vi.unstubAllGlobals();
});
it('keeps layout and focus preferences separate per workspace', () => {
  const chosen = { representation: 'focused' as const, focusId: 'plan', distance: 3 };
  writeGraphPresentation('a', chosen);
  writeGraphPresentation('b', { ...chosen, representation: 'hierarchy' });
  expect(readGraphPresentation('a')).toEqual(chosen);
  expect(readGraphPresentation('b').representation).toBe('hierarchy');
  expect(readGraphPresentation(undefined)).toEqual(DEFAULT_PRESENTATION);
});
it.each([
  'broken',
  '{"a":{"representation":"future","focusId":null,"distance":1}}',
  '{"a":{"representation":"focused","focusId":null,"distance":500}}',
])('recovers safely from invalid device preferences: %s', (value) => {
  storage.setItem('nix.graph-presentation', value);
  expect(readGraphPresentation('a')).toEqual(DEFAULT_PRESENTATION);
});
