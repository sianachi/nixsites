import { act, render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { describe, expect, it, vi } from 'vitest';

import { EditorToolbar, type ToolbarProps } from '../../editor/toolbar';
import { Editor, EditorContent } from '@tiptap/react';
import { nixEditingExtensions } from '@nix/editor-schema';
import { MoveBlock } from '../../editor/move-block';
import { TableControls } from '../../editor/table-controls';
import { ColumnWidthControls } from '../../editor/column-width';

/**
 * The formatting toolbar.
 *
 * Driven against a stand-in editor rather than a real one: TipTap needs a live ProseMirror view and
 * a DOM range to do anything, and what is being asserted here is not that TipTap can make text
 * bold - it is that this toolbar asks it to, says which controls are on, and does not offer table
 * operations outside a table.
 *
 * The commands are checked by name because that is the contract with the schema. A typo in a chain
 * would fail silently in the product - the button would click and nothing would happen.
 */

function editorStub(
  overrides: {
    active?: readonly string[];
    inTable?: boolean;
    inColumns?: boolean;
    destroyed?: boolean;
    alignment?: 'left' | 'center' | 'right';
    alignmentEnabled?: boolean;
  } = {},
): {
  editor: Editor;
  ran: string[];
} {
  const ran: string[] = [];
  const active = new Set(overrides.active ?? []);

  const chain = new Proxy(
    {},
    {
      get: (_target, property: string) => {
        if (property === 'run') {
          return () => true;
        }

        return (...args: unknown[]) => {
          if (property !== 'focus') {
            ran.push(args.length > 0 ? `${property}(${JSON.stringify(args[0])})` : property);
          }
          return chain;
        };
      },
    },
  );

  const editor = {
    isDestroyed: overrides.destroyed ?? false,
    chain: () => chain,
    can: () =>
      new Proxy(
        {},
        {
          get: (_target, property: string) => () =>
            ['setHardBreak', 'splitBlock'].includes(property)
              ? true
              : property === 'setTextAlign'
                ? (overrides.alignmentEnabled ?? true)
                : property.endsWith('ColumnToRow') || property.endsWith('ColumnFromRow')
                  ? (overrides.inColumns ?? false)
                  : (overrides.inTable ?? false),
        },
      ) as Record<string, unknown>,
    isActive: (name: string | Record<string, unknown>, attrs?: Record<string, unknown>) => {
      if (typeof name !== 'string') return name.textAlign === (overrides.alignment ?? null);
      if (name === 'table') {
        return overrides.inTable ?? false;
      }
      if (name === 'columnBlock') {
        return overrides.inColumns ?? false;
      }
      return active.has(attrs === undefined ? name : `${name}-${String(attrs.level)}`);
    },
  } as unknown as Editor;

  return { editor, ran };
}

function renderToolbar(
  options: Parameters<typeof editorStub>[0] = {},
  props: Pick<ToolbarProps, 'compact' | 'writingMode'> = {},
): {
  ran: string[];
  onInsertImage: ReturnType<typeof vi.fn>;
  onInsertLink: ReturnType<typeof vi.fn>;
  onUndo: ReturnType<typeof vi.fn>;
  onRedo: ReturnType<typeof vi.fn>;
} {
  const { editor, ran } = editorStub(options);
  const onInsertImage = vi.fn();
  const onInsertLink = vi.fn();
  const onUndo = vi.fn();
  const onRedo = vi.fn();

  render(
    <EditorToolbar
      editor={editor}
      {...props}
      onInsertImage={onInsertImage}
      onInsertLink={onInsertLink}
      onUndo={onUndo}
      onRedo={onRedo}
    />,
  );
  return { ran, onInsertImage, onInsertLink, onUndo, onRedo };
}

describe('what the toolbar offers', () => {
  it('keeps poetry line and stanza actions reachable on a phone', async () => {
    const { ran } = renderToolbar(
      { active: ['paragraph'] },
      { compact: true, writingMode: 'poetry' },
    );
    await userEvent.click(screen.getByRole('button', { name: 'Line break' }));
    await userEvent.click(screen.getByRole('button', { name: 'New stanza' }));
    expect(ran).toEqual(['setHardBreak', 'splitBlock']);
  });

  it('keeps task and numbered lists visible while planning on a phone', async () => {
    const { ran } = renderToolbar({}, { compact: true, writingMode: 'planning' });
    await userEvent.click(screen.getByRole('button', { name: 'Task list' }));
    await userEvent.click(screen.getByRole('button', { name: 'Numbered list' }));
    expect(ran).toEqual(['toggleTaskList', 'toggleOrderedList']);
  });

  it('keeps speech controls out of the compact writing sheet', async () => {
    renderToolbar({}, { compact: true });
    await userEvent.click(screen.getByRole('button', { name: 'More' }));
    expect(screen.queryByRole('button', { name: 'Dictate' })).not.toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'Read aloud' })).not.toBeInTheDocument();
  });

  it('keeps common actions visible and makes the remaining tools discoverable', async () => {
    const user = userEvent.setup();
    renderToolbar();

    for (const label of [
      'Block type',
      'Bold',
      'Italic',
      'Add link',
      'Insert',
      'More tools',
      'Undo',
      'Redo',
    ]) {
      expect(
        screen.getByRole('button', { name: label === 'Block type' ? /^Block type:/ : label }),
      ).toBeInTheDocument();
    }
    expect(screen.queryByRole('button', { name: 'Heading 1' })).not.toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'Underline' })).not.toBeInTheDocument();

    for (const [trigger, labels] of [
      [
        'Block type',
        [
          'Text',
          'Heading 1',
          'Heading 2',
          'Heading 3',
          'Bulleted list',
          'Numbered list',
          'Task list',
          'Quote',
          'Code block',
        ],
      ],
      [
        'More tools',
        [
          'Underline',
          'Strikethrough',
          'Inline code',
          'Highlight',
          'Align left',
          'Align center',
          'Align right',
          'Move up',
          'Move down',
        ],
      ],
      ['Insert', ['Divider', 'Image', 'Insert table']],
    ] as const) {
      await user.click(
        screen.getByRole('button', { name: trigger === 'Block type' ? /^Block type:/ : trigger }),
      );
      for (const label of labels) {
        expect(screen.getByRole('button', { name: label })).toBeInTheDocument();
      }
      await user.keyboard('{Escape}');
    }
  });

  it('opens a disclosure by keyboard, tabs through toggles and returns focus on Escape', async () => {
    const user = userEvent.setup();
    renderToolbar();
    screen.getByRole('button', { name: 'More tools' }).focus();
    await user.keyboard('{Enter}');
    expect(screen.getByRole('dialog', { name: 'More writing tools' })).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Underline' })).toHaveFocus();
    await user.tab();
    expect(screen.getByRole('button', { name: 'Strikethrough' })).toHaveFocus();
    await user.keyboard('{Escape}');
    expect(screen.queryByRole('dialog', { name: 'More writing tools' })).not.toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'More tools' })).toHaveFocus();
  });

  it('formats the saved text selection and returns focus to the real editor after choosing a tool', async () => {
    const user = userEvent.setup();
    const editor = new Editor({
      extensions: [...nixEditingExtensions, MoveBlock, TableControls, ColumnWidthControls],
      content: '<p>Morning notes</p>',
    });
    const view = render(
      <>
        <EditorToolbar
          editor={editor}
          onInsertImage={() => undefined}
          onInsertLink={() => undefined}
          onUndo={() => undefined}
          onRedo={() => undefined}
        />
        <EditorContent editor={editor} />
      </>,
    );
    try {
      act(() => {
        editor.commands.setTextSelection({ from: 1, to: 8 });
      });
      await user.click(screen.getByRole('button', { name: 'More tools' }));
      await user.click(screen.getByRole('button', { name: 'Highlight' }));
      expect(screen.queryByRole('dialog', { name: 'More writing tools' })).not.toBeInTheDocument();
      expect(editor.state.selection.from).toBe(1);
      expect(editor.state.selection.to).toBe(8);
      expect(editor.getHTML()).toContain('<mark');
      await waitFor(() => {
        expect(editor.view.dom).toHaveFocus();
      });
    } finally {
      view.unmount();
      editor.destroy();
    }
  });

  it('is a toolbar, and says so', () => {
    renderToolbar();

    // Announced as one control with contents rather than as twenty loose buttons, which is what a
    // screen reader would otherwise read out between every paragraph.
    expect(screen.getByRole('toolbar', { name: /formatting/i })).toBeInTheDocument();
  });

  it('gives every control a name that is not just an icon', () => {
    renderToolbar();

    for (const button of screen.getAllByRole('button')) {
      expect(button).toHaveAccessibleName();
    }
  });
});

