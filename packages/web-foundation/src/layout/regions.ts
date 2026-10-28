/**
 * The shell's arrangement, named once.
 *
 * ## The regions
 *
 * Left to right, and every screen in the product is some subset of these:
 *
 *   rail    | tree           | panes                      | settings panel
 *   fixed   | resizable,     | one to three, split by     | fixed width,
 *   width,  | collapsible,   | the address, each owning   | toggled per
 *   always  | a drawer below | one vertical scroller      | reader
 *           | `lg`           |                            |
 *
 * `shell/app-shell.tsx` composes them and owns the viewport: exactly one element
 * is `h-dvh`, exactly one clips, and each pane owns exactly one scroller. **The
 * vertical axis belongs to the pane, the horizontal axis to the view**, because
 * only the view knows what its wide axis is - a board scrolls through columns, a
 * table through property columns, and the pane cannot know which. See that file
 * for the full scroll model and for what went wrong before it existed.
 *
 * ## What belongs in this file
 *
 * **Only what more than one file needs, and only if it is a fact about the
 * arrangement rather than a fact about one component.** Both halves matter. A
 * dimension with one call site stays with the component that owns it, and the
 * two that are deliberately absent are worth naming so the next reader can see
 * the line was drawn rather than forgotten:
 *
 *   - the drawer's `w-[min(85%,320px)]` cap (`sidebar-drawer.tsx`), which no
 *     other file reasons about, and
 *   - the rail's width, which is never declared numerically at all - it falls
 *     out of `size-(--control-lg)` and its padding, and inventing a constant
 *     for it would be describing the code rather than deciding anything.
 *
 * The sidebar's and the settings panel's widths *are* here, and were not always.
 * They stayed put while this file lived in `app/`, because hoisting them would
 * have made `items/` depend on `app/` while `app/` already depended on `items/`.
 * That cycle is gone: `layout/` imports nothing from the application, so the
 * objection died with the folder. What justifies the move is the third copy -
 * `pane-state.ts` reasons about both numbers while owning neither, and had them
 * written out in prose.
 *
 * ## The class strings
 *
 * These are strings rather than components on purpose. The precedent is
 * `packages/ui/src/primitives/interaction.ts`, which does the same for
 * `focusRing` and the wash states: a shared class list is composed at the call
 * site, so a caller can still add to it, and nothing new appears in the DOM or
 * in the accessibility tree. A `<Pane>` component would add a wrapper element
 * to every one of these positions, and the role inventories the view tests
 * assert against would all have to move.
 *
 * Composing them by interpolation is safe for Tailwind's extractor, which
 * matches class names in source text: every utility below appears as a literal
 * in this file, so `paneColumn` interpolating `paneClip` contributes nothing
 * the extractor still needs to find. Compose freely; do not build a class name
 * out of fragments.
 *
 * They live in the app rather than in `packages/ui` because they encode this
 * shell's arrangement - a fixed tree beside a document beside a settings panel -
 * which is not something a design system should know.
 *
 * ## Why the widths are written as pixels
 *
 * The standard is AGENTS.md's: never hard-code a px value **the tokens carry**.
 * So the question at every raw number is which token would carry it, and the
 * sheet's answer is bounded - a type scale, a control-height scale and a
 * spacing base (ADR-0008). Those answer "how big is this text", "how tall is
 * this control" and "how much room is between things", and every one of those
 * in the shell and the views is a class off a scale.
 *
 * None of them answers "how wide is the sidebar". **The test a reader applies
 * is whether the number is a step of rhythm or a dimension chosen against the
 * screen.** A step of rhythm belongs to the scale and has to come from it. A
 * dimension - a panel's width, an overlay's cap, a popover's height - was
 * picked by looking at a composition, is checked by looking at one, and is
 * written as the pixel value it is. Restating it as a multiple of `--spacing`
 * would turn a number a reader can measure off a screenshot into one they
 * cannot, and would claim a scale membership the sheet does not grant.
 *
 * Two consequences worth naming. Giving those dimensions tokens is a change to
 * the token sheet rather than to a component, so it is decided there and not
 * here. And narrowing them for small screens is the responsive goal's work: a
 * fixed sidebar width is on the MVP-2.5 defect list already, and it is a
 * behaviour change rather than a taste one.
 */

