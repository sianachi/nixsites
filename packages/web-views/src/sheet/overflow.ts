/**
 * What a numeric cell shows when its column is too narrow for its value.
 *
 * A truncated number is a lie: right-aligned with overflow hidden, "1234567"
 * clipped to four digits reads as a different number, with no cue that
 * anything is missing. The spreadsheet convention is to fill the cell with
 * hash marks instead - obviously not a value, obviously "widen me". Text is
 * different: a clipped word ends in an ellipsis and never reads as a shorter
 * word that happens to be correct, so text is left to clip as it always has.
 *
 * The fit test uses the digit advance of the grid's own font, measured once
 * per module lifetime off-DOM (numbers are digits, an optional sign, a
 * point - all near the digit advance in Nunito Sans). Where canvas text
 * metrics do not exist (jsdom), a deliberately wide 9px estimate stands in,
 * so the fallback's failure mode is hashing a value that would just have
 * fit - never showing clipped digits.
 *
 * The hover title reveals a hashed cell's value, but hover is pointer-only;
 * the FormulaBar showing the active cell's raw text is the real disclosure,
 * and the cell's aria-label always carries the full value.
 */

/** jsdom/SSR stand-in, deliberately wider than the real glyphs. */
const FALLBACK_GLYPH_WIDTH = 9;

/**
 * The horizontal padding a cell's content sits inside: px-2 (8px) per side on
 * every gridcell in sheet-grid.tsx, which cross-references this constant -
 * the two must describe the same box.
 */
const CELL_HORIZONTAL_PADDING = 16;

const OVERFLOW_CHAR = '#';

interface GlyphWidths {
  readonly digit: number;
  readonly hash: number;
}

let cachedGlyphs: GlyphWidths | null = null;

/**
 * Digit and hash advances at the cell font: text-sm (0.875rem against the
 * real root font size) in the document's own body family. Null where canvas
 * metrics are unavailable.
 */
function measureGlyphWidths(): GlyphWidths | null {
  if (typeof document === 'undefined') {
    return null;
  }
  const context = document.createElement('canvas').getContext('2d');
  if (context === null) {
    return null;
  }
  const rootSize = Number.parseFloat(window.getComputedStyle(document.documentElement).fontSize);
  const size = Number.isFinite(rootSize) && rootSize > 0 ? rootSize * 0.875 : 14;
  context.font = `${String(size)}px ${window.getComputedStyle(document.body).fontFamily}`;
  const digit = context.measureText('0').width;
  const hash = context.measureText(OVERFLOW_CHAR).width;
  return digit > 0 && hash > 0 ? { digit, hash } : null;
}

function glyphWidths(): GlyphWidths {
  if (cachedGlyphs === null) {
    const measured = measureGlyphWidths();
    // Only a measurement of the real face is worth keeping. Before the
    // self-hosted font finishes loading, the canvas measures whatever system
    // family stood in - and a stand-in narrower than the real face would let
    // clipped digits through for the life of the page, which is exactly the
    // lie this module exists to refuse. Until the fonts are ready, use the
    // measurement once and forget it; the conservative fallback covers the
    // rest.
    if (measured !== null && document.fonts.status === 'loaded') {
      cachedGlyphs = measured;
    } else {
      return measured ?? { digit: FALLBACK_GLYPH_WIDTH, hash: FALLBACK_GLYPH_WIDTH };
    }
  }
  return cachedGlyphs;
}

/**
 * The text a cell renders: the display text when it is not numeric or fits,
 * otherwise hash marks filling the width. Never empty - even the narrowest
 * column shows one hash, or the overflow would be invisible.
 */
export function fitCellText(display: string, numeric: boolean, columnWidth: number): string {
  if (!numeric || display.length === 0) {
    return display;
  }
  const { digit, hash } = glyphWidths();
  const available = columnWidth - CELL_HORIZONTAL_PADDING;
  if (display.length * digit <= available) {
    return display;
  }
  const count = Math.max(1, Math.floor(available / hash));
  return OVERFLOW_CHAR.repeat(count);
}
