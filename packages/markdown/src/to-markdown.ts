/**
 * Direction 1: a ProseMirror document body, as plain JSON, rendered to Markdown.
 *
 * **Built on the `@nix/export` visitor, not on a second tree-walk of its own.** `visitProse`
 * already guarantees exhaustiveness - the compiler will not accept a `NodeHandlers` map missing a
 * block, and a block a newer build added leaves an `unknown-node` loss rather than vanishing - so a
 * Markdown serializer written as `NodeHandlers<string>` gets the same guarantee the PDF and DOCX
 * mappers get, for free (ADR-0037). It stays pure JSON in, string out: no ProseMirror `Node` is
 * constructed on this path.
 *
 * Marks Markdown cannot carry (comment, colour, underline, highlight) drop the mark and keep the
 * text, each recording a loss the first time it is seen. Structure Markdown cannot carry (a column
 * layout, a table, a task list's checkboxes) degrades to the nearest thing Markdown has and records
 * a loss. Everything else is standard CommonMark/GFM. See `losses.ts` for why the loss vocabulary
 * is this package's own rather than the export report's closed set.
 */

import {
  readBoolean,
  readNumber,
  readString,
  visitProse,
  createLossReport,
  type NodeHandler,
  type NodeHandlers,
  type ProseNode,
} from '@nix/export';
import { CALLOUT_TONES, REFERENCE_KINDS, isRecord, readToggleLevel } from '@nix/editor-schema';

import {
  MARKDOWN_LOSSES,
  createLossCollector,
  type LossCollector,
  type ToMarkdownResult,
} from './losses.js';

/** A stand-in item id: this boundary has no real one, and losses are folded by kind, not by item. */
const DOC_ITEM_ID = 'document';

/**
 * The characters that would otherwise start Markdown inline syntax mid-text.
 *
 * Deliberately a small set: over-escaping turns clean prose into a thicket of backslashes that then
 * has to survive its own round-trip. These five are the ones that change meaning inside a run of
 * text; block-level starters (`#`, `-`, `>`) only bite at the start of a line, which the block
 * handlers control.
 */
