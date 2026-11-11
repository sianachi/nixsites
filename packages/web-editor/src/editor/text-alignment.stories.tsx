import { nixEditingExtensions } from '@nix/editor-schema';
import { EditorContent, useEditor } from '@tiptap/react';
import type { ReactElement } from 'react';
import userEvent from '@testing-library/user-event';
import { within } from '@testing-library/dom';
import { readingExtensions } from './reading-extensions';
import { proseRoot } from './prose';
import { EditorToolbar } from './toolbar';
import { MoveBlock } from './move-block';
import { TableControls } from './table-controls';
import { ColumnWidthControls } from './column-width';

export default { title: 'Nix/Editor/Text alignment', parameters: { layout: 'padded' } };

const POEM =
  '<p>At the edge of morning<br>the quiet holds its breath.</p>' +
  '<p style="text-align: center">A window fills with light<br>and lets the day begin.</p>' +
  '<p style="text-align: right">The last star<br>takes its time.</p>' +
  '<p style="text-align: justify">By the time the first boats left the harbour, the wind had picked up and the morning fog had lifted. The path along the shore was still quiet.</p>';

function Poem({
  compact = false,
  readOnly = false,
}: {
  compact?: boolean;
  readOnly?: boolean;
}): ReactElement {
  const editor = useEditor({
    extensions: [
      ...readingExtensions,
      ...nixEditingExtensions.filter(
        (extension) => !readingExtensions.some((reading) => reading.name === extension.name),
      ),
      MoveBlock,
      TableControls,
      ColumnWidthControls,
    ],
    content: POEM,
    editable: !readOnly,
    editorProps: { attributes: { class: proseRoot, role: 'textbox', 'aria-label': 'Poem' } },
  });
  return (
    <div className="mx-auto max-w-prose space-y-4 font-body text-md">
      {readOnly ? null : (
        <EditorToolbar
          editor={editor}
          compact={compact}
          onInsertImage={() => undefined}
          onInsertLink={() => undefined}
          onUndo={() => undefined}
          onRedo={() => undefined}
        />
      )}
      <EditorContent editor={editor} />
    </div>
  );
}

export const WritingPoem = { render: (): ReactElement => <Poem /> };
export const MobileWritingTools = { render: (): ReactElement => <Poem compact /> };
export const ReadingPoem = { render: (): ReactElement => <Poem readOnly /> };

export const BlockTypeChoices = {
  render: (): ReactElement => <Poem />,
  play: async ({ canvasElement }: { canvasElement: HTMLElement }): Promise<void> => {
    const canvas = within(canvasElement.ownerDocument.body);
    await userEvent.click(canvas.getByRole('button', { name: /^Block type:/ }));
  },
};
export const MoreWritingTools = {
  render: (): ReactElement => <Poem />,
  play: async ({ canvasElement }: { canvasElement: HTMLElement }): Promise<void> => {
    const canvas = within(canvasElement.ownerDocument.body);
    await userEvent.click(canvas.getByRole('button', { name: 'More tools' }));
    await userEvent.click(canvas.getByRole('button', { name: 'Justify' }));
  },
};
export const InsertTablePicker = {
  render: (): ReactElement => <Poem />,
  play: async ({ canvasElement }: { canvasElement: HTMLElement }): Promise<void> => {
    const canvas = within(canvasElement.ownerDocument.body);
    await userEvent.click(canvas.getByRole('button', { name: 'Insert' }));
    await userEvent.click(canvas.getByRole('button', { name: 'Insert table' }));
  },
};
export const NarrowWritingPane = {
  render: (): ReactElement => (
    <div className="max-w-sm">
      <Poem />
    </div>
  ),
};