describe('running a command', () => {
  it('asks the schema for the command the button names', async () => {
    const user = userEvent.setup();
    const { ran } = renderToolbar();

    await user.click(screen.getByRole('button', { name: 'Bold' }));
    await user.click(screen.getByRole('button', { name: /^Block type:/ }));
    await user.click(screen.getByRole('button', { name: 'Bulleted list' }));
    await user.click(screen.getByRole('button', { name: /^Block type:/ }));
    await user.click(screen.getByRole('button', { name: 'Quote' }));

    expect(ran).toEqual(['toggleBold', 'toggleBulletList', 'toggleBlockquote']);
  });

  it('inserts a table of the picked size, with a header row', async () => {
    const user = userEvent.setup();
    const { ran } = renderToolbar();

    await user.click(screen.getByRole('button', { name: 'Insert' }));
    // The button opens the size picker rather than inserting; the size is the pick.
    await user.click(screen.getByRole('button', { name: 'Insert table' }));
    expect(screen.getByRole('button', { name: 'Insert table' })).toHaveAttribute(
      'aria-expanded',
      'true',
    );
    await user.click(screen.getByRole('button', { name: '2 by 4 table' }));

    // A table whose first row is not a header is a grid, and the schema carries tableHeader for
    // exactly this reason.
    expect(ran).toEqual(['insertTable({"rows":2,"cols":4,"withHeaderRow":true})']);
    expect(screen.queryByRole('group', { name: 'Table size' })).not.toBeInTheDocument();
  });

  it('closes the size picker on Escape and returns the focus to its button', async () => {
    const user = userEvent.setup();
    const { ran } = renderToolbar();

    await user.click(screen.getByRole('button', { name: 'Insert' }));
    await user.click(screen.getByRole('button', { name: 'Insert table' }));
    await user.keyboard('{Escape}');

    expect(screen.queryByRole('group', { name: 'Table size' })).not.toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Insert table' })).toHaveFocus();
    expect(ran).toEqual([]);
  });

  it('inserts a three-by-three directly from the compact toolbar', async () => {
    const user = userEvent.setup();
    const { ran } = renderToolbar({}, { compact: true });

    await user.click(screen.getByRole('button', { name: 'More' }));
    await user.click(screen.getByRole('button', { name: 'Insert table' }));

    expect(ran).toEqual(['insertTable({"rows":3,"cols":3,"withHeaderRow":true})']);
  });

  it('opens the image form instead of asking the browser for an address', async () => {
    const user = userEvent.setup();
    const { onInsertImage, ran } = renderToolbar();

    await user.click(screen.getByRole('button', { name: 'Insert' }));
    await user.click(screen.getByRole('button', { name: 'Image' }));

    expect(onInsertImage).toHaveBeenCalledOnce();
    expect(ran).toEqual([]);
  });

  it('opens the link form for a selection and removes an existing link directly', async () => {
    const user = userEvent.setup();
    const first = renderToolbar();

    await user.click(screen.getByRole('button', { name: 'Add link' }));
    expect(first.onInsertLink).toHaveBeenCalledOnce();
    expect(first.ran).toEqual([]);

    const existing = renderToolbar({ active: ['link'] });
    await user.click(screen.getByRole('button', { name: 'Remove link' }));
    expect(existing.onInsertLink).not.toHaveBeenCalled();
    expect(existing.ran).toEqual(['unsetLink']);
  });

  it('sends undo to the document history rather than the editor', async () => {
    const user = userEvent.setup();
    const { onUndo, ran } = renderToolbar();

    await user.click(screen.getByRole('button', { name: 'Undo' }));

    // The document is a CRDT: ProseMirror's own history would revert whichever edit came last,
    // including a colleague's. Nothing is asked of the editor chain at all.
    expect(onUndo).toHaveBeenCalled();
    expect(ran).toEqual([]);
  });

  it('discloses the history keys to sighted and assistive-technology users', () => {
    renderToolbar();

    const undoButton = screen.getByRole('button', { name: 'Undo' });
    const redoButton = screen.getByRole('button', { name: 'Redo' });
    const navigatorPlatform: unknown = Reflect.get(navigator, 'platform');
    const applePlatform =
      typeof navigatorPlatform === 'string' && /Mac|iP(hone|[oa]d)/.test(navigatorPlatform);
    const ariaModifier = applePlatform ? 'Meta' : 'Control';
    const visibleModifier = applePlatform ? 'Command' : 'Ctrl';

    expect(undoButton).toHaveAttribute('title', `Undo (${visibleModifier}+Z)`);
    expect(undoButton).toHaveAttribute('aria-keyshortcuts', `${ariaModifier}+Z`);
    expect(redoButton).toHaveAttribute(
      'title',
      `Redo (${visibleModifier}+Shift+Z or ${visibleModifier}+Y)`,
    );
    expect(redoButton).toHaveAttribute(
      'aria-keyshortcuts',
      `${ariaModifier}+Shift+Z ${ariaModifier}+Y`,
    );
  });
});

