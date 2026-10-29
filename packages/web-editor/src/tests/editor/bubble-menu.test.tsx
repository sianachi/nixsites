import { nixExtensions } from '@nix/editor-schema';
import { act, fireEvent, render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { EditorContent, useEditor, type Editor } from '@tiptap/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { type ReactNode } from 'react';

import { BubbleMenu } from '../../editor/bubble-menu';

/**
 * The bubble menu against a real editor: shown over a real selection, applying the mark through
 * the schema's own command, and read back out of the document's HTML.
 *
 * The colour classes themselves are `prose.ts`'s to render and its tests' to assert; here the
 * contract is the attribute the mark writes, because that is what the stylesheet hooks onto.
 */

let captured: Editor | null = null;

function Harness(): ReactNode {
  const editor = useEditor({
    extensions: [...nixExtensions],
    onCreate: ({ editor: created }) => {
      captured = created;
    },
  });

  return (
    <>
      <EditorContent editor={editor} />
      <BubbleMenu editor={editor} />
    </>
  );
}

beforeEach(() => {
  captured = null;
});

/** Renders the harness with `content` in the document and nothing selected yet. */
async function editorWith(content: string): Promise<Editor> {
  render(<Harness />);

  await waitFor(() => {
    expect(captured).not.toBeNull();
  });

  const editor = captured;
  if (editor === null) {
    throw new Error('The editor never reported itself created.');
  }

  // jsdom performs no layout, so the selection has no coordinates to measure. The menu only
  // uses them to position its floating box, which these tests do not assert on.
  vi.spyOn(editor.view, 'coordsAtPos').mockReturnValue({
    left: 0,
    top: 0,
    right: 0,
    bottom: 0,
  });

  act(() => {
    editor.commands.insertContent(content);
  });

  return editor;
}

/** Selects the given document range, which is what makes the menu appear. */
function select(editor: Editor, from: number, to: number): void {
  act(() => {
    editor.commands.setTextSelection({ from, to });
  });
}

describe('the selection bubble menu', () => {
  it.each([
    ['Bold', 'strong'],
    ['Italic', 'em'],
    ['Underline', 'u'],
    ['Strikethrough', 's'],
    ['Inline code', 'code'],
  ])('toggles %s on selected text without moving the selection', async (label, tag) => {
    const editor = await editorWith('some words');
    select(editor, 1, 5);
    const button = await screen.findByRole('button', { name: label });
    fireEvent.mouseDown(button);
    fireEvent.click(button);

    expect(editor.getHTML()).toContain(`<${tag}>some</${tag}>`);
    expect(button).toHaveAttribute('aria-pressed', 'true');
    expect(editor.state.selection.from).toBe(1);
    expect(editor.state.selection.to).toBe(5);

    fireEvent.click(button);
    expect(editor.getHTML()).not.toContain(`<${tag}>`);
  });

  it('keeps touch formatting inside the viewport on a device with a fine primary pointer', async () => {
    const pointer = Object.assign(new EventTarget(), {
      matches: true,
      media: '(any-pointer: coarse)',
      onchange: null,
      addListener: () => undefined,
      removeListener: () => undefined,
    }) satisfies MediaQueryList;
    const fine = Object.assign(new EventTarget(), pointer, { matches: false });
    vi.stubGlobal('matchMedia', (query: string) =>
      query === '(any-pointer: coarse)' ? pointer : fine,
    );
    const viewport = Object.assign(new EventTarget(), {
      width: 280,
      height: 240,
      offsetLeft: 10,
      offsetTop: 20,
      pageLeft: 10,
      pageTop: 20,
      scale: 1,
      onresize: null,
      onscroll: null,
      onscrollend: null,
    }) satisfies VisualViewport;
    vi.stubGlobal('visualViewport', viewport);
    const editor = await editorWith('some words');
    vi.spyOn(editor.view, 'coordsAtPos').mockReturnValue({
      left: 275,
      right: 280,
      top: 25,
      bottom: 250,
    });
    select(editor, 1, 5);

    const menu = await screen.findByRole('toolbar', { name: 'Selection formatting' });
    expect(menu).toHaveStyle({ left: '18px', maxWidth: '264px', maxHeight: '72px', top: '172px' });
    viewport.height = 180;
    act(() => {
      viewport.dispatchEvent(new Event('resize'));
    });
    await waitFor(() => {
      expect(menu).toHaveStyle({ top: '112px' });
    });
  });

  it('stays hidden while the selection is a caret', async () => {
    await editorWith('some words');

    expect(screen.queryByRole('toolbar', { name: 'Selection formatting' })).not.toBeInTheDocument();
  });

  it('appears over selected text with both axes, each choice naming the one it sets', async () => {
    const editor = await editorWith('some words');
    select(editor, 1, 5);

    const toolbar = await screen.findByRole('toolbar', { name: 'Selection formatting' });
    expect(toolbar).toBeInTheDocument();

    // Grouped, and each button still reachable by a name of its own: a group label is announced
    // on entry, but a user arriving at one button by arrow key or by voice hears only that
    // button, and "Accent" twice would be two buttons with the same name and different effects.
    expect(screen.getByRole('group', { name: 'Text colour' })).toBeInTheDocument();
    expect(screen.getByRole('group', { name: 'Highlight' })).toBeInTheDocument();

    for (const name of [
      'Default colour',
      'Accent colour',
      'Muted colour',
      'No highlight',
      'Accent highlight',
      'Muted highlight',
    ]) {
      expect(screen.getByRole('button', { name })).toBeInTheDocument();
    }
  });

  it('applies the accent colour to the selected text as a token name, never a value', async () => {
    const editor = await editorWith('some words');
    select(editor, 1, 5);

    fireEvent.click(await screen.findByRole('button', { name: 'Accent colour' }));

    // The document stores the role's name; what it looks like is the stylesheet's decision at
    // render, which is the whole point of a token-named palette.
    expect(editor.getHTML()).toContain('data-text-color="accent"');
    expect(editor.getHTML()).not.toMatch(/#[0-9a-f]{3,8}/i);
  });

  it('applies the muted colour to the selected text', async () => {
    const editor = await editorWith('some words');
    select(editor, 1, 5);

    fireEvent.click(await screen.findByRole('button', { name: 'Muted colour' }));

    expect(editor.getHTML()).toContain('data-text-color="muted"');
  });

  it('presses the applied colour and releases it when the colour changes', async () => {
    const editor = await editorWith('some words');
    select(editor, 1, 5);

    // Unmarked text is the default colour, and the menu says so from the start.
    expect(await screen.findByRole('button', { name: 'Default colour' })).toHaveAttribute(
      'aria-pressed',
      'true',
    );

    fireEvent.click(screen.getByRole('button', { name: 'Accent colour' }));

    expect(screen.getByRole('button', { name: 'Accent colour' })).toHaveAttribute(
      'aria-pressed',
      'true',
    );
    expect(screen.getByRole('button', { name: 'Default colour' })).toHaveAttribute(
      'aria-pressed',
      'false',
    );
  });

  it('removes the mark entirely when the default colour is chosen', async () => {
    const editor = await editorWith('some words');
    select(editor, 1, 5);

    fireEvent.click(await screen.findByRole('button', { name: 'Accent colour' }));
    expect(editor.getHTML()).toContain('data-text-color="accent"');

    fireEvent.click(screen.getByRole('button', { name: 'Default colour' }));

    // Cleared, not stored: writing `text: "default"` would pin today's meaning of ordinary
    // text into the document forever.
    expect(editor.getHTML()).not.toContain('data-text-color');
    expect(editor.getHTML()).not.toContain('textColor');
  });

  it('applies a highlight to the selected text as a token name, never a value', async () => {
    const editor = await editorWith('some words');
    select(editor, 1, 5);

    fireEvent.click(await screen.findByRole('button', { name: 'Accent highlight' }));

    expect(editor.getHTML()).toContain('data-background-color="accent"');
    expect(editor.getHTML()).not.toMatch(/#[0-9a-f]{3,8}/i);
  });

  it('presses the applied highlight without pressing anything in the other group', async () => {
    const editor = await editorWith('some words');
    select(editor, 1, 5);

    fireEvent.click(await screen.findByRole('button', { name: 'Muted highlight' }));

    expect(screen.getByRole('button', { name: 'Muted highlight' })).toHaveAttribute(
      'aria-pressed',
      'true',
    );
    // The text is still in its default colour: the mark exists, but nothing is on the ink axis,
    // and a menu reading only "does this range carry the mark" would get this backwards.
    expect(screen.getByRole('button', { name: 'Default colour' })).toHaveAttribute(
      'aria-pressed',
      'true',
    );
    expect(screen.getByRole('button', { name: 'No highlight' })).toHaveAttribute(
      'aria-pressed',
      'false',
    );
  });

  it('sets a colour and a highlight together, neither clearing the other', async () => {
    const editor = await editorWith('some words');
    select(editor, 1, 5);

    fireEvent.click(await screen.findByRole('button', { name: 'Accent colour' }));
    fireEvent.click(screen.getByRole('button', { name: 'Muted highlight' }));

    expect(editor.getHTML()).toContain('data-text-color="accent"');
    expect(editor.getHTML()).toContain('data-background-color="muted"');
  });

  it('clears the highlight and keeps the text colour, rather than taking both', async () => {
    const editor = await editorWith('some words');
    select(editor, 1, 5);

    fireEvent.click(await screen.findByRole('button', { name: 'Accent colour' }));
    fireEvent.click(screen.getByRole('button', { name: 'Muted highlight' }));
    fireEvent.click(screen.getByRole('button', { name: 'No highlight' }));

    expect(editor.getHTML()).not.toContain('data-background-color');
    expect(editor.getHTML()).toContain('data-text-color="accent"');
  });

  it('clears the text colour and keeps the highlight, rather than taking both', async () => {
    const editor = await editorWith('some words');
    select(editor, 1, 5);

    fireEvent.click(await screen.findByRole('button', { name: 'Accent colour' }));
    fireEvent.click(screen.getByRole('button', { name: 'Muted highlight' }));
    fireEvent.click(screen.getByRole('button', { name: 'Default colour' }));

    expect(editor.getHTML()).not.toContain('data-text-color');
    expect(editor.getHTML()).toContain('data-background-color="muted"');
  });

  it('leaves no mark behind once both axes have been cleared', async () => {
    const editor = await editorWith('some words');
    select(editor, 1, 5);

    fireEvent.click(await screen.findByRole('button', { name: 'Accent colour' }));
    fireEvent.click(screen.getByRole('button', { name: 'Muted highlight' }));
    fireEvent.click(screen.getByRole('button', { name: 'No highlight' }));
    fireEvent.click(screen.getByRole('button', { name: 'Default colour' }));

    // Back to where it started. An empty mark left in the document would be a change nobody
    // asked for, riding along in the CRDT for the rest of the note's life.
    expect(editor.getHTML()).not.toContain('data-text-color');
    expect(editor.getHTML()).not.toContain('data-background-color');
    expect(editor.getHTML()).not.toContain('<span');
  });

  it('presses nothing over a selection that mixes coloured and plain text', async () => {
    const editor = await editorWith('some words');

    // Colour the first word only, then select across the boundary.
    select(editor, 1, 5);
    fireEvent.click(await screen.findByRole('button', { name: 'Accent colour' }));
    select(editor, 1, 11);

    // The selection is neither all default nor all accent. Saying "Default colour, pressed"
    // over it would be a lie, and so would "Accent colour, pressed".
    for (const name of ['Default colour', 'Accent colour', 'Muted colour']) {
      expect(screen.getByRole('button', { name })).toHaveAttribute('aria-pressed', 'false');
    }
  });

  it('is reachable with the keyboard: Tab reaches the row and Enter applies a colour', async () => {
    const user = userEvent.setup();
    const editor = await editorWith('some words');
    select(editor, 1, 5);
    await screen.findByRole('toolbar', { name: 'Selection formatting' });

    // The menu sits after the editable region in the DOM, so Tab from the text reaches it.
    act(() => {
      editor.view.focus();
    });
    await user.tab();

    expect(screen.getByRole('button', { name: 'Bold' })).toHaveFocus();

    await user.keyboard(
      '{ArrowRight}{ArrowRight}{ArrowRight}{ArrowRight}{ArrowRight}{ArrowRight}{Enter}',
    );

    expect(editor.getHTML()).toContain('data-text-color="accent"');
  });

  it('costs one tab stop, roving through both groups with the arrow keys', async () => {
    const user = userEvent.setup();
    const editor = await editorWith('some words');
    select(editor, 1, 5);
    await screen.findByRole('toolbar', { name: 'Selection formatting' });

    act(() => {
      editor.view.focus();
    });
    await user.tab();

    // One stop for the whole toolbar: every other button is out of the Tab order, in the second
    // group as much as the first. A group that kept its own tab stop would be a second widget.
    expect(screen.getByRole('button', { name: 'Bold' })).toHaveAttribute('tabindex', '0');
    for (const name of [
      'Italic',
      'Underline',
      'Strikethrough',
      'Inline code',
      'Default colour',
      'Accent colour',
      'Muted colour',
      'No highlight',
      'Accent highlight',
      'Muted highlight',
    ]) {
      expect(screen.getByRole('button', { name })).toHaveAttribute('tabindex', '-1');
    }

    await user.keyboard('{ArrowRight}');
    expect(screen.getByRole('button', { name: 'Italic' })).toHaveFocus();
    await user.keyboard('{ArrowRight}{ArrowRight}{ArrowRight}{ArrowRight}{ArrowRight}');
    expect(screen.getByRole('button', { name: 'Accent colour' })).toHaveFocus();

    // Straight through the group boundary rather than stopping at it.
    await user.keyboard('{ArrowRight}{ArrowRight}');
    expect(screen.getByRole('button', { name: 'No highlight' })).toHaveFocus();

    await user.keyboard('{ArrowLeft}');
    expect(screen.getByRole('button', { name: 'Muted colour' })).toHaveFocus();

    // Home and End are the whole row's ends, not the ends of the group focus happens to be in.
    await user.keyboard('{End}');
    expect(screen.getByRole('button', { name: 'Muted highlight' })).toHaveFocus();

    // And the arrows wrap around them.
    await user.keyboard('{ArrowRight}');
    expect(screen.getByRole('button', { name: 'Bold' })).toHaveFocus();

    await user.keyboard('{ArrowLeft}');
    expect(screen.getByRole('button', { name: 'Muted highlight' })).toHaveFocus();

    await user.keyboard('{Home}');
    expect(screen.getByRole('button', { name: 'Bold' })).toHaveFocus();
  });

  it('keeps the selection when a button is pressed with the pointer', async () => {
    const editor = await editorWith('some words');
    select(editor, 1, 5);

    const button = await screen.findByRole('button', { name: 'Accent colour' });
    fireEvent.mouseDown(button);

    // The press must not blur the editor: a collapsing selection would take the range being
    // coloured with it, and the click would land on a caret.
    expect(editor.state.selection.empty).toBe(false);
    expect(editor.state.selection.from).toBe(1);
    expect(editor.state.selection.to).toBe(5);
  });

  it('stays open when focus moves from the text into the menu', async () => {
    const user = userEvent.setup();
    const editor = await editorWith('some words');
    select(editor, 1, 5);
    await screen.findByRole('toolbar', { name: 'Selection formatting' });

    act(() => {
      editor.view.focus();
    });
    await user.tab();

    // Focus arriving in the menu is not focus leaving the editing surface; closing here would
    // shut the menu on the keyboard user in the act of reaching it.
    expect(screen.getByRole('toolbar', { name: 'Selection formatting' })).toBeInTheDocument();
  });

  it('closes on Escape and puts the caret back in the text', async () => {
    const user = userEvent.setup();
    const editor = await editorWith('some words');
    select(editor, 1, 5);
    await screen.findByRole('toolbar', { name: 'Selection formatting' });

    act(() => {
      editor.view.focus();
    });
    await user.tab();
    await user.keyboard('{Escape}');

    expect(screen.queryByRole('toolbar', { name: 'Selection formatting' })).not.toBeInTheDocument();
    await waitFor(() => {
      expect(editor.view.dom).toHaveFocus();
    });
    // Dismissing the menu is not an edit: the selection it was offered over is untouched.
    expect(editor.getHTML()).not.toContain('data-text-color');
  });

  it('disables the colours where a mark cannot go, rather than doing nothing quietly', async () => {
    const editor = await editorWith('some words');

    act(() => {
      editor.commands.setTextSelection({ from: 1, to: 5 });
      editor.commands.toggleCodeBlock();
      editor.commands.setTextSelection({ from: 1, to: 5 });
    });

    // A code block admits no marks, so the commands are no-ops there. Saying so is the honest
    // state; a button that looks live and changes nothing teaches people to distrust the menu.
    for (const name of ['Accent colour', 'Muted colour', 'Accent highlight', 'Muted highlight']) {
      expect(await screen.findByRole('button', { name })).toBeDisabled();
    }
  });

  it('announces itself politely when it opens, because it opens away from the focus', async () => {
    const editor = await editorWith('some words');
    select(editor, 1, 5);

    await screen.findByRole('toolbar', { name: 'Selection formatting' });
    expect(screen.getByText('Selection formatting options available')).toBeInTheDocument();
  });

  it('closes when the selection collapses back to a caret', async () => {
    const editor = await editorWith('some words');
    select(editor, 1, 5);
    await screen.findByRole('toolbar', { name: 'Selection formatting' });

    select(editor, 3, 3);

    expect(screen.queryByRole('toolbar', { name: 'Selection formatting' })).not.toBeInTheDocument();
  });
});
