/**
 * Walking a document body, once, for every format that has to draw one.
 *
 * The dispatcher shares exhaustive node handling and loss reporting between Markdown mapping
 * and view previews. Each caller keeps its own output model.
 *
 * **The handler map is a mapped type, so a missing node is a compile error.** That, plus the test
 * asserting {@link PROSE_NODES} equals the schema's own node set, is what makes a new block
 * impossible to ship unmapped: adding one to `@nix/editor-schema` fails a test here, and fixing
 * that test then fails to compile in every converter until each says what it does with it.
 *
 * **The body is read as plain JSON rather than parsed through `nixSchema` or a Zod schema, which is
 * a deliberate exception to the parse-at-every-boundary rule.** An archive outlives the build that
 * wrote it, so a body may hold a node this build has never heard of; a schema that validates the
 * whole document would refuse it entirely, and refusing a whole document over one unknown block is
 * a worse answer than drawing the rest and saying what was skipped. The rule the boundary keeps
 * instead is that **nothing is dropped silently** - every value this file declines to render leaves
 * a `LossKind` behind. See ADR-0037.
 */

import { rejectAllSuggestions } from '@nix/editor-schema';

import type { LossReport, LossSink } from './loss.js';

/**
 * Every node the document schema declares.
 *
 * Kept as a literal rather than derived from `nixSchema.nodes` at runtime, because a derived list
 * would agree with the schema by construction and so could not detect drift. `visit.test.ts`
 * asserts the two are equal, which is the check a derived list cannot make.
 */
export const PROSE_NODES = [
  'doc',
  'paragraph',
  'text',
  'hardBreak',
  'heading',
  'blockquote',
  'codeBlock',
  'horizontalRule',
  'callout',
  'image',
  'bulletList',
  'orderedList',
  'listItem',
  'taskList',
  'taskItem',
  'table',
  'tableRow',
  'tableHeader',
  'tableCell',
  'columnBlock',
  'column',
  'details',
  'detailsSummary',
  'detailsContent',
  'reference',
  'itemBlock',
  'pageBreak',
] as const;

export type ProseNodeName = (typeof PROSE_NODES)[number];

/** Every mark the document schema declares. Same reasoning as {@link PROSE_NODES}. */
export const PROSE_MARKS = [
  'bold',
  'italic',
  'underline',
  'strike',
  'code',
  'highlight',
  'link',
  'textColor',
  'comment',
  'suggestionInsert',
  'suggestionDelete',
  'suggestionFormat',
] as const;

export type ProseMarkName = (typeof PROSE_MARKS)[number];

const NODE_NAMES: ReadonlySet<string> = new Set<string>(PROSE_NODES);
const MARK_NAMES: ReadonlySet<string> = new Set<string>(PROSE_MARKS);

export interface ProseMark {
  readonly type: ProseMarkName;
  readonly attrs: Readonly<Record<string, unknown>>;
}

/** One node of a body, normalised so a handler never reaches into raw JSON. */
export interface ProseNode {
  readonly type: string;
  readonly attrs: Readonly<Record<string, unknown>>;

  /** Set only on `text` nodes. */
  readonly text: string | null;

  /** Marks this build knows. Unknown ones are dropped and recorded; see `readMarks`. */
  readonly marks: readonly ProseMark[];

  /** Raw children, normalised lazily by the walk rather than eagerly here. */
  readonly content: readonly unknown[];
}

/**
 * What a handler is told about where it is.
 *
 * Constructed by {@link visitProse}, never by a caller: `depth` is an output of the recursion, and
 * a caller able to supply it is a caller able to supply the wrong one. Handlers get a write-only
 * {@link LossSink} rather than the report, so a node mapper cannot read, reorder or clear what
 * another one recorded.
 */
export interface VisitContext {
  readonly itemId: string;

  /**
   * How deep this node sits below the body's root, counting the root as 0.
   *
   * Here because a mapper that flattens - OOXML lists, whose nesting is a level number on an
   * otherwise flat paragraph - cannot recover it from the recursion the way a tree-building mapper
   * can.
   */
  readonly depth: number;

  readonly loss: LossSink;
}

/**
 * What one node becomes.
 *
 * `children()` is a thunk rather than an array so a handler that drops a subtree never pays to
 * build it: an image's alt-text placeholder, a details block rendered summary-only. Returning null
 * drops the node from its parent's output.
 */
export type NodeHandler<T> = (node: ProseNode, ctx: VisitContext, children: () => T[]) => T | null;

/**
 * A handler per node, and the compiler will not accept fewer.
 *
 * Mapped over {@link ProseNodeName} rather than indexed by string on purpose - an index signature
 * makes a missing block a runtime surprise, and this is exactly the type whose whole job is to make
 * it a build failure.
 */
export type NodeHandlers<T> = Readonly<Record<ProseNodeName, NodeHandler<T>>> & {
  readonly unknownNode?: NodeHandler<T>;
};

export interface VisitRequest {
  /** Whose body this is. Every loss recorded during the walk is filed against it. */
  readonly itemId: string;

  readonly report: LossReport;
}

