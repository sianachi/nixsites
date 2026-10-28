import { nixEditingExtensions } from '@nix/editor-schema';
import { EditorContent, useEditor } from '@tiptap/react';
import { useState, type ReactElement } from 'react';

import { PageGuides } from './page-guides-overlay';
import { headingClass, proseClasses, proseRoot } from './prose';
import { TableControls } from './table-controls';

export default { title: 'Nix/Editor/Page guides', parameters: { layout: 'padded' } };

/**
 * The schema with its clothes on, for a story: the same class map `note-editor.tsx` applies,
 * without the collaboration binding, the node views and the API client that file also owns.
 */
const storyExtensions = nixEditingExtensions.map((extension) => {
  if (extension.name === 'heading') {
    return extension.extend({
      renderHTML({
        node,
        HTMLAttributes,
      }: {
        node: { attrs: { level?: unknown } };
        HTMLAttributes: Record<string, unknown>;
      }) {
        const level = Number(node.attrs.level ?? 1);
        return [`h${String(level)}`, { ...HTMLAttributes, class: headingClass(level) }, 0];
      },
    });
  }
  const className = proseClasses[extension.name];
  return className === undefined
    ? extension
    : extension.configure({ HTMLAttributes: { class: className } });
});

const LOREM =
  'The quick brown fox jumps over the lazy dog while the five boxing wizards jump quickly. Pack my box with five dozen liquor jugs, and sphinx of black quartz, judge my vow. ';

function paragraphs(count: number, sentences: number): string {
  return Array.from({ length: count }, () => `<p>${LOREM.repeat(sentences)}</p>`).join('');
}

const LONG_NOTE = [
  '<h1>A report long enough to page</h1>',
  paragraphs(4, 3),
  '<h2>Method</h2>',
  paragraphs(6, 4),
  '<hr>',
  '<h2>Findings</h2>',
  paragraphs(8, 3),
].join('');

function Example(): ReactElement {
  const [host, setHost] = useState<HTMLDivElement | null>(null);
  const editor = useEditor({
    extensions: [...storyExtensions, TableControls],
    content: LONG_NOTE,
    editorProps: { attributes: { class: `${proseRoot} outline-none` } },
  });
  return (
    <div ref={setHost} className="relative">
      <EditorContent editor={editor} />
      <PageGuides editor={editor} host={host} />
    </div>
  );
}

export const LongNote = { render: (): ReactElement => <Example /> };
