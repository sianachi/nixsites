import { useEffect, useLayoutEffect, useRef, type RefObject } from 'react';

import { placeFloatingMenu, readViewportBounds } from '../primitives/placement';
import type { FloatingMenuAnchor } from '../primitives/placement';

/**
 * Keeps a fixed-position panel beside its anchor and inside the visual viewport.
 *
 * Shared by `<Menu>`, `<ContextMenu>` and `<Popover>`, which all float a panel off a trigger or a
 * point and all owe the same three things: open below and flip above when there is no room, stay
 * 8px inside the *visual* viewport (which shrinks under an on-screen keyboard), and step aside on a
 * phone, where the panel becomes a bottom sheet above the on-screen keyboard.
 *
 * `anchor` is read on every placement rather than captured, so a caller may pass a fresh closure
 * each render without re-binding the listeners. `remeasure` re-runs placement when the panel's
 * content - and so its size - changes.
 */
export function useAnchoredPanel(
  panelRef: RefObject<HTMLElement | null>,
  anchor: () => FloatingMenuAnchor | null,
  remeasure: unknown,
  /** Pixels at the bottom of the visual viewport the phone sheet must stay clear of (a dock). */
  sheetClearance?: () => number,
): void {
  useLayoutEffect(() => {
    const panel = panelRef.current;
    if (!panel) return;
    if (typeof panel.showPopover !== 'function') {
      panel.removeAttribute('popover');
      return;
    }
    // The top layer escapes chat stacking and ancestor clipping before controls take focus.
    panel.showPopover();
    return () => {
      if (panel.isConnected && panel.matches(':popover-open')) panel.hidePopover();
    };
  }, [panelRef]);

  const latest = useRef(anchor);
  const clearance = useRef(sheetClearance);
  useEffect(() => {
    latest.current = anchor;
    clearance.current = sheetClearance;
  });

  useEffect(() => {
    const panel = panelRef.current;
    if (!panel) return;

    const margin = 8;

    const place = (): void => {
      const scrollTop = panel.scrollTop;
      const desktop =
        typeof matchMedia === 'function' ? matchMedia('(min-width: 640px)').matches : true;
      const viewport = readViewportBounds();
      panel.style.removeProperty('width');
      panel.style.removeProperty('min-width');
      panel.style.removeProperty('max-width');
      panel.style.removeProperty('max-height');
      if (!desktop) {
        const lift = clearance.current?.() ?? 0;
        const maxHeight = Math.max(0, (viewport.height - lift) * 0.7);
        panel.style.setProperty('width', `${String(viewport.width)}px`);
        panel.style.setProperty('min-width', '0');
        panel.style.setProperty('max-width', `${String(viewport.width)}px`);
        panel.style.setProperty('max-height', `${String(maxHeight)}px`);
        panel.style.setProperty('left', `${String(viewport.left)}px`);
        panel.style.setProperty(
          'top',
          `${String(viewport.top + viewport.height - lift - panel.getBoundingClientRect().height)}px`,
        );
        panel.style.setProperty('bottom', 'auto');
        panel.style.setProperty('transform', 'none');
        panel.scrollTop = scrollTop;
        return;
      }

      const anchorRect = latest.current();
      if (anchorRect === null) return;
      panel.style.removeProperty('bottom');
      const maxWidth = Math.max(0, viewport.width - margin * 2);
      const minWidth = Number.parseFloat(getComputedStyle(panel).minWidth) || 0;
      panel.style.setProperty('min-width', `${String(Math.min(minWidth, maxWidth))}px`);
      panel.style.setProperty('max-width', `${String(maxWidth)}px`);
      const panelRect = panel.getBoundingClientRect();

      // `minHeight` set to the panel's own measured height (plus the same margin) flips it
      // whenever there is not enough room below for the panel as rendered.
      const placement = placeFloatingMenu(anchorRect, panelRect.width, viewport, {
        minHeight: panelRect.height + margin,
      });

      // A panel taller than either side of its anchor is capped to the side chosen, and its own
      // overflow-y-auto makes the rest reachable by scrolling.
      panel.style.setProperty('max-height', `${String(Math.max(0, placement.maxHeight - 4))}px`);
      panel.style.setProperty('left', `${String(placement.left)}px`);
      panel.style.setProperty(
        'top',
        `${String(placement.above ? placement.top - 4 : placement.top + 4)}px`,
      );
      panel.style.setProperty('transform', placement.above ? 'translateY(-100%)' : 'none');
      panel.scrollTop = scrollTop;
    };
    const onScroll = (event: Event): void => {
      if (event.target instanceof Node && panel.contains(event.target)) return;
      place();
    };

    place();
    // Content that grows after opening (a thread's replies, a composer) re-places the panel.
    const resized = typeof ResizeObserver === 'undefined' ? null : new ResizeObserver(place);
    resized?.observe(panel);
    const viewport = window.visualViewport;
    window.addEventListener('resize', place);
    document.addEventListener('scroll', onScroll, true);
    viewport?.addEventListener('resize', place);
    viewport?.addEventListener('scroll', place);
    return () => {
      resized?.disconnect();
      window.removeEventListener('resize', place);
      document.removeEventListener('scroll', onScroll, true);
      viewport?.removeEventListener('resize', place);
      viewport?.removeEventListener('scroll', place);
    };
  }, [panelRef, remeasure]);
}