/**
 * A pane that clips its children and shrinks below their content size.
 *
 * `min-h-0` and `min-w-0` are both load-bearing: a flex child's default
 * `min-*: auto` refuses to shrink past its content, which is what pushes a wide
 * table out of its column. `overflow-hidden` is what stops a descendant that is
 * still too wide from painting over its neighbour - shrinking and clipping are
 * different problems and both need saying.
 */
export const paneClip = 'min-h-0 min-w-0 overflow-hidden';

/** A clipping pane that stacks its children and takes the space left over. */
export const paneColumn = `flex flex-1 flex-col ${paneClip}`;

/**
 * A pane's scroller.
 *
 * `overflow-y-auto` states the intent - the pane exists to scroll vertically -
 * but it is worth knowing that CSS does not honour it as a restriction. Per CSS
 * Overflow 3, when one axis is not `visible` the other's `visible` computes to
 * `auto`, so this element is a scroll container on *both* axes and
 * `overflow-y-auto` and `overflow-auto` compute identically. Verified in a
 * browser, not assumed.
 *
 * What actually keeps the horizontal axis out of the pane's hands is the view
 * inside it: `min-w-0` lets the pane shrink to the space available, and every
 * view wide enough to need it carries its own `overflow-x-auto`, which
 * constrains its content to the pane's width so the pane's own horizontal
 * scroller never has anything to scroll. A wide view that does *not* bring one
 * falls back to this - which is the degraded case, not the design.
 */
export const paneScroller = 'min-h-0 min-w-0 flex-1 overflow-y-auto';

/**
 * The width the tree starts at, and the range a drag may take it through.
 *
 * The floor is not a taste number: the tree indents 12px per level and bounds itself at nine
 * levels (`ROW_INDENT`), so below about 200px a nested title is down to a few characters and the
 * hover controls start covering them. The ceiling stops a stray drag from leaving the panes
 * narrower than the tree that navigates them.
 */
export const SIDEBAR_DEFAULT_WIDTH = 264;
export const SIDEBAR_MINIMUM_WIDTH = 200;
export const SIDEBAR_MAXIMUM_WIDTH = 480;

/**
 * The settings panel's preferred width, capped by the space its viewport can provide.
 *
 * **A class literal, not a number, and this is the one place being clever breaks the build.**
 * Tailwind's extractor matches class names in source text, so `w-[${String(WIDTH)}px]` emits no
 * CSS at all - the utility never appears anywhere for it to find. Exporting the number as well
 * would put two spellings of one value back in the file, which is what this consolidation exists
 * to remove, so there is one export and it is the literal.
 */
export const settingsPanelWidth = 'w-[340px] max-w-full';

/**
 * The history panel is wider than settings: it shows a revision rendered as a document beside
 * a diff, and at the settings width a paragraph wraps to a ribbon nobody can compare.
 */
export const historyPanelWidth = 'w-[440px] max-w-full';

/** Two document panes need room beyond the workspace sidebar. */
export const NARROWEST_FOR_TWO_PANES = 1280;

/** Phone-only arrangements follow Tailwind's sm breakpoint. */
export const WIDE_ENOUGH_FOR_NON_PHONE_LAYOUT = '(min-width: 640px)';

/** Portrait tablets use a drawer; landscape layouts can keep the workspace beside the page. */
export const WIDE_ENOUGH_FOR_A_FIXED_SIDEBAR = '(min-width: 1024px)';

/** Details overlay the page until the sidebar, document and panel all have room. */
export const WIDE_ENOUGH_FOR_INLINE_DETAILS = '(min-width: 1280px)';

/** Companion views need the same document width as independent panes. */
export const WIDE_ENOUGH_FOR_COMPANION_BESIDE = WIDE_ENOUGH_FOR_INLINE_DETAILS;

/** A note's title, tools and body use the available pane width at the body type step. */
export const noteColumn = 'w-full font-body text-md';
