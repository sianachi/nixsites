/**
 * An item bundle stream, as one Markdown document.
 *
 * **Markdown is for reading and re-editing as plain text, which is a different promise from a PDF's
 * page or a DOCX's editing copy.** The body maps through {@link documentToMarkdown}, so a note comes
 * across as headings, lists, code and prose that any Markdown reader understands - and keeps its
 * references as `nix://` links and its images as image links. Views, canvases and spreadsheets
 * have readable static alternatives. Formatting and interaction limits are declared before
 * export and recorded in the closing section because the file outlives the download.
 *
 * The converter reaches for nothing - no clock, no filesystem, no rasteriser - and streams its
 * output as UTF-8 chunks, one item at a time in manifest order (parents before children).
 */

import type { ConvertRequest, DocumentConverter, LossKind, LossNotice } from '@nix/export';

import { documentToMarkdown } from './to-markdown.js';
import { portableBody, portableStructure } from './portable.js';

const DECLARED_LOSS: readonly LossNotice[] = [
  { kind: 'comment-dropped', detail: 'Comment threads are not carried over.' },
  {
    kind: 'text-formatting-dropped',
    detail:
      'Text alignment, colour, highlight and underline have no Markdown equivalent and are dropped, though the text they covered is kept.',
  },
  {
    kind: 'columns-flattened',
    detail: 'Side-by-side columns become a single column, one after another.',
  },
  {
    kind: 'views-as-text',
    detail:
      'Views become readable source records and form content; live queries, calculations and interactions are not reproduced.',
  },
  {
    kind: 'body-as-text',
    detail:
      'Canvases become element inventories and spreadsheets retain cell contents and formulas as text. Attachments link to their original Nix items.',
  },
  {
    kind: 'view-rows-truncated',
    detail: 'View source records may be limited or unavailable; incomplete snapshots are labelled.',
  },
  {
    kind: 'unknown-node',
    detail:
      'Unfamiliar blocks retain their readable text and children; their original presentation is not preserved.',
  },
  {
    kind: 'unknown-mark',
    detail: 'Formatting from a newer version of Nix is dropped, and the text it covered is kept.',
  },
  {
    kind: 'malformed-node',
    detail: 'Anything in the document this version cannot read is left out and listed at the end.',
  },
];

/**
 * A loss whose `kind` came across as a plain string from the Markdown mapping, mapped to the closed
 * {@link LossKind} set the export report and the closing section use. A kind with no entry here is
 * one this converter's declared list does not promise, and is folded to `malformed-node` rather than
 * dropped silently - the same posture the archive formats take for content they cannot classify.
 */
const LOSS_KIND_BY_MARKDOWN_KIND: Readonly<Record<string, LossKind>> = {
  'comment-dropped': 'comment-dropped',
  'color-dropped': 'text-formatting-dropped',
  'alignment-dropped': 'text-formatting-dropped',
  'highlight-dropped': 'text-formatting-dropped',
  'underline-dropped': 'text-formatting-dropped',
  'columns-flattened': 'columns-flattened',
  'table-flattened': 'malformed-node',
  'unknown-node': 'unknown-node',
  'unknown-mark': 'unknown-mark',
  'malformed-node': 'malformed-node',
};

function classify(markdownKind: string): LossKind {
  return LOSS_KIND_BY_MARKDOWN_KIND[markdownKind] ?? 'malformed-node';
}

export const markdownConverter: DocumentConverter = {
  format: 'md',
  mediaType: 'text/markdown; charset=utf-8',
  extension: 'md',

  declaredLoss: () => DECLARED_LOSS,

  async *convert(request: ConvertRequest): AsyncGenerator<Uint8Array> {
    const encoder = new TextEncoder();

    // Folded by kind, first detail wins, insertion order preserved - so the closing section reads in
    // the order the document does rather than in map order, matching the export report's posture.
    const losses = new Map<LossKind, string>();

    function note(kind: LossKind, detail: string): void {
      if (!losses.has(kind)) {
        losses.set(kind, detail);
      }
    }

    for await (const bundle of request.bundles) {
      yield encoder.encode(`# ${bundle.title}\n\n`);

      const body = bundle.body;

      if (body !== null && 'prosemirror' in body) {
        const converted = documentToMarkdown(body.prosemirror);
        yield encoder.encode(converted.markdown);
        yield encoder.encode('\n\n');

        for (const loss of converted.losses) {
          note(classify(loss.kind), loss.detail);
        }
      } else {
        const rendered = portableBody(body);
        yield encoder.encode(`${rendered}\n\n`);
        if (body !== null)
          note(
            'body-as-text',
            'Canvas layout and spreadsheet calculations are represented as readable stored content.',
          );
      }

      yield encoder.encode(`${portableStructure(bundle)}\n\n`);
      if (bundle.type === 'file')
        note('body-as-text', 'Attachments link to their original Nix items.');
      if (bundle.views !== null && bundle.views.views.length > 0) {
        note(
          'views-as-text',
          'Views are represented by accessible source records and form content; live queries, calculations and interactions are not reproduced.',
        );
        if (bundle.viewRowsTruncated)
          note('view-rows-truncated', 'The exported view source records are incomplete.');
      }
    }

    if (losses.size > 0) {
      yield encoder.encode('---\n\n## What was left out\n\n');

      for (const detail of losses.values()) {
        yield encoder.encode(`- ${detail}\n`);
      }
    }
  },
};
