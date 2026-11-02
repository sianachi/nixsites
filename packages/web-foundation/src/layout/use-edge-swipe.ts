import { useEffect, useRef } from 'react';

/**
 * Phone drawers follow the finger. The edge swipe starts here, before any drawer is mounted, and
 * hands the live gesture to the drawer the moment it mounts (`SidebarDrawer` takes the handoff).
 */
export type DrawerSide = 'left' | 'right';

export interface DrawerHandoff {
  readonly side: DrawerSide;
  /** Finger x in client pixels. */
  x: number;
  /** Finger speed in px/ms, positive toward the right. Set once the finger lifts. */
  vx: number;
  ended: boolean;
  readonly at: number;
  listener: (() => void) | null;
}

let handoff: DrawerHandoff | null = null;

/** The gesture that opened this drawer, if one did in the last moment. */
export function takeHandoff(side: DrawerSide): DrawerHandoff | null {
  const taken = handoff;
  if (taken?.side !== side || performance.now() - taken.at > 600) return null;
  return taken;
}

export function releaseHandoff(taken: DrawerHandoff): void {
  taken.listener = null;
  if (handoff === taken) handoff = null;
}

/** Snap open when the finger is going that way fast, else by whichever side of halfway it is on. */
export function snapsOpen(progress: number, openingVelocity: number): boolean {
  if (Math.abs(openingVelocity) > 0.3) return openingVelocity > 0;
  return progress > 0.5;
}

const EDGE = 20;
const SLOP = 10;

/** True when the movement is a deliberate, mostly horizontal drag rather than a scroll or a tap. */
export function isHorizontalIntent(dx: number, dy: number): boolean {
  return Math.abs(dx) > SLOP && Math.abs(dx) > Math.abs(dy) * 1.5;
}

/**
 * Swipe in from the screen edge to open a drawer. Touch only; a vertical start is left to the page
 * so scrolling and text selection are untouched.
 */
export function useEdgeSwipeOpen(side: DrawerSide, enabled: boolean, onOpen: () => void): void {
  // Read live rather than as an effect dependency: opening flips `enabled`, and tearing the
  // listeners down mid-gesture would strand the drag the drawer has just taken over.
  const open = useRef(onOpen);
  const active = useRef(enabled);
  useEffect(() => {
    open.current = onOpen;
    active.current = enabled;
  }, [onOpen, enabled]);

  useEffect(() => {
    let start: { x: number; y: number } | null = null;
    let claimed: DrawerHandoff | null = null;
    let last = { x: 0, t: 0 };
    let vx = 0;
    const sample = (x: number, t: number): void => {
      if (t > last.t) vx = (x - last.x) / (t - last.t);
      last = { x, t };
    };
    const down = (event: TouchEvent): void => {
      const touch = event.touches[0];
      if (!active.current || event.touches.length !== 1 || touch === undefined) return;
      const atEdge =
        side === 'left' ? touch.clientX <= EDGE : touch.clientX >= window.innerWidth - EDGE;
      start = atEdge ? { x: touch.clientX, y: touch.clientY } : null;
      last = { x: touch.clientX, t: event.timeStamp };
      vx = 0;
    };
    const move = (event: TouchEvent): void => {
      const touch = event.touches[0];
      if (touch === undefined) return;
      sample(touch.clientX, event.timeStamp);
      if (claimed !== null) {
        event.preventDefault();
        claimed.x = touch.clientX;
        claimed.listener?.();
        return;
      }
      if (start === null) return;
      const dx = touch.clientX - start.x;
      const dy = touch.clientY - start.y;
      if (!isHorizontalIntent(dx, dy) || (side === 'left' ? dx : -dx) < 0) {
        if (Math.abs(dy) > SLOP) start = null;
        return;
      }
      event.preventDefault();
      claimed = {
        side,
        x: touch.clientX,
        vx: 0,
        ended: false,
        at: performance.now(),
        listener: null,
      };
      handoff = claimed;
      start = null;
      open.current();
    };
    const end = (): void => {
      start = null;
      if (claimed === null) return;
      claimed.vx = vx;
      claimed.ended = true;
      claimed.listener?.();
      claimed = null;
    };
    document.addEventListener('touchstart', down, { passive: true });
    document.addEventListener('touchmove', move, { passive: false });
    document.addEventListener('touchend', end);
    document.addEventListener('touchcancel', end);
    return () => {
      document.removeEventListener('touchstart', down);
      document.removeEventListener('touchmove', move);
      document.removeEventListener('touchend', end);
      document.removeEventListener('touchcancel', end);
    };
  }, [side]);
}
