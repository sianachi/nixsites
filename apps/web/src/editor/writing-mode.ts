import { Extension, type Editor } from '@tiptap/core';
import { Plugin } from '@tiptap/pm/state';
import { z } from 'zod';
import { create } from 'zustand';

import { browserStorage } from '../lib/browser-storage';
import { writeStored } from '../lib/stored-setting';

export const WritingModeSchema = z.enum(['prose', 'poetry', 'planning', 'collaboration']);
export type WritingMode = z.infer<typeof WritingModeSchema>;
export const WRITING_MODE_STORAGE_KEY = 'nix.writing-mode';

export const WRITING_MODES: Readonly<
  Record<
    WritingMode,
    { readonly label: string; readonly description: string; readonly measure: string }
  >
> = {
  prose: {
    label: 'Prose',
    description: 'A comfortable reading width for everyday writing.',
    measure: 'max-w-prose',
  },
  poetry: {
    label: 'Poetry',
    description: 'Enter adds a line. Shift+Enter starts a stanza in plain text.',
    measure: 'max-w-xl',
  },
  planning: {
    label: 'Planning',
    description: 'More room for plans, with task and numbered lists close at hand.',
    measure: 'max-w-4xl',
  },
  collaboration: {
    label: 'Collaboration',
    description: 'Keep live editing status and the people in this note visible.',
    measure: 'max-w-4xl',
  },
};

export function loadWritingMode(storage: Storage | undefined): {
  readonly mode: WritingMode;
  readonly saved: boolean;
} {
  try {
    const parsed = WritingModeSchema.safeParse(storage?.getItem(WRITING_MODE_STORAGE_KEY));
    return { mode: parsed.success ? parsed.data : 'prose', saved: storage !== undefined };
  } catch {
    return { mode: 'prose', saved: false };
  }
}

export const useWritingModePreference = create<{
  readonly mode: WritingMode;
  readonly saved: boolean;
  readonly setMode: (mode: WritingMode) => void;
}>((set) => ({
  ...loadWritingMode(browserStorage()),
  setMode: (mode) => {
    set({ mode, saved: writeStored(WRITING_MODE_STORAGE_KEY, mode === 'prose' ? null : mode) });
  },
}));

export function setEditorWritingMode(editor: Editor, mode: WritingMode): void {
  const editorProps = editor.options.editorProps;
  const attributes = editorProps.attributes;
  editor.setOptions({
    editorProps: {
      ...editorProps,
      attributes:
        typeof attributes === 'function'
          ? (state) => ({ ...attributes(state), 'data-writing-mode': mode })
          : { ...attributes, 'data-writing-mode': mode },
    },
  });
}

function inVerse(editor: Editor): boolean {
  const { selection } = editor.state;
  return (
    editor.isEditable &&
    useWritingModePreference.getState().mode === 'poetry' &&
    selection.$from.depth === 1 &&
    selection.$from.parent.type.name === 'paragraph' &&
    selection.$from.sameParent(selection.$to)
  );
}

export const WritingModeKeymap = Extension.create({
  name: 'writingModeKeymap',
  priority: 900,

  addKeyboardShortcuts() {
    return {
      Enter: () => inVerse(this.editor) && this.editor.commands.setHardBreak(),
      'Shift-Enter': () => inVerse(this.editor) && this.editor.commands.splitBlock(),
    };
  },

  addProseMirrorPlugins() {
    return [
      new Plugin({
        props: {
          handleDOMEvents: {
            beforeinput: (_view, event) => {
              if (
                !(event instanceof InputEvent) ||
                event.isComposing ||
                !event.cancelable ||
                event.inputType !== 'insertParagraph'
              ) {
                return false;
              }
              if (!inVerse(this.editor)) return false;
              // Software keyboards can insert a paragraph without sending an Enter keydown.
              if (!this.editor.commands.setHardBreak()) return false;
              event.preventDefault();
              return true;
            },
          },
        },
      }),
    ];
  },
});
