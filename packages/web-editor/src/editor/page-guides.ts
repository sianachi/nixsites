/**
 * Where the pages fall: the arithmetic behind the page guides, with no DOM in it.
 *
 * **What a guide is.** A note has no pages; the PDF and Word exports do. A guide is a line drawn
 * across the editor where the export would start a new page, so somebody writing to a page count
 * sees the boundary while writing rather than after exporting. It is an estimate, and it says so
 * in the interface: the editor's measure and typeface are not the page's, and only a layout pass
 * with the export's own fonts could say exactly which word lands first on page three.
 *
 * **How the estimate is made.** The export page is A4 with fixed margins and a fixed body size.
 * The exporter that ships is the Go one (`apps/go-workers/internal/exporter/pdf.go`); its numbers
 * are mirrored here and a test keeps them in agreement, because a browser bundle cannot read a Go
 * constant. Zoom that page until its body
 * type is the size of the editor's, and the page becomes a rectangle in editor pixels. Text is
 * roughly an area: the same words fill the same number of square pixels whether the column is
 * wide or narrow. So a page's worth of editor column is that rectangle's area divided by the
 * column's width, corrected for the editor's looser leading. Measured against a real export this
 * lands within about ten percent, which is what "estimated" means on the label.
 *
 * **Where a boundary snaps.** A page does not end mid-line. A text block that crosses the
 * boundary is cut on its own line grid, so the guide sits between two lines rather than through
 * one; a block that cannot be cut - an image, a rule, a linked item - moves whole onto the next
 * page, as the exporters' own layout would. A hard page break is a boundary the writer already
 * chose: the count restarts under it and no guide is drawn over it, since the block draws itself.
 */

/**
 * The exported page, in points: A4, the Go exporter's uniform `pdfMargin`, and the body size and
 * leading it writes paragraphs with (`SetFont("Nix", "", 11)` and `Write(size*1.45, ...)`).
 */
export const EXPORT_PAGE = {
  width: 595.28,
  height: 841.89,
  margins: [50, 50, 50, 50] as const,
  bodySize: 11,
  lineHeight: 1.45,
} as const;

/** The type area: the page less its margins. */
export const EXPORT_TYPE_AREA = {
  width: EXPORT_PAGE.width - EXPORT_PAGE.margins[0] - EXPORT_PAGE.margins[2],
  height: EXPORT_PAGE.height - EXPORT_PAGE.margins[1] - EXPORT_PAGE.margins[3],
} as const;

export interface EditorMetrics {
  /** The editing column's width in pixels. */
  readonly width: number;
  /** The body type size in pixels. */
  readonly fontSize: number;
  /** The body line height in pixels. */
  readonly lineHeight: number;
}

/**
 * How tall one exported page is, measured in pixels of this editor column.
 *
 * `null` when the metrics cannot support an estimate - a column that has not been laid out yet
 * reports zero width, and a guide every zero pixels is not a guide.
 */
export function estimatedPageHeight(metrics: EditorMetrics): number | null {
  const { width, fontSize, lineHeight } = metrics;
  if (!(width > 0) || !(fontSize > 0) || !(lineHeight > 0)) {
    return null;
  }
  const zoom = fontSize / EXPORT_PAGE.bodySize;
  const leading = lineHeight / fontSize / EXPORT_PAGE.lineHeight;
  const area = EXPORT_TYPE_AREA.width * EXPORT_TYPE_AREA.height * zoom * zoom * leading;
  const height = area / width;
  // Fewer than a handful of lines to a page means the metrics are nonsense, not a small page.
  return height >= lineHeight * 4 ? height : null;
}

/** What kind of block this is, for the purpose of cutting it. */
export type BlockKind =
  /** Cut on its line grid. */
  | 'text'
  /** Never cut: moves whole to the next page. */
  | 'atomic'
  /** A boundary the writer chose. */
  | 'pageBreak';

export interface MeasuredBlock {
  readonly kind: BlockKind;
  /** The block's top edge, in the same coordinate space the guides are returned in. */
  readonly top: number;
  readonly height: number;
  /** The block's own line height, for the grid it is cut on. */
  readonly lineHeight: number;
}

export interface PageGuide {
  /** Where the new page starts. */
  readonly top: number;
  /** The number of the page that starts here. */
  readonly page: number;
}

/**
 * The upper bound on guides for one document. A document that estimates to more pages than this
 * is drawn up to here and no further - the cost of a runaway is a frozen tab, and nobody is
 * reading page guide five hundred.
 */
const MAX_GUIDES = 500;

/**
 * Where the guides go for these blocks at this page height.
 *
 * Blocks are in document order. Coordinates in are coordinates out: the caller decides what
 * zero is.
 */
export function planPageGuides(
  blocks: readonly MeasuredBlock[],
  pageHeight: number,
): readonly PageGuide[] {
  if (!(pageHeight > 0)) {
    return [];
  }

  const guides: PageGuide[] = [];
  let page = 1;
  let pageStart = 0;

  for (const block of blocks) {
    if (block.kind === 'pageBreak') {
      page += 1;
      pageStart = block.top + block.height;
      continue;
    }

    const bottom = block.top + block.height;
    while (bottom > pageStart + pageHeight && guides.length < MAX_GUIDES) {
      const boundary = pageStart + pageHeight;
      let cut = cutFor(block, pageStart, boundary);
      // Every page has to be at least a line tall or the loop never leaves this block.
      if (cut <= pageStart) {
        cut = Math.max(boundary, pageStart + Math.max(block.lineHeight, 1));
      }
      page += 1;
      guides.push({ top: cut, page });
      pageStart = cut;
    }
  }

  return guides;
}

/** Where the boundary lands once snapped to what `block` can be cut on. */
function cutFor(block: MeasuredBlock, pageStart: number, boundary: number): number {
  // The boundary is in the gap above this block: the new page starts with it.
  if (block.top >= boundary) {
    return block.top;
  }

  const startsThisPage = block.top > pageStart;

  if (block.kind === 'atomic') {
    // Move it whole, unless it opened the page and is taller than one - then nothing can be
    // done but cut it where the page ends.
    return startsThisPage ? block.top : boundary;
  }

  const lineHeight = block.lineHeight > 0 ? block.lineHeight : 1;
  const lines = Math.floor((boundary - block.top) / lineHeight);
  if (lines < 1) {
    // No whole line fits: take the block to the next page rather than leave a fragment of a
    // line behind, unless it opened this page, where a one-line page is the only progress.
    return startsThisPage ? block.top : block.top + lineHeight;
  }
  return block.top + lines * lineHeight;
}
