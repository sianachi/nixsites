import { createPortal } from 'react-dom';
import {
  useCallback,
  useEffect,
  useLayoutEffect,
  useRef,
  type PointerEvent as ReactPointerEvent,
  type ReactNode,
} from 'react';

import {
  isHorizontalIntent,
  releaseHandoff,
  snapsOpen,
  takeHandoff,
  type DrawerSide,
} from './use-edge-swipe';

/**
 * The workspace tree, as an off-canvas drawer.
 *
 * `<WorkspaceSidebar>` is otherwise a permanent flex sibling of the panes it navigates - see
 * `app-shell.tsx`. On a phone there is no room to share: a fixed-width column beside the content
 * would leave neither one usable. This is the same tree, unmounted or mounted by the shell's own
 * narrow-scoped visibility, standing in for the flex panel below the width where a screen can hold
 * both. The caller decides when it is on screen at all - this component only mounts open, the way
 * `SidebarDivider` is unmounted rather than hidden when the tree is (see `app-shell.tsx`'s own
 * comment on that).
 *
 * **Not a native `<dialog>` opened with `showModal()`**, which is what `<Dialog>` in `packages/ui`
 * uses for exactly this problem. That is not a missed reuse: a `showModal()` dialog renders in the
 * browser's own top layer, anchored to the *viewport* rather than to any ancestor in the page - and
 * covering the viewport is exactly what this component exists not to do. The header above it -
 * search, the profile menu, and the very toggle button that opened the drawer - has to stay on
 * screen and reachable, because the toggle is the way back, and a top-layer dialog would sit over
 * it along with everything else.
 *
 * **No focus trap, and no `role="dialog"` either**, for the same reason: this is not a modal in the
 * sense either of those exists to serve. While the drawer is open, `app-shell.tsx` applies React
 * 19's native `inert` attribute to the pane content it overlays - the sibling this component does
 * not itself render - which makes that region genuinely unreachable to pointer and assistive
 * technology without a hand-rolled trap standing in for what the platform already does. The header
 * stays interactive throughout, on purpose: closing the drawer has to remain one tab or one click
 * away. What is left inside is the plain scrim-and-panel below, and the `<aside aria-label
 * ="Workspace">` already inside `<WorkspaceSidebar>` is the real landmark here once nothing wraps
 * it in a dialog role it was never using anyway.
 */

export interface SidebarDrawerProps {
  /** Asked to close - by Escape or by tapping the scrim. Whether that closes anything, and where
   * focus goes afterwards, is entirely the caller's decision - see `app-shell.tsx`, which sends
   * focus to the header's own toggle button on this path and somewhere else entirely when a row is
   * picked instead. */
  readonly onClose: () => void;

  /** Which screen edge the drawer slides from. */
  readonly side?: DrawerSide;

  /** Cover the whole viewport instead of the positioned shell around it (the right-hand panel). */
  readonly fixed?: boolean;

  readonly children: ReactNode;
}

const SETTLE_MS = 200;

const reducedMotion = (): boolean =>
  typeof window.matchMedia !== 'function' ||
  window.matchMedia('(prefers-reduced-motion: reduce)').matches;

/**
 * Touch gestures (phone only in practice): an edge swipe hands its live finger position over via
 * `useEdgeSwipeOpen`, and a horizontal drag on the open drawer closes it. Both snap on release by
 * distance and velocity, and the page dims with the drawer's progress.
 */
