import { CALLOUT_TONES, type CalloutTone } from '@nix/editor-schema';

import {
  DOCUMENT_BODY_STEP,
  DOCUMENT_HEADING_STEP,
  DOCUMENT_SECONDARY_STEP,
  TOGGLE_SUMMARY_STEP,
} from './prose-type';

/**
 * The document's typography, as class strings.
 *
 * **Why this file exists.** Tailwind's preflight resets the browser's default typography to
 * nothing: no heading sizes, no list markers, no quote indent, no table borders. A rich document
 * rendered under it is a column of identical plain text, and the editor looks broken when in fact
 * only its clothes are missing. These strings are the clothes.
 *
 * **Why class strings and not a stylesheet.** The repository allows exactly two `.css` files - the
 * Tailwind entry and the design-token sheet - so there is nowhere to put a `.prose h1 { ... }` rule
 * and no wish for one. The upside is that the styles are ordinary source: greppable, diffable, and
 * checked by a test rather than by eye.
 *
 * **Why here and not in `@nix/editor-schema`.** The collaboration service builds the same
 * extension list in Node to check that an accepted update still parses. It renders nothing, and a
 * presentation concern in that package would be a concern it has to carry into a process that has
 * no DOM. The schema says what a document may contain; this file says what it looks like.
 *
 * **How they reach the document.** ProseMirror renders the document, so React never sees a heading
 * to put a `className` on. `note-editor.tsx` instead hands each string to its extension as
 * `HTMLAttributes.class`, which TipTap merges into that node's rendered element - see the mapping
 * there.
 *
 * **No arbitrary values, anywhere.** Every size is a step on the token sheet's type or spacing
 * scale and every colour is a role or a ramp step. One hard-coded length here is how a type scale
 * quietly stops being one, so `prose.test.ts` sweeps this file for them rather than trusting
 * review to notice.
 */

/**
 * The gap above a block, cancelled for the first block in any container.
 *
 * `first:mt-0` is what keeps the top of a note, a list item and a table cell flush with its
 * container instead of opening with a blank band.
 */
const BLOCK_GAP = 'mt-4 first:mt-0';

/**
 * The table's type step, spelled with the wrapper variant in full: a variant-prefixed class has
 * to appear complete in the source for Tailwind to emit it, so this cannot be composed from
 * `DOCUMENT_SECONDARY_STEP` at runtime. `prose.test.ts` checks the two agree.
 */
const TABLE_TYPE_STEP =
  '[&_.tableWrapper>table]:text-lg sm:not-any-pointer-coarse:[&_.tableWrapper>table]:text-base';

/**
 * The editable element itself: the measure, the ground, and the pieces of the document that
 * ProseMirror draws rather than the schema.
 *
 * The decoration classes below are ProseMirror's and prosemirror-tables', invented by those
 * libraries and normally styled by stylesheets those packages ship. We import neither stylesheet,
 * so the selection, the gap cursor and the column resize handle would otherwise be invisible -
 * present in the DOM, doing nothing a reader can see. They are reached with descendant variants
 * because there is no extension whose `HTMLAttributes` they pass through.
 */