/**
 * Walks a body and returns whatever the `doc` handler made of it, or null for a body that is not
 * one.
 *
 * **A null return is always accompanied by a `body-not-rendered` entry in the report**, so a
 * converter that draws nothing for an item never has to remember to say so - which is the mistake
 * three separate converters would otherwise each make once.
 *
 * The one case a caller still owes: `ItemBundle.body` is legitimately null for an item nobody has
 * opened, and that is not a loss - there is nothing to lose. Check for it before calling rather
 * than handing a null body here, or the report will claim a document went missing that never
 * existed.
 */
export function visitProse<T>(
  body: unknown,
  handlers: NodeHandlers<T>,
  request: VisitRequest,
): T | null {
  const ctx: VisitContext = {
    itemId: request.itemId,
    depth: 0,
    loss: request.report.for(request.itemId),
  };

  // Suggestions are proposals, not content: every format draws the document as if all were rejected.
  const root = readNode(rejectAllSuggestions(body), ctx);

  if (root?.type !== 'doc') {
    ctx.loss.note(
      'body-not-rendered',
      'This document could not be read and was left out of this file.',
    );
    return null;
  }

  return walk(root, handlers, ctx);
}

function walk<T>(node: ProseNode, handlers: NodeHandlers<T>, ctx: VisitContext): T | null {
  if (ctx.depth > 64) {
    ctx.loss.note('malformed-node', 'Content beyond the document nesting limit was omitted.');
    return null;
  }
  if (!NODE_NAMES.has(node.type)) {
    ctx.loss.note(
      'unknown-node',
      handlers.unknownNode
        ? `A "${node.type}" block was flattened to readable content; its original presentation is unknown.`
        : `A "${node.type}" block, and everything inside it, was written by a newer version of Nix and could not be drawn.`,
    );
    if (!handlers.unknownNode) return null;
  }

  const handler = NODE_NAMES.has(node.type)
    ? handlers[node.type as ProseNodeName]
    : handlers.unknownNode;
  if (handler === undefined) return null;

  return handler(node, ctx, () => {
    const childContext: VisitContext = { ...ctx, depth: ctx.depth + 1 };
    const results: T[] = [];

    for (const raw of node.content) {
      const child = readNode(raw, childContext);
      if (child === null) {
        childContext.loss.note(
          'malformed-node',
          `Something inside a "${node.type}" block was not readable and was left out.`,
        );
        continue;
      }

      const result = walk(child, handlers, childContext);
      if (result !== null) {
        results.push(result);
      }
    }

    return results;
  });
}

/**
 * Normalises one raw child into a node, or null when it is not one.
 *
 * Returning null rather than noting the loss itself: the caller knows what the malformed value sat
 * inside, and "something inside a table" is a sentence somebody can act on where "a node was
 * malformed" is not.
 */
function readNode(value: unknown, ctx: VisitContext): ProseNode | null {
  if (!isRecord(value) || typeof value.type !== 'string') {
    return null;
  }

  const attrs = value.attrs;
  const text = value.text;
  const content = value.content;

  return {
    type: value.type,
    attrs: isRecord(attrs) ? attrs : {},
    text: typeof text === 'string' ? text : null,
    marks: readMarks(value.marks, ctx),
    content: Array.isArray(content) ? content : [],
  };
}

/**
 * The marks this build can render, with the rest recorded rather than passed through.
 *
 * Passing an unknown mark through would mean every converter reaching into an attribute bag it
 * cannot reason about, and silently dropping it would put a claim in the file - "this is what your
 * document says" - that the report does not back.
 */
function readMarks(value: unknown, ctx: VisitContext): readonly ProseMark[] {
  if (!Array.isArray(value)) {
    return [];
  }

  const marks: ProseMark[] = [];

  for (const raw of value) {
    if (!isRecord(raw) || typeof raw.type !== 'string') {
      continue;
    }

    const type = raw.type;

    if (!MARK_NAMES.has(type)) {
      // Justification: the schema's own name for the mark is interpolated into a sentence somebody
      // reads. It is jargon, and there is no better name available - a mark this build has never
      // heard of has no label but the one the document gives it. Naming it beats "some formatting".
      ctx.loss.note(
        'unknown-mark',
        `Some text carried "${type}" formatting written by a newer version of Nix.`,
      );
      continue;
    }

    const attrs = raw.attrs;
    marks.push({ type: type as ProseMarkName, attrs: isRecord(attrs) ? attrs : {} });
  }

  return marks;
}

/**
 * Attribute readers.
 *
 * A body is JSON somebody else wrote, so every attribute is `unknown` and every converter would
 * otherwise cast - which the `no-explicit-any` rule forbids and which would be wrong anyway. These
 * return the fallback for a missing or wrongly-typed value, which is the same rule the editor
 * applies when it meets an attribute it does not recognise.
 */
export function readString(attrs: Readonly<Record<string, unknown>>, key: string): string | null {
  const value = attrs[key];
  return typeof value === 'string' && value.length > 0 ? value : null;
}

export function readNumber(attrs: Readonly<Record<string, unknown>>, key: string): number | null {
  const value = attrs[key];
  return typeof value === 'number' && Number.isFinite(value) ? value : null;
}

export function readBoolean(attrs: Readonly<Record<string, unknown>>, key: string): boolean {
  return attrs[key] === true;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}
