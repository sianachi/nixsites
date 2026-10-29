import { nixEditingExtensions } from '@nix/editor-schema';
import { EditorContent, useEditor } from '@tiptap/react';
import { useState, type ReactElement } from 'react';
import { MemoryRouter } from 'react-router';
import { AudioPlayer } from '@nix/web-foundation/audio/audio-player';
import { PetDeviceSettings } from '../pets/pet-device-settings';
import { EpubReader } from '@nix/web-editor/plugins/epub-reader';
import { PropertyInput } from '@nix/web-collections/properties/property-input';
import { InlineAiPanel } from '@nix/web-editor/editor/inline-ai/inline-ai-panel';
import type {
  InlineAiController,
  InlinePanelState,
} from '@nix/web-editor/editor/inline-ai/use-inline-ai';

export default { title: 'Nix/UI UX pass', parameters: { layout: 'padded' } };

function LongText({ card = false }: { card?: boolean }): ReactElement {
  const [value, setValue] = useState('First line\nSecond line\nThird line\nFourth line');
  return (
    <PropertyInput
      item={{ title: 'Review notes', properties: { notes: value } }}
      property={{
        key: 'notes',
        label: 'Notes',
        type: 'long_text',
        options: [],
        required: false,
        expression: null,
        aggregate: null,
        source: null,
      }}
      density={card ? 'card' : 'panel'}
      onCommit={(next) => {
        setValue(typeof next === 'string' ? next : '');
      }}
    />
  );
}
export const LongTextPanel = { render: (): ReactElement => <LongText /> };
export const LongTextCard = { render: (): ReactElement => <LongText card /> };
export const DevicePreferences = {
  render: (): ReactElement => <PetDeviceSettings inlineWriting />,
};
export const AudioIdle = {
  render: (): ReactElement => (
    <AudioPlayer
      itemId="story-audio"
      title="Recording"
      resolveUrl={() => Promise.reject(new Error('No recording in this story'))}
      onDownload={() => undefined}
    />
  ),
};
export const EpubUnavailable = {
  render: (): ReactElement => (
    <EpubReader fileName="Book.epub" blob={undefined} itemId={undefined} />
  ),
};

const INITIAL: InlinePanelState = {
  phase: 'done',
  kind: 'improve',
  instruction: '',
  language: '',
  text: 'Clearer writing, ready to review.',
  stopped: false,
  failure: null,
  canReplace: true,
  hadSelection: true,
  applying: false,
};
function InlinePreview({
  failed = false,
  initial = INITIAL,
}: {
  failed?: boolean;
  initial?: InlinePanelState;
}): ReactElement {
  const editor = useEditor({
    extensions: [...nixEditingExtensions],
    content: '<p>Original text remains here until accepted.</p>',
    editorProps: { attributes: { role: 'textbox', 'aria-label': 'Story note body' } },
  });
  const [state, setState] = useState<InlinePanelState>(
    failed
      ? { ...INITIAL, phase: 'error', failure: 'interrupted', text: 'Partial text is kept.' }
      : initial,
  );
  const idle = () => {
    setState({ ...state, phase: 'idle' });
  };
  const controller: InlineAiController = {
    state,
    available: true,
    start: () => undefined,
    setInstruction: (instruction) => {
      setState((previous) => ({ ...previous, instruction }));
    },
    setLanguage: (language) => {
      setState((previous) => ({ ...previous, language }));
    },
    generate: () => undefined,
    stop: () => undefined,
    retry: () => undefined,
    accept: idle,
    discard: idle,
    anchorRect: () => ({ left: 80, top: 120, bottom: 145 }),
  };
  return (
    <MemoryRouter>
      <EditorContent editor={editor} />
      <InlineAiPanel editor={editor} controller={controller} />
    </MemoryRouter>
  );
}
export const InlineResult = { render: (): ReactElement => <InlinePreview /> };
export const InlineInterrupted = { render: (): ReactElement => <InlinePreview failed /> };
export const InlineCommandChooser = {
  render: (): ReactElement => (
    <InlinePreview initial={{ ...INITIAL, phase: 'choosing', kind: null, text: '' }} />
  ),
};
export const InlineCustomPrompt = {
  render: (): ReactElement => (
    <InlinePreview
      initial={{
        ...INITIAL,
        phase: 'composing',
        kind: 'custom',
        text: '',
        instruction: 'Write a poem about the morning.\nKeep each line short.',
      }}
    />
  ),
};
export const InlineLongResult = {
  render: (): ReactElement => (
    <InlinePreview
      initial={{
        ...INITIAL,
        text: `A link to review:\nhttps://example.com/${'unbroken-path'.repeat(40)}\n${'More words to read.\n'.repeat(20)}`,
      }}
    />
  ),
};
