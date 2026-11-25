import { describe, expect, it } from 'vitest';

import { sharingScope } from '../../pets/conversation/state/sharing-scope';

// Each case is the scope Core's PetWorkerClient checks for the same request.
describe('sharingScope', () => {
  it('asks for the workspace when workspace context is on, even with a page attached', () => {
    expect(sharingScope(undefined, true, { itemId: 'page' })).toEqual({ kind: 'workspace' });
    expect(sharingScope(undefined, true, { itemIds: ['a'] })).toEqual({ kind: 'workspace' });
  });

  it('asks for the attached items when workspace context is off', () => {
    expect(sharingScope(undefined, false, { itemId: 'page' })).toEqual({
      kind: 'selected',
      itemIds: ['page'],
    });
    expect(sharingScope(undefined, false, { itemIds: ['b', 'a', 'b'] })).toEqual({
      kind: 'selected',
      itemIds: ['a', 'b'],
    });
  });

  it('asks for the subtree in a note chat', () => {
    expect(sharingScope('root', true, { itemId: 'root' })).toEqual({
      kind: 'subtree',
      itemIds: ['root'],
    });
  });

  it('asks nothing for plain text without workspace context', () => {
    expect(sharingScope(undefined, false, {})).toBeNull();
  });
});
