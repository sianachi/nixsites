/**
 * The gutter a view's content is inset by, matching ItemHeader and ViewSwitcher (editor-page.tsx,
 * view-switcher.tsx).
 *
 * A view's own content - board, gallery, list, calendar, timeline - carries no horizontal padding
 * of its own, so without the wrapper below its grid or table started flush with the pane's edge, a
 * further two steps left of where the switcher's tabs and the header's title both start. One
 * wrapper rather than the same padding repeated in five view files, which is what let it drift the
 * first time (see the follow-up note in rhythm-specimen.tsx's chrome-alignment demo).
 *
 * **Exported as a constant, not described in prose.** The wrapper removed the repetition and a
 * comment saying "px-8" was the only thing tying the one remaining exception - the calendar's
 * bleeding scroller - back to it, which is the same drift in slower motion. A whole class string
 * rather than an assembled one, because Tailwind generates only what it can read in the source.
 *
 * **A leaf module, deliberately.** `ContainerView` (`container-view.tsx`) is what actually applies
 * this padding, but a kind view - `calendar-view.tsx` in particular, for the bleed below - needs
 * the same constant without depending on the dispatcher that renders every kind, `container-view`
 * among them via `view-kinds`. Importing the wrapper for its constant would have closed a cycle:
 * `view-kinds → calendar-view → container-view → view-kinds`. This file has no imports of its own,
 * so nothing that reaches it can be pulled back into a kind view through it.
 */
export const VIEW_GUTTER = 'px-4 sm:px-8';

/**
 * The gutter, cancelled and then re-applied inside.
 *
 * For content that must scroll edge to edge of the pane while its own padding keeps the resting
 * layout identical - the calendar's wide grid is the one case. Paired with {@link VIEW_GUTTER} so
 * the negative margin can never be a different number from the padding it undoes.
 */
export const VIEW_GUTTER_BLEED = '-mx-4 px-4 sm:-mx-8 sm:px-8';
