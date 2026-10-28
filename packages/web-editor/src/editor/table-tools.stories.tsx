import { nixEditingExtensions } from '@nix/editor-schema';
import { EditorContent, useEditor } from '@tiptap/react';
import { useEffect, type ReactElement } from 'react';

import { proseClasses, proseRoot } from './prose';
import { ColumnWidthControls } from './column-width';
import { TableControls } from './table-controls';
import { TableMenu } from './table-menu';
import { TableSizePicker } from './table-size-picker';

export default { title: 'Nix/Editor/Table tools', parameters: { layout: 'padded' } };

const storyExtensions = nixEditingExtensions.map((extension) => {
  const className = proseClasses[extension.name];
  return className === undefined
    ? extension
    : extension.configure({ HTMLAttributes: { class: className } });
});

const TABLE_NOTE = [
  '<p>Quarterly figures, by region. The caret starts in the second row.</p>',
  '<table>',
  '<tr><th>Region</th><th>Q1</th><th>Q2</th><th>Q3</th></tr>',
  '<tr><td>North</td><td>1,204</td><td>1,318</td><td>1,402</td></tr>',
  '<tr><td>South</td><td>980</td><td>1,022</td><td>1,105</td></tr>',
  '<tr><td>West</td><td>1,511</td><td>1,490</td><td>1,602</td></tr>',
  '</table>',
  '<p>Notes follow the table.</p>',
].join('');

function InTable(): ReactElement {
  const editor = useEditor({
    extensions: [...storyExtensions, TableControls, ColumnWidthControls],
    content: TABLE_NOTE,
    editorProps: { attributes: { class: `${proseRoot} outline-none` } },
  });
  useEffect(() => {
    // The caret in "1,022": second data row, third column.
    let target = -1;
    editor.state.doc.descendants((node, pos) => {
      if (target < 0 && node.isText && node.text === '1,022') target = pos;
      return target < 0;
    });
    if (target >= 0) editor.commands.setTextSelection(target + 1);
    editor.commands.focus();
  }, [editor]);
  return (
    <div className="pt-16">
      <EditorContent editor={editor} />
      <TableMenu editor={editor} />
    </div>
  );
}

export const CaretInATable = { render: (): ReactElement => <InTable /> };

export const SizePicker = {
  render: (): ReactElement => (
    <TableSizePicker
      onPick={() => {
        /* A story has no editor to insert into. */
      }}
      onDismiss={() => {
        /* Nor a toolbar to return the focus to. */
      }}
    />
  ),
};
