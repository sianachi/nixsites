import { focusRing } from '@nix/ui';
import { useRef, type ReactNode } from 'react';

import { SIDEBAR_DEFAULT_WIDTH, SIDEBAR_MAXIMUM_WIDTH, SIDEBAR_MINIMUM_WIDTH } from './regions';
import { clampWidth } from './use-sidebar';

/** How far one arrow press moves the edge, and one with Shift held. Pixels, like the value. */
const STEP = 8;
const COARSE_STEP = 32;

export interface SidebarDividerProps {
  /** The tree's settled width. The handle reads it; only `onCommit` may change it. */
  readonly width: number;

  /**
   * Called continuously during a drag with the new width.
   *
   * The shell is expected to apply it without a React render, the same contract as the pane
   * divider's: a state update per pointer event would re-render the tree and every open editor
   * for the whole length of the drag.
   */
  readonly onPreview: (width: number) => void;

  /** Called once the value has settled: on pointer release, or immediately on a key press. */
  readonly onCommit: (width: number) => void;
}

/**
 * The handle on the workspace tree's free edge.
 *
 * The same window-splitter grammar as `PaneDivider`, and deliberately not that component: a pane
 * divider trades a *share* between the two neighbours it sits between, while this moves one edge
 * of a fixed-width region and reports pixels. Folding both behaviours into one control would give
 * it two value models and a flag to pick between them.
 *
 * **Keyboard first, pointer second**, for the reason the pane divider records: a layout control
 * that can only be dragged is a layout control for only some people. Enter toggles between the
 * default width and wherever the handle was before it - the one position a drag cannot aim at.
 */
export function SidebarDivider({ width, onPreview, onCommit }: SidebarDividerProps): ReactNode {
  const ref = useRef<HTMLDivElement>(null);

  // Where the handle was before Enter sent it to the default, so the same key puts it back. A ref
  // rather than state because nothing renders from it.
  const beforeDefaultRef = useRef<number | null>(null);

  function onKeyDown(event: React.KeyboardEvent<HTMLDivElement>): void {
    const step = event.shiftKey ? COARSE_STEP : STEP;

    if (event.key === 'ArrowLeft') {
      event.preventDefault();
      onCommit(clampWidth(width - step));
      return;
    }

    if (event.key === 'ArrowRight') {
      event.preventDefault();
      onCommit(clampWidth(width + step));
      return;
    }

    if (event.key === 'Home') {
      event.preventDefault();
      onCommit(SIDEBAR_MINIMUM_WIDTH);
      return;
    }

    if (event.key === 'End') {
      event.preventDefault();
      onCommit(SIDEBAR_MAXIMUM_WIDTH);
      return;
    }

    if (event.key === 'Enter' || event.key === ' ') {
      event.preventDefault();

      if (width === SIDEBAR_DEFAULT_WIDTH) {
        const restored = beforeDefaultRef.current;
        if (restored !== null) {
          beforeDefaultRef.current = null;
          onCommit(restored);
        }
        return;
      }

      beforeDefaultRef.current = width;
      onCommit(SIDEBAR_DEFAULT_WIDTH);
    }
  }

  function onPointerDown(event: React.PointerEvent<HTMLDivElement>): void {
    // Only the primary button. Without this, a right-click to open a context menu starts a drag
    // that nothing ends.
    if (event.button !== 0) {
      return;
    }

    const element = ref.current;
    const tree = element?.previousElementSibling;
    if (!element || !tree) {
      return;
    }

    // Capture, so the drag survives the pointer leaving the handle - which it does immediately,
    // because the handle is a few pixels wide and a hand is not that steady.
    element.setPointerCapture(event.pointerId);

    // The edge being dragged is the tree's right edge, so the width under the pointer is the
    // distance from the tree's left edge - measured, not derived, for the pane divider's reason:
    // the element already knows and asking it is exact.
    const left = tree.getBoundingClientRect().left;

    function onPointerMove(moveEvent: PointerEvent): void {
      onPreview(clampWidth(moveEvent.clientX - left));
    }

    // Narrowed once, so the listeners below close over a value TypeScript knows is an element.
    const handle = element;

    function stopTracking(): void {
      handle.removeEventListener('pointermove', onPointerMove);
      handle.removeEventListener('pointerup', onPointerUp);
      handle.removeEventListener('pointercancel', onPointerCancel);
    }

    function onPointerUp(upEvent: PointerEvent): void {
      onCommit(clampWidth(upEvent.clientX - left));
      stopTracking();
    }

    function onPointerCancel(): void {
      // A gesture the system took away has to put the layout back where it started rather than
      // commit wherever the pointer happened to be - `pointercancel` carries stale or zero
      // coordinates in some engines, which here would slam the tree to its minimum.
      onPreview(width);
      stopTracking();
    }

    handle.addEventListener('pointermove', onPointerMove);
    handle.addEventListener('pointerup', onPointerUp);
    handle.addEventListener('pointercancel', onPointerCancel);
  }

  // Justification: `jsx-a11y` classes `separator` as non-interactive, which is true of the
  // decorative kind and false of this one. ARIA defines a *focusable* separator as the window
  // splitter widget - a range control with a value, which is exactly what this is and why it
  // carries `aria-valuenow`, `aria-valuemin` and `aria-valuemax`. The rule cannot tell the two
  // apart, and the element it would steer this towards, a `<button>`, has no way to report a
  // value at all.
  /* eslint-disable jsx-a11y/no-noninteractive-element-interactions, jsx-a11y/no-noninteractive-tabindex */
  return (
    <div
      ref={ref}
      role="separator"
      tabIndex={0}
      aria-orientation="vertical"
      aria-label="Resize the Explorer"
      aria-valuenow={width}
      // A bare number is announced with no units and no subject.
      aria-valuetext={`Explorer ${String(width)} pixels wide`}
      aria-valuemin={SIDEBAR_MINIMUM_WIDTH}
      aria-valuemax={SIDEBAR_MAXIMUM_WIDTH}
      onKeyDown={onKeyDown}
      onPointerDown={onPointerDown}
      className={[
        // The same hairline-in-a-band the pane divider draws: the visible rule is the divider
        // colour, the band either side is hit area, and the pseudo-element widens the target to
        // WCAG 2.2's 24px without widening what the eye sees.
        'group relative shrink-0 touch-none',
        'w-2 cursor-col-resize before:absolute before:inset-y-0 before:-inset-x-2',
        focusRing,
      ].join(' ')}
    >
      <span
        aria-hidden="true"
        className={[
          'pointer-events-none absolute inset-y-0 left-1/2 w-px -translate-x-1/2',
          'bg-divider transition-colors',
          'group-hover:bg-accent group-focus-visible:bg-accent',
        ].join(' ')}
      />
    </div>
  );
  /* eslint-enable jsx-a11y/no-noninteractive-element-interactions, jsx-a11y/no-noninteractive-tabindex */
}
