/**
 * Markdown for Nix document bodies, both directions.
 *
 * One place that knows how a Nix document maps to Markdown, imported by the CLI and the MCP server
 * so `note read` and `note write` are the same mapping and a body written as Markdown and read back
 * is the body it started as, modulo what Markdown genuinely cannot carry. The mapping is built on
 * `@nix/editor-schema` (the one definition of what a document may contain) and `@nix/export` (the
 * exhaustive visitor), so it cannot drift from what the editor and the collaboration service accept.
 *
 * `documentToMarkdown` reports what it dropped; `markdownToDocument` validates before it returns.
 * Neither constructs a ProseMirror instance at its boundary - plain JSON in, plain JSON out.
 */

export { splitFrontMatter, parseScalar, noteFromMarkdown } from './front-matter.js';
export { EMPTY_MARKDOWN_IMPORT_SCAN, type MarkdownImportScan } from './scan.js';
export { documentToMarkdown, escapeInline } from './to-markdown.js';
export { markdownToDocument, type FromMarkdownResult } from './from-markdown.js';
export { type MarkdownLoss } from './losses.js';
