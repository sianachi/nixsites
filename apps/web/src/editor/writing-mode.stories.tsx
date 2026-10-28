import { nixEditingExtensions } from '@nix/editor-schema';
import { EditorContent, useEditor } from '@tiptap/react';
import { useEffect, type ReactElement } from 'react';
import { within } from '@testing-library/dom';
import userEvent from '@testing-library/user-event';
import { Button } from '@nix/ui';

import { WIDE_ENOUGH_FOR_NON_PHONE_LAYOUT } from '@nix/web-foundation/layout/regions';
import { ColumnWidthControls } from './column-width';
import { MoveBlock } from './move-block';
import { proseRoot } from './prose';
import { readingExtensions } from './reading-extensions';
import { TableControls } from './table-controls';
import { EditorToolbar } from './toolbar';
import {
  setEditorWritingMode,
  useWritingModePreference,
  WritingModeKeymap,
  WRITING_MODES,
  type WritingMode,
} from './writing-mode';
import { WritingModeControl } from './writing-mode-control';
import { MobileNoteToolbar } from './mobile-note-toolbar';
import { TextWidthControl } from './text-width-control';
import { useTextWidthPreference } from './text-width-preference';

export default { title: 'Nix/Editor/Writing modes', parameters: { layout: 'padded' } };

function Writing({
  initialMode = 'prose',
  compact = false,
  content = '<p>At the edge of morning<br>the quiet holds its breath.</p><p>A new day begins.</p>',
}: {
  readonly initialMode?: WritingMode;
  readonly compact?: boolean;
  readonly content?: string;
}): ReactElement {
  const mode = useWritingModePreference((state) => state.mode);
  const width = useTextWidthPreference((state) => state.width);
  useEffect(() => {
    useWritingModePreference.setState({ mode: initialMode, saved: true });
    useTextWidthPreference.setState({ width: 'reading', saved: true });
  }, [initialMode]);
  const editor = useEditor({
    extensions: [
      ...readingExtensions,
      ...nixEditingExtensions.filter(
        (extension) => !readingExtensions.some((reading) => reading.name === extension.name),
      ),
      WritingModeKeymap,
      MoveBlock,
      TableControls,
      ColumnWidthControls,
    ],
    content,
    editorProps: {
      attributes: {
        class: `${proseRoot} min-h-48 outline-none`,
        'data-writing-mode': mode,
        role: 'textbox',
        'aria-label': 'Note body',
        'aria-multiline': 'true',
      },
    },
  });
  useEffect(() => {
    setEditorWritingMode(editor, mode);
  }, [editor, mode]);

  const formatting = (
    <EditorToolbar
      editor={editor}
      compact={compact}
      writingMode={mode}
      writingModeControl={<WritingModeControl />}
      textWidthControl={compact ? undefined : <TextWidthControl />}
      onInsertImage={() => undefined}
      onInsertLink={() => undefined}
      onUndo={() => undefined}
      onRedo={() => undefined}
    />
  );
  return (
    <div
      className={compact ? 'relative flex h-96 w-80 max-w-full flex-col gap-4' : 'w-full space-y-4'}
    >
      {compact ? (
        <MobileNoteToolbar
          formatting={formatting}
          editor={editor}
          actions={<Button variant="ghost">Children</Button>}
        />
      ) : (
        formatting
      )}
      <div
        data-text-width={width}
        className={`min-w-0 w-full ${
          !compact && width === 'full'
            ? 'max-w-none [&_.ProseMirror]:max-w-none'
            : WRITING_MODES[mode].measure
        }`}
      >
        <EditorContent editor={editor} />
      </div>
    </div>
  );
}

