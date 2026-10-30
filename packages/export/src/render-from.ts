/**
 * Direction 2 of `nix-render`: a presentation tree back into a ProseMirror body.
 *
 * The DOCX importer in the Go worker emits the tree and Collab turns it into a document here, so
 * the worker never names a schema node. It is the inverse of `renderDocument` for what the tree
 * can hold; an image `src` is kept verbatim, so a `nix-file:<sourceId>` placeholder still reaches
 * the import mapping that resolves it.
 */

import { isRecord } from '@nix/editor-schema';
import {
  RENDER_FORMAT,
  RENDER_VERSION,
  RUN_STYLES,
  type RenderBlock,
  type RenderDocument,
  type RenderRun,
} from './render.js';

type Json = Record<string, unknown>;

/** Parses a tree a worker posted. Returns null for anything that is not a `nix-render` v1 document. */
export function parseRenderDocument(value: unknown): RenderDocument | null {
  if (!isRecord(value) || value.format !== RENDER_FORMAT || value.version !== RENDER_VERSION) {
    return null;
  }
  if (!Array.isArray(value.blocks)) return null;
  const losses = Array.isArray(value.losses)
    ? value.losses.filter((loss): loss is string => typeof loss === 'string')
    : [];
  // Shapes inside blocks are read leniently by the converter: a malformed block becomes an empty
  // paragraph rather than a refused import, matching how `visitProse` treats a malformed node.
  return {
    format: RENDER_FORMAT,
    version: RENDER_VERSION,
    blocks: value.blocks as RenderBlock[],
    losses,
  };
}

function text(run: RenderRun): Json | null {
  if (typeof run.text !== 'string' || run.text.length === 0) return null;
  if (run.text === '\n') return { type: 'hardBreak' };
  const marks: Json[] = [];
  for (const style of run.styles ?? []) {
    if ((RUN_STYLES as readonly string[]).includes(style)) marks.push({ type: style });
  }
  if (typeof run.href === 'string' && run.href.length > 0) {
    marks.push({
      type: 'link',
      attrs: {
        href: run.href,
        target: '_blank',
        rel: 'noopener noreferrer nofollow',
        class: null,
        title: null,
      },
    });
  }
  const node: Json = { type: 'text', text: run.text };
  if (marks.length > 0) node.marks = marks;
  return node;
}

function inline(runs: unknown): Json[] {
  if (!Array.isArray(runs)) return [];
  return runs
    .filter(isRecord)
    .map((run) => text(run as unknown as RenderRun))
    .filter((node): node is Json => node !== null);
}

function paragraph(runs: unknown, align?: unknown): Json {
  const node: Json = { type: 'paragraph' };
  if (align === 'center' || align === 'right') node.attrs = { textAlign: align };
  const content = inline(runs);
  if (content.length > 0) node.content = content;
  return node;
}

function blocks(value: unknown): Json[] {
  if (!Array.isArray(value)) return [];
  return value.filter(isRecord).map((block) => toNode(block as RenderBlock));
}

/** A block's node. A kind this build does not know becomes a paragraph of its runs. */
function toNode(block: RenderBlock): Json {
  switch (block.kind) {
    case 'paragraph':
      return paragraph(block.runs, block.align);
    case 'heading': {
      const level: unknown = block.level;
      return {
        type: 'heading',
        attrs: {
          level:
            typeof level === 'number' && Number.isInteger(level)
              ? Math.min(6, Math.max(1, level))
              : 1,
        },
        content: inline(block.runs),
      };
    }
    case 'quote':
      return { type: 'blockquote', content: blocks(block.blocks) };
    case 'callout':
      return { type: 'callout', attrs: { tone: block.tone }, content: blocks(block.blocks) };
    case 'code': {
      const node: Json = {
        type: 'codeBlock',
        attrs: {
          language: block.language ?? null,
          renderFileId: block.renderFile ?? null,
          renderSourceHash: null,
        },
      };
      if (typeof block.text === 'string' && block.text.length > 0) {
        node.content = [{ type: 'text', text: block.text }];
      }
      return node;
    }
    case 'rule':
      return { type: 'horizontalRule' };
    case 'pageBreak':
      return { type: 'pageBreak' };
    case 'image':
      return {
        type: 'image',
        attrs: {
          src: block.src,
          alt: block.alt,
          fileItemId: block.file ?? null,
          width: block.width ?? null,
          title: null,
          height: null,
        },
      };
    case 'list': {
      const task =
        Array.isArray(block.items) &&
        block.items.some((item) => isRecord(item) && 'checked' in item);
      const items = (Array.isArray(block.items) ? block.items : []).filter(isRecord).map((item) => {
        const node: Json = { type: task ? 'taskItem' : 'listItem', content: blocks(item.blocks) };
        if (task) node.attrs = { checked: item.checked === true };
        return node;
      });
      if (task) return { type: 'taskList', content: items };
      const node: Json = { type: block.ordered ? 'orderedList' : 'bulletList', content: items };
      if (block.ordered && typeof block.start === 'number') node.attrs = { start: block.start };
      return node;
    }
    case 'table':
      return {
        type: 'table',
        content: (Array.isArray(block.rows) ? block.rows : []).filter(isRecord).map((row) => ({
          type: 'tableRow',
          content: (Array.isArray(row.cells) ? row.cells : []).map((cell) => ({
            type: row.header === true ? 'tableHeader' : 'tableCell',
            content: [paragraph(cell)],
          })),
        })),
      };
    case 'details': {
      const node: Json = {
        type: 'details',
        content: [
          { type: 'detailsSummary', content: inline(block.summary) },
          { type: 'detailsContent', content: blocks(block.blocks) },
        ],
      };
      if (typeof block.level === 'number') node.attrs = { toggleLevel: block.level };
      return node;
    }
    default:
      return paragraph((block as { runs?: unknown }).runs);
  }
}

/** The ProseMirror JSON for a tree, ready for a `ProseBody` envelope. */
export function documentFromRender(render: RenderDocument): unknown {
  return { type: 'doc', content: blocks(render.blocks) };
}
