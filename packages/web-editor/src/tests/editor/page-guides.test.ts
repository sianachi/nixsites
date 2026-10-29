import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

import {
  EXPORT_PAGE,
  estimatedPageHeight,
  planPageGuides,
  type MeasuredBlock,
} from '../../editor/page-guides';

/**
 * The page guides' arithmetic.
 *
 * Two things can go wrong silently: the mirrored page geometry drifting from the export's, and
 * a boundary landing somewhere the export would never put one - through a line, through an
 * image, or before the block the writer already broke the page after. Both are checked here
 * without a DOM, which is why the arithmetic is a module of its own.
 */

const repoRoot = join(dirname(fileURLToPath(import.meta.url)), '..', '..', '..', '..', '..');

describe('the exported page', () => {
  it('is the one the Go PDF exporter prints', () => {
    // The exporter is Go and cannot be imported here, so its numbers are mirrored. This is what
    // keeps the mirror honest: change the margin there and this names the constant to change
    // here.
    const source = readFileSync(
      join(repoRoot, 'apps', 'go-workers', 'internal', 'exporter', 'pdf.go'),
      'utf8',
    );
    const [left, top, right, bottom] = EXPORT_PAGE.margins;
    expect(new Set([left, top, right, bottom]).size, 'the Go margin is uniform').toBe(1);
    expect(source).toContain(`const pdfMargin = ${String(left)}.0`);
    expect(source).toContain(`fpdf.New("P", "pt", "A4", "")`);
    expect(source).toContain(`pdf.SetFont("Nix", "", ${String(EXPORT_PAGE.bodySize)})`);
    expect(source).toContain(`pdf.Write(size*${String(EXPORT_PAGE.lineHeight)}, pdfText(text))`);
  });
});

describe('the page height', () => {
  it('is around fifty lines for the editor as shipped', () => {
    // 13px body on 1.5 leading in a 65ch column. The A4 export holds about forty-six lines of
    // eighty characters at 11pt; the editor's line is shorter, so its page is taller in lines.
    // What matters is the order of magnitude: a page of a few lines or a few thousand is a
    // broken estimate.
    const height = estimatedPageHeight({ width: 470, fontSize: 13, lineHeight: 19.5 });
    expect(height).not.toBeNull();
    const lines = (height ?? 0) / 19.5;
    expect(lines).toBeGreaterThan(40);
    expect(lines).toBeLessThan(70);
  });

  it('holds the same words at any width', () => {
    // Text is an area: halve the column and the page is twice as tall, to the pixel.
    const narrow = estimatedPageHeight({ width: 300, fontSize: 13, lineHeight: 19.5 });
    const wide = estimatedPageHeight({ width: 600, fontSize: 13, lineHeight: 19.5 });
    expect(narrow).toBeCloseTo((wide ?? 0) * 2, 6);
  });

  it('refuses metrics from a column that has no layout', () => {
    expect(estimatedPageHeight({ width: 0, fontSize: 13, lineHeight: 19.5 })).toBeNull();
    expect(estimatedPageHeight({ width: 470, fontSize: 0, lineHeight: 0 })).toBeNull();
    expect(estimatedPageHeight({ width: Number.NaN, fontSize: 13, lineHeight: 19.5 })).toBeNull();
  });
});

function text(top: number, height: number, lineHeight = 20): MeasuredBlock {
  return { kind: 'text', top, height, lineHeight };
}

describe('where the guides fall', () => {
  it('draws nothing for a document shorter than a page', () => {
    expect(planPageGuides([text(0, 100), text(120, 100)], 1000)).toEqual([]);
  });

  it('cuts a paragraph between two of its lines, never through one', () => {
    // A 40-line paragraph on a page of 25.5 lines: the cut is after line 25, on the grid.
    const guides = planPageGuides([text(0, 800)], 510);
    expect(guides).toEqual([{ top: 500, page: 2 }]);
  });

  it('starts the next page from the cut, not from the nominal boundary', () => {
    // The second page is a full page measured from where the first one actually ended.
    const guides = planPageGuides([text(0, 2000)], 510);
    expect(guides.map((guide) => guide.top)).toEqual([500, 1000, 1500]);
    expect(guides.map((guide) => guide.page)).toEqual([2, 3, 4]);
  });

  it('moves a block whole when the boundary falls in the gap above it', () => {
    const guides = planPageGuides([text(0, 400), text(420, 200)], 410);
    expect(guides).toEqual([{ top: 420, page: 2 }]);
  });

  it('moves an image whole to the next page rather than cutting it', () => {
    const guides = planPageGuides(
      [text(0, 300), { kind: 'atomic', top: 320, height: 300, lineHeight: 20 }],
      500,
    );
    expect(guides).toEqual([{ top: 320, page: 2 }]);
  });

  it('cuts an image taller than a page where the page ends, since nothing else can be done', () => {
    const guides = planPageGuides([{ kind: 'atomic', top: 0, height: 1200, lineHeight: 20 }], 500);
    expect(guides.map((guide) => guide.top)).toEqual([500, 1000]);
  });

  it('takes a paragraph to the next page rather than leave less than a line of it', () => {
    // 10px of a 20px line would fit: not a line, so the paragraph moves.
    const guides = planPageGuides([text(0, 490), text(500, 200)], 510);
    expect(guides).toEqual([{ top: 500, page: 2 }]);
  });

  it('restarts the count under a hard page break and draws no guide over it', () => {
    const guides = planPageGuides(
      [text(0, 200), { kind: 'pageBreak', top: 220, height: 40, lineHeight: 20 }, text(280, 600)],
      500,
    );
    // The break made page 2, which starts under it at 260. The paragraph after it overflows into
    // page 3 at the nominal boundary of 760, which happens to be on its 20px grid from 280.
    expect(guides).toEqual([{ top: 760, page: 3 }]);
  });

  it('always makes progress, so a degenerate page height cannot hang the editor', () => {
    const guides = planPageGuides([text(0, 100, 20)], 1);
    expect(guides.length).toBeGreaterThan(0);
    expect(guides.length).toBeLessThanOrEqual(500);
    for (let index = 1; index < guides.length; index += 1) {
      expect(guides[index]?.top ?? 0).toBeGreaterThan(guides[index - 1]?.top ?? 0);
    }
  });

  it('draws nothing when there is no page height', () => {
    expect(planPageGuides([text(0, 5000)], 0)).toEqual([]);
    expect(planPageGuides([text(0, 5000)], Number.NaN)).toEqual([]);
  });
});
