/**
 * `nix-render`: a document body as a presentation tree, for converters that never see the schema.
 *
 * The Go export worker draws PDF and DOCX from this and the DOCX importer emits it, so Go names no
 * ProseMirror node or mark; schema changes touch TypeScript only. The vocabulary is what a page can
 * show - blocks of runs - and nothing the editor needs for editing (ids, suggestions, comments).
 * `visitProse` already rejects suggestions and reports unknown nodes, so those semantics are shared
 * with Markdown and published sites (GitHub issue 273).
 *
 * A reader rejects an unknown major version and skips (with a loss) an unknown block kind, so a
 * minor addition here is a new kind, never a changed one.
 */

import {
  CALLOUT_TONES,
  REFERENCE_KINDS,
  readTextAlignment,
  readToggleLevel,
} from '@nix/editor-schema';

import type { LossReport } from './loss.js';
import {
  readBoolean,
  readNumber,
  readString,
  visitProse,
  type NodeHandler,
  type NodeHandlers,
  type ProseNode,
  type VisitContext,
} from './visit.js';

export const RENDER_FORMAT = 'nix-render';
export const RENDER_VERSION = 1;

export const RUN_STYLES = ['bold', 'italic', 'underline', 'strike', 'code', 'highlight'] as const;
export type RunStyle = (typeof RUN_STYLES)[number];

export interface RenderRun {
  readonly text: string;
  readonly styles?: readonly RunStyle[];
  readonly href?: string;
}

export interface RenderListItem {
  /** Present on task-list items only. */
  readonly checked?: boolean;
  readonly blocks: readonly RenderBlock[];
}

export interface RenderTableRow {
  readonly header: boolean;
  readonly cells: readonly (readonly RenderRun[])[];
}

export type RenderBlock =
  | {
      readonly kind: 'paragraph';
      readonly runs: readonly RenderRun[];
      readonly align?: 'center' | 'right';
    }
  | { readonly kind: 'heading'; readonly level: number; readonly runs: readonly RenderRun[] }
  | { readonly kind: 'quote'; readonly blocks: readonly RenderBlock[] }
  | { readonly kind: 'callout'; readonly tone: string; readonly blocks: readonly RenderBlock[] }
  | {
      readonly kind: 'code';
      readonly language: string | null;
      readonly text: string;
      /** A captured picture of the code (a Mermaid diagram), as a file item id. */
      readonly renderFile?: string;
    }
  | { readonly kind: 'rule' }
  | { readonly kind: 'pageBreak' }
  | {
      readonly kind: 'image';
      readonly src: string;
      readonly alt: string;
      readonly file?: string;
      readonly width?: number;
    }
  | {
      readonly kind: 'list';
      readonly ordered: boolean;
      readonly start?: number;
      readonly items: readonly RenderListItem[];
    }
  | { readonly kind: 'table'; readonly rows: readonly RenderTableRow[] }
  | {
      readonly kind: 'details';
      readonly summary: readonly RenderRun[];
      readonly level?: number;
      readonly blocks: readonly RenderBlock[];
    };

export interface RenderDocument {
  readonly format: typeof RENDER_FORMAT;
  readonly version: typeof RENDER_VERSION;
  readonly blocks: readonly RenderBlock[];
  /** What the tree could not hold, in the order first seen. */
  readonly losses: readonly string[];
}

/** A wrapper with no presentation of its own (doc, list item, column): its blocks, handed up. */
interface Group {
  readonly kind: 'group';
  readonly blocks: readonly RenderBlock[];
}

/** A handler's product: blocks for block nodes, runs for inline ones, groups for wrappers. */
type Piece = RenderBlock | RenderRun | Group;

function isRun(piece: Piece): piece is RenderRun {
  return !('kind' in piece);
}

function isGroup(piece: Piece): piece is Group {
  return 'kind' in piece && piece.kind === 'group';
}

function runs(pieces: Piece[]): RenderRun[] {
  return pieces.filter(isRun);
}