export const proseRoot = [
  // A measure. Text that runs the full width of a wide pane is measurably harder to read; 65ch is
  // Tailwind's prose measure and lands near the classic 45-75 character band.
  `min-w-0 max-w-prose break-words font-body ${DOCUMENT_BODY_STEP} text-foreground`,
  '[&[data-writing-mode="planning"]]:max-w-none [&[data-writing-mode="collaboration"]]:max-w-none',

  // The caret and the text selection. The selection fill is a fixed ramp step rather than a role
  // because a highlight is a physical light wash: dark ink on a pale accent reads on either
  // ground, whereas a role-coloured selection would invert with the theme and stop looking like a
  // selection at all.
  'caret-foreground selection:bg-accent-200 selection:text-neutral-900',

  // Vim basics' block cursor (`vim-motions.ts`): the character under the Normal-mode cursor is
  // inverted while the editor has focus, and the thin caret is hidden so there is one cursor, not
  // two. Unfocused, the block is left undrawn, so a second pane never shows a cursor it is not
  // taking keys for.
  '[&.nix-vim-command]:caret-transparent',
  '[&.ProseMirror-focused_.nix-vim-cursor]:bg-foreground [&.ProseMirror-focused_.nix-vim-cursor]:text-background',

  // A selected block - an image, a rule - carries the same accent ring as a focused control.
  '[&_.ProseMirror-selectednode]:outline-2 [&_.ProseMirror-selectednode]:outline-offset-2 [&_.ProseMirror-selectednode]:outline-accent',

  // The gap cursor: the caret shown between two blocks that cannot hold text. Drawn as a hairline
  // on the element itself, since a pseudo-element would need a stylesheet.
  '[&_.ProseMirror-gapcursor]:block [&_.ProseMirror-gapcursor]:border-t [&_.ProseMirror-gapcursor]:border-foreground',

  // Table column resizing. The handle is a bare widget with no dimensions of its own; without
  // these it is a zero-size div and the column edge is undraggable in practice.
  '[&.resize-cursor]:cursor-col-resize',
  '[&_.column-resize-handle]:pointer-events-none [&_.column-resize-handle]:absolute [&_.column-resize-handle]:top-0 [&_.column-resize-handle]:bottom-0 [&_.column-resize-handle]:-right-px [&_.column-resize-handle]:w-0.5 [&_.column-resize-handle]:bg-accent',

  // A cell selection, tinted rather than filled so the text inside stays legible on either ground.
  '[&_.selectedCell]:bg-accent/25',

  // The table's wrapper, which the resizable table view draws around every table. It carries
  // the block gap, so the table itself does not: an overflow container does not let a margin
  // collapse through it, and a gap on both would be two gaps. The overflow is what lets a wide
  // table scroll sideways inside a narrow pane rather than push the pane wider.
  '[&_.tableWrapper]:mt-4 [&_.tableWrapper:first-child]:mt-0 [&_.tableWrapper]:overflow-x-auto',

  // The table element itself, reached from the wrapper rather than through `proseClasses.table`
  // because a resizable table never receives that entry: the table extension hands a resizable
  // table to prosemirror-tables' own node view, and that view builds the `<table>` without the
  // extension's `HTMLAttributes`. Every table in the app is resizable, so the entry below was a
  // class nobody saw, and tables rendered at the width of their content with no outer edge.
  // `table-fixed` is what makes the column widths prosemirror-tables writes into the colgroup
  // stick; without it the browser re-balances the columns and a dragged edge appears to do
  // nothing.
  `[&_.tableWrapper>table]:w-full [&_.tableWrapper>table]:table-fixed [&_.tableWrapper>table]:border-collapse [&_.tableWrapper>table]:border [&_.tableWrapper>table]:border-divider ${TABLE_TYPE_STEP}`,

  // Where you are in a table (`table-controls.ts`): the table the caret is in gets the accent
  // edge, the row and the column of its cell a faint wash, and the cell itself a little more.
  // A cell selection draws itself and is left alone, which is what the `:not` is for.
  '[&_.is-active-table>table]:border-accent-400',
  '[&_.is-active-row:not(.selectedCell)]:bg-foreground/4 [&_.is-active-column:not(.selectedCell)]:bg-foreground/4',
  '[&_.is-active-cell:not(.selectedCell)]:bg-accent/10',

  // The text palette, selected on the attribute the mark writes. Descendant variants rather
  // than one class per colour because the mark's own class string cannot vary by attribute -
  // the same constraint that gives `heading` and `callout` their functions, solved the other
  // way because a colour is one declaration and a heading is six.
  //
  // Three names, because three is what a mono token sheet can render distinguishably. The set
  // was briefly six - with `success`, `warning` and `danger` - and three of those rendered
  // identically, which would have been a picker offering choices the product never honoured,
  // stored permanently in documents. `marks.ts` holds the reasoning; widening the set is an
  // ADR adding a semantic ramp to the tokens, not a class string here.
  '[&_[data-text-color="accent"]]:text-accent-text',
  '[&_[data-text-color="muted"]]:text-muted',

  // The wash, and the ink that has to come with it.
  //
  // **A highlight does not invert.** It stands for a marker pen, which is the same argument the
  // text selection and the `highlight` mark below already make, and it is why both washes are
  // fixed ramp steps rather than roles: a role-coloured wash would swap to a dark step on the
  // dark ground and stop reading as a highlight at all. The consequence is that the wash brings
  // its own foreground. Left to inherit, `text-foreground` over `bg-accent-200` is the dark
  // ground's near-white ink on a near-white wash: 1.1:1, which is not low contrast but none.
  //
  // `accent-200` is the step the selection and the `highlight` mark already wash with, so the
  // three ways a run of text can be lit in this product agree. `neutral-300` for the muted one
  // rather than `neutral-200`: a grey wash has no hue to be found by, and `neutral-200` sits
  // within 1.02:1 of the surface a document is written on, so it would be a highlight nobody
  // could see on paper - where the blue one is found by its hue rather than by its lightness.
  '[&_[data-background-color="accent"]]:bg-accent-200',
  '[&_[data-background-color="muted"]]:bg-neutral-300',

  // The ink over a wash, which is the foreground palette pinned to its paper values.
  //
  // A pale wash *is* a paper ground, whatever the page around it is doing, so the roles cannot
  // be used here - `text-accent-text` resolves to accent-300 on ink, which is 1.2:1 over the
  // accent wash. Naming the steps directly keeps the foreground choice visible over a highlight
  // instead of silently ignored, which is what a control that offers both axes owes the person
  // using them. The steps clear 4.5:1 over both washes (accent-800: 8.1 and 6.7; neutral-800:
  // 8.2 and 6.8; neutral-900, the unset case: 11.6 and 9.6) and stay told apart by hue, the
  // accent ink being a blue-slate against two neutrals.
  //
  // Specificity, not source order, decides these against the two foreground rules above: a
  // second attribute selector puts each of them a step higher, and the unset case uses `:not`
  // for the same reason. It is written as "neither named colour" rather than "no attribute" so
  // that a `data-text-color` this build cannot read - which renders as the literal `default`,
  // per the fallback-at-render rule - still gets ink it can be read with.
  '[&_[data-background-color="accent"]:not([data-text-color="accent"]):not([data-text-color="muted"])]:text-neutral-900',
  '[&_[data-background-color="accent"][data-text-color="accent"]]:text-accent-800',
  '[&_[data-background-color="accent"][data-text-color="muted"]]:text-neutral-800',
  '[&_[data-background-color="muted"]:not([data-text-color="accent"]):not([data-text-color="muted"])]:text-neutral-900',
  '[&_[data-background-color="muted"][data-text-color="accent"]]:text-accent-800',
  '[&_[data-background-color="muted"][data-text-color="muted"]]:text-neutral-800',

  // A toggle presenting as a heading matches the real heading of that rank, so a document does
  // not have two visual hierarchies. Size only - the weight and spacing come from the summary
  // rule above, which already applies - and the size comes from `prose-type.ts`, where it sits
  // beside the real heading's own step rather than agreeing with it by hand.
  `[&_[data-toggle-level="1"]_summary]:font-heading ${TOGGLE_SUMMARY_STEP[1]}`,
  `[&_[data-toggle-level="2"]_summary]:font-heading ${TOGGLE_SUMMARY_STEP[2]}`,
  `[&_[data-toggle-level="3"]_summary]:font-heading ${TOGGLE_SUMMARY_STEP[3]}`,

  // A column takes an equal share unless it states a width, which arrives as an inline
  // flex-grow from `note-editor.tsx` - a fraction cannot be a class. `min-w-0` is what lets a
  // long word or a wide table inside a column shrink rather than force the row wider.
  '[&_[data-column]]:min-w-0 [&_[data-column]]:flex-1 [&_[data-column]]:basis-0',
].join(' ');

