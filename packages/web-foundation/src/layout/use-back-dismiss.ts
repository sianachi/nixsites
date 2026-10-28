import { z } from 'zod';
import { useEffect, useRef } from 'react';

const overlayMarkerSchema = z.object({ nixOverlay: z.string() });

/**
 * Every currently open overlay's marker, top-of-stack last. Module state, shared across every
 * hook instance in the tab: a Back press produces exactly one `popstate` event no matter how many
 * overlays are open, and only the topmost one (the one the reader is actually looking at) should
 * answer it - the stack is what tells `back` which marker that is. Whether a sibling overlay's own
 * programmatic close counts as a genuine step past *this* marker is a separate question, answered
 * by comparing against `window.history.state` itself (see `back` below); the stack alone cannot
 * tell the two apart, since both leave this marker no longer on top.
 */
const overlayStack: string[] = [];

/**
 * One same-address history entry lets the browser Back gesture dismiss a shell overlay.
 *
 * Two things this asks of a caller: `dismiss` must actually drive `open` to `false` - `back`
 * has already popped this instance's marker off the stack by the time it calls `dismiss`, so an
 * overlay that stays open cannot be reached by another Back press until it unmounts. And closing
 * an overlay that is not currently on top (its own control, while another overlay opened after it
 * is still open) leaves its history entry behind rather than popping it - the entry it would
 * clean up is not the current one - so the reader's very next Back press, once the overlay above
 * it is gone too, is a no-op that consumes a step rather than doing anything visible.
 */
export function useBackDismiss(open: boolean, dismiss: () => void): void {
  const callback = useRef(dismiss);
  useEffect(() => {
    callback.current = dismiss;
  }, [dismiss]);
  useEffect(() => {
    if (!open) return;
    const marker = crypto.randomUUID();
    overlayStack.push(marker);
    const originalUrl = window.location.href;
    window.history.pushState({ ...window.history.state, nixOverlay: marker }, '', originalUrl);
    const back = (): void => {
      // Not the topmost overlay: some overlay opened after this one is the one the Back press
      // actually addresses, so this instance stays open and lets that one's own listener answer.
      if (overlayStack[overlayStack.length - 1] !== marker) return;
      // Still the current history entry: this `popstate` was not a genuine step past this
      // overlay's own entry - it is the one a sibling overlay's programmatic close produced by
      // calling `history.back()` below to clean up its own entry, landing back on this one's.
      if (overlayMarkerSchema.safeParse(window.history.state).data?.nixOverlay === marker) return;
      overlayStack.pop();
      callback.current();
    };
    window.addEventListener('popstate', back);
    return () => {
      window.removeEventListener('popstate', back);
      const index = overlayStack.lastIndexOf(marker);
      if (index !== -1) overlayStack.splice(index, 1);
      if (
        overlayMarkerSchema.safeParse(window.history.state).data?.nixOverlay === marker &&
        window.location.href === originalUrl
      )
        window.history.back();
    };
  }, [open]);
}