export function escapeInline(text: string): string {
  return text.replace(/[\\`*[\]]/g, (match) => `\\${match}`);
}

/** A code span, widened to double backticks only when the content itself carries one. */
function codeSpan(text: string): string {
  return text.includes('`') ? `\`\` ${text} \`\`` : `\`${text}\``;
}

/** The raw text of a node's direct text children, for contexts (code) where Markdown does not escape. */
function rawText(node: ProseNode): string {
  return node.content
    .map((child) => (isRecord(child) && typeof child.text === 'string' ? child.text : ''))
    .join('');
}

/**
 * Plain text pulled from a raw subtree, for table cells the visitor does not recurse into.
 *
 * A reference contributes its label, the same text the schema's own `leafText` gives the search
 * index, so a cell naming another note is not blank in the flattened table.
 */
function inlineTextRaw(value: unknown): string {
  if (!isRecord(value)) {
    return '';
  }
  if (value.type === 'text' && typeof value.text === 'string') {
    return value.text;
  }
  if (value.type === 'reference') {
    const attrs = isRecord(value.attrs) ? value.attrs : {};
    return readString(attrs, 'label') ?? readString(attrs, 'targetId') ?? '';
  }
  if (Array.isArray(value.content)) {
    return value.content.map(inlineTextRaw).join('');
  }
  return '';
}

/** Prefix every line with a blockquote marker, bare `>` for the blank lines between paragraphs. */
function quote(text: string): string {
  return text
    .split('\n')
    .map((line) => (line.length > 0 ? `> ${line}` : '>'))
    .join('\n');
}

/** A list item: the marker on the first line, the marker's width of indent on every line after. */
function withMarker(marker: string, body: string): string {
  const indent = ' '.repeat(marker.length);
  return body
    .split('\n')
    .map((line, index) => {
      if (index === 0) {
        return marker + line;
      }
      return line.length > 0 ? indent + line : '';
    })
    .join('\n');
}

function clampLevel(value: number | null): number {
  if (value === null) {
    return 1;
  }
  return Math.min(3, Math.max(1, Math.trunc(value)));
}

function calloutTone(node: ProseNode): string {
  const tone = readString(node.attrs, 'tone');
  return tone !== null && (CALLOUT_TONES as readonly string[]).includes(tone) ? tone : 'note';
}

function referenceKind(node: ProseNode): string {
  const kind = readString(node.attrs, 'kind');
  return kind !== null && (REFERENCE_KINDS as readonly string[]).includes(kind) ? kind : 'item';
}

/**
 * One text node's Markdown, marks and all.
 *
 * Code is applied innermost (it does not escape, and CommonMark requires a non-escaping mark to be
 * the innermost one); the link wraps outermost so its text carries whatever emphasis was on it. The
 * four marks Markdown has no syntax for are noted and dropped, the run of text kept intact.
 */
function renderText(node: ProseNode, loss: LossCollector): string {
  const raw = node.text ?? '';
  const present = new Set(node.marks.map((mark) => mark.type));

  let out = present.has('code') ? codeSpan(raw) : escapeInline(raw);

  if (present.has('strike')) {
    out = `~~${out}~~`;
  }
  if (present.has('italic')) {
    out = `*${out}*`;
  }
  if (present.has('bold')) {
    out = `**${out}**`;
  }
  if (present.has('underline')) {
    loss.note(MARKDOWN_LOSSES.underlineDropped.kind, MARKDOWN_LOSSES.underlineDropped.detail);
  }
  if (present.has('highlight')) {
    loss.note(MARKDOWN_LOSSES.highlightDropped.kind, MARKDOWN_LOSSES.highlightDropped.detail);
  }
  if (present.has('textColor')) {
    loss.note(MARKDOWN_LOSSES.colorDropped.kind, MARKDOWN_LOSSES.colorDropped.detail);
  }
  if (present.has('comment')) {
    loss.note(MARKDOWN_LOSSES.commentDropped.kind, MARKDOWN_LOSSES.commentDropped.detail);
  }

  const link = node.marks.find((mark) => mark.type === 'link');
  if (link !== undefined) {
    const href = readString(link.attrs, 'href') ?? '';
    out = `[${out}](${href})`;
  }

  return out;
}

/**
 * A table, flattened to a GFM pipe table.
 *
 * **Best-effort, and a declared loss, on purpose.** GFM requires a header row and cannot express
 * merged cells, column widths or alignment that differs from the header cell for that column. Its
 * cells hold one line of inline Markdown while this renderer deliberately extracts plain text from
 * Nix's block cells. Every table therefore records `table-flattened`, including when its simplest
 * grid and alignment happen to round-trip.
 */
function renderTable(node: ProseNode, loss: LossCollector): string {
  loss.note(MARKDOWN_LOSSES.tableFlattened.kind, MARKDOWN_LOSSES.tableFlattened.detail);

  const rows = node.content
    .filter(isRecord)
    .filter((row) => row.type === 'tableRow')
    .map((row) => (Array.isArray(row.content) ? row.content : []).filter(isRecord));

  if (rows.length === 0) {
    return '';
  }

  const cellText = (cell: Record<string, unknown>): string =>
    inlineTextRaw(cell).replace(/\|/g, '\\|').replace(/\n+/g, ' ').trim();

  const cellAlign = (cell: Record<string, unknown>): string => {
    const attrs = isRecord(cell.attrs) ? cell.attrs : {};
    switch (readString(attrs, 'align')) {
      case 'left':
        return ':---';
      case 'right':
        return '---:';
      case 'center':
        return ':--:';
      default:
        return '---';
    }
  };

  const width = Math.max(...rows.map((cells) => cells.length));
  const padded = (cells: string[]): string[] => {
    const copy = [...cells];
    while (copy.length < width) {
      copy.push('');
    }
    return copy;
  };

  const headerCells = rows[0] ?? [];
  const line = (cells: string[]): string => `| ${padded(cells).join(' | ')} |`;
  const headerLine = line(headerCells.map(cellText));
  const separator = line(
    padded(headerCells.map(cellAlign)).map((marker) => (marker.length > 0 ? marker : '---')),
  );
  const bodyLines = rows.slice(1).map((cells) => line(cells.map(cellText)));

  return [headerLine, separator, ...bodyLines].join('\n');
}

/** The serializer, closed over the collector its handlers record losses into. */
function buildHandlers(loss: LossCollector): NodeHandlers<string> {
  const block: NodeHandler<string> = (_node, _ctx, children) => children().join('\n\n');
  const inline: NodeHandler<string> = (_node, _ctx, children) => children().join('');

  const alignedInline: NodeHandler<string> = (node, ctx, children) => {
    if (node.attrs.textAlign != null && node.attrs.textAlign !== 'left') {
      const notice = MARKDOWN_LOSSES.alignmentDropped;
      loss.note(notice.kind, notice.detail);
    }
    return inline(node, ctx, children);
  };

  const renderList = (start: number | null): NodeHandler<string> => {
    return (_node, _ctx, children) =>
      children()
        .map((body, index) => {
          const marker = start === null ? '- ' : `${String(start + index)}. `;
          return withMarker(marker, body);
        })
        .join('\n');
  };

  return {
    unknownNode: (node, _ctx, children) =>
      [node.text === null ? '' : escapeInline(node.text), ...children()]
        .filter(Boolean)
        .join('\n\n'),
    doc: block,
    paragraph: alignedInline,
    text: (node) => renderText(node, loss),
    hardBreak: () => '\\\n',
    heading: (node, ctx, children) =>
      `${'#'.repeat(clampLevel(readNumber(node.attrs, 'level')))} ${alignedInline(node, ctx, children) ?? ''}`,
    blockquote: (_node, _ctx, children) => quote(children().join('\n\n')),
    codeBlock: (node) =>
      `\`\`\`${readString(node.attrs, 'language') ?? ''}\n${rawText(node)}\n\`\`\``,
    horizontalRule: () => '---',
    pageBreak: () => {
      loss.note('page-break-flattened', 'Explicit page boundaries are not preserved in Markdown.');
      return '---';
    },
    itemBlock: (node) => {
      loss.note(
        'item-block-linked',
        'Linked sections are exported as source links; live content is not included.',
      );
      return `[Linked item](nix://item/${readString(node.attrs, 'targetId') ?? ''})`;
    },
    callout: (node, _ctx, children) =>
      quote(`[!${calloutTone(node)}]\n\n${children().join('\n\n')}`),
    image: (node) =>
      `![${readString(node.attrs, 'alt') ?? ''}](${readString(node.attrs, 'src') ?? ''})`,
    bulletList: renderList(null),
    orderedList: (node, ctx, children) =>
      renderList(readNumber(node.attrs, 'start') ?? 1)(node, ctx, children),
    listItem: block,
    taskList: (node, ctx, children) => {
      loss.note(MARKDOWN_LOSSES.taskListFlattened.kind, MARKDOWN_LOSSES.taskListFlattened.detail);
      return renderList(null)(node, ctx, children);
    },
    taskItem: (node, _ctx, children) => {
      const box = readBoolean(node.attrs, 'checked') ? '[x] ' : '[ ] ';
      return box + children().join('\n\n');
    },
    table: (node) => renderTable(node, loss),
    // Rows and cells are read directly by `renderTable`, which does not recurse, so these are
    // unreachable. They exist because `NodeHandlers` demands every node name; returning the cells'
    // text keeps them harmless if a future change ever does recurse.
    tableRow: (_node, _ctx, children) => children().join(' '),
    tableHeader: (_node, _ctx, children) => children().join(''),
    tableCell: (_node, _ctx, children) => children().join(''),
    columnBlock: (_node, _ctx, children) => {
      loss.note(MARKDOWN_LOSSES.columnsFlattened.kind, MARKDOWN_LOSSES.columnsFlattened.detail);
      return children().join('\n\n');
    },
    column: block,
    details: (node, _ctx, children) => {
      const parts = children();
      const summary = parts[0] ?? '';
      const content = parts[1] ?? '';
      const level = readToggleLevel(node.attrs.toggleLevel);
      // The toggle level is carried on a data attribute so a heading toggle round-trips as one; a
      // plain toggle opens with a bare tag. `from-markdown` reads it back with the same reader.
      const open = level === null ? '<details>' : `<details data-toggle-level="${String(level)}">`;
      return `${open}\n<summary>${summary}</summary>\n\n${content}\n\n</details>`;
    },
    detailsSummary: alignedInline,
    detailsContent: block,
    reference: (node) => {
      const kind = referenceKind(node);
      const targetId = readString(node.attrs, 'targetId') ?? '';
      const label =
        readString(node.attrs, 'label') ?? (targetId.length > 0 ? targetId : 'reference');
      return `[${escapeInline(label)}](nix://${kind}/${targetId})`;
    },
  };
}

/**
 * Render a document body to Markdown, with the list of everything the mapping could not carry.
 *
 * The visitor's own structural losses - a block from a newer build, a malformed node - are folded
 * into the same list by their kind string, so the caller sees one report rather than two.
 */
export function documentToMarkdown(doc: unknown): ToMarkdownResult {
  const loss = createLossCollector();
  const report = createLossReport();
  const markdown =
    visitProse<string>(doc, buildHandlers(loss), { itemId: DOC_ITEM_ID, report }) ?? '';

  for (const entry of report.entries()) {
    loss.note(entry.kind, entry.detail);
  }

  return { markdown, losses: loss.list() };
}
