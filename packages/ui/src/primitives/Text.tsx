import { cva } from 'class-variance-authority';
import { createElement, type ReactNode } from 'react';

import { cn } from '../lib/cn';

/**
 * <Text> - the typography primitive. Every string the product renders goes
 * through it, so the pairing - one family, headings told apart by weight - and
 * the type scale exist in exactly one place.
 *
 * Two rules are encoded here rather than left to discipline:
 *
 * 1. Family follows role. Heading variants take `--font-heading` at the
 *    heading weight; everything else takes `--font-body`. A caller cannot
 *    pick a family.
 *
 * 2. Accent text respects contrast. The accent/ground pair is tuned to about
 *    3:1 - enough for chrome and large display type, not for body copy - so
 *    `tone="accent"` resolves to the base accent only on the display-size
 *    headings and to `--color-accent-text` everywhere else. There is no way to
 *    ask for base-accent body copy. `--color-accent-text` is a role, so it
 *    moves with the ground: accent-700 at 5.8:1 on paper, accent-300 at 12.1:1
 *    on ink.
 *
 * Sizes and line heights come from the token sheet's type scale (`--text-2xs`
 * ... `--text-3xl`, ADR-0008): each variant names a step and takes the line
 * height paired with it, and nothing here names a pixel. A body-sized heading
 * (h5, h6) therefore takes a body line height, because the pairing belongs to
 * the step rather than to the role - which is what stops the sheet and this
 * file from drifting into two scales.
 *
 * Tracking comes from the sheet's tracking scale (`--tracking-tight` ...
 * `--tracking-widest`), which arrived after this component did: the earlier
 * note here said the sheet carried no such scale and that one value per
 * variant was not worth inventing one for. It exists now, five named steps
 * pulled from the em values a dozen components had each written by hand, and
 * the three variants that track (h1-h5 tight, h6 wider, kicker widest) name a
 * step like every other axis. There is deliberately no `tracking` prop: a
 * caller who wants a different step wants a different variant, and the one
 * real exception in the product - the login wordmark, set at the h2 step but
 * opened to `tracking-slight` because it is two capitals rather than a
 * sentence - is a wordmark, not typography this primitive should learn.
 */

/**
 * `note` is the one variant added by the adoption sweep rather than by the
 * original scale, and it is worth saying why, because a scale that grows a rung
 * per call site stops being a scale.
 *
 * It is `--text-sm` (12px), the step between `bodySmall` (13px) and `caption`
 * (11px). The sheet has always published it - name, size and its own paired
 * line height - and it was the only published step no variant named, which is
 * the whole reason it kept being written by hand. It is not a size somebody
 * wanted; it is the size the interface already speaks in: `Field`'s hint and
 * error lines set it, and so did roughly twenty places in `apps/web` saying the
 * same thing about a control - a validation message, a "loading this" line, an
 * empty-state sentence sitting where a value would be. That is one role with
 * one step, said in twenty voices.
 *
 * Not `caption`, which is metadata *about* content (a figure's caption, a
 * timestamp beside a row) and reads a step quieter. Not `bodySmall`, which is
 * prose the reader is meant to read at length. A note is neither: it is the
 * interface talking about itself.
 */
export type TextVariant =
  'h1' | 'h2' | 'h3' | 'h4' | 'h5' | 'h6' | 'body' | 'bodySmall' | 'note' | 'caption' | 'kicker';

type TextTone = 'default' | 'muted' | 'accent';

/**
 * The roles a paragraph of text may take.
 *
 * Deliberately four names rather than React's `AriaRole`, which is every role in ARIA: this
 * primitive renders text, and the roles text can honestly claim are the announcement ones plus the
 * opt-out. `status` and `alert` are live regions - polite and assertive respectively - so a message
 * that appears in place announces itself; `note` marks an aside that is commentary on its
 * surroundings; `presentation` strips implicit semantics from a paragraph that is decoration.
 *
 * Anything outside this set is a sign the thing being built is not text: a `role="button"` on a
 * paragraph is a button, and `role="listitem"` on one belongs to a list this component does not
 * render. Widening the union is one line and one reviewer looking at it, which is the point.
 */