/**
 * The gutter between two columns, and the negative margin a resize handle needs to sit *in* it
 * rather than beside it.
 *
 * **The two are one decision and have to move together.** A flex gap applies between every pair
 * of children, so inserting a handle between two columns buys a second gap: 24 + 8 + 24 where
 * there was 24. The handle gives back the 32 it added, which is `-mx-4`. Change the gap without
 * changing the inset and a row with handles has a wider gutter than one without; they are stated
 * here, next to each other, because `column-controls.ts` is where the handle is drawn and there
 * is nothing there to notice the arithmetic broke.
 */
const COLUMN_GAP_STACKED = 'gap-4';
const COLUMN_GAP_ROW = 'md:gap-6';
export const COLUMN_HANDLE_INSET = '-mx-4';

/**
 * One class string per schema node and mark, keyed by the name TipTap knows it as.
 *
 * `heading` and `callout` are absent on purpose: their appearance depends on an attribute (the
 * level, the tone), which a single string cannot express. They have functions below.
 */
export const proseClasses: Readonly<Record<string, string>> = {
  paragraph: BLOCK_GAP,

  // Lists. `list-outside` puts the marker in the gutter so wrapped lines align with the first
  // line rather than with the bullet, and the padding is what gives the marker that gutter.
  bulletList: `${BLOCK_GAP} list-disc list-outside pl-6 marker:text-muted`,
  orderedList: `${BLOCK_GAP} list-decimal list-outside pl-6 marker:text-muted`,

  // A nested list belongs to the item above it, so it sits closer than two separate paragraphs
  // would. The parent item states that, because the nested list cannot know it is nested.
  listItem: 'mt-2 first:mt-0 [&>ul]:mt-2 [&>ol]:mt-2',

  // Task lists carry a checkbox instead of a marker. TipTap renders each item as
  // `li > label > input` plus a sibling `div` holding the content, and the checkbox has to sit on
  // the first line of that content rather than float above it - hence `items-start` with a nudge
  // down, rather than `items-center`, which would drift lower on every wrapped line.
  taskList: `${BLOCK_GAP} list-none pl-0`,
  taskItem: [
    'mt-2 first:mt-0 flex items-start gap-2',
    '[&>label]:mt-1 [&>label]:flex [&>label]:shrink-0 [&>label]:items-center',
    '[&>label>input]:size-4 [&>label>input]:accent-accent-500',
    '[&>div]:min-w-0 [&>div]:flex-1',
  ].join(' '),

  // A quote is set apart by a rule and an indent, not by italics: quoted material often contains
  // its own emphasis, and italicising the block would leave that emphasis nowhere to go.
  blockquote: `${BLOCK_GAP} border-l-2 border-l-divider pl-4 text-muted`,

  // Code is set one step below body copy - a monospace face runs visually larger at the same size
  // - and scrolls rather than wraps, because a wrapped line of code is a misread line of code.
  codeBlock: `${BLOCK_GAP} overflow-x-auto border border-divider bg-surface px-4 py-3 font-mono ${DOCUMENT_SECONDARY_STEP} text-foreground`,

  horizontalRule: 'my-8 border-t border-divider',

  itemBlock: `${BLOCK_GAP} rounded-md border border-divider p-4`,
  pageBreak: `${BLOCK_GAP} border-y border-dashed border-divider py-3`,
  image: `${BLOCK_GAP} block h-auto max-w-full border border-divider`,

  // Tables. `table-fixed` is what makes the column widths prosemirror-tables writes into the
  // colgroup take effect; without it the browser re-measures from content and dragging a column
  // edge appears to do nothing. Borders live on the cells and rows and collapse into the table's
  // own frame, so the grid is drawn once rather than doubled at every seam.
  // Kept for a table rendered without the resizable node view (a read-only preview, a test);
  // in the editor the same look is applied from `proseRoot` - see the note there. The block gap
  // is on the wrapper (see `proseRoot`), not here. The cells are `relative`
  // because the column resize handle is positioned inside them: without it the handle lands
  // against the nearest positioned ancestor, which is the pane, and the column edge appears to
  // be draggable from somewhere else entirely.
  //
  // `max-sm:min-w-24` is the floor a column cannot be squeezed under on a phone. A fixed-layout
  // table with `w-full` otherwise divides whatever room it has evenly across every column with
  // nothing stopping a column short of its own content - `colwidth`, where prosemirror-tables
  // stores a drag, lives on the `<col>` element the resizable node view builds, and a `<col>`'s
  // width is not a floor a fixed layout is bound by, only a starting point it can shrink from.
  // A `min-width` on the cell itself is: past it the table stops fitting the pane and the
  // wrapper's `overflow-x-auto` (see `proseRoot`) takes over, scrolling the table sideways
  // instead of running every column's text into a single unreadable column of characters. Left
  // off above the breakpoint, where the pane already has room to spare and a floor would only
  // narrow how far a drag can shrink a column on a desktop screen.
  table: `w-full table-fixed border-collapse border border-divider ${DOCUMENT_SECONDARY_STEP}`,
  tableRow: 'border-b border-divider',
  tableHeader:
    'relative max-sm:min-w-24 border-r border-divider bg-surface px-3 py-2 text-left align-top font-semibold',
  tableCell: 'relative max-sm:min-w-24 border-r border-divider px-3 py-2 align-top',

  // A row of columns - below the medium breakpoint, a stack.
  //
  // Not a nicety. Four columns is the ceiling the schema documents, and on a 375px screen less
  // the editor's own padding and the gaps, that is about sixty pixels of measure per column:
  // roughly six characters a line. Every other block in this file degrades to narrow but
  // readable; without this one, side-by-side content is the first thing that becomes
  // structurally unreadable, in stored prose somebody cannot un-author.
  columnBlock: `${BLOCK_GAP} flex flex-col ${COLUMN_GAP_STACKED} md:flex-row ${COLUMN_GAP_ROW}`,

  // A collapsible section. The open state is per-session on purpose - the reasoning lives in
  // `packages/editor-schema/src/details.ts` - so nothing here reads a stored attribute.
  //
  // The summary is a `<summary>` rendered by `toggleSummaryView` in `toggle-button.ts` (a node
  // view, so a toggle heading's summary can carry heading semantics) and is reached by tag.
  // The content is hidden by `DetailsContent`'s own node view, which sets the `hidden`
  // attribute that Tailwind's preflight already turns into `display: none`; there is nothing
  // for this file to do about folding, and an earlier attempt to select on `.is-open` here
  // matched at the wrong depth and did nothing at all.
  //
  // `list-none` because a `<summary>` still gets `display: list-item` from the user-agent
  // stylesheet, which would draw the browser's own disclosure triangle beside ours.
  details: [
    BLOCK_GAP,
    'border-l-2 border-l-divider pl-4',
    '[&_summary]:list-none [&_summary]:font-medium',
    // The disclosure button, drawn by `renderToggleButton` in `toggle-button.ts` as a Lucide
    // chevron. Focus is not left to the browser: a control inside a contenteditable region is
    // exactly where a default outline is least likely to be visible.
    '[&>button]:mr-2 [&>button]:align-middle [&>button]:text-muted [&>button]:transition-transform',
    '[&>button]:hover:text-foreground',
    '[&>button]:focus-visible:outline-2 [&>button]:focus-visible:-outline-offset-2 [&>button]:focus-visible:outline-accent',
    '[&.is-open>button]:rotate-90',
  ].join(' '),

  // A reference resolves to a title at render; until it does, the stored label stands in. Set
  // as accent text rather than a link, because it points inside the workspace rather than out.
  reference: 'text-accent-text underline decoration-dotted underline-offset-2',

  // The two blocks computed from the document's own shape. Both are drawn by a node view that
  // walks the live document, so what is styled here is the frame it sits in.
  tableOfContents: `${BLOCK_GAP} border-l-2 border-l-divider py-1 pl-4 ${DOCUMENT_SECONDARY_STEP} text-muted`,
  breadcrumb: `${BLOCK_GAP} ${DOCUMENT_SECONDARY_STEP} text-muted`,

  // Marks. Bold is 600 rather than 700: those are the weights the app actually loads, and asking
  // for one it does not have gets a synthesised smear instead of a face.
  bold: 'font-semibold',
  italic: 'italic',
  underline: 'underline underline-offset-2',
  strike: 'line-through',
  code: `border border-divider bg-surface px-1 py-0.5 font-mono ${DOCUMENT_SECONDARY_STEP}`,

  // Highlight is a fixed pale wash with dark ink on top, for the same reason the text selection
  // is: it stands for a marker pen, and a marker pen does not invert.
  highlight: 'bg-accent-200 text-neutral-900',

  // Body-size accent text uses the accent-text role, which the token sheet points at a step dark
  // enough to read on paper and light enough to read on ink.
  link: 'text-accent-text underline decoration-1 underline-offset-2 hover:text-accent-hover',

  // Colour is carried by a `data-` attribute, not by this string, so the base entry only has
  // to make the span exist as a box. The palette itself is in `proseRoot` above, where a
  // descendant variant can select on the attribute.
  // A background wash needs a little air or it butts flush against the neighbouring glyphs,
  // and `box-decoration-clone` is what keeps the corners rounded on every line of a span that
  // wraps rather than only on the first and last.
  textColor: 'rounded-sm px-0.5 box-decoration-clone',

  // A commented range is marked the way a reader would mark one: underneath, not on top, so
  // the words stay the words. The thread it belongs to is on the element as an attribute.
  comment: 'border-b-2 border-b-accent-400 bg-accent/10 hover:bg-accent/20 cursor-default',
};

