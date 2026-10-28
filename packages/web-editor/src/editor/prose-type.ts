/**
 * The document's type scale, stated once.
 *
 * **Why this is a module and not `<Text>`.** ProseMirror owns the document's DOM. React never sees
 * a heading, a paragraph or a code block to put a component around - `note-editor.tsx` hands each
 * node's class *string* to its extension as `HTMLAttributes.class` and TipTap merges it into the
 * element it renders. So the one place in the product where the type scale cannot go through the
 * typography primitive is also the place with the most typography in it, and the fallback has to be
 * the next best thing: the steps named here, in one table, rather than spelled out at each of the
 * eight sites in `prose.ts` that need them.
 *
 * That matters because two of those sites are supposed to agree and had no way of saying so. A
 * toggle presenting as a heading is meant to match the real heading of the same rank; before this
 * module the only thing holding the two tables together was a comment in `prose.ts` asking the next
 * editor to keep them in step. Now the sizes sit next to each other and a mismatch is visible in
 * one screenful.
 *
 * **Why the toggle steps are spelled out again rather than composed.** Tailwind v4 finds classes by
 * scanning source text, so a variant-prefixed class has to appear complete somewhere in the source:
 * `` `[&_[data-toggle-level="1"]_summary]:${DOCUMENT_HEADING_STEP[1]}` `` compiles to nothing at
 * all, silently, and the toggle renders at body size with no error anywhere. The prefixed spellings
 * below are therefore literals, kept immediately under the table they have to match - which is the
 * closest a scanner-driven toolchain lets us get to stating the relationship once. `specimens.ts`
 * records the same constraint for the same reason.
 *
 * Unprefixed steps compose freely: `text-md` appears literally in this file, so Tailwind emits it
 * however `prose.ts` goes on to concatenate it.
 */

/**
 * Body copy inside the document.
 *
 * A step above the interface's own body text on purpose: this is prose somebody sits and reads,
 * and it is measured to a `max-w-prose` column rather than fitted into a panel.
 */
// Touch text stays above mobile browsers' 16px focus-zoom threshold.
export const DOCUMENT_BODY_STEP = 'text-lg sm:not-any-pointer-coarse:text-md';

/**
 * One step under body copy, for the blocks that are not prose: code, tables, and the two blocks
 * computed from the document's own shape (the table of contents and the breadcrumb).
 *
 * Monospace runs visually larger than the body face at the same nominal size, and a table or a
 * generated index is scanned rather than read - both want to sit back from the copy around them.
 */
export const DOCUMENT_SECONDARY_STEP = 'text-lg sm:not-any-pointer-coarse:text-base';

/**
 * The three heading ranks the schema defines, as sizes.
 *
 * 28, 22 and 17 against 15px body copy: size alone carries the hierarchy, so it survives a
 * screenshot, a print, and a reader who cannot tell 600 from 400.
 */
export const DOCUMENT_HEADING_STEP: Readonly<Record<1 | 2 | 3, string>> = {
  1: 'text-2xl',
  2: 'text-xl',
  3: 'text-lg',
};

/**
 * The same three sizes, aimed at a toggle's `<summary>` through a descendant variant.
 *
 * Must match `DOCUMENT_HEADING_STEP` rank for rank - a document with two visual hierarchies, one
 * for headings and one for collapsed sections, is a document whose outline lies. Spelled out
 * rather than composed for the scanner reason in this module's note; `prose.test.ts` checks the
 * two tables against each other so the duplication cannot drift.
 */
export const TOGGLE_SUMMARY_STEP: Readonly<Record<1 | 2 | 3, string>> = {
  1: '[&_[data-toggle-level="1"]_summary]:text-2xl',
  2: '[&_[data-toggle-level="2"]_summary]:text-xl',
  3: '[&_[data-toggle-level="3"]_summary]:text-lg',
};
