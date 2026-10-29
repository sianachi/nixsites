import { nixEditingExtensions } from '@nix/editor-schema';
import { Editor } from '@tiptap/core';
import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { WritingModeControl } from '@nix/web-editor/editor/writing-mode-control';
import {
  loadWritingMode,
  setEditorWritingMode,
  useWritingModePreference,
  WritingModeKeymap,
  WRITING_MODE_STORAGE_KEY,
} from '@nix/web-editor/editor/writing-mode';
import { memoryStorage } from '@nix/web-foundation/testing/memory-storage';

let editor: Editor | undefined;
let storage: Storage;

beforeEach(() => {
  storage = memoryStorage();
  vi.stubGlobal('localStorage', storage);
  useWritingModePreference.setState({ mode: 'prose', saved: true });
});

afterEach(() => {
  editor?.destroy();
  editor = undefined;
  useWritingModePreference.setState({ mode: 'prose', saved: true });
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

function open(content = '<p>Morning</p>'): Editor {
  editor = new Editor({
    element: document.createElement('div'),
    extensions: [...nixEditingExtensions, WritingModeKeymap],
    content,
  });
  editor.commands.setTextSelection(8);
  return editor;
}

function enter(current: Editor, shiftKey = false): KeyboardEvent {
  const event = new KeyboardEvent('keydown', {
    key: 'Enter',
    shiftKey,
    bubbles: true,
    cancelable: true,
  });
  current.view.dom.dispatchEvent(event);
  return event;
}

describe('writing modes', () => {
  it('preserves dynamic editor attributes while changing the same editor writing mode', () => {
    const current = open();
    current.setOptions({
      editorProps: {
        ...current.options.editorProps,
        attributes: (state) => ({
          role: 'textbox',
          'data-document-size': String(state.doc.content.size),
        }),
      },
    });
    setEditorWritingMode(current, 'planning');
    current.commands.insertContent(' light');
    expect(current.view.dom).toHaveAttribute('role', 'textbox');
    expect(current.view.dom).toHaveAttribute('data-writing-mode', 'planning');
    expect(current.view.dom).toHaveAttribute('data-document-size', '15');
  });

  it('remembers the selected mode locally and restores focus to its control', async () => {
    render(<WritingModeControl />);
    await userEvent.click(screen.getByRole('button', { name: 'Writing mode: Prose' }));
    await userEvent.click(screen.getByRole('button', { name: /^Poetry/ }));

    expect(useWritingModePreference.getState().mode).toBe('poetry');
    expect(localStorage.getItem(WRITING_MODE_STORAGE_KEY)).toBe('poetry');
    expect(loadWritingMode(localStorage)).toEqual({ mode: 'poetry', saved: true });
    await waitFor(() => {
      expect(screen.getByRole('button', { name: 'Writing mode: Poetry' })).toHaveFocus();
    });
  });

  it('uses prose for an unknown stored mode and remains usable with blocked storage', () => {
    localStorage.setItem(WRITING_MODE_STORAGE_KEY, 'unknown');
    expect(loadWritingMode(localStorage)).toEqual({ mode: 'prose', saved: true });
    expect(loadWritingMode(undefined)).toEqual({ mode: 'prose', saved: false });
    vi.spyOn(storage, 'setItem').mockImplementation(() => {
      throw new Error('Storage is blocked');
    });

    useWritingModePreference.getState().setMode('planning');
    expect(useWritingModePreference.getState().mode).toBe('planning');
    expect(useWritingModePreference.getState().saved).toBe(false);
  });

  it('adds poetry lines and stanzas using the existing document schema', () => {
    useWritingModePreference.setState({ mode: 'poetry' });
    const current = open();
    expect(enter(current).defaultPrevented).toBe(true);
    current.commands.insertContent('Light');
    expect(current.getHTML()).toContain('Morning<br>Light');

    expect(enter(current, true).defaultPrevented).toBe(true);
    current.commands.insertContent('Next stanza');
    expect(current.getHTML()).toContain('</p><p>Next stanza</p>');
  });

  it('accepts a software keyboard paragraph input as a poetry line', () => {
    useWritingModePreference.setState({ mode: 'poetry' });
    const current = open();
    const event = new InputEvent('beforeinput', {
      inputType: 'insertParagraph',
      bubbles: true,
      cancelable: true,
    });
    current.view.dom.dispatchEvent(event);
    current.commands.insertContent('Light');
    expect(event.defaultPrevented).toBe(true);
    expect(current.getHTML()).toContain('Morning<br>Light');
  });

  it('keeps ordinary paragraph Enter behavior after leaving poetry without replacing the editor', () => {
    useWritingModePreference.setState({ mode: 'poetry' });
    const current = open();
    enter(current);
    current.commands.insertContent('Light');
    useWritingModePreference.setState({ mode: 'prose' });
    enter(current);
    current.commands.insertContent('A new paragraph');
    expect(current.getHTML()).toContain('Morning<br>Light</p><p>A new paragraph</p>');
  });

  it.each([
    '<ul><li><p>Morning</p></li></ul>',
    '<h2>Morning</h2>',
    '<pre><code>Morning</code></pre>',
  ])('preserves the normal Enter behavior of structured blocks', (content) => {
    useWritingModePreference.setState({ mode: 'poetry' });
    const current = open(content);
    enter(current);
    expect(current.getHTML()).not.toContain('<br>');
  });

  it('does not handle composing or read-only software keyboard input', () => {
    useWritingModePreference.setState({ mode: 'poetry' });
    const current = open();
    const composing = new InputEvent('beforeinput', {
      inputType: 'insertParagraph',
      isComposing: true,
      bubbles: true,
      cancelable: true,
    });
    current.view.dom.dispatchEvent(composing);
    expect(composing.defaultPrevented).toBe(false);
    current.view.dom.dispatchEvent(
      new InputEvent('beforeinput', { inputType: 'insertParagraph', bubbles: true }),
    );
    expect(current.getHTML()).not.toContain('<br>');
    current.setEditable(false);
    enter(current);
    expect(current.getHTML()).not.toContain('<br>');
  });
});
