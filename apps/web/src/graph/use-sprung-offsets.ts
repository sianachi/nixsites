import { useEffect, useMemo, useRef, useState } from 'react';

import { prefersReducedMotion } from '@nix/web-foundation/lib/motion';
import type { Offset } from './graph-layout';
import { atRest, AT_HOME, bodyAt, stepSpring, type Body } from './graph-spring';

/**
 * Offsets that travel to where they are told to be, rather than appearing there.
 *
 * `target` is where each nudged node belongs; what comes back is where each is right now. A node
 * that leaves `target` springs home and is then forgotten, so "Tidy up" is an animation and not a
 * jump. The node under the pointer is `pinned`: it must sit exactly under the hand, and a spring
 * between a finger and the thing it is holding reads as lag.
 *
 * With reduced motion asked for, the target is handed straight back and no frame is ever requested.
 */
export function useSprungOffsets(
  target: ReadonlyMap<string, Offset>,
  pinned: string | null,
): ReadonlyMap<string, Offset> {
  const [shown, setShown] = useState<ReadonlyMap<string, Offset>>(target);
  const bodies = useRef(new Map<string, Body>());
  const still = prefersReducedMotion();

  useEffect(() => {
    if (still) {
      bodies.current.clear();
      return;
    }

    // The held node is already where it is going. Recorded here rather than in the first frame,
    // because a release can arrive before any frame does - and a node with no recorded position
    // would then spring out from home to the place it was just dropped.
    const held = pinned === null ? undefined : target.get(pinned);
    if (pinned !== null && held !== undefined) {
      bodies.current.set(pinned, bodyAt(held));
    }

    let frame = 0;
    let last: number | null = null;

    const tick = (now: number): void => {
      const seconds = last === null ? 1 / 60 : (now - last) / 1000;
      last = now;

      const next = new Map<string, Offset>();
      let moving = false;

      for (const id of new Set([...target.keys(), ...bodies.current.keys()])) {
        const goal = target.get(id) ?? AT_HOME;

        if (id === pinned) {
          bodies.current.set(id, bodyAt(goal));
          next.set(id, goal);
          continue;
        }

        const body = stepSpring(bodies.current.get(id) ?? bodyAt(AT_HOME), goal, seconds);
        if (!atRest(body, goal)) {
          moving = true;
          bodies.current.set(id, body);
          next.set(id, { dx: body.dx, dy: body.dy });
        } else if (target.has(id)) {
          bodies.current.set(id, bodyAt(goal));
          next.set(id, goal);
        } else {
          bodies.current.delete(id);
        }
      }

      setShown(next);
      if (moving) {
        frame = requestAnimationFrame(tick);
      }
    };

    frame = requestAnimationFrame(tick);
    return () => {
      cancelAnimationFrame(frame);
    };
  }, [target, pinned, still]);

  // Memoised for identity: the drawing recomputes positions and edges whenever this map changes,
  // so a fresh map on a render where nothing moved would redo that work for an identical picture.
  return useMemo(() => {
    if (still) {
      return target;
    }

    const held = pinned === null ? undefined : target.get(pinned);
    if (pinned === null || held === undefined || shown.get(pinned) === held) {
      return shown;
    }

    const exact = new Map(shown);
    exact.set(pinned, held);
    return exact;
  }, [still, target, pinned, shown]);
}