function blocks(pieces: Piece[]): RenderBlock[] {
  const out: RenderBlock[] = [];
  let pending: RenderRun[] = [];
  const flush = () => {
    if (pending.length > 0) {
      out.push({ kind: 'paragraph', runs: pending });
      pending = [];
    }
  };
  // Runs that sit directly among blocks (an unknown wrapper flattened) are gathered as a paragraph.
  for (const piece of pieces) {
    if (isRun(piece)) {
      pending.push(piece);
    } else if (isGroup(piece)) {
      flush();
      out.push(...piece.blocks);
    } else {
      flush();
      out.push(piece);
    }
  }
  flush();
  return out;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/** Plain text of a raw subtree, for table cells (not recursed by the visitor) and labels. */
function plainText(value: unknown): string {
  if (!isRecord(value)) return '';
  if (value.type === 'text' && typeof value.text === 'string') return value.text;
  if (value.type === 'hardBreak') return '\n';
  if (value.type === 'reference') {
    const attrs = isRecord(value.attrs) ? value.attrs : {};
    return readString(attrs, 'label') ?? readString(attrs, 'targetId') ?? '';
  }
  return Array.isArray(value.content) ? value.content.map(plainText).join('') : '';
}

function textRun(node: ProseNode, ctx: VisitContext): RenderRun {
  const styles: RunStyle[] = [];
  let href: string | undefined;
  for (const mark of node.marks) {
    switch (mark.type) {
      case 'bold':
      case 'italic':
      case 'underline':
      case 'strike':
      case 'code':
      case 'highlight':
        styles.push(mark.type);
        break;
      case 'link':
        href = readString(mark.attrs, 'href') ?? undefined;
        break;
      case 'textColor':
        ctx.loss.note(
          'text-formatting-dropped',
          'Text colour is not carried into exported documents.',
        );
        break;
      case 'comment':
        ctx.loss.note('comment-dropped', 'Comments are not carried into exported documents.');
        break;
      // Suggestion marks never reach here: the visitor rejects them before the walk.
      case 'suggestionInsert':
      case 'suggestionDelete':
      case 'suggestionFormat':
        break;
    }
  }
  const run: { text: string; styles?: RunStyle[]; href?: string } = { text: node.text ?? '' };
  if (styles.length > 0) run.styles = styles;
  if (href !== undefined) run.href = href;
  return run;
}

function headingLevel(node: ProseNode): number {
  const level = readNumber(node.attrs, 'level') ?? 1;
  return Math.min(6, Math.max(1, Math.trunc(level)));
}

function buildHandlers(): NodeHandlers<Piece> {
  const container: NodeHandler<Piece> = (_node, _ctx, children) => ({
    kind: 'group',
    blocks: blocks(children()),
  });
  const unwrap = (piece: Piece | null): RenderBlock[] => {
    if (piece === null) return [];
    if (isRun(piece)) return [{ kind: 'paragraph', runs: [piece] }];
    return isGroup(piece) ? [...piece.blocks] : [piece];
  };

  const paragraph: NodeHandler<Piece> = (node, _ctx, children) => {
    const align = readTextAlignment(node.attrs.textAlign);
    const block: { kind: 'paragraph'; runs: RenderRun[]; align?: 'center' | 'right' } = {
      kind: 'paragraph',
      runs: runs(children()),
    };
    if (align === 'center' || align === 'right') block.align = align;
    return block;
  };

  const list =
    (ordered: boolean, task: boolean): NodeHandler<Piece> =>
    (node, _ctx, children) => {
      const items: RenderListItem[] = [];
      for (const child of node.content) {
        if (!isRecord(child)) continue;
        const attrs = isRecord(child.attrs) ? child.attrs : {};
        const item: { checked?: boolean; blocks: RenderBlock[] } = { blocks: [] };
        if (task) item.checked = readBoolean(attrs, 'checked');
        items.push(item);
      }
      // The visitor walks the same children in the same order, and `container` yields one piece
      // per item; a malformed item is dropped by the visitor, so match by index from the front.
      const walked = children();
      for (let index = 0; index < walked.length && index < items.length; index += 1) {
        (items[index] as { blocks: RenderBlock[] }).blocks = unwrap(walked[index] ?? null);
      }
      const block: { kind: 'list'; ordered: boolean; start?: number; items: RenderListItem[] } = {
        kind: 'list',
        ordered,
        items,
      };
      const start = readNumber(node.attrs, 'start');
      if (ordered && start !== null && start !== 1) block.start = start;
      return block;
    };

  return {
    unknownNode: (node, _ctx, children) =>
      node.text !== null ? { text: node.text } : { kind: 'group', blocks: blocks(children()) },
    doc: container,
    paragraph,
    text: (node, ctx) => textRun(node, ctx),
    hardBreak: () => ({ text: '\n' }),
    heading: (node, _ctx, children) => ({
      kind: 'heading',
      level: headingLevel(node),
      runs: runs(children()),
    }),
    blockquote: (_node, _ctx, children) => ({ kind: 'quote', blocks: blocks(children()) }),
    codeBlock: (node) => {
      const block: { kind: 'code'; language: string | null; text: string; renderFile?: string } = {
        kind: 'code',
        language: readString(node.attrs, 'language'),
        text: node.content.map(plainText).join(''),
      };
      const renderFile = readString(node.attrs, 'renderFileId');
      if (renderFile !== null) block.renderFile = renderFile;
      return block;
    },
    horizontalRule: () => ({ kind: 'rule' }),
    pageBreak: () => ({ kind: 'pageBreak' }),
    callout: (node, _ctx, children) => {
      const tone = readString(node.attrs, 'tone');
      return {
        kind: 'callout',
        tone: tone !== null && (CALLOUT_TONES as readonly string[]).includes(tone) ? tone : 'note',
        blocks: blocks(children()),
      };
    },
    image: (node) => {
      const block: { kind: 'image'; src: string; alt: string; file?: string; width?: number } = {
        kind: 'image',
        src: readString(node.attrs, 'src') ?? '',
        alt: readString(node.attrs, 'alt') ?? '',
      };
      const file = readString(node.attrs, 'fileItemId');
      if (file !== null) block.file = file;
      const width = readNumber(node.attrs, 'width');
      if (width !== null && width > 0) block.width = width;
      return block;
    },
    bulletList: list(false, false),
    orderedList: list(true, false),
    taskList: list(false, true),
    listItem: container,
    taskItem: container,
    table: (node, ctx) => {
      const rows: RenderTableRow[] = [];
      for (const row of node.content) {
        if (!isRecord(row) || row.type !== 'tableRow' || !Array.isArray(row.content)) continue;
        const cells = row.content.filter(isRecord);
        if (cells.some((cell) => Array.isArray(cell.content) && cell.content.length > 1)) {
          ctx.loss.note(
            'text-formatting-dropped',
            'Table cells were flattened to their text; blocks inside a cell were joined.',
          );
        }
        rows.push({
          header: cells.length > 0 && cells.every((cell) => cell.type === 'tableHeader'),
          cells: cells.map((cell) => [{ text: plainText(cell) }]),
        });
      }
      return { kind: 'table', rows };
    },
    // Rows and cells are read by `table` directly; these exist because the map must be exhaustive.
    tableRow: () => null,
    tableHeader: () => null,
    tableCell: () => null,
    columnBlock: (_node, ctx, children) => {
      ctx.loss.note('columns-flattened', 'Columns were laid out one after another.');
      return { kind: 'group', blocks: children().flatMap((piece) => unwrap(piece)) };
    },
    column: container,
    details: (node, _ctx, children) => {
      const parts = children();
      const summary = parts[0];
      const block: {
        kind: 'details';
        summary: RenderRun[];
        level?: number;
        blocks: RenderBlock[];
      } = {
        kind: 'details',
        summary:
          summary !== undefined && !isRun(summary) && summary.kind === 'paragraph'
            ? [...summary.runs]
            : [],
        blocks: unwrap(parts[1] ?? null),
      };
      const level = readToggleLevel(node.attrs.toggleLevel);
      if (level !== null) block.level = level;
      return block;
    },
    detailsSummary: paragraph,
    detailsContent: container,
    reference: (node) => {
      const kind = readString(node.attrs, 'kind');
      const targetId = readString(node.attrs, 'targetId') ?? '';
      const safeKind =
        kind !== null && (REFERENCE_KINDS as readonly string[]).includes(kind) ? kind : 'item';
      return {
        text: readString(node.attrs, 'label') ?? (targetId.length > 0 ? targetId : 'reference'),
        href: `nix://${safeKind}/${targetId}`,
      };
    },
    // Embedded sections were already inlined by Collab (`expandEmbeddedSections`); one that was not
    // is drawn as its link, the same answer Markdown gives.
    itemBlock: (node, ctx) => {
      ctx.loss.note(
        'reference-flattened',
        'A linked section is represented by its link; its live content is not included.',
      );
      const targetId = readString(node.attrs, 'targetId') ?? '';
      return { kind: 'paragraph', runs: [{ text: 'Linked item', href: `nix://item/${targetId}` }] };
    },
  };
}

const HANDLERS = buildHandlers();

/**
 * A body as a render tree, or null (with `body-not-rendered` in the report) when it is not one.
 *
 * The doc-level losses the visitor files against `itemId` are the caller's to read from `report`;
 * `losses` on the returned document repeats them as sentences so a reader with no report (the Go
 * worker) still sees them.
 */
export function renderDocument(
  body: unknown,
  request: { readonly itemId: string; readonly report: LossReport },
): RenderDocument | null {
  const root = visitProse<Piece>(body, HANDLERS, request);
  if (root === null) return null;
  return {
    format: RENDER_FORMAT,
    version: RENDER_VERSION,
    blocks: isRun(root)
      ? [{ kind: 'paragraph', runs: [root] }]
      : isGroup(root)
        ? [...root.blocks]
        : [root],
    losses: request.report
      .entries()
      .filter((entry) => entry.itemId === request.itemId)
      .map((entry) => entry.detail),
  };
}
