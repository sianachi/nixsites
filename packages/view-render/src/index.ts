/**
 * A view over an item's children, drawn as a picture.
 *
 * The interface shows a board, a calendar or a gallery; a page cannot hold one of those, so an
 * export holds a drawing of it. **Drawn, not screenshotted**: this produces SVG from the view's own
 * definition and its rows, with no browser anywhere - the product removed headless Chromium for
 * footprint, and putting one back would hand a browser to the service that will parse untrusted
 * files. See ADR-0038.
 *
 * The output is a string. A PDF embeds it directly; a Word document needs a raster, which its host
 * supplies - keeping this package pure, testable by reading its markup, and sandboxable when
 * MVP-9's plugin seam arrives.
 */

export { renderView } from './render.js';

export { chatTranscript } from './chat.js';