export const Prose = { render: (): ReactElement => <Writing /> };
export const Poetry = { render: (): ReactElement => <Writing initialMode="poetry" /> };
export const PhonePoetry = {
  render: (): ReactElement => <Writing initialMode="poetry" compact />,
};
export const Planning = { render: (): ReactElement => <Writing initialMode="planning" /> };
export const Collaboration = {
  render: (): ReactElement => <Writing initialMode="collaboration" />,
};
export const PhonePlanning = {
  render: (): ReactElement => <Writing initialMode="planning" compact />,
};
export const ModeChoices = {
  render: (): ReactElement => <Writing />,
  play: async ({ canvasElement }: { canvasElement: HTMLElement }): Promise<void> => {
    await userEvent.click(
      within(canvasElement).getByRole('button', { name: 'Writing mode: Prose' }),
    );
  },
};

export const PhoneModeChoices = {
  render: (): ReactElement => <Writing initialMode="collaboration" compact />,
  play: async ({ canvasElement }: { canvasElement: HTMLElement }): Promise<void> => {
    await userEvent.click(
      within(canvasElement).getByRole('button', { name: 'Writing mode: Collaboration' }),
    );
    const panel = within(canvasElement).getByRole('dialog', { name: 'Writing mode' });
    const choices = within(panel).getAllByRole('button');
    for (const choice of choices) {
      const label = choice.querySelector('span');
      const description = label?.nextElementSibling;
      if (!label || !description) throw new Error('Writing mode needs a label and description.');
      if (description.getBoundingClientRect().top < label.getBoundingClientRect().bottom) {
        throw new Error('Writing mode descriptions overlap their labels.');
      }
      if (description.getBoundingClientRect().bottom > choice.getBoundingClientRect().bottom) {
        throw new Error('Writing mode descriptions extend beyond their buttons.');
      }
    }
  },
};

export const FullPaneWidth = {
  render: (): ReactElement => <Writing />,
  play: async ({ canvasElement }: { canvasElement: HTMLElement }): Promise<void> => {
    const canvas = within(canvasElement);
    const body = canvas.getByRole('textbox', { name: 'Note body' });
    await userEvent.click(canvas.getByRole('button', { name: 'Text width' }));
    await userEvent.click(canvas.getByRole('button', { name: 'Full pane width' }));
    const surface = body.closest('[data-text-width]');
    if (
      !surface ||
      Math.abs(body.getBoundingClientRect().width - surface.getBoundingClientRect().width) > 1
    ) {
      throw new Error('Full pane width must fill the writing surface.');
    }
    if (canvas.getByRole('textbox', { name: 'Note body' }) !== body) {
      throw new Error('Changing text width replaced the note body.');
    }
  },
};

export const PhoneLongWords = {
  render: (): ReactElement => (
    <Writing compact content={`<p>${'A-long-unbroken-note-title-'.repeat(12)}</p>`} />
  ),
};

export const TouchTypography = {
  render: (): ReactElement => (
    <Writing
      initialMode="planning"
      content="<p>Body text stays readable.</p><pre><code>Code stays readable.</code></pre><table><tbody><tr><td><p>Table text stays readable.</p></td></tr></tbody></table>"
    />
  ),
  play: ({ canvasElement }: { canvasElement: HTMLElement }): void => {
    const canvas = within(canvasElement);
    const view = canvasElement.ownerDocument.defaultView;
    if (view === null) throw new Error('The writing story needs a browser window.');
    const touch =
      view.matchMedia('(any-pointer: coarse)').matches ||
      !view.matchMedia(WIDE_ENOUGH_FOR_NON_PHONE_LAYOUT).matches;
    const body = canvas.getByRole('textbox', { name: 'Note body' });
    const code = body.querySelector('pre');
    if (code === null) throw new Error('The writing story needs its code sample.');
    for (const element of [body, code, canvas.getByRole('table')]) {
      const size = Number.parseFloat(view.getComputedStyle(element).fontSize);
      if (!Number.isFinite(size) || (touch ? size < 16 : size >= 16)) {
        throw new Error(
          `Unexpected ${touch ? 'touch' : 'desktop'} writing size: ${String(size)}px.`,
        );
      }
    }
  },
};
