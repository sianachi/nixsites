import type { Editor } from '@tiptap/react';
import {
  absolutePositionToRelativePosition,
  relativePositionToAbsolutePosition,
  ySyncPluginKey,
} from 'y-prosemirror';
import type * as Y from 'yjs';

import { plainText, type ReplaceRange } from './inline-ai-material';

/**
 * Putting a result into the note, once, and only where it still belongs.
 *
 * The note is shared: while a result streams in, somebody else may type above the span it was
 * asked about, or into it. Two things follow. The span has to be tracked through those edits, and
 * Replace has to refuse a span whose text is no longer what the model saw - overwriting words
 * nobody asked it about is worse than putting the result below instead.
 */

/** Follows a span of the note through whatever happens to the document meanwhile. */
export interface RangeAnchor {
  /** Where the span is now, or null when the position cannot be recovered. */
  resolve: () => ReplaceRange | null;
  dispose: () => void;
}

interface SyncState {
  readonly doc: Y.Doc;
  readonly type: Y.XmlFragment;
  readonly binding: { readonly mapping: Parameters<typeof absolutePositionToRelativePosition>[2] };
}

interface MappingLike {
  map: (pos: number, assoc?: number) => number;
}

function syncState(editor: Editor): SyncState | null {
  const state = ySyncPluginKey.getState(editor.state) as Partial<SyncState> | undefined;
  if (state?.doc === undefined || state.type === undefined || state.binding === undefined) {
    return null;
  }
  return state as SyncState;
}

/**
 * Anchors `from` and `to`.
 *
 * In a collaborative note a colleague's edit reaches the editor as a rewrite of the whole
 * document, so a transaction mapping would carry every position to the end of it; the span is
 * anchored in the shared Yjs document instead, which is what survives such edits. Without a
 * binding (an editor that is not synced) the transactions' own mappings do the same work.
 */
export function anchorRange(editor: Editor, from: number, to: number): RangeAnchor {
  const sync = syncState(editor);
  if (sync !== null) {
    const start = absolutePositionToRelativePosition(
      from,
      sync.type,
      sync.binding.mapping,
    ) as Y.RelativePosition;
    const end = absolutePositionToRelativePosition(
      to,
      sync.type,
      sync.binding.mapping,
    ) as Y.RelativePosition;
    return {
      resolve: () => {
        const live = syncState(editor);
        if (live === null) return null;
        const a: number | null = relativePositionToAbsolutePosition(
          live.doc,
          live.type,
          start,
          live.binding.mapping,
        );
        const b: number | null = relativePositionToAbsolutePosition(
          live.doc,
          live.type,
          end,
          live.binding.mapping,
        );
        if (a === null || b === null || a > b) return null;
        return { from: a, to: b };
      },
      dispose: () => undefined,
    };
  }

  let current: ReplaceRange | null = { from, to };
  const onTransaction = ({
    transaction,
  }: {
    readonly transaction: { readonly docChanged: boolean; readonly mapping: MappingLike };
  }): void => {
    if (!transaction.docChanged || current === null) return;
    // A caret (an empty span) stays put when text is typed at it; a span grows with edits at its
    // edges only inward, so a replace never swallows what was typed beside it.
    const collapsed = current.from === current.to;
    const a = transaction.mapping.map(current.from, collapsed ? -1 : 1);
    const b = transaction.mapping.map(current.to, -1);
    current = a > b ? null : { from: a, to: b };
  };
  editor.on('transaction', onTransaction);
  return {
    resolve: () => current,
    dispose: () => {
      editor.off('transaction', onTransaction);
    },
  };
}

export type ApplyMode = 'replace' | 'insert';

export type ApplyOutcome =
  | { readonly kind: 'replaced' }
  | { readonly kind: 'inserted'; readonly fellBack: boolean }
  | { readonly kind: 'failed'; readonly reason: 'unreadable' | 'not_editable' };

export interface ApplyTarget {
  readonly anchor: RangeAnchor;
  /** Present when the span is replaceable: the text it held when the command began. */
  readonly replace: { readonly rangeText: string } | null;
  /** Where to insert after if the span cannot be recovered, from the command's start. */
  readonly end: number;
}

type Block = Record<string, unknown>;

/** The position just after the top-level block holding `pos`. */
function afterBlockAt(editor: Editor, pos: number): number {
  const { doc } = editor.state;
  const clamped = Math.max(0, Math.min(pos, doc.content.size));
  const $pos = doc.resolve(clamped);
  return $pos.depth >= 1 ? $pos.after(1) : clamped;
}

/**
 * Writes `markdown` into the note as one transaction, so a single undo reverts it.
 *
 * Replace overwrites the tracked span only if it still holds the text the model was shown;
 * otherwise - the span was edited, or cannot be recovered - the result is inserted below instead
 * and the outcome says so. Insert below always goes after the block that holds the end of the span.
 */
export async function applyInlineResult(
  editor: Editor,
  markdown: string,
  target: ApplyTarget,
  mode: ApplyMode,
): Promise<ApplyOutcome> {
  // Parsed by the same function an import uses, loaded when first needed.
  const { markdownToDocument } = await import('@nix/markdown/from-markdown');
  if (editor.isDestroyed || !editor.isEditable) return { kind: 'failed', reason: 'not_editable' };

  const parsed = markdownToDocument(markdown);
  const content = parsed.ok ? (parsed.doc as { content?: unknown }).content : undefined;
  if (!Array.isArray(content) || content.length === 0) {
    return { kind: 'failed', reason: 'unreadable' };
  }
  const blocks = content as Block[];

  // Resolved after the parser loaded, right before the write: the note may have moved on while it
  // did, and a position read earlier would be that much staler.
  const span = target.anchor.resolve();

  if (mode === 'replace' && target.replace !== null && span !== null) {
    const { doc } = editor.state;
    const intact =
      span.to <= doc.content.size &&
      plainText(doc, span.from, span.to) === target.replace.rangeText;
    if (intact) {
      // A phrase inside a sentence takes the result's inline content, not a paragraph of its own;
      // a whole block, or a result of several blocks, takes the blocks.
      const first = blocks[0];
      const inline =
        blocks.length === 1 &&
        first?.type === 'paragraph' &&
        doc.resolve(span.from).parent.isTextblock &&
        doc.resolve(span.from).sameParent(doc.resolve(span.to))
          ? first.content
          : undefined;
      const ok = editor
        .chain()
        .focus()
        .insertContentAt(span, Array.isArray(inline) ? (inline as Block[]) : blocks)
        .run();
      return ok ? { kind: 'replaced' } : { kind: 'failed', reason: 'unreadable' };
    }
  }

  const after = afterBlockAt(editor, span?.to ?? target.end);
  const ok = editor.chain().focus().insertContentAt(after, blocks).run();
  return ok
    ? { kind: 'inserted', fellBack: mode === 'replace' }
    : { kind: 'failed', reason: 'unreadable' };
}
