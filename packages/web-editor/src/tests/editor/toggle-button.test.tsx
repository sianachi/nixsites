import { nixExtensions } from '@nix/editor-schema';
import { act, fireEvent, render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { EditorContent, useEditor, type Editor } from '@tiptap/react';
import { beforeEach, describe, expect, it } from 'vitest';
import { type ReactNode } from 'react';

import { renderToggleButton, toggleSummaryView } from '../../editor/toggle-button';

/**
 * A toggle under a keyboard, against a real editor.
 *
 * These exist because a toggle starts closed and its body carries `hidden`: a disclosure
 * button a keyboard cannot reach or operate means content a keyboard-only reader cannot
 * open at all. The button is rendered by the details extension's node view and decorated by
 * `renderToggleButton`, so the tests run the two together - the attributes on their own
 * prove nothing about whether Enter actually opens anything.
 *
 * **The keyboard is driven with `userEvent`, which dispatches at whatever element holds the
 * focus - the same contract a browser honours.** `fireEvent.keyDown(button, ...)` delivers to
 * the element named regardless of where the focus actually is, and the bug class these tests
 * exist to catch is precisely "the control worked once and then the focus moved away": the
 * extension's own click handler hands focus back to the document, so a second keystroke would
 * land in the text. Written with `fireEvent`, every one of these passed while that was broken.
 *
 * The harness wires the two renderers to their extensions exactly as `note-editor.tsx` does;
 * the classes and the collaboration plumbing it also adds change nothing about this behaviour.
 */

let captured: Editor | null = null;

function Harness(): ReactNode {
  const editor = useEditor({
    extensions: nixExtensions.map((extension) => {
      if (extension.name === 'details') {
        return extension.configure({ renderToggleButton });
      }
      if (extension.name === 'detailsSummary') {
        return extension.extend({
          addNodeView() {
            return toggleSummaryView;
          },
        });
      }
      return extension;
    }),
    onCreate: ({ editor: created }) => {
      captured = created;
    },
  });

  return <EditorContent editor={editor} />;
}

beforeEach(() => {
  captured = null;
});

/**
 * Waits for the animation frame after the current one.
 *
 * TipTap's `focus()` command does its work inside a `requestAnimationFrame`, so the focus a
 * click hands to the document does not move until the next frame. Asserting before that frame
 * would pass against a control that loses the focus a millisecond later, which is the failure
 * this file is here to catch; two frames is one more than the steal needs.
 */
async function nextFrame(): Promise<void> {
  await act(async () => {
    await new Promise<void>((resolve) => {
      requestAnimationFrame(() => {
        requestAnimationFrame(() => {
          resolve();
        });
      });
    });
  });
}

/** Renders the harness and returns the editor once it reports itself created. */
async function renderEditor(): Promise<Editor> {
  render(<Harness />);

  await waitFor(() => {
    expect(captured).not.toBeNull();
  });

  const editor = captured;
  if (editor === null) {
    throw new Error('The editor never reported itself created.');
  }

  return editor;
}

/**
 * Renders one closed toggle: summary "Plan", body "Hidden body". A `level` makes it a toggle
 * heading of that rank, which is the only difference between the two menu entries.
 */
async function openWithToggle(level?: number): Promise<Editor> {
  const editor = await renderEditor();

  act(() => {
    editor.commands.insertContent({
      type: 'details',
      attrs: { toggleLevel: level ?? null },
      content: [
        { type: 'detailsSummary', content: [{ type: 'text', text: 'Plan' }] },
        {
          type: 'detailsContent',
          content: [{ type: 'paragraph', content: [{ type: 'text', text: 'Hidden body' }] }],
        },
      ],
    });
  });

  return editor;
}

describe('the toggle under a keyboard', () => {
  it('offers a disclosure button named after its section, with the state in aria-expanded', async () => {
    await openWithToggle();

    // A constant name carrying the summary's own text, so six toggles are six distinguishable
    // buttons - and the open state lives in `aria-expanded` alone. A name that flipped between
    // "Expand Plan" and "Collapse Plan" would be a button that renames itself, which is the
    // vendor default's mistake and not a disclosure.
    const button = screen.getByRole('button', { name: 'Plan' });
    expect(button).toHaveAttribute('aria-expanded', 'false');
  });

  it('names a section nobody has titled yet rather than announcing a bare button', async () => {
    const editor = await renderEditor();

    act(() => {
      editor.commands.insertContent({
        type: 'details',
        content: [
          { type: 'detailsSummary' },
          { type: 'detailsContent', content: [{ type: 'paragraph' }] },
        ],
      });
    });

    expect(screen.getByRole('button', { name: 'Untitled section' })).toBeInTheDocument();
  });

  it('is focusable despite living inside the editable region', async () => {
    await openWithToggle();

    // Inside a contenteditable region a button is normally part of the text, not a tab
    // stop; the explicit island attributes are what give the keyboard a way in.
    const button = screen.getByRole('button', { name: 'Plan' });
    expect(button).toHaveAttribute('tabindex', '0');
    expect(button).toHaveAttribute('contenteditable', 'false');

    act(() => {
      button.focus();
    });
    expect(button).toHaveFocus();
  });

  it('starts closed, with the body hidden', async () => {
    await openWithToggle();

    expect(screen.getByText('Hidden body')).not.toBeVisible();
  });

  it('opens on Enter and closes on Space, holding the focus through both', async () => {
    const user = userEvent.setup();
    await openWithToggle();

    const button = screen.getByRole('button', { name: 'Plan' });
    act(() => {
      button.focus();
    });

    await user.keyboard('{Enter}');
    expect(screen.getByText('Hidden body')).toBeVisible();
    expect(button).toHaveAttribute('aria-expanded', 'true');

    // The extension's click handler ends by focusing the document, which is right for a
    // pointer and strands a keyboard: the Space below would type a space instead of closing
    // the section, and the state change would be announced on an element nobody is on. The
    // steal lands a frame after the click, so the wait is part of the assertion.
    await nextFrame();
    expect(button).toHaveFocus();

    await user.keyboard(' ');
    expect(screen.getByText('Hidden body')).not.toBeVisible();
    expect(button).toHaveAttribute('aria-expanded', 'false');

    await nextFrame();
    expect(button).toHaveFocus();
  });

  it('keeps Enter and Space on the button away from the document', async () => {
    const user = userEvent.setup();
    const editor = await openWithToggle();
    const before = editor.getJSON();

    const button = screen.getByRole('button', { name: 'Plan' });
    act(() => {
      button.focus();
    });
    await user.keyboard('{Enter}');
    await nextFrame();
    await user.keyboard(' ');
    await nextFrame();

    // Opening and closing a section is a reading posture, not an edit: the same keys that
    // split blocks and insert spaces elsewhere must leave the content untouched here.
    expect(editor.getJSON()).toEqual(before);
    expect(button).toHaveFocus();
  });

  it('moves on below a closed toggle when Enter is pressed in its summary', async () => {
    const editor = await openWithToggle();

    // The caret at the end of "Plan", inside the summary.
    act(() => {
      editor.commands.setTextSelection(6);
    });
    fireEvent.keyDown(editor.view.dom, { key: 'Enter' });

    // A closed toggle's body is hidden, so Enter must not drop the caret into content
    // nobody can see - it carries on with a new block after the toggle instead.
    const doc = editor.state.doc;
    expect(doc.firstChild?.type.name).toBe('details');
    expect(doc.childCount).toBeGreaterThan(1);
    expect(doc.child(1).type.name).toBe('paragraph');
  });

  it('unwraps the toggle on Backspace at the start of its summary', async () => {
    const editor = await openWithToggle();

    // The caret before the "P" of "Plan".
    act(() => {
      editor.commands.setTextSelection(2);
    });
    fireEvent.keyDown(editor.view.dom, { key: 'Backspace' });

    // The way back out for a keyboard: the summary and the body become ordinary blocks, and
    // the text survives.
    expect(editor.state.doc.firstChild?.type.name).not.toBe('details');
    expect(editor.getText()).toContain('Plan');
    expect(editor.getText()).toContain('Hidden body');
  });
});

describe('a toggle heading', () => {
  it('presents its summary as a heading of the level it claims', async () => {
    await openWithToggle(2);

    // The summary renders at the matching heading's type step, and a type step is invisible
    // to a screen reader: without the role the document shows a hierarchy that assistive
    // technology can neither hear nor navigate.
    //
    // Queried by accessible *name*, not text content, because a heading takes its name from
    // its contents: a disclosure button inside this one would contribute its own name and
    // make the heading "Plan Plan", which `toHaveTextContent` cannot see. It does not today -
    // the extension's node view appends the button as a sibling of the content wrapper, and
    // the summary sits inside that wrapper - and this assertion is what says so out loud, and
    // what would fail if the vendor ever moved the button in.
    expect(screen.getByRole('heading', { level: 2, name: 'Plan' })).toBeInTheDocument();
  });

  it('leaves a plain toggle summary as plain text', async () => {
    await openWithToggle();

    // Bolded text is not a heading; only a toggle that claims a level gets the role.
    expect(screen.queryByRole('heading')).not.toBeInTheDocument();
  });
});