describe('saying what is on', () => {
  it('marks an active control as pressed and names the selected block', async () => {
    renderToolbar({ active: ['bold', 'heading-2'] });

    expect(screen.getByRole('button', { name: 'Bold' })).toHaveAttribute('aria-pressed', 'true');
    expect(screen.getByRole('button', { name: /^Block type:/ })).toHaveTextContent('Heading 2');
    await userEvent.click(screen.getByRole('button', { name: /^Block type:/ }));
    expect(screen.getByRole('button', { name: 'Heading 2' })).toHaveAttribute(
      'aria-pressed',
      'true',
    );
    expect(screen.getByRole('button', { name: 'Italic' })).toHaveAttribute('aria-pressed', 'false');
  });

  it('leaves an insert unpressed rather than pressed-false', async () => {
    renderToolbar();

    await userEvent.click(screen.getByRole('button', { name: 'Insert' }));
    // An insert is an action, not a state. `aria-pressed="false"` would tell a screen reader it is
    // a toggle that happens to be off, which is a different and untrue thing.
    expect(screen.getByRole('button', { name: 'Insert table' })).not.toHaveAttribute(
      'aria-pressed',
    );
    expect(screen.getByRole('button', { name: 'Divider' })).not.toHaveAttribute('aria-pressed');
  });
});

