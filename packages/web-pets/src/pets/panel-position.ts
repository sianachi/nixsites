/** Where the open conversation panel sits when the launcher has been dragged somewhere. The
 * launcher is clamped to the viewport at its own small size, so the much larger panel cannot
 * simply grow from the launcher's corner: it would run off the right or bottom edge. This module
 * is pure arithmetic over boxes the caller measured, so it reads no DOM and can be checked
 * without one. */

export interface Box {
  readonly left: number;
  readonly top: number;
  readonly width: number;
  readonly height: number;
}

export interface Size {
  readonly width: number;
  readonly height: number;
}

/** Keeps `value` within `[min, max]`; when the range is empty (the panel is larger than the
 * space available) `min` wins, so the panel's top-left corner stays reachable rather than the
 * header sliding off the top or left edge. */
function clamp(value: number, min: number, max: number): number {
  return Math.max(min, Math.min(value, max));
}

/** Where the open panel sits: its corner nearest the launcher stays at the launcher, then the
 * whole box is kept inside the viewport. A launcher in the right half aligns the panel's right
 * edge with its own, otherwise the left edges align; a launcher in the bottom half aligns the
 * bottoms, otherwise the tops. `bottomClearance` is the room the mobile navigation takes from
 * the viewport's bottom edge. */
export function openPanelPosition(
  launcher: Box,
  panel: Size,
  viewport: Size,
  margin: number,
  bottomClearance: number,
): { readonly left: number; readonly top: number } {
  const rightHalf = launcher.left + launcher.width / 2 > viewport.width / 2;
  const bottomHalf = launcher.top + launcher.height / 2 > viewport.height / 2;
  const left = rightHalf ? launcher.left + launcher.width - panel.width : launcher.left;
  const top = bottomHalf ? launcher.top + launcher.height - panel.height : launcher.top;
  return {
    left: clamp(left, margin, viewport.width - panel.width - margin),
    top: clamp(top, margin, viewport.height - panel.height - margin - bottomClearance),
  };
}
