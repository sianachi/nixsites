/**
 * The colours an exported document is drawn with.
 *
 * **This package's first JavaScript export, and the reason is a guard rather than a preference.**
 * `scripts/check-raw-design-values.sh` scans `apps/` and `packages/` for raw hex and prunes exactly
 * one directory: this one. A PDF converter writing `'#1d1f20'` trips it; a DOCX converter writing
 * the same colour as `'1D1F20'` - Open XML takes no leading hash - does not. A guard that catches
 * one of two twins is worse than one that catches neither, because it teaches you it is covering
 * you. Declaring the palette here makes both converters exempt *by construction* and satisfies
 * AGENTS.md's "all colours come from packages/design-tokens" literally rather than by waiver.
 *
 * **These are the light ground's values and always will be.** A document printed on paper has one
 * ground; there is no dark-mode PDF. `print.test.ts` asserts every value below appears verbatim in
 * `theme.css`'s light ground, which is the only thing stopping this file becoming a second, stale
 * copy of the palette.
 *
 * **The screen roles that are not literal colours are resolved to the nearest ramp step.**
 * `--color-divider` is a `color-mix()` against the ground, which a PDF or an Open XML fill cannot
 * express - both take a flat colour. The neutral step named below is what that mix lands on over
 * paper, and stating the substitution here is better than each converter inventing its own.
 */

/**
 * The roles a converter draws with.
 *
 * Declared here rather than imported from `@nix/export`, whose `DocumentConverter` seam names the
 * same shape. Neither package depends on the other - a token sheet that imported an export format's
 * types, or an export format that imported a stylesheet, would both be the wrong direction - and
 * structural typing makes the import unnecessary. What keeps the two honest is that every converter
 * imports both, so a field added on one side and not the other stops compiling where they meet.
 */
export interface PrintPalette {
  readonly ink: string;
  readonly muted: string;
  readonly accentText: string;
  readonly accentFill: string;
  readonly surface: string;
  readonly divider: string;
  readonly calloutFill: string;
  readonly codeFill: string;
  readonly highlight: string;
}

export const PRINT_PALETTE: PrintPalette = {
  /** Body text. `--color-text`. */
  ink: '#1d1f20',

  /** Quiet copy: captions, the loss appendix, a table's row numbers. `--color-muted`. */
  muted: '#5d5d60',

  /** A link, and a reference that became its label. `--color-accent-text`. */
  accentText: '#416180',

  /** The one solid accent object on a page. `--color-accent-fill`. */
  accentFill: '#416180',

  /** The ground a card, a callout or a table header sits on. `--color-surface`. */
  surface: '#f6f7f9',

  /** A hairline between regions. `--color-divider` resolved over paper. */
  divider: '#d4d4d7',

  /** Behind a callout, one step off the ground so the block reads as set apart. */
  calloutFill: '#f5f5f8',

  /** Behind code, deliberately a step darker than a callout so the two never read alike. */
  codeFill: '#e7e7ea',

  /** Behind highlighted text. The lightest accent tint that still reads as deliberate. */
  highlight: '#d6ebff',
};
