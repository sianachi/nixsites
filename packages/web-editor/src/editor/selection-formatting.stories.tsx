import { nixEditingExtensions } from '@nix/editor-schema';
import { Button } from '@nix/ui';
import { EditorContent, useEditor } from '@tiptap/react';
import { useEffect, type ReactElement } from 'react';

import { BubbleMenu } from './bubble-menu';
import { MobileNoteToolbar } from './mobile-note-toolbar';
import { proseRoot } from './prose';

export default { title: 'Nix/Editor/Selection formatting', parameters: { layout: 'padded' } };

function SelectedText({ mobile = false }: { readonly mobile?: boolean }): ReactElement {
  const editor = useEditor({
    extensions: [...nixEditingExtensions],
    content: '<p>Select words to apply a text style, colour or highlight.</p>',
    editorProps: { attributes: { class: proseRoot, role: 'textbox', 'aria-label': 'Note body' } },
  });
  useEffect(() => {
    editor.commands.setTextSelection({ from: 1, to: 13 });
  }, [editor]);
  return (
    <div className={`relative h-96 min-w-0 pt-20 ${mobile ? 'max-w-xs' : ''}`}>
      <EditorContent editor={editor} />
      <BubbleMenu editor={editor} />
      {mobile ? (
        <MobileNoteToolbar
          editor={editor}
          formatting={
            <div role="toolbar" aria-label="Formatting" className="flex w-max items-center gap-1">
              <Button variant="ghost" onClick={() => editor.chain().focus().toggleBold().run()}>
                Bold
              </Button>
              <Button variant="ghost" onClick={() => editor.chain().focus().toggleItalic().run()}>
                Italic
              </Button>
              <Button
                variant="ghost"
                onClick={() => editor.chain().focus().toggleHighlight().run()}
              >
                Highlight
              </Button>
            </div>
          }
          actions={<Button variant="ghost">Children</Button>}
        />
      ) : null}
    </div>
  );
}

export const SelectedWords = { render: (): ReactElement => <SelectedText /> };
export const NarrowWritingTools = { render: (): ReactElement => <SelectedText mobile /> };
