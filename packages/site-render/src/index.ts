/**
 * A published Nix site, rendered (ADR-0063).
 *
 * Pure: a build manifest, its pages, their bodies and their stripped images go in; every file of
 * the static site comes out, with a report of what could not be shown. The sites worker uploads
 * the result; the CLI writes it to a directory and serves it for preview.
 */

export { SiteManifestError, parseSiteManifest, parseSitePages, type SitePage } from './manifest.js';
export { collectFileReferences } from './references.js';
export { UnsupportedImage, stripImageMetadata, type StrippedImage } from './images.js';
export {
  MAX_DOWNLOAD_BYTES,
  MAX_VIDEO_BYTES,
  UnsupportedDownload,
  downloadType,
  prepareDownload,
  safeFileName,
  type PublishedDownload,
} from './downloads.js';
export { MAX_DIAGRAM_BYTES, sanitizeSvg } from './svg.js';
export { escapeHtml } from './html/escape.js';
export { tokenize } from './search.js';
export { renderSite, type RenderedFile } from './render.js';
export { loadPreviewRasterizer } from './theme/preview-image.js';
export { PDF_CSP, SITE_CSP, SVG_CSP, normalizePath } from './serve.js';
