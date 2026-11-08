import { useEffect, useRef, useState } from 'react';

/**
 * Confirm "this just happened here": spread the result on the element that changed
 * (`<li {...useFlash(item.updatedAt)}>`). It tints once whenever `trigger` changes (not on mount);
 * a repeat alternates a/b so the animation restarts. Styles live in the design tokens
 * (`[data-flash]`), opacity only. For appear/leave motion put `data-enter=""` on the new element
 * and `data-leave=""` on the one going away, and unmount it after ~150 ms (`animationend`);
 * reduced motion keeps the tint and drops the movement.
 */
export function useFlash(trigger: unknown): { 'data-flash'?: 'a' | 'b' } {
  const [phase, setPhase] = useState<'a' | 'b' | undefined>(undefined);
  const previous = useRef(trigger);
  useEffect(() => {
    if (!Object.is(previous.current, trigger)) {
      previous.current = trigger;
      setPhase((p) => (p === 'a' ? 'b' : 'a'));
    }
  }, [trigger]);
  return phase === undefined ? {} : { 'data-flash': phase };
}