type TextRole = 'alert' | 'status' | 'note' | 'presentation';

/**
 * The caps label that names a control, as a class string rather than a variant.
 *
 * It is not a variant because it is never a `<Text>`: the thing it dresses is a
 * `<label>`, a `<legend>`, an `<output>` or a grid's column header - elements
 * that carry `htmlFor`, or announce a group, or are the header cell. Wrapping
 * any of them in a paragraph to reach the type would break the wiring that is
 * the whole reason they exist. So the look is published the way `focusRing` and
 * `blueprintFrame` are published: one string, composed onto whatever element
 * the semantics demand.
 *
 * `text-xs` at `tracking-wider` is the sheet's own pairing for caps at this
 * step (see the tracking scale's note: the smaller the caps, the more air they
 * need back). The colour is part of the look and not a caller's choice - a
 * label that competes with the value it names is the wrong way round.
 */
export const fieldLabel = 'font-heading text-xs uppercase tracking-wider text-muted';

type TextElement =
  | 'h1'
  | 'h2'
  | 'h3'
  | 'h4'
  | 'h5'
  | 'h6'
  | 'p'
  | 'span'
  | 'div'
  | 'figcaption'
  // Description lists: a term and its definition are text like any other, and a caller who had to
  // drop out of the component to mark one up would be marking it up wrongly.
  | 'dt'
  | 'dd'
  // A list item, for the same reason and with one extra constraint: `<ul>` and `<ol>` accept only
  // `<li>` children, so a list whose rows are one line of text each has nowhere to put a wrapper.
  // The list element itself is layout and stays the caller's, as it must - this component renders
  // one element, and a list is two.
  | 'li'
  // A table's caption, for the same reason: it is the table's accessible name, so it has to be a
  // real <caption> child of the <table> and cannot be a styled div sitting above it.
  | 'caption';

/**
 * Variants that clear WCAG's large-text threshold and may carry base accent.
 *
 * Two of them now, not three. The threshold is 24px, or 18.66px at weight 700,
 * and these headings are set at 600 - so the 24px line is the one that applies.
 * On the type scale h1 is 40px and h2 is 28px, both clear; h3 is 22px and does
 * not. It used to be 25px, which is the single visible consequence of moving
 * off hand-picked sizes, and it moves h3 to the accent step that carries body
 * copy rather than leaving it at 3.7:1.
 */
const DISPLAY_VARIANTS = ['h1', 'h2'] as const satisfies readonly TextVariant[];

/** Everything at or below h3: accent here must come from the text-carrying step. */
const BODY_SIZED_VARIANTS = [
  'h3',
  'h4',
  'h5',
  'h6',
  'body',
  'bodySmall',
  'note',
  'caption',
  'kicker',
] as const satisfies readonly TextVariant[];

// Size first, then the traits: the step's paired line height is applied by the
// font-size utility, and a variant that refines the shared traits (h6's
// tracking) has to come after the constant it refines for tailwind-merge to
// keep the refinement.
const heading = 'font-heading font-semibold tracking-tight';
const body = 'font-body font-normal';