export function SidebarDrawer({
  onClose,
  side = 'left',
  fixed = false,
  children,
}: SidebarDrawerProps): ReactNode {
  const panel = useRef<HTMLDivElement>(null);
  const scrim = useRef<HTMLButtonElement>(null);
  const close = useRef(onClose);
  const drag = useRef<{
    x0: number;
    y0: number;
    claimed: boolean;
    last: { x: number; t: number };
    vx: number;
  } | null>(null);
  useEffect(() => {
    close.current = onClose;
  }, [onClose]);

  const show = useCallback(
    (progress: number, animate: boolean) => {
      const moving = animate && !reducedMotion();
      if (panel.current) {
        panel.current.style.transition = moving
          ? `transform ${String(SETTLE_MS)}ms ease-out`
          : 'none';
        panel.current.style.transform = `translateX(${String((side === 'left' ? -1 : 1) * (1 - progress) * 100)}%)`;
      }
      if (scrim.current) {
        scrim.current.style.transition = moving
          ? `opacity ${String(SETTLE_MS)}ms ease-out`
          : 'none';
        scrim.current.style.opacity = String(progress);
      }
    },
    [side],
  );

  const settle = useCallback(
    (progress: number, vx: number) => {
      // `vx` is screen-space; the opening direction points away from the drawer's own edge.
      if (snapsOpen(progress, side === 'left' ? vx : -vx)) {
        show(1, true);
        return;
      }
      show(0, true);
      window.setTimeout(
        () => {
          close.current();
        },
        reducedMotion() ? 0 : SETTLE_MS,
      );
    },
    [show, side],
  );

  useLayoutEffect(() => {
    const taken = takeHandoff(side);
    if (taken === null) {
      show(0, false);
      const frame = requestAnimationFrame(() => {
        show(1, true);
      });
      return () => {
        cancelAnimationFrame(frame);
      };
    }
    const follow = (): void => {
      const width = Math.max(panel.current?.offsetWidth ?? 1, 1);
      const progress = Math.min(
        1,
        Math.max(0, (side === 'left' ? taken.x : window.innerWidth - taken.x) / width),
      );
      if (taken.ended) {
        settle(progress, taken.vx);
        releaseHandoff(taken);
      } else {
        show(progress, false);
      }
    };
    taken.listener = follow;
    follow();
    return () => {
      // Not `releaseHandoff`: StrictMode re-runs this effect and the second run still needs it.
      taken.listener = null;
    };
  }, [side, show, settle]);

  function progressAt(x: number): number {
    const width = Math.max(panel.current?.offsetWidth ?? 1, 1);
    const origin = drag.current?.x0 ?? x;
    return Math.min(1, Math.max(0, 1 - (side === 'left' ? origin - x : x - origin) / width));
  }

  function onPointerDown(event: ReactPointerEvent): void {
    if (event.pointerType !== 'touch') return;
    drag.current = {
      x0: event.clientX,
      y0: event.clientY,
      claimed: false,
      last: { x: event.clientX, t: event.timeStamp },
      vx: 0,
    };
  }

  function onPointerMove(event: ReactPointerEvent): void {
    const state = drag.current;
    if (state === null) return;
    const dx = event.clientX - state.x0;
    const dy = event.clientY - state.y0;
    if (event.timeStamp > state.last.t) {
      state.vx = (event.clientX - state.last.x) / (event.timeStamp - state.last.t);
    }
    state.last = { x: event.clientX, t: event.timeStamp };
    if (state.claimed) {
      show(progressAt(event.clientX), false);
    } else if (isHorizontalIntent(dx, dy) && (side === 'left' ? dx < 0 : dx > 0)) {
      // Only a drag toward the drawer's own edge (closing) is claimed; vertical stays a scroll.
      state.claimed = true;
      event.currentTarget.setPointerCapture(event.pointerId);
    } else if (Math.abs(dy) > 10) {
      drag.current = null;
    }
  }

  function onPointerEnd(event: ReactPointerEvent): void {
    const state = drag.current;
    if (state?.claimed) settle(progressAt(event.clientX), state.vx);
    drag.current = null;
  }

  useEffect(() => {
    // On `window`, not `document`. `document` sits between a keydown's target and `window` on
    // every event's path, so anything nested inside this drawer that needs "my own Escape wins"
    // stops propagation at `document` - see `CreateMenu` (`workspace-sidebar.tsx`), `ProfileMenu`
    // and `CommandPalette` for that half of the convention - and never reaches a listener out here
    // at all. That ordering is fixed by where each listener sits in the DOM's own propagation
    // path, not by which of them happened to attach first: two listeners on the very same node run
    // in attachment order regardless of `stopPropagation`, which is why the drawer listens further
    // out instead of trying to out-order every interactive layer that might nest inside it.
    function onKeyDown(event: KeyboardEvent): void {
      if (event.key === 'Escape') {
        onClose();
      }
    }

    window.addEventListener('keydown', onKeyDown);
    return () => {
      window.removeEventListener('keydown', onKeyDown);
    };
  }, [onClose]);

  const drawer = (
    <>
      {/* Dismisses on tap, the gesture everybody tries first. Not reachable by Tab - Escape is
          the keyboard way out, and a scrim in the tab sequence would be a stop between the panel
          and itself with nothing to say about either. Sized to the whole remaining area, so as a
          touch target it clears WCAG 2.5.8's 24px minimum by a wide margin. */}
      <button
        ref={scrim}
        type="button"
        tabIndex={-1}
        aria-label={side === 'left' ? 'Close the Explorer' : 'Close the panel'}
        onClick={onClose}
        className={`${fixed ? 'fixed z-[60]' : 'absolute z-0'} inset-0 cursor-pointer bg-neutral-900/40`}
      />

      {/* design-token-exempt: the phone browser takes the available width; wider drawers cap at
          320px with room for a dismissing scrim. This is panel geometry, not a spacing scale.

          `z-10`, not `z-20`: this panel and the scrim below it sit *beside* `<main>`, not inside
          it, so `<main>`'s own `isolate` (see `app-shell.tsx`) does nothing to keep this pair out
          of the header's way - stacking containment only reaches descendants, and these two are
          `<main>`'s siblings. What actually keeps them from competing with the header's popovers
          is the number itself: low enough to lose outright to the profile menu and search overlay
          in the one stacking context they all share. Ordering the panel above its own scrim
          (`z-10` over `z-0`) is the only thing this pair's numbers need to do relative to each
          other. See `app-shell.tsx`'s skip-link comment for the full ladder. */}
      <div
        ref={panel}
        onPointerDown={onPointerDown}
        onPointerMove={onPointerMove}
        onPointerUp={onPointerEnd}
        onPointerCancel={onPointerEnd}
        className={`${fixed ? 'fixed z-[61]' : 'absolute z-10'} inset-y-0 ${side === 'left' ? 'left-0' : 'right-0'} flex w-[85%] shrink-0 touch-pan-y overflow-hidden shadow-lg sm:w-[min(85%,320px)]`}
      >
        {children}
      </div>
    </>
  );

  // A viewport-wide drawer must escape the page's stacking contexts to sit above the bottom bar.
  return fixed ? createPortal(drawer, document.body) : drawer;
}
