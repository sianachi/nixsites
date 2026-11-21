/**
 * How far in or out the drawing is.
 *
 * Its own module for the same reason `graph-layout.ts` is one: it is arithmetic with bounds and a
 * step, and arithmetic with bounds is where off-by-one lives. Keeping it out of the component means
 * the ladder can be tested without rendering an SVG, and the component holds one number.
 *
 * **A fixed ladder rather than a multiplier.** Repeatedly multiplying by 1.2 gives 1, 1.2, 1.44,
 * 1.728 - values a reader can never return to exactly, so "back to where I was" becomes
 * unreachable and the label reads 173%. Named steps mean every position is one a person can land
 * on again, and the reset button has somewhere unambiguous to go.
 */

/**
 * The steps, smallest first.
 *
 * A quarter at the bottom because that is roughly where a large workspace fits a pane at all, and
 * three at the top because past that a disc is a blob and the labels are the only content - at
 * which point the reader wants the item, not the drawing. The middle is denser than the ends: the
 * useful range is around 1 and a doubling step there would skip the fit a reader is hunting for.
 */
const STEPS = [0.25, 0.5, 0.75, 1, 1.5, 2, 3] as const;

/**
 * The nearest step above an arbitrary scale, or that scale when it is already past the top.
 *
 * A wheel or a pinch leaves the camera between steps. The buttons still move along the ladder, so
 * from 137% "zoom in" lands on 150% - a place a reader can return to - rather than on 205%.
 */
export function stepIn(scale: number): number {
  return STEPS.find((step) => step > scale + 1e-6) ?? scale;
}

/** The nearest step below an arbitrary scale, or that scale when it is already past the bottom. */
export function stepOut(scale: number): number {
  return [...STEPS].reverse().find((step) => step < scale - 1e-6) ?? scale;
}