const textVariants = cva('wrap-anywhere', {
  variants: {
    variant: {
      h1: `text-3xl ${heading}`,
      h2: `text-2xl ${heading}`,
      h3: `text-xl ${heading}`,
      h4: `text-lg ${heading}`,
      h5: `text-md ${heading}`,
      h6: `text-base ${heading} tracking-wider uppercase`,
      body: `text-md ${body}`,
      bodySmall: `text-base ${body}`,
      note: `text-sm ${body}`,
      caption: `text-xs ${body}`,
      // 11px, not the sheet's 10px step: no visible text sits below 11px (the platform floor).
      kicker: `text-xs ${body} tracking-widest uppercase`,
    },
    tone: {
      default: 'text-foreground',
      // The role, not a ramp step. The design system's own advice is to prefer
      // a ramp step over an ad-hoc color-mix, and it pays here: the 55% ink the
      // source sheet uses for muted copy lands at 3.7:1 on paper. But the step
      // that reads as quiet-but-legible differs by ground - neutral-700 clears
      // AA at 5.9:1 on paper and is nearly invisible on ink - so the choice of
      // step belongs to the sheet, which is what `--color-muted` is. It crosses
      // to neutral-400 on the dark ground, 8.9:1.
      muted: 'text-muted',
      // Resolved by the compound variants below - never by this entry, so a
      // new variant that forgets to declare its contrast class fails loudly
      // (uncolored text) instead of quietly shipping a 3:1 accent.
      accent: '',
    },
    // Single-line ellipsis. A caller who reaches for this has already decided the full string is
    // available elsewhere - the native tooltip via `title`, an adjacent detail view - because this
    // variant hides the overflow rather than reflowing it.
    truncate: {
      true: 'truncate',
      false: '',
    },
    // Multi-line clamp, for the card-and-grid layouts that give a title a fixed number of rows
    // rather than one. Named `lines` rather than `clamp` because the number is the caller-facing
    // fact - how many rows this text may take - and `line-clamp-*` is just how the sheet spells it.
    lines: {
      1: 'line-clamp-1',
      2: 'line-clamp-2',
      3: 'line-clamp-3',
    },
  },
  compoundVariants: [
    { tone: 'accent', variant: [...DISPLAY_VARIANTS], class: 'text-accent' },
    { tone: 'accent', variant: [...BODY_SIZED_VARIANTS], class: 'text-accent-text' },
  ],
  defaultVariants: { variant: 'body', tone: 'default' },
});

const DEFAULT_ELEMENT: Record<TextVariant, TextElement> = {
  h1: 'h1',
  h2: 'h2',
  h3: 'h3',
  h4: 'h4',
  h5: 'h5',
  h6: 'h6',
  body: 'p',
  bodySmall: 'p',
  note: 'p',
  caption: 'figcaption',
  kicker: 'span',
};

export interface TextProps {
  variant?: TextVariant;
  tone?: TextTone;
  /**
   * Override the rendered element when the document outline demands it - a
   * page's second-level heading styled as `h1`, say. Visual weight stays with
   * `variant`; this only changes the tag.
   */
  as?: TextElement;
  id?: string;
  children?: ReactNode;
  /** Layout only - margin, width, grid placement. Never type or color. */
  className?: string;
  /**
   * The three accessibility attributes below, and no spread.
   *
   * This component used to take none, and the workaround was to wrap it: see
   * `export-dialog.tsx`, which put `role="status"` on a surrounding `<div>`
   * because the paragraph could not carry it. That was tolerable for one call
   * site and wrong at twenty - a validation message announced by a wrapper
   * around the message is a different tree from the message announcing itself,
   * and the difference shows up in what a screen reader reads back.
   *
   * They are listed one by one rather than admitted as
   * `HTMLAttributes<HTMLElement>` on purpose. An open spread would let `style`,
   * `onClick` and a second `className` in through the back door, and every one
   * of those is something this primitive exists to refuse: type and colour come
   * from the variant, and text that handles clicks is a control that should be
   * a control. If a fourth attribute is genuinely needed, adding it here is one
   * line and one reviewer looking at it - which is the point.
   */
  role?: TextRole;
  /** Native tooltip for text that truncates - the full string, unelided. */
  title?: string;
  /**
   * Collapse to a single line with a trailing ellipsis, for a title beside a fixed-width control
   * that cannot grow with the string. Pair with `title` so the elided text is still reachable.
   */
  truncate?: boolean;
  /**
   * Clamp to this many lines, wrapping otherwise, for a card or grid cell whose height is fixed by
   * its neighbours rather than by the string in it. Mutually exclusive with `truncate` in practice
   * - a caller wants one line or a fixed few, not both.
   */
  lines?: 1 | 2 | 3;
  /** For a note that appears in place: the live region is the text itself. */
  'aria-live'?: 'off' | 'polite' | 'assertive';
}

export function Text({
  variant = 'body',
  tone = 'default',
  as,
  id,
  children,
  className,
  role,
  title,
  truncate,
  lines,
  'aria-live': ariaLive,
}: TextProps): ReactNode {
  return createElement(
    as ?? DEFAULT_ELEMENT[variant],
    {
      className: cn(textVariants({ variant, tone, truncate, lines }), className),
      id,
      role,
      title,
      'aria-live': ariaLive,
    },
    children,
  );
}