/**
 * The three heading levels, each visibly a different rank.
 *
 * Size does the work, and the sizes are `prose-type.ts`'s - see there for what they are and why a
 * toggle's summary has to take the same three. The first level also carries a hairline, which is
 * the Industry grammar for the top of a section.
 */
const HEADING_CLASSES: Readonly<Record<1 | 2 | 3, string>> = {
  1: `mt-8 first:mt-0 border-b border-divider pb-2 font-heading ${DOCUMENT_HEADING_STEP[1]} font-semibold text-foreground`,
  2: `mt-6 first:mt-0 font-heading ${DOCUMENT_HEADING_STEP[2]} font-semibold text-foreground`,
  3: `mt-6 first:mt-0 font-heading ${DOCUMENT_HEADING_STEP[3]} font-semibold text-foreground`,
};

/**
 * The class for a heading of `level`.
 *
 * A level the schema does not define renders as a first-level heading, matching what TipTap's own
 * renderer does with an out-of-range level: a document from a newer build shows its structure at
 * the wrong rank rather than losing it.
 */
export function headingClass(level: number): string {
  return level === 2 || level === 3 ? HEADING_CLASSES[level] : HEADING_CLASSES[1];
}

/**
 * The four callout tones.
 *
 * The Industry token sheet is deliberately mono - one steel accent, no red and no amber - so tone
 * cannot be carried by hue here without inventing a colour the sheet does not have. It is carried
 * by weight instead: a quiet hairline for a note, the accent for a tip, a thicker accent rule for
 * a warning, and full-strength ink for a danger. The `data-tone` attribute stays on the element
 * either way, so a palette that grows a semantic ramp later changes these strings and nothing
 * else.
 */
const CALLOUT_BASE = `${BLOCK_GAP} bg-surface px-4 py-3`;

const CALLOUT_CLASSES: Readonly<Record<CalloutTone, string>> = {
  note: `${CALLOUT_BASE} border-l-2 border-l-divider`,
  tip: `${CALLOUT_BASE} border-l-2 border-l-accent-500`,
  warning: `${CALLOUT_BASE} border-l-4 border-l-accent-text`,
  danger: `${CALLOUT_BASE} border-l-4 border-l-foreground font-medium`,
};

/**
 * The class for a callout of `tone`.
 *
 * Unknown tones fall back to `note`, matching the schema's own reading of the attribute: a callout
 * from a newer build is readable in the wrong tone and unreadable in no tone at all.
 */
export function calloutClass(tone: string): string {
  return isTone(tone) ? CALLOUT_CLASSES[tone] : CALLOUT_CLASSES.note;
}

function isTone(value: string): value is CalloutTone {
  return (CALLOUT_TONES as readonly string[]).includes(value);
}
