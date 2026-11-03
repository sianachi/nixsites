import { nixExtensions } from '@nix/editor-schema';
import { Editor, type JSONContent } from '@tiptap/core';
import { act, render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, describe, expect, it } from 'vitest';

import { registerActiveEditor } from '@nix/web-editor/editor/active-editor';
import { OutlinePane } from '../../panel/outline-pane';

const heading = (level: number, text: string): JSONContent => ({
  type: 'heading',
  attrs: { level },
  content: [{ type: 'text', text }],
});
const paragraph = (text: string): JSONContent => ({
  type: 'paragraph',
  content: [{ type: 'text', text }],
});

let stop: (() => void) | null = null;
afterEach(() => {
  stop?.();
  stop = null;
});

function open(content: JSONContent[]): Editor {
  const editor = new Editor({
    element: document.createElement('div'),
    extensions: nixExtensions,
    content: { type: 'doc', content },
  });
  stop = registerActiveEditor(editor);
  return editor;
}

describe('the outline pane', () => {
  it('lists the headings of the open note and follows edits', () => {
    const editor = open([heading(1, 'Brief'), paragraph('x'), heading(2, 'Scope')]);
    render(<OutlinePane />);

    expect(screen.getByRole('button', { name: 'Brief' })).toBeVisible();
    expect(screen.getByRole('button', { name: 'Scope' })).toBeVisible();

    act(() => {
      editor.commands.setContent({ type: 'doc', content: [heading(3, 'Risks')] });
    });
    expect(screen.getByRole('button', { name: 'Risks' })).toBeVisible();
    expect(screen.queryByRole('button', { name: 'Brief' })).not.toBeInTheDocument();
  });

  it('moves the caret to a heading when it is chosen', async () => {
    const editor = open([heading(1, 'Brief'), paragraph('body'), heading(2, 'Scope')]);
    render(<OutlinePane />);

    await userEvent.setup().click(screen.getByRole('button', { name: 'Scope' }));

    const { $from } = editor.state.selection;
    expect($from.parent.type.name).toBe('heading');
    expect($from.parent.textContent).toBe('Scope');
  });

  it('says so when the note has no headings, and when nothing with a body is open', () => {
    open([paragraph('just text')]);
    const { unmount } = render(<OutlinePane />);
    expect(screen.getByText('No headings yet.')).toBeVisible();
    unmount();

    stop?.();
    stop = null;
    render(<OutlinePane />);
    expect(screen.getByText('Open a note to see its outline.')).toBeVisible();
  });
});
