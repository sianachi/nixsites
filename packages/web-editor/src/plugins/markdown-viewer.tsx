import { markdownToDocument } from '@nix/markdown';
import { Text } from '@nix/ui';
import { EditorContent, useEditor } from '@tiptap/react';
import { useMemo, type ReactElement } from 'react';

import { proseRoot } from '../editor/prose';
import { readingExtensions } from '../editor/reading-extensions';
import { bareMediaType, fileExtension, type FileViewerPlugin } from './file-viewer-registry';
import { TextViewer } from './text-viewer';

/**
 * A Markdown file, rendered as the document it describes.
 *
 * The same mapping the CLI's `note read` and the importer use (`@nix/markdown`), drawn by a
 * read-only editor wearing the same classes the note editor wears, so a README on the file page
 * looks like the note it would become if imported. What Markdown cannot say - front matter, an
 * unresolved wiki link - is what the importer cannot say either, and the parser refuses rather
 * than guesses; a refused file falls back to its source, which is still the content.
 */

export function isMarkdownFile(fileName: string, mediaType: string): boolean {
  const type = bareMediaType(mediaType);
  if (type === 'text/markdown' || type === 'text/x-markdown') {
    return true;
  }
  const extension = fileExtension(fileName);
  return extension === 'md' || extension === 'markdown' || extension === 'mdx';
}

function RenderedMarkdown({
  fileName,
  doc,
}: {
  readonly fileName: string;
  readonly doc: Record<string, unknown>;
}): ReactElement {
  const editor = useEditor(
    {
      extensions: readingExtensions,
      content: doc,
      editable: false,
      editorProps: {
        attributes: { class: `${proseRoot} outline-none`, 'aria-label': fileName },
      },
    },
    [doc],
  );
  return (
    <div
      role="region"
      aria-label={`${fileName} document`}
      // eslint-disable-next-line jsx-a11y/no-noninteractive-tabindex -- Keyboard users need to scroll documents and wider tables.
      tabIndex={0}
      className="min-h-0 min-w-0 flex-1 overflow-auto px-2 py-4 sm:px-8 sm:py-6"
    >
      <EditorContent editor={editor} />
    </div>
  );
}

export function MarkdownViewer({
  fileName,
  source,
}: {
  readonly fileName: string;
  readonly source: string;
}): ReactElement {
  const parsed = useMemo(() => markdownToDocument(source), [source]);
  if (!parsed.ok) {
    return (
      <div className="flex min-h-0 min-w-0 flex-1 flex-col">
        <Text variant="note" tone="muted" as="p" role="status" className="px-2 py-2 sm:px-8">
          Shown as source: {parsed.reason}
        </Text>
        <TextViewer fileName={fileName} source={source} />
      </div>
    );
  }
  return <RenderedMarkdown fileName={fileName} doc={parsed.doc as Record<string, unknown>} />;
}

export const markdownViewerPlugin: FileViewerPlugin = {
  id: 'nix.markdown.viewer',
  matches: ({ fileName, mediaType }) => isMarkdownFile(fileName, mediaType),
  Component: MarkdownViewer,
};