describe('the table group', () => {
  it('is absent outside a table', () => {
    renderToolbar();

    // A permanent row of controls that do nothing most of the time teaches people to stop looking
    // at the toolbar.
    expect(screen.queryByRole('button', { name: 'Add row' })).not.toBeInTheDocument();
    expect(screen.queryByRole('group', { name: 'Table' })).not.toBeInTheDocument();
  });

  it('appears inside one, with the row and column operations', async () => {
    renderToolbar({ inTable: true });

    await userEvent.click(screen.getByRole('button', { name: 'Table' }));
    const group = screen.getByRole('group', { name: 'Table' });

    for (const label of ['Add column', 'Add row', 'Delete column', 'Delete row', 'Delete table']) {
      expect(within(group).getByRole('button', { name: label })).toBeInTheDocument();
    }
  });
});

describe('an editor that has been torn down', () => {
  it('draws nothing rather than throwing out of render', () => {
    // `useEditor` destroys the old editor and builds a new one whenever its dependencies change,
    // and React's strict mode does that on every mount in development. `destroy()` nulls the
    // editor's command manager, so a render landing between the two reached `editor.can()` on an
    // editor without one - which threw out of render and took the whole application root down,
    // repeatedly, with a stack that named the toolbar and not the cause.
    const destroyed = {
      isDestroyed: true,
      chain: () => {
        throw new Error('A destroyed editor has no command manager.');
      },
      can: () => {
        throw new Error('A destroyed editor has no command manager.');
      },
      isActive: () => {
        throw new Error('A destroyed editor has no command manager.');
      },
    } as unknown as Editor;

    expect(() => {
      render(
        <EditorToolbar
          editor={destroyed}
          onInsertImage={() => undefined}
          onInsertLink={() => undefined}
          onUndo={() => undefined}
          onRedo={() => undefined}
        />,
      );
    }).not.toThrow();

    expect(screen.queryByRole('toolbar')).not.toBeInTheDocument();
  });
});

