import { nixSchema } from '@nix/editor-schema';
import {
  documentToMarkdown,
  escapeInline,
  markdownToDocument,
  type MarkdownLoss,
} from '@nix/markdown';
import { prosemirrorJSONToYXmlFragment, yXmlFragmentToProseMirrorRootNode } from 'y-prosemirror';
import * as Y from 'yjs';

/**
 * Markdown editing over a collaborative note (requirement 8), as data.
 *
 * The Yjs document stays canonical. Entering the mode serialises the current body once and says
 * what Markdown cannot carry; leaving it parses the text and replaces the whole body in one
 * transaction, tagged with {@link MARKDOWN_ORIGIN} so the undo manager treats the swap as one step
 * a person can take back. Whole-document rather than block-diffed: the person edited the whole
 * text, and pairing arbitrary edits to blocks would be a guess (the companion's block edits are
 * targeted, which is why they can pair). Unchanged text writes nothing at all.
 */
export const MARKDOWN_ORIGIN = Symbol('nix.editor.markdown-mode');

export interface MarkdownSnapshot {
  readonly markdown: string;
  readonly losses: readonly MarkdownLoss[];
}

export function snapshotMarkdown(fragment: Y.XmlFragment): MarkdownSnapshot {
  const { markdown, losses } = documentToMarkdown(
    yXmlFragmentToProseMirrorRootNode(fragment, nixSchema).toJSON(),
  );
  return { markdown, losses };
}

export type ApplyMarkdownOutcome =
  | { readonly kind: 'unchanged' }
  | { readonly kind: 'applied' }
  | { readonly kind: 'invalid'; readonly reason: string };

/**
 * Replaces the body with `text` parsed as Markdown, unless it is the text the mode started from.
 * An unparseable text writes nothing and says so, so the editor keeps the textarea open.
 */
export function applyMarkdown(
  doc: Y.Doc,
  fragment: Y.XmlFragment,
  text: string,
  startedFrom: string,
): ApplyMarkdownOutcome {
  if (text === startedFrom) return { kind: 'unchanged' };
  const parsed = markdownToDocument(text);
  if (!parsed.ok) {
    return { kind: 'invalid', reason: 'This Markdown could not be read back into a note.' };
  }
  const scratch = new Y.Doc();
  try {
    const built = prosemirrorJSONToYXmlFragment(
      nixSchema,
      parsed.doc,
      scratch.getXmlFragment('default'),
    );
    const elements = built.toArray().map((node) => {
      if (!(node instanceof Y.XmlElement) && !(node instanceof Y.XmlText)) {
        throw new Error('Unsupported note block.');
      }
      return node.clone();
    });
    doc.transact(() => {
      fragment.delete(0, fragment.length);
      // A body is never empty (note-editor.tsx keeps a paragraph floor); an empty text is a paragraph.
      fragment.insert(0, elements.length === 0 ? [new Y.XmlElement('paragraph')] : elements);
    }, MARKDOWN_ORIGIN);
    return { kind: 'applied' };
  } finally {
    scratch.destroy();
  }
}

/**
 * Calls `onRemote` the first time somebody else changes the body while the mode is open, so the
 * person can be told before their text overwrites it. Local transactions (the floor guard, the
 * mode's own write) do not count.
 */
export function watchRemoteChanges(fragment: Y.XmlFragment, onRemote: () => void): () => void {
  const observer = (
    _events: readonly Y.YEvent<Y.XmlElement>[],
    transaction: Y.Transaction,
  ): void => {
    if (!transaction.local) onRemote();
  };
  fragment.observeDeep(observer);
  return () => {
    fragment.unobserveDeep(observer);
  };
}

/**
 * Replaces the open `[[query` (from `triggerStart` to the caret) with a link to the item, in the
 * spelling `documentToMarkdown` gives a reference, and says where the caret goes: just after it.
 */
export function insertNoteLink(
  text: string,
  caret: number,
  triggerStart: number,
  target: { readonly id: string; readonly title: string },
): { readonly text: string; readonly caret: number } {
  const link = `[${escapeInline(target.title)}](nix://item/${target.id})`;
  return {
    text: text.slice(0, triggerStart) + link + text.slice(caret),
    caret: triggerStart + link.length,
  };
}
