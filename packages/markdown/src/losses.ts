/**
 * What a Markdown conversion could not carry across, and the two result shapes the public
 * functions return.
 *
 * **Markdown has a smaller vocabulary than the document schema, so a faithful conversion has to
 * say what it dropped rather than drop it quietly.** The `@nix/export` visitor already owns a
 * closed {@link LossKind} set for the archive formats; this package keeps its own open-string set
 * instead, because the Markdown mapping loses different things (a column layout, an inline colour)
 * than a PDF does, and folding both into one closed enum would make each converter carry the
 * other's kinds. The two are bridged in one place - `documentToMarkdown` folds the visitor's own
 * structural losses (an unknown block from a newer build, a malformed node) into this collector by
 * their kind string - so the caller still sees a single list.
 *
 * Kinds are deduped: a document that drops forty comment marks reports `comment-dropped` once, the
 * same posture `@nix/export`'s report takes, because a reader wants "comments were dropped", not
 * forty identical sentences.
 */

export interface MarkdownLoss {
  readonly kind: string;
  readonly detail: string;
}

export interface ToMarkdownResult {
  readonly markdown: string;
  readonly losses: readonly MarkdownLoss[];
}

/**
 * The Markdown-specific loss kinds, with the sentence each carries the first time it is seen.
 *
 * A frozen table rather than scattered string literals so the serializer and the tests name the
 * same thing, and so the detail sentence lives next to its kind rather than being retyped at each
 * call site.
 */
export const MARKDOWN_LOSSES = {
  alignmentDropped: {
    kind: 'alignment-dropped',
    detail: 'Text alignment was dropped; Markdown keeps the words and line breaks.',
  },
  columnsFlattened: {
    kind: 'columns-flattened',
    detail: 'Column layout was flattened to a single column.',
  },
  tableFlattened: {
    kind: 'table-flattened',
    detail:
      'GFM uses the first row as a header and cannot preserve merged cells, column widths, per-cell alignment, multi-block cells or inline formatting.',
  },
  commentDropped: {
    kind: 'comment-dropped',
    detail: 'A comment mark was dropped; the text it covered was kept.',
  },
  colorDropped: {
    kind: 'color-dropped',
    detail: 'A text-colour mark was dropped; the text it covered was kept.',
  },
  underlineDropped: {
    kind: 'underline-dropped',
    detail: 'An underline mark was dropped; Markdown has no underline, and the text was kept.',
  },
  highlightDropped: {
    kind: 'highlight-dropped',
    detail: 'A highlight mark was dropped; the text it covered was kept.',
  },
} as const;

/**
 * A write-only sink that folds by kind and preserves first-seen order.
 *
 * Deliberately not the list itself: a node handler should be able to record a loss without being
 * able to read, reorder or clear what another handler recorded - the same reasoning `LossSink` in
 * `@nix/export` is built on.
 */
export interface LossCollector {
  note(kind: string, detail: string): void;
  list(): readonly MarkdownLoss[];
}

export function createLossCollector(): LossCollector {
  // A Map keyed by kind gives dedup and insertion order together, the way the export report does.
  const seen = new Map<string, MarkdownLoss>();

  return {
    note(kind: string, detail: string): void {
      if (!seen.has(kind)) {
        seen.set(kind, { kind, detail });
      }
    },
    list(): readonly MarkdownLoss[] {
      return [...seen.values()];
    },
  };
}
