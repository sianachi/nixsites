import { renderHook } from '@testing-library/react';
import { describe, expect, it } from 'vitest';
import { useApplySwitch } from '../../pets/conversation/state/use-apply-switch';

const base = { workspaceId: 'w', petId: 'p', savedDefault: true, readOnly: false };

interface Props {
  loaded: boolean;
  conversationKey: string;
  pendingToolIds: readonly string[];
}
function setup() {
  return renderHook<ReturnType<typeof useApplySwitch>, Props>(
    (props) => useApplySwitch({ ...base, needsDecisionIds: [], ...props }),
    { initialProps: { loaded: false, conversationKey: '', pendingToolIds: [] } },
  );
}

describe('useApplySwitch on (re)mount', () => {
  it('never auto-applies a write that was already waiting when the conversation loaded', () => {
    const { result, rerender } = setup();
    rerender({ loaded: true, conversationKey: 'a', pendingToolIds: ['waiting'] });
    expect(result.current.applyWithoutAsking).toBe(true);
    expect(result.current.applyExemptToolIds).toEqual(['waiting']);
    // A write that arrives after the load is covered by the switch.
    rerender({ loaded: true, conversationKey: 'a', pendingToolIds: ['waiting', 'later'] });
    expect(result.current.applyExemptToolIds).toEqual(['waiting']);
  });

  it('also exempts a write already pending in a conversation resumed in the same mount', () => {
    const { result, rerender } = setup();
    rerender({ loaded: true, conversationKey: 'a', pendingToolIds: [] });
    expect(result.current.applyExemptToolIds).toEqual([]);
    rerender({ loaded: true, conversationKey: 'b', pendingToolIds: ['resumed'] });
    expect(result.current.applyWithoutAsking).toBe(true);
    expect(result.current.applyExemptToolIds).toEqual(['resumed']);
  });
});
