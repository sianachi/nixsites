import type { Node as ProseMirrorNode } from '@tiptap/pm/model';
import type { Editor } from '@tiptap/react';

import { readDevicePreference } from '@nix/web-foundation/lib/device-preferences';

import { MAX_SELECTION_CHARS, truncateUtf8, utf8Length, type InlineKind } from './inline-ai-stream';

/** How much of the text before the cursor `continue` sends. */
export const CONTINUE_CHARS = 8_000;

/** What the person is asked to wait for being told, rather than a request that cannot succeed. */
export type MaterialProblem = 'empty' | 'too_long';

/** The span of the note a result may replace. */
export interface ReplaceRange {
  readonly from: number;
  readonly to: number;
}

/**
 * What a command works on, and where its result may land.
 *
 * Gathered once when the command is invoked, so the material, the span Replace targets and the
 * text that span held then all describe the same moment of the note.
 */
export interface InlineMaterial {
  /** Sent as `selection`. Never logged. */
  readonly text: string;
  /** The span Replace would overwrite; null when the command works on no replaceable span. */
  readonly range: ReplaceRange | null;
  /** The text `range` held now, so a later replace can tell whether it still holds it. */
  readonly rangeText: string;
  /** Where Insert below is measured from: the end of what the command worked on. */
  readonly end: number;
  /** Whether the person had text selected, which makes Replace the primary action. */
  readonly hadSelection: boolean;
  readonly problem: MaterialProblem | null;
}

/** Paragraph breaks as blank lines, hard breaks as line breaks, and no placeholder for an image. */
export function plainText(doc: ProseMirrorNode, from: number, to: number): string {
  return doc.textBetween(from, to, '\n\n', (node) => (node.type.name === 'hardBreak' ? '\n' : ''));
}

/**
 * Whether the command needs text to work on. `continue` can start from nothing, and `custom`
 * carries its own words; the rest have nothing to do without material.
 */
function needsMaterial(kind: InlineKind): boolean {
  return kind !== 'continue' && kind !== 'custom';
}

export function gatherMaterial(editor: Editor, kind: InlineKind): InlineMaterial {
  const { state } = editor;
  const { doc, selection } = state;
  const { from, to, empty } = selection;

  // A selection that spans real text: what is selected is the material, whatever the command.
  if (!empty) {
    const text = plainText(doc, from, to);
    if (text.trim() !== '') {
      return {
        text,
        // Continuing from a selection must not erase it, so only Insert below is offered.
        range: kind === 'continue' ? null : { from, to },
        rangeText: text,
        end: to,
        hadSelection: true,
        problem: utf8Length(text) > MAX_SELECTION_CHARS ? 'too_long' : null,
      };
    }
  }

  const head = selection.head;
  const none = { range: null, rangeText: '', hadSelection: false, problem: null } as const;

  if (kind === 'continue') {
    return {
      ...none,
      text: truncateUtf8(plainText(doc, 0, head), CONTINUE_CHARS, true),
      end: head,
    };
  }
  if (kind === 'custom') {
    return { ...none, text: '', end: head };
  }
  if (kind === 'summarise' || kind === 'action_items') {
    // The start of a long note, because the start is where the point of it usually is.
    const text = truncateUtf8(plainText(doc, 0, doc.content.size), MAX_SELECTION_CHARS);
    return { ...none, text, end: head, problem: text.trim() === '' ? 'empty' : null };
  }

  // improve, fix, translate: the block the caret is in, replaced whole.
  const $head = doc.resolve(head);
  if ($head.parent.isTextblock && $head.depth >= 1) {
    const text = $head.parent.textContent;
    const range = { from: $head.before(), to: $head.after() };
    return {
      text,
      range,
      rangeText: plainText(doc, range.from, range.to),
      end: range.to,
      hadSelection: false,
      problem:
        text.trim() === '' ? 'empty' : utf8Length(text) > MAX_SELECTION_CHARS ? 'too_long' : null,
    };
  }
  return { ...none, text: '', end: head, problem: needsMaterial(kind) ? 'empty' : null };
}

/** Additional note text leaves the editor only after an explicit device opt-in. */
export function contextFor(editor: Editor): string | undefined {
  if (readDevicePreference('inlineContext') !== 'true') return undefined;
  return truncateUtf8(plainText(editor.state.doc, 0, editor.state.doc.content.size), 32_000);
}
