import { act, renderHook } from '@testing-library/react';
import { afterEach, expect, it } from 'vitest';
import { clearPetDrafts, usePetDraft } from '../../lib/pet-drafts';
afterEach(clearPetDrafts);
it('shares the draft across surfaces, isolates workspace and pet, and clears it for sign-out', () => {
  const a = renderHook(() => usePetDraft('workspace', 'pet'));
  act(() => {
    a.result.current[1]('Private draft');
  });
  const b = renderHook(() => usePetDraft('workspace', 'pet'));
  const other = renderHook(() => usePetDraft('other', 'pet'));
  const note = renderHook(() => usePetDraft('workspace', 'pet', 'note'));
  expect(note.result.current[0]).toBe('');
  const otherPet = renderHook(() => usePetDraft('workspace', 'other-pet'));
  expect(b.result.current[0]).toBe('Private draft');
  expect(other.result.current[0]).toBe('');
  expect(otherPet.result.current[0]).toBe('');
  act(clearPetDrafts);
  expect(a.result.current[0]).toBe('');
  expect(b.result.current[0]).toBe('');
});
