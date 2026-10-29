// The editor layer of the web test setup: the foundation base plus the DOM gaps ProseMirror hits.
import '@nix/web-foundation/testing/setup';

// A contenteditable selection is real DOM state even when layout is not. ProseMirror asks the
// selection's Range for its rectangle only to scroll the caret into view; jsdom omits both Range
// measurement methods entirely. Zero rectangles preserve the state transition without pretending
// that a browser position was measured.
if (typeof Range !== 'undefined' && typeof Range.prototype.getClientRects !== 'function') {
  Range.prototype.getClientRects = function getClientRects(): DOMRectList {
    return [] as unknown as DOMRectList;
  };
}

if (typeof Range !== 'undefined' && typeof Range.prototype.getBoundingClientRect !== 'function') {
  Range.prototype.getBoundingClientRect = function getBoundingClientRect(): DOMRect {
    return new DOMRect();
  };
}
