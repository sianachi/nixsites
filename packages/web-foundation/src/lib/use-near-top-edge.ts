import { useEffect, useState } from 'react';

/** How far from the top edge of the window the pointer counts as being near it. */
const NEAR_TOP_PX = 72;

/**
 * Whether the pointer is within reach of the window's top edge.
 *
 * For controls that hide until wanted: a quiet control is revealed by the pointer approaching its
 * edge, and by keyboard focus, which the caller handles in CSS. Only the transition re-renders -
 * setting the value it already holds is a no-op - so a mouse crossing the window costs two renders.
 */
export function useNearTopEdge(): boolean {
  const [near, setNear] = useState(false);

  useEffect(() => {
    function onMove(event: PointerEvent): void {
      setNear(event.clientY <= NEAR_TOP_PX);
    }
    function onLeave(): void {
      setNear(false);
    }
    document.addEventListener('pointermove', onMove);
    document.documentElement.addEventListener('pointerleave', onLeave);
    return () => {
      document.removeEventListener('pointermove', onMove);
      document.documentElement.removeEventListener('pointerleave', onLeave);
    };
  }, []);

  return near;
}

/**
 * The classes that make a control visible only when it is wanted.
 *
 * `opacity`, never `visibility` or `display`: those drop the control from the tab order, and a
 * control that keyboard focus cannot reach to reveal is a control a keyboard cannot use (see the
 * calendar's create-item control). While hidden it ignores the pointer so it cannot be pressed
 * unseen; focus, a near pointer and a coarse pointer - which has no hover to approach with - each
 * bring it back.
 */
export function quietTopControl(near: boolean): string {
  return near
    ? 'opacity-100'
    : 'pointer-events-none opacity-0 focus-visible:pointer-events-auto focus-visible:opacity-100 pointer-coarse:pointer-events-auto pointer-coarse:opacity-100';
}
