import { nixEditingExtensions } from '@nix/editor-schema';
import { EditorContent, useEditor } from '@tiptap/react';
import { useEffect, type ReactElement } from 'react';

import { GhostText, setGhostTextContext } from './ghost-text';
import { proseClasses, proseRoot } from './prose';

export default { title: 'Nix/Editor/Phrase suggestions', parameters: { layout: 'padded' } };

/** The schema with the classes `note-editor.tsx` applies, minus the collaboration binding. */
const storyExtensions = nixEditingExtensions.map((extension) => {
  const className = proseClasses[extension.name];
  return className === undefined
    ? extension
    : extension.configure({ HTMLAttributes: { class: className } });
});

/** Two sentences that teach the document's model "the quarterly review is", twice. */
const NOTE =
  '<p>The quarterly review is due on Friday. The quarterly review is late again.</p><p></p>';

/**
 * A note with a suggestion showing: "the quar" has been typed at the end of the last paragraph,
 * and after the idle pause the rest is drawn in muted text. Right Arrow accepts it; Escape or any
 * further typing removes it.
 */
function Example(): ReactElement {
  const editor = useEditor({
    extensions: [...storyExtensions, GhostText],
    content: NOTE,
    editorProps: { attributes: { class: `${proseRoot} outline-none`, 'aria-label': 'Note body' } },
  });

  // Typed once the editor exists, as a person would, so the suggestion arrives the real way.
  useEffect(() => {
    setGhostTextContext(editor, { enabled: true, learnable: false });
    editor
      .chain()
      .focus()
      .setTextSelection(editor.state.doc.content.size - 1)
      .insertContent('the quar')
      .run();
  }, [editor]);

  return <EditorContent editor={editor} />;
}

export const SuggestionShowing = { render: (): ReactElement => <Example /> };