describe('the columns group', () => {
  it('stays out of the way outside a row of columns', () => {
    renderToolbar();

    expect(screen.queryByRole('group', { name: 'Columns' })).not.toBeInTheDocument();
  });

  it('offers the two operations a row needs once one exists', async () => {
    // Without them the row is a trap: the slash menu inserts two columns and the handles resize
    // them, and nothing else could add a third, take one away, or get back to ordinary flow.
    renderToolbar({ inColumns: true });

    await userEvent.click(screen.getByRole('button', { name: 'Columns' }));
    const group = screen.getByRole('group', { name: 'Columns' });
    expect(within(group).getByRole('button', { name: 'Add column' })).toBeEnabled();
    expect(within(group).getByRole('button', { name: 'Remove column' })).toBeEnabled();
  });

  it('runs the column commands and not the table’s', async () => {
    // `addColumnAfter` belongs to the table extension. A column button calling it would be the
    // same namespace collision from the other side.
    const { ran } = renderToolbar({ inColumns: true });

    await userEvent.click(screen.getByRole('button', { name: 'Columns' }));
    await userEvent.click(screen.getByRole('button', { name: 'Add column' }));
    await userEvent.click(screen.getByRole('button', { name: 'Columns' }));
    await userEvent.click(screen.getByRole('button', { name: 'Remove column' }));

    expect(ran).toEqual(['addColumnToRow', 'removeColumnFromRow']);
  });

  it('tells people the keys, since a shortcut nobody is told about is not one', async () => {
    renderToolbar({ inColumns: true });

    await userEvent.click(screen.getByRole('button', { name: 'Columns' }));
    expect(screen.getByRole('button', { name: 'Add column' })).toHaveAttribute(
      'title',
      'Add column (Mod+Alt+Enter)',
    );
  });
});

describe('text alignment', () => {
  it('shows the saved alignment and offers all three choices', async () => {
    const { ran } = renderToolbar({ alignment: 'center' });
    await userEvent.click(screen.getByRole('button', { name: 'More tools' }));
    expect(screen.getByRole('button', { name: 'Align center' })).toHaveAttribute(
      'aria-pressed',
      'true',
    );
    expect(screen.getByRole('button', { name: 'Align left' })).toHaveAttribute(
      'aria-pressed',
      'false',
    );
    await userEvent.click(screen.getByRole('button', { name: 'Align right' }));
    expect(ran).toContain('setTextAlign("right")');
  });
  it('offers alignment in the mobile writing tools', async () => {
    const { ran } = renderToolbar({}, { compact: true });
    await userEvent.click(screen.getByRole('button', { name: 'More' }));
    await userEvent.click(screen.getByRole('button', { name: 'Align center' }));
    expect(ran).toContain('setTextAlign("center")');
  });
  it('disables alignment where the selection has no text blocks', async () => {
    renderToolbar({ alignmentEnabled: false });
    await userEvent.click(screen.getByRole('button', { name: 'More tools' }));
    expect(screen.getByRole('button', { name: 'Align center' })).toBeDisabled();
  });
});
