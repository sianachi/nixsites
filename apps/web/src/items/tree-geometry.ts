/**
 * Where on a row a drop would land.
 *
 * The row's middle band means inside; its top and bottom edges mean before and after, as siblings.
 * This distinction used to come free from the item's type - onto a folder meant inside, onto a note
 * meant beside - and with one kind of item there is nothing left to read it from but the pointer.
 *
 * The middle is deliberately the larger share. Dropping something *into* the thing under the
 * pointer is the common intent and the one that should be easy to hit; reordering is the
 * deliberate act, and its targets sit where a miss lands you inside rather than somewhere
 * surprising.
 */
export type DropZone = 'before' | 'inside' | 'after';

const EDGE_BAND = 0.25;

/**
 * How far a row is pushed in for its depth, enumerated as classes.
 *
 * The tree used to compute `paddingLeft` and set it through `style`. Inline styles are banned
 * repository-wide (`app.css` says so, and the rule is why there is one stylesheet), and a CSS
 * custom property assigned through `style` is still an inline style - it moves the value, not the
 * attribute. So the depths are written out.
 *
 * The steps are the drawing's 6px base and 12px per level, rounded onto the spacing scale: a 2-unit
 * base and 3.5 units per level. `--spacing` is 3.4px, so `ROW_INDENT` runs 0.8px wide at the root
 * and closes to exactly the drawn value by its last step.
 *
 * `CHILD_NOTICE_INDENT` is that ladder one level down plus the row's own gutter - the expand chevron
 * (`size-5`) and the gap beside it, 6 units together - so "Loading…" and "Empty" line up with the
 * titles of the children they stand in for rather than with their chevrons. It runs 1.1px wide at
 * the root and 0.4px at its last step: the gutter was written as a round 26px and the chevron and
 * gap it stands for actually measure 20.4px, so these notices end up a hair better aligned than
 * they were drawn. That is the only entry in this file that moves by more than a pixel.
 *
 * **Bounded, deliberately.** Depth is unbounded in principle and the sidebar's width is not - it
 * starts at 264px and can be dragged down to 200 - so the indent cannot be unbounded in practice:
 * nine levels already spend 102px of the width, and a tenth would be taken from the title. Past the bound the indent stops growing and deeper rows share the last
 * step. Depth is still carried where it is load-bearing - `role="treeitem"`, `aria-expanded`, and
 * each level's own `role="group"` - so what a tenth level loses is the picture of its depth, not
 * the fact of it, and assistive technology is told the same thing either way.
 *
 * **The two ladders have to stop at the same place**, which is why this one is a step shorter.
 * `CHILD_NOTICE_INDENT[i]` stands for a row at depth `i + 1`, so it runs out one level sooner: with
 * a ninth entry, a notice under a depth-8 node sat 11.9px further in than the children that then
 * replaced it, and the placeholder visibly jumped as they loaded.
 *
 * Both of those are relationships between the two ladders rather than facts about either, so they
 * are asserted in `tree-indent.test.ts` rather than only described here - which is also why all
 * three names below are exported.
 */
export const ROW_INDENT = [
  'pl-2',
  'pl-5.5',
  'pl-9',
  'pl-12.5',
  'pl-16',
  'pl-19.5',
  'pl-23',
  'pl-26.5',
  'pl-30',
] as const;

export const CHILD_NOTICE_INDENT = [
  'pl-11.5',
  'pl-15',
  'pl-18.5',
  'pl-22',
  'pl-25.5',
  'pl-29',
  'pl-32.5',
  'pl-36',
] as const;

/** The step for a depth, clamped to the deepest one the sidebar has room to draw. */
export function indentAt(scale: readonly [string, ...string[]], depth: number): string {
  return scale[Math.min(Math.max(depth, 0), scale.length - 1)] ?? scale[0];
}

export function dropZoneAt(offsetY: number, height: number): DropZone {
  if (height <= 0) {
    return 'inside';
  }

  const position = offsetY / height;

  if (position < EDGE_BAND) {
    return 'before';
  }

  return position > 1 - EDGE_BAND ? 'after' : 'inside';
}
