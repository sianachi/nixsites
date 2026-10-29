import { nixEditingExtensions, nixExtensions } from '@nix/editor-schema';
import { Editor, getSchema } from '@tiptap/core';
import type { Node as PMNode } from '@tiptap/pm/model';
import { TextSelection } from '@tiptap/pm/state';
import { act, render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { ColumnWidthControls } from '../../editor/column-width';
import { TableControls } from '../../editor/table-controls';
import { TableMenu } from '../../editor/table-menu';

/**
 * The floating table menu.
 *
 * Driven against a real editor, because what is asserted is what the commands do to a real
 * table - a row appears, a header toggles - and a stand-in would only prove the button was
 * wired to a name. jsdom performs no layout, so the table's rectangle is stubbed to something
 * on screen; the placement arithmetic itself is owed a real-browser check.
 */

const schema = getSchema(nixExtensions);

function cell(text: string, header = false): unknown {
  return {
    type: header ? 'tableHeader' : 'tableCell',
    content: [{ type: 'paragraph', content: [{ type: 'text', text }] }],
  };
}

function table(): unknown {
  return {
    type: 'table',
    content: [
      { type: 'tableRow', content: [cell('a1', true), cell('b1', true)] },
      { type: 'tableRow', content: [cell('a2'), cell('b2')] },
    ],
  };
}

function docOf(content: readonly unknown[]): PMNode {
  return schema.nodeFromJSON({ type: 'doc', content });
}

const editors: Editor[] = [];

function makeEditor(content: readonly unknown[]): Editor {
  const element = document.createElement('div');
  document.body.append(element);
  const editor = new Editor({
    element,
    extensions: [...nixEditingExtensions, TableControls, ColumnWidthControls],
    content: docOf(content).toJSON() as Record<string, unknown>,
  });
  editors.push(editor);
  return editor;
}

function placeCaret(editor: Editor, text: string): void {
  let found = -1;
  editor.state.doc.descendants((node, pos) => {
    if (found < 0 && node.isText && node.text === text) {
      found = pos;
    }
    return found < 0;
  });
  expect(found, text).toBeGreaterThan(-1);
  act(() => {
    editor.view.dispatch(
      editor.state.tr.setSelection(TextSelection.create(editor.state.doc, found + 1)),
    );
  });
}

beforeEach(() => {
  // Every element is on screen, a little way down. The menu reads only the table's rectangle.
  vi.spyOn(HTMLElement.prototype, 'getBoundingClientRect').mockReturnValue({
    top: 200,
    bottom: 300,
    left: 40,
    right: 500,
    width: 460,
    height: 100,
    x: 40,
    y: 200,
    toJSON: () => ({}),
  });
});

afterEach(() => {
  vi.restoreAllMocks();
  for (const editor of editors.splice(0)) {
    editor.destroy();
  }
  document.body.innerHTML = '';
});

function rowCount(editor: Editor): number {
  return editor.state.doc.firstChild?.childCount ?? 0;
}

describe('the table menu', () => {
  it('keeps table controls inside a narrow viewport', () => {
    vi.stubGlobal('innerWidth', 280);
    const editor = makeEditor([table()]);
    render(<TableMenu editor={editor} />);
    placeCaret(editor, 'b2');

    expect(screen.getByRole('toolbar', { name: 'Table tools' })).toHaveStyle({
      left: '8px',
      maxWidth: '264px',
    });
  });

  it('is absent until the caret is in a table', () => {
    const editor = makeEditor([
      { type: 'paragraph', content: [{ type: 'text', text: 'outside' }] },
      table(),
    ]);
    render(<TableMenu editor={editor} />);
    placeCaret(editor, 'outside');

    expect(screen.queryByRole('toolbar', { name: 'Table tools' })).not.toBeInTheDocument();

    placeCaret(editor, 'b2');

    expect(screen.getByRole('toolbar', { name: 'Table tools' })).toBeInTheDocument();
  });

  it('says where the caret is and offers every operation, grouped', () => {
    const editor = makeEditor([table()]);
    render(<TableMenu editor={editor} />);
    placeCaret(editor, 'b2');

    const menu = screen.getByRole('toolbar', { name: 'Table tools' });
    expect(within(menu).getByText('Row 2, column 2')).toBeInTheDocument();

    for (const group of ['Rows', 'Columns', 'Cells', 'Headers', 'Table']) {
      expect(within(menu).getByRole('group', { name: group })).toBeInTheDocument();
    }
    for (const label of [
      'Insert row above',
      'Insert row below',
      'Delete row',
      'Insert column left',
      'Insert column right',
      'Delete column',
      'Merge cells',
      'Split cell',
      'Header row',
      'Header column',
      'Delete table',
    ]) {
      expect(within(menu).getByRole('button', { name: label })).toBeInTheDocument();
    }
  });

  it('inserts a row below the caret', async () => {
    const user = userEvent.setup();
    const editor = makeEditor([table()]);
    render(<TableMenu editor={editor} />);
    placeCaret(editor, 'a2');

    await user.click(screen.getByRole('button', { name: 'Insert row below' }));

    expect(rowCount(editor)).toBe(3);
  });

  it('reports the header row as on and switches it off', async () => {
    const user = userEvent.setup();
    const editor = makeEditor([table()]);
    render(<TableMenu editor={editor} />);
    placeCaret(editor, 'a2');

    const headerRow = screen.getByRole('button', { name: 'Header row' });
    expect(headerRow).toHaveAttribute('aria-pressed', 'true');
    expect(screen.getByRole('button', { name: 'Header column' })).toHaveAttribute(
      'aria-pressed',
      'false',
    );

    await user.click(headerRow);

    expect(screen.getByRole('button', { name: 'Header row' })).toHaveAttribute(
      'aria-pressed',
      'false',
    );
    expect(editor.state.doc.firstChild?.firstChild?.firstChild?.type.name).toBe('tableCell');
  });

  it('keeps a command that cannot run here focusable and says so', () => {
    const editor = makeEditor([table()]);
    render(<TableMenu editor={editor} />);
    placeCaret(editor, 'a2');

    // One caret is one cell: nothing to merge.
    const merge = screen.getByRole('button', { name: 'Merge cells' });
    expect(merge).toHaveAttribute('aria-disabled', 'true');
    expect(merge).not.toBeDisabled();
  });

  it('is one tab stop the arrows walk, and Escape returns to the text', async () => {
    const user = userEvent.setup();
    const editor = makeEditor([table()]);
    render(<TableMenu editor={editor} />);
    placeCaret(editor, 'a2');

    const first = screen.getByRole('button', { name: 'Insert row above' });
    expect(first).toHaveAttribute('tabindex', '0');
    expect(screen.getByRole('button', { name: 'Delete table' })).toHaveAttribute('tabindex', '-1');

    act(() => {
      first.focus();
    });
    await user.keyboard('{ArrowRight}');
    expect(screen.getByRole('button', { name: 'Insert row below' })).toHaveFocus();

    await user.keyboard('{End}');
    expect(screen.getByRole('button', { name: 'Delete table' })).toHaveFocus();

    await user.keyboard('{ArrowRight}');
    expect(screen.getByRole('button', { name: 'Insert row above' })).toHaveFocus();

    await user.keyboard('{Escape}');
    // TipTap's focus command lands on the next animation frame.
    await waitFor(() => {
      expect(editor.view.hasFocus()).toBe(true);
    });
  });

  it('deletes the table', async () => {
    const user = userEvent.setup();
    const editor = makeEditor([table()]);
    render(<TableMenu editor={editor} />);
    placeCaret(editor, 'a2');

    await user.click(screen.getByRole('button', { name: 'Delete table' }));

    expect(editor.state.doc.firstChild?.type.name).not.toBe('table');
    expect(screen.queryByRole('toolbar', { name: 'Table tools' })).not.toBeInTheDocument();
  });
});
